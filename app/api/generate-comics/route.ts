import { NextResponse } from "next/server";
import OpenAI from "openai";
import { upsertComic } from "@/lib/comics";
import sharp from "sharp";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ComicType = Parameters<typeof upsertComic>[0]["comic_type"];

type ComicConfig = {
  type: ComicType;
  title: string;
  imagePrompt: string;
  textPrompt: string;
  captionPrompt: string;
  imageSize?: "1024x1024" | "1792x1024" | "1024x1792";
};

const COMICS: ComicConfig[] = [
  {
    type: "family" as const,
    imagePrompt:
      "A warm, cheerful newspaper comic strip panel in classic Sunday-funnies style. Simple, colorful line art suitable for all ages. A family of four — parents and two young kids — are sitting around a dinner table. The dad proudly presents a bowl of green smoothies he made from scratch. The kids stare in horror. The mom secretly feeds hers to the dog under the table. The dog looks equally appalled. If you include any visible text, it must be clear, correctly spelled English (no gibberish). The overall tone is wholesome and funny.",
    textPrompt: `Create the text for a single-panel family-friendly comic.

Return ONLY valid JSON (no Markdown) in exactly this shape:
{
  "caption": string | null,
  "bubbles": string[]
}

Rules:
- Choose EXACTLY ONE approach:
  A) Caption-only: set "caption" to a 1–2 sentence caption (no quotes) and set "bubbles" to [].
  B) Bubble-only: set "caption" to null and set "bubbles" to 1–3 short lines (max ~8 words each).
- If bubbles are used, they MUST be clear, correctly spelled English.
- Avoid profanity.

Scene: Dad proudly serves homemade green smoothies. Kids stare in horror. Mom secretly feeds hers to the dog under the table; dog looks unimpressed.`,
    captionPrompt:
      "Write a short, funny, family-friendly caption to appear UNDER the comic panel (1-2 sentences, no quotes). The comic shows a dad proudly serving healthy green smoothies, the kids look horrified, and the mom secretly feeds hers to the dog who also looks unimpressed.",
    title: "Family Funnies",
  },
  {
    type: "ai_dog" as const,
    imagePrompt:
      "A dry, witty newspaper comic strip panel. A distinguished golden retriever in a crisp business suit sits at the head of a conference room table, wearing glasses, holding a stylus, looking unimpressed. Around the table sit stressed human software engineers staring at laptops. A whiteboard behind the dog reads 'SPRINT PLANNING — DAY 47'. The dog has a deadpan, slightly judgmental expression. Classic black-and-white comic strip art style with clean lines. If you include any visible text, it must be clear, correctly spelled English (no gibberish).",
    textPrompt: `Create the text for a single-panel dry office-humor comic.

Return ONLY valid JSON (no Markdown) in exactly this shape:
{
  "caption": string | null,
  "bubbles": string[]
}

Rules:
- Choose EXACTLY ONE approach:
  A) Caption-only: set "caption" to a one-liner (no quotes) and set "bubbles" to [].
  B) Bubble-only: set "caption" to null and set "bubbles" to 1–3 short lines (max ~8 words each).
- If bubbles are used, they MUST be clear, correctly spelled English.
- Caption (if present) is shown UNDER the panel, one-liner, no quotes.
- Tone: dry, witty, slightly sarcastic, with a hint of warmth.

Scene: AI dog manager 'Rex' runs sprint planning. Engineers look stressed. Rex looks unimpressed.`,
    captionPrompt:
      "Write a dry, witty, sarcastic one-liner caption to appear UNDER the comic panel (no quotes). The comic shows an AI dog manager named 'Rex' running a software sprint planning meeting and looking utterly unimpressed by his human engineers. Occasionally hint at warmth beneath the sarcasm.",
    title: "Byte & Rex",
  },
  {
    type: "teen_bot" as const,
    imagePrompt: `A modern, cartoonish 3-panel horizontal comic strip (triptych) with EXACTLY three equal-width panels side-by-side, separated by TWO thin vertical gutters. Use clear panel borders. ABSOLUTELY NO extra panels, no inset panels, no overlapping panels, no background outside the three panels.

Setting: modern high school (hallway, classroom, cafeteria, lockers, etc.).
Main character: a nerdy teenage humanoid AI bot student (android teen vibe) who is cute and relatable.
Supporting characters: other teens or a teacher as needed.

Story beats (3 panels only):
- Panel 1 (beginning): a realistic high-school problem or awkward moment.
- Panel 2 (middle): transition + extra context, OR a suggestion/wisdom from another character.
- Panel 3 (end): twist/punchline.

Visual style: clean line art, bright flat colors, expressive faces.

Text rules (MANDATORY):
- The ONLY readable text in the image must be in speech/thought bubbles.
- You MUST include speech/thought bubbles with readable text.
- Bubble text MUST be clear, correctly spelled English.
- Make the bubble text LARGE, high-contrast, and easy to read.
- NO caption text at the bottom of the image (no under-image caption).`,
    textPrompt: `Create the dialogue for a 3-panel wide strip called "Circuit High".

Return ONLY valid JSON (no Markdown) in exactly this shape:
{
  "caption": null,
  "bubbles": string[]
}

Rules:
- This strip is ALWAYS bubble-only: caption MUST be null.
- bubbles MUST contain EXACTLY 3 strings:
  - bubbles[0] is the key line for Panel 1 (beginning/problem)
  - bubbles[1] is the key line for Panel 2 (middle/advice/context)
  - bubbles[2] is the key line for Panel 3 (end/twist/punchline)
- All bubble text MUST be clear, correctly spelled English.
- Keep each line short (ideally <= 12 words).
- Each line should be something a teen would actually say.
- Avoid unusual names, slang spellings, emojis, leetspeak, or stylized punctuation.
- Modern, funny, relatable, no profanity.`,
    captionPrompt: "(Unused) Circuit High is bubble-only; no caption.",
    title: "Circuit High",
    imageSize: "1792x1024" as const,
  },
];

type ComicText = {
  caption: string | null;
  bubbles: string[];
};

type ComicTextMode =
  | { mode: "either"; maxBubbles: number }
  | { mode: "caption-only" }
  | { mode: "bubble-only"; minBubbles: number; maxBubbles: number };

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
  mode: ComicTextMode = { mode: "either", maxBubbles: 4 },
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
      .filter((t: any) => typeof t === "string" && t.trim().length > 0)
      .map((t: any) => String(t).trim())
      .slice(
        0,
        mode.mode === "either"
          ? mode.maxBubbles
          : mode.mode === "bubble-only"
            ? mode.maxBubbles
            : 0,
      );

    const normalizedCaption = caption && caption.length > 0 ? caption : null;

    // Enforce the requested mode server-side.
    if (mode.mode === "caption-only") {
      if (normalizedCaption) return { caption: normalizedCaption, bubbles: [] };
      const fallback = (await generateCaption(captionPrompt)).trim();
      return { caption: fallback.length > 0 ? fallback : null, bubbles: [] };
    }

    if (mode.mode === "bubble-only") {
      const trimmed = bubbles.slice(0, mode.maxBubbles);
      if (trimmed.length >= mode.minBubbles)
        return { caption: null, bubbles: trimmed };
      // Force a bubble-only retry by falling back to captionPrompt as a last resort,
      // but keep caption null per requirements.
      return { caption: null, bubbles: trimmed };
    }

    // either
    if (normalizedCaption) return { caption: normalizedCaption, bubbles: [] };
    if (bubbles.length > 0) return { caption: null, bubbles };
    return { caption: null, bubbles: [] };
  } catch {
    // Fallback: keep the system working even if the model returns invalid JSON.
    const caption = (await generateCaption(captionPrompt)).trim();
    return { caption: caption.length > 0 ? caption : null, bubbles: [] };
  }
}

function buildImagePrompt(
  basePrompt: string,
  text: ComicText,
  comicType: ComicType,
): string {
  if (text.caption) {
    return `${basePrompt}\n\nIMPORTANT: Use caption-only. Do not include any speech bubbles or other readable text inside the image.`;
  }

  if (Array.isArray(text.bubbles) && text.bubbles.length > 0) {
    const lines = text.bubbles.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const placementHint =
      comicType === "teen_bot"
        ? "\n\nPlacement: line 1 must appear in panel 1, line 2 in panel 2, line 3 in panel 3."
        : "";
    return `${basePrompt}\n\nInclude speech/thought bubbles inside the image with EXACTLY the following text (clear, correctly spelled English, no gibberish):\n${lines}${placementHint}`;
  }

  // If no caption and no bubble lines are provided, allow a silent comic.
  return `${basePrompt}\n\nIf you include any text, it must be clear, correctly spelled English.`;
}

async function verifyThreePanelStrip(imageUrl: string): Promise<boolean> {
  try {
    const res = await withRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Check whether this image is a comic strip with EXACTLY three equal-width panels side-by-side (3 panels total), separated by two vertical gutters.

Return ONLY JSON:
{ "threePanels": boolean }
`,
                },
                { type: "image_url", image_url: { url: imageUrl } },
              ] as any,
            },
          ],
          max_tokens: 20,
        }),
      "verify-three-panels",
    );

    let content = (res.choices[0]?.message?.content ?? "").trim();
    content = content
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(content);
    return parsed?.threePanels === true;
  } catch {
    // If verification fails, don't block generation.
    return true;
  }
}

async function verifyCircuitHigh(imageUrl: string): Promise<boolean> {
  try {
    const res = await withRetry(
      () =>
        openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Validate this image for the comic "Circuit High".

Return ONLY JSON:
{
  "threePanels": boolean,
  "hasReadableEnglishBubbles": boolean
}

Definitions:
- threePanels: EXACTLY three equal-width panels side-by-side (two vertical gutters), no extra/inset panels.
- hasReadableEnglishBubbles: speech/thought bubbles are present and the text looks like correctly spelled English (not gibberish).
`,
                },
                { type: "image_url", image_url: { url: imageUrl } },
              ] as any,
            },
          ],
          max_tokens: 40,
        }),
      "verify-circuit-high",
    );

    let content = (res.choices[0]?.message?.content ?? "").trim();
    content = content
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const parsed = JSON.parse(content);
    return (
      parsed?.threePanels === true && parsed?.hasReadableEnglishBubbles === true
    );
  } catch {
    return true;
  }
}

async function generateImage(
  prompt: string,
  size: "1024x1024" | "1792x1024" | "1024x1792" = "1024x1024",
): Promise<string> {
  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  // Prefer base64 so we don't depend on remote URL hosting.
  // Fall back to DALL·E URL output if the account/model doesn't support base64.
  try {
    const res = await withRetry(
      () =>
        openai.images.generate({
          model: imageModel,
          prompt,
          size,
        }),
      `image(${imageModel})`,
    );
    const data = res.data ?? [];
    const b64 = data[0]?.b64_json;
    const url = data[0]?.url;
    if (typeof url === "string" && url.length > 0) return url;
    if (typeof b64 === "string" && b64.length > 0) {
      return `data:image/png;base64,${b64}`;
    }
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
          size,
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

function decodeDataUrlToBuffer(dataUrl: string): Buffer {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL");
  return Buffer.from(match[2], "base64");
}

async function imageToBuffer(imageUrlOrDataUrl: string): Promise<Buffer> {
  if (imageUrlOrDataUrl.startsWith("data:image/")) {
    return decodeDataUrlToBuffer(imageUrlOrDataUrl);
  }
  const res = await fetch(imageUrlOrDataUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function composeThreePanelStrip(panelImages: string[]): Promise<string> {
  if (panelImages.length !== 3) throw new Error("Expected 3 panel images");

  // Target a classic newspaper 3-panel strip ratio (~13.25" x 4.25" ≈ 3.12:1)
  // while keeping widths aligned with OpenAI's 1792-wide format.
  const width = 1792;
  const height = 576;
  const gutter = 14;
  const panelWidth = (width - 2 * gutter) / 3;
  if (!Number.isInteger(panelWidth)) throw new Error("Non-integer panel width");

  const panelBuffers = await Promise.all(
    panelImages.map(async (img) => {
      const buf = await imageToBuffer(img);
      return (
        sharp(buf)
          // Never crop panel content; letterbox/pad instead.
          .resize(panelWidth, height, {
            fit: "contain",
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .png()
          .toBuffer()
      );
    }),
  );

  const base = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#ffffff",
    },
  });

  const x1 = 0;
  const x2 = panelWidth + gutter;
  const x3 = 2 * (panelWidth + gutter);

  const svgOverlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${panelWidth}" height="${height}" fill="none" stroke="#000" stroke-width="3"/>
      <rect x="${x2}" y="0" width="${panelWidth}" height="${height}" fill="none" stroke="#000" stroke-width="3"/>
      <rect x="${x3}" y="0" width="${panelWidth}" height="${height}" fill="none" stroke="#000" stroke-width="3"/>
    </svg>`,
  );

  const out = await base
    .composite([
      { input: panelBuffers[0], left: x1, top: 0 },
      { input: panelBuffers[1], left: x2, top: 0 },
      { input: panelBuffers[2], left: x3, top: 0 },
      { input: svgOverlay, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  return `data:image/png;base64,${out.toString("base64")}`;
}

function buildCircuitHighPanelPrompt(
  panelIndex: 1 | 2 | 3,
  bubbleLine: string,
): string {
  const beat =
    panelIndex === 1
      ? "BEGINNING: a realistic high-school problem or awkward moment"
      : panelIndex === 2
        ? "MIDDLE: transition + extra context OR advice/wisdom from another character"
        : "END: twist/punchline";

  const titleRule =
    panelIndex === 1
      ? "Optional: You MAY include the title text 'Circuit High' ONCE in this panel only (small, top-left corner). If you include it, it must appear exactly once total in the entire 3-panel strip."
      : "Mandatory: Do NOT include the words 'Circuit High' anywhere in this panel (no title, no logo, no signage).";

  return `Single-panel cartoon comic panel for a 3-panel strip called "Circuit High".

This is PANEL ${panelIndex} of 3. Beat: ${beat}.

Framing:
- This is a single panel intended to fit a near-square newspaper panel.
- Keep important characters and the speech/thought bubble comfortably inside the panel (no edge-to-edge cropping).

Title rule:
${titleRule}

Style:
- Modern, cartoonish, clean line art, bright flat colors.
- Contemporary high school setting.

Characters:
- Main character: nerdy teenage humanoid AI bot (android teen vibe), cute and relatable.
- Panel 2 should include another teen/teacher giving advice.

Text (MANDATORY):
- Include exactly ONE speech/thought bubble with the EXACT text below, in clear correctly spelled English.
- Make the bubble text LARGE, high-contrast, and easy to read.
- Do not include any other readable text anywhere (no signs, posters, labels, UI text, or background words).

Bubble text (exact): ${bubbleLine}`;
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
        if (comic.type === "teen_bot") {
          const maxAttempts = 4;
          let finalText: ComicText | null = null;
          let image_url: string | null = null;

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const attemptText = await generateComicText(
              comic.textPrompt,
              comic.captionPrompt,
              { mode: "bubble-only", minBubbles: 3, maxBubbles: 3 },
            );

            if (attemptText.bubbles.length !== 3) {
              if (attempt === maxAttempts) {
                throw new Error("Circuit High did not produce 3 bubble lines");
              }
              continue;
            }

            const panel1 = await generateImage(
              buildCircuitHighPanelPrompt(1, attemptText.bubbles[0]),
              "1024x1024",
            );
            const panel2 = await generateImage(
              buildCircuitHighPanelPrompt(2, attemptText.bubbles[1]),
              "1024x1024",
            );
            const panel3 = await generateImage(
              buildCircuitHighPanelPrompt(3, attemptText.bubbles[2]),
              "1024x1024",
            );

            image_url = await composeThreePanelStrip([panel1, panel2, panel3]);
            finalText = { caption: null, bubbles: attemptText.bubbles };
            break;
          }

          if (!image_url)
            throw new Error("Failed to generate Circuit High image");
          if (!finalText)
            throw new Error("Failed to generate Circuit High text");

          await upsertComic({
            comic_type: comic.type,
            title: comic.title,
            caption: undefined,
            image_url,
            published_at: pubDate,
            test_data: false,
          });

          return { type: comic.type, status: "ok" };
        }

        const finalText = await generateComicText(
          comic.textPrompt,
          comic.captionPrompt,
        );
        let image_url = await generateImage(
          buildImagePrompt(comic.imagePrompt, finalText, comic.type),
          comic.imageSize,
        );

        if (!image_url) throw new Error("Failed to generate image");

        await upsertComic({
          comic_type: comic.type,
          title: comic.title,
          caption: finalText.caption ?? undefined,
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
