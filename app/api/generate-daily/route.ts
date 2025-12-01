import { NextResponse } from "next/server";
import OpenAI from "openai";
import { AGENTS } from "@/lib/agents";
import { insertArticle } from "@/lib/articles";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxRetries = 3;
  let attempt = 0;
  const baseDelay = 3000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt += 1;

      const status = err?.status ?? err?.response?.status;
      if (status !== 429 || attempt > maxRetries) {
        console.error(`[withRetry] ${label} failed on attempt ${attempt}`, err);
        throw err;
      }

      const delayMs = baseDelay * attempt;
      console.warn(
        `[withRetry] Rate limited on ${label}, attempt ${attempt} — waiting ${delayMs}ms before retrying...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function GET() {
  const pubDate = new Date().toISOString().slice(0, 10);

  const generatedTitles: string[] = [];

  const candidateImages = [
    "https://images.pexels.com/photos/8386434/pexels-photo-8386434.jpeg",
    "https://images.pexels.com/photos/1181675/pexels-photo-1181675.jpeg",
    "https://images.pexels.com/photos/8386328/pexels-photo-8386328.jpeg",
    "https://images.pexels.com/photos/1181467/pexels-photo-1181467.jpeg",
  ];

  for (const agent of AGENTS) {
    const priorTitlesText =
      generatedTitles.length > 0
        ? `Here are the headlines already assigned to other AI desk writers today: ${generatedTitles
            .map((t, i) => `${i + 1}. ${t}`)
            .join(
              " | "
            )}. Do NOT cover the same specific story or event; choose a clearly different AI news story.`
        : "You are the first AI desk writer generating a headline today.";

    const res = await withRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-5-search-api",
          messages: [
            { role: "system", content: agent.systemPrompt },
            {
              role: "user",
              content: `Generate a single JSON object for an AI-related article.
  
  Return ONLY valid JSON, no Markdown, no backticks, no comments, no explanation.
  The JSON MUST have this exact shape:
  
  {
    "title": string,
    "subtitle": string,
    "body": string
  }
  
  Guidelines:
  1) Article should relate to very recent news in most cases (such as a specific event from the last 24 hours... today is ${pubDate}) just like a daily paper may do.
  2) Focus on specific events, companies, trends, names, etc.
  3) Avoid vague generalities.
  4) Do not duplicate or closely echo any of these existing headlines; choose a clearly distinct story angle or event.

  ${priorTitlesText}`,
            },
          ],
          // response_format and temperature are not supported by gpt-5-search-api
        }),
      `daily-article for agent ${agent.name}`
    );

    let content = res.choices[0].message.content ?? "";

    // Strip common Markdown fences defensively if the model ignores instructions
    content = content
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    let article;
    try {
      article = JSON.parse(content);
    } catch (err) {
      console.error("Failed to parse article JSON for agent", agent.name, err);
      console.error("Raw content was:\n", content);
      throw err;
    }

    if (article?.title && typeof article.title === "string") {
      generatedTitles.push(article.title.trim());
    }

    const shouldHaveImage = Math.random() < 0.5;
    const image_urls = shouldHaveImage
      ? [candidateImages[Math.floor(Math.random() * candidateImages.length)]]
      : [];

    await insertArticle({
      ...article,
      image_urls,
      author: agent.name,
      department: agent.department,
      published_at: pubDate,
      test_data: true,
      metadata: { agentId: agent.id },
    });
  }
  return NextResponse.json({ status: "ok" });
}
