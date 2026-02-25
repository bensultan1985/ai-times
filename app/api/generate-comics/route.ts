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
    textPrompt: `Create the text for a single-panel family-friendly comic.

Return ONLY valid JSON (no Markdown) in exactly this shape:
{
  "caption": string | null,
  "bubbles": Array<{ "text": string, "position": "top-left"|"top-right"|"bottom-left"|"bottom-right"|"center" }>
}

Rules:
- Use bubbles only if it improves the joke; otherwise use a caption; sometimes use both.
- If bubbles are used, keep them short (max ~8 words each) and never empty.
- 0 to 2 bubbles total.
- Avoid profanity.
- Caption (if present) is shown UNDER the panel, 1-2 sentences, no quotes.

Scene: Dad proudly serves homemade green smoothies. Kids stare in horror. Mom secretly feeds hers to the dog under the table; dog looks unimpressed.`,
    captionPrompt:
      "Write a short, funny, family-friendly caption to appear UNDER the comic panel (1-2 sentences, no quotes). The comic shows a dad proudly serving healthy green smoothies, the kids look horrified, and the mom secretly feeds hers to the dog who also looks unimpressed.",
    title: "Family Funnies",
  },
  {
    type: "ai_dog" as const,
    imagePrompt:
      "A dry, witty newspaper comic strip panel. A distinguished golden retriever in a crisp business suit sits at the head of a conference room table, wearing glasses, holding a stylus, looking unimpressed. Around the table sit stressed human software engineers staring at laptops. A whiteboard behind the dog reads 'SPRINT PLANNING — DAY 47'. The dog has a deadpan, slightly judgmental expression. Classic black-and-white comic strip art style with clean lines. Do NOT include any speech bubbles, captions, word balloons, or readable text inside the image.",
    textPrompt: `Create the text for a single-panel dry office-humor comic.

Return ONLY valid JSON (no Markdown) in exactly this shape:
{
  "caption": string | null,
  "bubbles": Array<{ "text": string, "position": "top-left"|"top-right"|"bottom-left"|"bottom-right"|"center" }>
}

Rules:
- Use bubbles only if it improves the joke; otherwise use a caption; sometimes use both.
- If bubbles are used, keep them short (max ~8 words each) and never empty.
- 0 to 2 bubbles total.
- Caption (if present) is shown UNDER the panel, one-liner, no quotes.
- Tone: dry, witty, slightly sarcastic, with a hint of warmth.

Scene: AI dog manager 'Rex' runs sprint planning. Engineers look stressed. Rex looks unimpressed.`,
    captionPrompt:
      "Write a dry, witty, sarcastic one-liner caption to appear UNDER the comic panel (no quotes). The comic shows an AI dog manager named 'Rex' running a software sprint planning meeting and looking utterly unimpressed by his human engineers. Occasionally hint at warmth beneath the sarcasm.",
    title: "Byte & Rex",
  },
];

type BubblePosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

type ComicText = {
  caption: string | null;
  bubbles: Array<{ text: string; position: BubblePosition }>;
};

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

async function generateComicText(
  textPrompt: string,
  captionPrompt: string,
): Promise<ComicText> {
  const res = await withRetry(
    () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: textPrompt }],
        max_tokens: 160,
      }),
    "comic-text",
  );

  let content = (res.choices[0]?.message?.content ?? "").trim();
  content = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    const parsed = JSON.parse(content);
    const caption =
      typeof parsed?.caption === "string" ? parsed.caption.trim() : null;
    const bubblesRaw = Array.isArray(parsed?.bubbles) ? parsed.bubbles : [];
    const bubbles = bubblesRaw
      .filter(
        (b: any) => typeof b?.text === "string" && b.text.trim().length > 0,
      )
      .slice(0, 2)
      .map((b: any) => {
        const position = String(b.position ?? "top-left") as BubblePosition;
        const allowed: BubblePosition[] = [
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
          "center",
        ];
        return {
          text: String(b.text).trim(),
          position: allowed.includes(position) ? position : "top-left",
        };
      });

    return {
      caption: caption && caption.length > 0 ? caption : null,
      bubbles,
    };
  } catch {
    // Fallback: keep the system working even if the model returns invalid JSON.
    const caption = (await generateCaption(captionPrompt)).trim();
    return { caption: caption.length > 0 ? caption : null, bubbles: [] };
  }
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
        const [image_url, text] = await Promise.all([
          generateImage(comic.imagePrompt),
          generateComicText(comic.textPrompt, comic.captionPrompt),
        ]);

        const metadata =
          Array.isArray(text.bubbles) && text.bubbles.length > 0
            ? { bubbles: text.bubbles }
            : null;

        await upsertComic({
          comic_type: comic.type,
          title: comic.title,
          caption: text.caption ?? undefined,
          image_url,
          published_at: pubDate,
          test_data: false,
          metadata,
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
