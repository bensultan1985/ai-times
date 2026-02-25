import { NextResponse } from "next/server";
import OpenAI from "openai";
import { upsertComic } from "@/lib/comics";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const COMICS = [
  {
    type: "family" as const,
    imagePrompt:
      "A warm, cheerful newspaper comic strip panel in classic Sunday-funnies style. Simple, colorful line art suitable for all ages. A family of four — parents and two young kids — are sitting around a dinner table. The dad proudly presents a bowl of green smoothies he made from scratch. The kids stare in horror. The mom secretly feeds hers to the dog under the table. The dog looks equally appalled. Do NOT include any speech bubbles, captions, word balloons, or readable text inside the image. The overall tone is wholesome and funny.",
    captionPrompt:
      "Write a short, funny, family-friendly caption to appear UNDER the comic panel (1-2 sentences, no quotes). The comic shows a dad proudly serving healthy green smoothies, the kids look horrified, and the mom secretly feeds hers to the dog who also looks unimpressed.",
    title: "Family Funnies",
  },
  {
    type: "ai_dog" as const,
    imagePrompt:
      "A dry, witty newspaper comic strip panel. A distinguished golden retriever in a crisp business suit sits at the head of a conference room table, wearing glasses, holding a stylus, looking unimpressed. Around the table sit stressed human software engineers staring at laptops. A whiteboard behind the dog reads 'SPRINT PLANNING — DAY 47'. The dog has a deadpan, slightly judgmental expression. Classic black-and-white comic strip art style with clean lines. Do NOT include any speech bubbles, captions, word balloons, or readable text inside the image.",
    captionPrompt:
      "Write a dry, witty, sarcastic one-liner caption to appear UNDER the comic panel (no quotes). The comic shows an AI dog manager named 'Rex' running a software sprint planning meeting and looking utterly unimpressed by his human engineers. Occasionally hint at warmth beneath the sarcasm.",
    title: "Byte & Rex",
  },
];

async function generateCaption(prompt: string): Promise<string> {
  const res = await withRetry(
    () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
      }),
    "caption",
  );
  return (res.choices[0]?.message?.content ?? "").trim();
}

async function generateImage(prompt: string): Promise<string> {
  // Prefer base64 so we don't depend on remote URL hosting.
  // Fall back to DALL·E URL output if the account/model doesn't support base64.
  try {
    const res = await withRetry(
      () =>
        openai.images.generate({
          model: "gpt-image-1",
          prompt,
          size: "1024x1024",
        }),
      "image(gpt-image-1)",
    );
    const data = res.data ?? [];
    const b64 = data[0]?.b64_json;
    const url = data[0]?.url;
    if (typeof b64 === "string" && b64.length > 0) {
      return `data:image/png;base64,${b64}`;
    }
    if (typeof url === "string" && url.length > 0) return url;
    throw new Error("No image data returned from OpenAI");
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const message = err?.message ?? "";
    const maybeUnsupportedModel = status === 400 || status === 404;
    if (!maybeUnsupportedModel && !/model/i.test(message)) throw err;

    const res = await withRetry(
      () =>
        openai.images.generate({
          model: "dall-e-3",
          prompt,
          n: 1,
          size: "1024x1024",
          response_format: "url",
        }),
      "image(dall-e-3)",
    );
    const data = res.data ?? [];
    const url = data[0]?.url;
    if (!url) throw new Error("No image URL returned from OpenAI");
    return url;
  }
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxRetries = 3;
  const baseDelayMs = 1500;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const isRetryable =
        status === 429 || status === 500 || status === 502 || status === 503;

      if (!isRetryable || attempt > maxRetries) {
        console.error(
          `[generate-comics] ${label} failed after ${attempt} attempt(s)`,
          err,
        );
        throw err;
      }

      const delayMs = baseDelayMs * attempt;
      console.warn(
        `[generate-comics] ${label} retry ${attempt}/${maxRetries} after ${delayMs}ms (status=${status ?? "unknown"})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Unreachable, but keeps TS happy.
  throw new Error("Retry loop exhausted");
}

export async function GET() {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY" },
      { status: 500 },
    );
  }

  const pubDate = new Date().toISOString().slice(0, 10);

  const results = await Promise.all(
    COMICS.map(async (comic) => {
      try {
        const [image_url, caption] = await Promise.all([
          generateImage(comic.imagePrompt),
          generateCaption(comic.captionPrompt),
        ]);

        await upsertComic({
          comic_type: comic.type,
          title: comic.title,
          caption,
          image_url,
          published_at: pubDate,
          test_data: false,
        });

        return { type: comic.type, status: "ok" };
      } catch (err: unknown) {
        console.error(
          `[generate-comics] Failed to generate ${comic.type}`,
          err,
        );
        const message = err instanceof Error ? err.message : String(err);
        return { type: comic.type, status: "error", error: message };
      }
    }),
  );

  return NextResponse.json({ results });
}
