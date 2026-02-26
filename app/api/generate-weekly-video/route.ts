import { NextResponse } from "next/server";
import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { upsertVideoEpisode } from "@/lib/videos";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ScriptLine = { speaker: "Juan" | "Xero" | "Lyle"; text: string };

type SegmentScript = {
  segment_name: "beginning" | "middle" | "end";
  setting: string;
  visual_prompt: string;
  dialogue: ScriptLine[];
};

type EpisodeScript = {
  title: string;
  logline: string;
  segments: SegmentScript[];
};

function getWeekKey(date = new Date()): string {
  // ISO week: week starts Monday.
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((+d - +yearStart) / 86400000 + 1) / 7);
  const year = d.getUTCFullYear();
  return `${year}-W${String(weekNo).padStart(2, "0")}`;
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
        console.error(`[generate-weekly-video] ${label} failed`, err);
        throw err;
      }

      const delayMs = baseDelayMs * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("Retry loop exhausted");
}

async function generateEpisodeScript(): Promise<EpisodeScript> {
  const prompt = `Write a weekly 1-minute sitcom episode script with three characters:

- Juan: an AI robot (breadwinner), thoughtful, slightly earnest.
- Xero: an AI robot (breadwinner), sharper, dry, sarcastic.
- Lyle: out-of-work middle-aged roommate, sits in a rocking chair with a drink can; resistant to change but dependent on the bots.

Premise: Juan and Xero pay the bills; Lyle struggles with modern change, but there is warmth underneath.
Tone: blend broad + dry + sarcastic, with occasional heartwarming beat. Inspiration: Roseanne / Home Improvement vibes (no direct references).

Structure: 3 segments, 12 seconds each (36 seconds total):
1) beginning
2) middle
3) end

Rules:
- The episode must be coherent across segments (continuity).
- Keep dialogue short and natural; 2–5 lines per segment.
- All dialogue must be clear English.
- The spoken text must NOT include character name prefixes (no "Juan:", "Xero:", "Lyle:"). The speaker is provided in the separate "speaker" field.
- Include a consistent living-room setting: Juan and Xero on a couch; Lyle in a rocking chair next to them holding a drink can.

Return ONLY valid JSON in exactly this shape:
{
  "title": string,
  "logline": string,
  "segments": [
    {
      "segment_name": "beginning"|"middle"|"end",
      "setting": string,
      "visual_prompt": string,
      "dialogue": [ {"speaker":"Juan"|"Xero"|"Lyle", "text": string} ]
    }
  ]
}`;

  const res = await withRetry(
    () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 900,
      }),
    "script",
  );

  let content = (res.choices[0]?.message?.content ?? "").trim();
  content = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const parsed = JSON.parse(content);

  if (!parsed?.segments || !Array.isArray(parsed.segments)) {
    throw new Error("Invalid script JSON: missing segments");
  }

  return parsed as EpisodeScript;
}

async function generateStillImageB64(prompt: string): Promise<Buffer> {
  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const res = await withRetry(
    () =>
      openai.images.generate({
        model: imageModel,
        prompt,
        size: "1024x1024",
      }),
    `image(${imageModel})`,
  );

  const data = res.data ?? [];
  const b64 = data[0]?.b64_json;
  const url = data[0]?.url;

  if (typeof b64 === "string" && b64.length > 0) {
    return Buffer.from(b64, "base64");
  }

  if (typeof url === "string" && url.length > 0) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  throw new Error("No image returned");
}

async function generateAnimatedFrames(opts: {
  tmpDir: string;
  basePrompt: string;
  frames: number;
}): Promise<{ firstFramePath: string; patternPath: string }> {
  const { tmpDir, basePrompt, frames } = opts;
  const frameDir = path.join(tmpDir, "frames");
  await fs.mkdir(frameDir, { recursive: true });

  for (let idx = 1; idx <= frames; idx += 1) {
    const framePrompt = `${basePrompt}

ANIMATION INSTRUCTIONS:
- This is frame ${idx} of ${frames} in a short 2D animated shot.
- Keep the same characters, camera, outfits, and living room layout consistent across frames.
- Only small, natural motion between frames (head turn, blink, hand gesture, slight posture shift, rocking chair subtly rocking).
- No readable text.
`;

    const imageBuf = await generateStillImageB64(framePrompt);
    const framePath = path.join(
      frameDir,
      `frame-${String(idx).padStart(3, "0")}.png`,
    );
    await fs.writeFile(framePath, imageBuf);
  }

  const firstFramePath = path.join(frameDir, "frame-001.png");
  const patternPath = path.join(frameDir, "frame-%03d.png");
  return { firstFramePath, patternPath };
}

async function generateTtsMp3(text: string, voice: string): Promise<Buffer> {
  const primaryModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const fallbackModel = "tts-1";

  const tryModel = async (model: string) => {
    const resp: any = await withRetry(
      () =>
        openai.audio.speech.create({
          model,
          voice,
          input: text,
          format: "mp3",
        } as any),
      `tts(${model})`,
    );

    // openai sdk returns a Response-like object
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  };

  try {
    return await tryModel(primaryModel);
  } catch {
    return await tryModel(fallbackModel);
  }
}

async function runFfmpeg(args: string[], cwd: string): Promise<void> {
  if (!ffmpegPath)
    throw new Error("ffmpeg binary not available (ffmpeg-static)");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath as string, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`),
      );
    });
  });
}

function voiceForSpeaker(speaker: ScriptLine["speaker"]): string {
  // Voices are best-effort; can be overridden by env.
  const juan = process.env.OPENAI_VOICE_JUAN || "nova";
  const xero = process.env.OPENAI_VOICE_XERO || "alloy";
  const lyle = process.env.OPENAI_VOICE_LYLE || "onyx";

  if (speaker === "Juan") return juan;
  if (speaker === "Xero") return xero;
  return lyle;
}

function sanitizeSpokenText(text: string): string {
  let t = String(text ?? "").trim();

  // Remove common script-y prefixes the model might accidentally include.
  // Examples: "Juan: ...", "Xero - ...", "LYLE: ..."
  t = t.replace(/^(juan|xero|lyle)\s*[:\-–—]\s*/i, "");

  // Defensive: if it starts with any name-like ALLCAPS prefix, drop it.
  t = t.replace(/^[A-Z]{2,12}\s*[:\-–—]\s*/, "");

  // Collapse excessive whitespace.
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

async function buildSegmentAudio(
  tmpDir: string,
  dialogue: ScriptLine[],
): Promise<string> {
  const lineFiles: string[] = [];
  let i = 0;
  for (const line of dialogue) {
    i += 1;
    const voice = voiceForSpeaker(line.speaker);
    const spoken = sanitizeSpokenText(line.text);
    const mp3 = await generateTtsMp3(spoken, voice);
    const file = path.join(tmpDir, `line-${i}.mp3`);
    await fs.writeFile(file, mp3);
    lineFiles.push(file);
  }

  // Concat (re-encode for stability).
  const listPath = path.join(tmpDir, "concat.txt");
  const list = lineFiles
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, list);

  const combinedMp3 = path.join(tmpDir, "combined.mp3");
  await runFfmpeg(
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:a",
      "libmp3lame",
      "-q:a",
      "4",
      combinedMp3,
    ],
    tmpDir,
  );

  // Pad + trim to exactly 12s and output as AAC.
  const outM4a = path.join(tmpDir, "audio.m4a");
  await runFfmpeg(
    [
      "-y",
      "-i",
      combinedMp3,
      "-filter:a",
      "apad=pad_dur=12,atrim=0:12",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outM4a,
    ],
    tmpDir,
  );

  return outM4a;
}

async function buildSegmentVideoFromFrames(
  tmpDir: string,
  framesPattern: string,
  framesCount: number,
  audioPath: string,
  outPath: string,
): Promise<void> {
  // Render to 1280x720 with padding (never crop) and exactly 12s.
  // Use a rational framerate so the sequence duration is exactly 12s.
  const inputFps = `${framesCount}/12`;
  await runFfmpeg(
    [
      "-y",
      "-framerate",
      inputFps,
      "-i",
      framesPattern,
      "-i",
      audioPath,
      "-t",
      "12",
      "-vf",
      "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,minterpolate=fps=30:mi_mode=mci",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      outPath,
    ],
    tmpDir,
  );
}

export async function POST() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY" },
        { status: 500 },
      );
    }

    const weekKey = getWeekKey();
    const tmpRoot = path.join(process.cwd(), ".tmp", "weekly-video", weekKey);
    const outDir = path.join(process.cwd(), "public", "videos", weekKey);
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });

    const script = await generateEpisodeScript();

    // Normalize segments
    const desiredOrder: SegmentScript["segment_name"][] = [
      "beginning",
      "middle",
      "end",
    ];

    const segmentByName = new Map<string, SegmentScript>();
    for (const seg of script.segments) segmentByName.set(seg.segment_name, seg);

    const segments: SegmentScript[] = desiredOrder.map((name) => {
      const seg = segmentByName.get(name);
      if (!seg) {
        throw new Error(`Script missing segment: ${name}`);
      }
      return seg;
    });

    const segmentResults: Array<{
      segment_index: number;
      segment_name: string;
      video_url: string;
      duration_seconds: number;
    }> = [];

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const segTmp = path.join(tmpRoot, `${i}-${seg.segment_name}`);
      await fs.mkdir(segTmp, { recursive: true });

      const framesCount = Number(process.env.VIDEO_ANIM_FRAMES || "10");
      const basePrompt = `${seg.visual_prompt}\n\nScene setup must include: Juan and Xero robots sitting on a couch; Lyle in a rocking chair next to them holding a drink can. Living room. 2D animated cartoon style. No readable text.`;

      const { patternPath } = await generateAnimatedFrames({
        tmpDir: segTmp,
        basePrompt,
        frames: framesCount,
      });

      const audioPath = await buildSegmentAudio(segTmp, seg.dialogue);

      const fileName = `${String(i + 1).padStart(2, "0")}-${seg.segment_name}.mp4`;
      const outPath = path.join(outDir, fileName);
      await buildSegmentVideoFromFrames(
        segTmp,
        patternPath,
        framesCount,
        audioPath,
        outPath,
      );

      segmentResults.push({
        segment_index: i,
        segment_name: seg.segment_name,
        video_url: `/videos/${weekKey}/${fileName}`,
        duration_seconds: 12,
      });
    }

    await upsertVideoEpisode({
      week_key: weekKey,
      title: script.title,
      logline: script.logline,
      script,
      segments: segmentResults,
    });

    return NextResponse.json({
      week_key: weekKey,
      title: script.title,
      logline: script.logline,
      segments: segmentResults,
    });
  } catch (err: any) {
    console.error("[generate-weekly-video] failed", err);
    const message = err?.message ? String(err.message) : String(err);
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
