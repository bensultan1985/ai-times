import { NextResponse } from "next/server";
import OpenAI from "openai";
import { insertComic } from "@/lib/comics";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const COMICS = [
  {
    type: "family" as const,
    imagePrompt:
      "A warm, cheerful newspaper comic strip panel in classic Sunday-funnies style. Simple, colorful line art suitable for all ages. A family of four — parents and two young kids — are sitting around a dinner table. The dad proudly presents a bowl of green smoothies he made from scratch. The kids stare in horror. The mom secretly feeds hers to the dog under the table. The dog looks equally appalled. Speech bubbles are blank. The overall tone is wholesome and funny.",
    captionPrompt:
      "Write a short, funny, family-friendly caption (1-2 sentences, no quotes) for a comic strip where a dad proudly serves healthy green smoothies, the kids look horrified, and the mom secretly feeds hers to the dog who also looks unimpressed.",
    title: "Family Funnies",
  },
  {
    type: "ai_dog" as const,
    imagePrompt:
      "A dry, witty newspaper comic strip panel. A distinguished golden retriever in a crisp business suit sits at the head of a conference room table, wearing glasses, holding a stylus, looking unimpressed. Around the table sit stressed human software engineers staring at laptops. A whiteboard behind the dog reads 'SPRINT PLANNING — DAY 47'. The dog has a deadpan, slightly judgmental expression. Classic black-and-white comic strip art style with clean lines. Speech bubbles are blank.",
    captionPrompt:
      "Write a dry, witty, sarcastic one-liner caption (no quotes) for a comic strip where an AI dog manager named 'Rex' runs a software sprint planning meeting and looks utterly unimpressed by his human engineers. Occasionally hint at warmth beneath the sarcasm.",
    title: "Byte & Rex",
  },
];

async function generateCaption(prompt: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 80,
  });
  return (res.choices[0].message.content ?? "").trim();
}

async function generateImage(prompt: string): Promise<string> {
  const res = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    response_format: "url",
  });
  const data = res.data ?? [];
  const url = data[0]?.url;
  if (!url) throw new Error("No image URL returned from OpenAI");
  return url;
}

export async function GET() {
  const pubDate = new Date().toISOString().slice(0, 10);

  const results = await Promise.all(
    COMICS.map(async (comic) => {
      try {
        const [image_url, caption] = await Promise.all([
          generateImage(comic.imagePrompt),
          generateCaption(comic.captionPrompt),
        ]);

        await insertComic({
          comic_type: comic.type,
          title: comic.title,
          caption,
          image_url,
          published_at: pubDate,
          test_data: false,
        });

        return { type: comic.type, status: "ok" };
      } catch (err: unknown) {
        console.error(`[generate-comics] Failed to generate ${comic.type}`, err);
        const message = err instanceof Error ? err.message : String(err);
        return { type: comic.type, status: "error", error: message };
      }
    })
  );

  return NextResponse.json({ results });
}
