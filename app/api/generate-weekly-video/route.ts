import { NextResponse } from "next/server";
import OpenAI from "openai";
import { toFile } from "openai";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { getVideoEpisodeByWeekKey, upsertVideoEpisode } from "@/lib/videos";
import sharp from "sharp";
import { getVoiceGuidanceForPrompt } from "@/lib/videoVoices";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ScriptLine = { speaker: "Juan" | "Xero" | "Lyle"; text: string };

type SegmentScript = {
  segment_name: string;
  setting: string;
  visual_prompt: string;
  dialogue: ScriptLine[];
};

type EpisodeScript = {
  title: string;
  logline: string;
  segments: SegmentScript[];
};

// Episode structure knobs:
// Change this to generate more/fewer segments per episode.
const SEGMENT_COUNT = 10;
const SEGMENT_SECONDS: 4 | 8 | 12 = 12;

function getDesiredSegmentNames(segmentCount: number): string[] {
  if (segmentCount === 3) return ["beginning", "middle", "end"];
  return Array.from({ length: segmentCount }, (_, i) => `segment_${i + 1}`);
}

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

async function generateEpisodeScript(opts: {
  desiredSegmentNames: string[];
  segmentSeconds: number;
}): Promise<EpisodeScript> {
  const desiredSegmentNames = opts.desiredSegmentNames;
  const segmentSeconds = opts.segmentSeconds;
  const structureList = desiredSegmentNames
    .map((name, i) => `${i + 1}) ${name}`)
    .join("\n");
  const totalSeconds = desiredSegmentNames.length * segmentSeconds;

  const prompt = `Write a weekly 1-minute sitcom episode script with three characters:

- Juan: an AI robot (breadwinner), thoughtful, slightly earnest.
- Xero: an AI robot (breadwinner), sharper, dry, sarcastic.
- Lyle: out-of-work middle-aged roommate, sits in a rocking chair with a drink can; resistant to change but dependent on the bots.

Premise: Juan and Xero pay the bills; Lyle struggles with modern change, but there is warmth underneath.
Tone: blend broad + dry + sarcastic, with occasional heartwarming beat. Inspiration: Roseanne / Home Improvement vibes (no direct references).

Structure: ${desiredSegmentNames.length} segments, ${segmentSeconds} seconds each (${totalSeconds} seconds total):
${structureList}

Rules:
- The episode must be coherent across segments (continuity).
- Keep dialogue short and natural; 2–5 lines per segment.
- All dialogue must be clear English.
- The spoken text must NOT include character name prefixes (no "Juan:", "Xero:", "Lyle:"). The speaker is provided in the separate "speaker" field.
- Include a consistent living-room setting: Juan and Xero on a couch; Lyle in a rocking chair next to them holding a drink can.
- Off-screen dialogue is allowed (it can feel realistic), but if you do it, you MUST explicitly indicate it in "visual_prompt" (e.g., "(OFFSCREEN)" or "voice from kitchen") and ensure the camera framing matches.

Return ONLY valid JSON in exactly this shape:
{
  "title": string,
  "logline": string,
  "segments": [
    {
      "segment_name": string,
      "setting": string,
      "visual_prompt": string,
      "dialogue": [ {"speaker":"Juan"|"Xero"|"Lyle", "text": string} ]
    }
  ]
}

Constraints for this request:
- You MUST return exactly ${desiredSegmentNames.length} segments.
- Each segment_name MUST be one of: ${desiredSegmentNames.join(", ")}
- Each segment_name MUST appear exactly once.
`;

  const jsonSchema: any = {
    type: "object",
    additionalProperties: false,
    required: ["title", "logline", "segments"],
    properties: {
      title: { type: "string" },
      logline: { type: "string" },
      segments: {
        type: "array",
        minItems: desiredSegmentNames.length,
        maxItems: desiredSegmentNames.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["segment_name", "setting", "visual_prompt", "dialogue"],
          properties: {
            segment_name: {
              type: "string",
              enum: desiredSegmentNames,
            },
            setting: { type: "string" },
            visual_prompt: { type: "string" },
            dialogue: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["speaker", "text"],
                properties: {
                  speaker: {
                    type: "string",
                    enum: ["Juan", "Xero", "Lyle"],
                  },
                  text: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };

  const maxTokens = Math.min(3000, 700 + 140 * desiredSegmentNames.length);

  const res = await withRetry(
    () =>
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        // Enforce valid JSON output.
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "episode_script",
            strict: true,
            schema: jsonSchema,
          },
        } as any,
      }),
    "script",
  );

  const content = (res.choices[0]?.message?.content ?? "").trim();
  if (!content) throw new Error("Empty script response");
  const parsed = JSON.parse(content);

  if (!parsed?.segments || !Array.isArray(parsed.segments)) {
    throw new Error("Invalid script JSON: missing segments");
  }

  const segs = parsed.segments as any[];
  if (segs.length !== desiredSegmentNames.length) {
    throw new Error(
      `Invalid script JSON: expected ${desiredSegmentNames.length} segments, got ${segs.length}`,
    );
  }

  const gotNames = segs.map((s) => String(s?.segment_name ?? "").trim());
  const allowed = new Set(desiredSegmentNames);
  for (const n of gotNames) {
    if (!allowed.has(n)) {
      throw new Error(`Invalid script JSON: unexpected segment_name: ${n}`);
    }
  }
  const unique = new Set(gotNames);
  if (unique.size !== gotNames.length) {
    throw new Error("Invalid script JSON: duplicate segment_name values");
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

const VIDEO_SIZE_16_9 = "1280x720" as const;

// Toggleable prompt block: encourages shot variety without breaking continuity.
// Set env OPENAI_VIDEO_CAMERA_VARIETY=false to disable.
const USE_CAMERA_VARIETY_GUIDANCE =
  (process.env.OPENAI_VIDEO_CAMERA_VARIETY ?? "true").toLowerCase() !== "false";

const CAMERA_VARIETY_GUIDANCE = `Cinematography (direction, NOT spoken):
- You may change camera angle, shot size, and framing to match the moment.
- Allowed examples: wide establishing shot, medium two-shot on the couch, close-up reaction, over-the-shoulder, cutaways to hands/tablet/drink can.
- Allowed movement: subtle push-in, gentle pan/tilt, very light handheld feel (optional).
- Continuity constraints: stay in the same living room and keep character designs consistent. Do not teleport characters or change the room layout between cuts.`;

async function createVideoJob(opts: {
  model: "sora-2" | "sora-2-pro";
  prompt: string;
  seconds: 4 | 8 | 12;
  inputReferencePath?: string;
  inputReferenceBuffer?: Buffer;
  inputReferenceFileName?: string;
}): Promise<{ id: string; status: string; seconds: string; size: string }> {
  const {
    model,
    prompt,
    seconds,
    inputReferencePath,
    inputReferenceBuffer,
    inputReferenceFileName,
  } = opts;

  // Explicitly request 16:9 from the generator.
  const createArgs: any = { model, prompt, seconds, size: VIDEO_SIZE_16_9 };
  const refName =
    inputReferenceFileName ||
    (inputReferencePath ? path.basename(inputReferencePath) : "reference.png");
  if (inputReferenceBuffer) {
    createArgs.input_reference = await toFile(inputReferenceBuffer, refName, {
      type: "image/png",
    });
  } else if (inputReferencePath) {
    createArgs.input_reference = await toFile(
      fsSync.createReadStream(inputReferencePath),
      refName,
      { type: "image/png" },
    );
  }

  const video: any = await withRetry(
    () => (openai as any).videos.create(createArgs),
    "video.create",
  );

  return {
    id: String(video.id),
    status: String(video.status ?? "queued"),
    seconds: String(video.seconds ?? seconds),
    size: String(video.size ?? VIDEO_SIZE_16_9),
  };
}

async function buildReferenceImage(
  tmpRoot: string,
  scriptTitle: string,
): Promise<string> {
  const outPath = path.join(tmpRoot, "reference-1280x720.png");

  try {
    await fs.access(outPath);
    return outPath;
  } catch {
    // continue
  }

  const modelingRoot = path.join(process.cwd(), "lib", "video-modeling");
  const livingRoomPath = path.join(modelingRoot, "settings", "living room.png");
  const juanPath = path.join(modelingRoot, "characters", "juan.png");
  const xeroPath = path.join(modelingRoot, "characters", "xero.png");
  const lylePath = process.env.OPENAI_VIDEO_LYLE_IMAGE
    ? path.isAbsolute(process.env.OPENAI_VIDEO_LYLE_IMAGE)
      ? process.env.OPENAI_VIDEO_LYLE_IMAGE
      : path.join(process.cwd(), process.env.OPENAI_VIDEO_LYLE_IMAGE)
    : path.join(modelingRoot, "characters", "lyle.png");

  const fileExists = async (p: string) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  };

  const canUseModelingAssets =
    (await fileExists(livingRoomPath)) &&
    (await fileExists(juanPath)) &&
    (await fileExists(xeroPath));

  if (canUseModelingAssets) {
    const base = sharp(await fs.readFile(livingRoomPath))
      .resize(1280, 720, { fit: "cover" })
      .png();

    const loadAndResize = async (p: string, targetHeight: number) => {
      const input = await fs.readFile(p);
      const { data, info } = await sharp(input)
        .resize({ height: targetHeight, fit: "contain" })
        .png()
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    };

    const bottomMargin = 20;
    const gap = 40;
    const juan = await loadAndResize(juanPath, 560);
    const xero = await loadAndResize(xeroPath, 560);

    const totalCouchWidth = juan.width + gap + xero.width;
    const startX = Math.max(40, Math.round((1280 - totalCouchWidth) / 2));

    const comps: sharp.OverlayOptions[] = [
      {
        input: juan.data,
        left: startX,
        top: Math.max(0, 720 - bottomMargin - juan.height),
      },
      {
        input: xero.data,
        left: startX + juan.width + gap,
        top: Math.max(0, 720 - bottomMargin - xero.height),
      },
    ];

    if (await fileExists(lylePath)) {
      const lyle = await loadAndResize(lylePath, 580);
      comps.push({
        input: lyle.data,
        left: Math.max(0, 1280 - 80 - lyle.width),
        top: Math.max(0, 720 - bottomMargin - lyle.height),
      });
    }

    await base.composite(comps).toFile(outPath);
    return outPath;
  }

  const prompt = `Design a single frame from a 2D animated sitcom set in a living room.

Characters (robots + roommate):
- Juan: thoughtful AI robot, slightly earnest.
- Xero: dry, sarcastic AI robot.
- Lyle: out-of-work middle-aged roommate in a rocking chair holding a drink can.

Blocking:
- Juan and Xero sit together on a couch.
- Lyle sits in a rocking chair next to them.

Style:
- Clean 2D animation, sitcom vibe, warm living room lighting, consistent designs.
- No readable text.

This is a reference image for the episode titled: ${scriptTitle}`;

  const buf = await generateStillImageB64(prompt);

  await sharp(buf)
    .resize(1280, 720, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toFile(outPath);

  return outPath;
}

function getBoolEnv(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v == null) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultValue;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const h = await fs.open(lockPath, "wx");
    await h.close();
    return true;
  } catch {
    return false;
  }
}

async function finalizeEpisodeInBackground(opts: {
  origin: string;
  weekKey: string;
}): Promise<void> {
  const { origin, weekKey } = opts;
  const tmpRoot = path.join(process.cwd(), ".tmp", "weekly-video", weekKey);
  const lockPath = path.join(tmpRoot, "finalize.lock");
  const assembledPath = path.join(tmpRoot, "episode-with-title.mp4");

  if (await fileExists(assembledPath)) return;
  const locked = await tryAcquireLock(lockPath);
  if (!locked) return;

  const maxMinutes = 25;
  const pollMs = 15_000;
  const maxAttempts = Math.ceil((maxMinutes * 60_000) / pollMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const stRes = await fetch(
        `${origin}/api/video-episode-status?week_key=${encodeURIComponent(weekKey)}`,
        { cache: "no-store" },
      );
      const stJson: any = await stRes.json().catch(() => null);
      const overall = String(stJson?.overall_status ?? "unknown");

      if (overall === "completed") {
        // Assemble & cache combined episode; return JSON meta only (no MP4 download).
        const combineRes = await fetch(
          `${origin}/api/video-episode-content?week_key=${encodeURIComponent(weekKey)}&meta=1`,
          { cache: "no-store" },
        );
        if (combineRes.ok) {
          return;
        }

        // If combine failed, stop retrying here; status polling can be re-triggered later.
        const errJson: any = await combineRes.json().catch(() => null);
        const msg = errJson?.error ? String(errJson.error) : "combine failed";
        console.warn("[generate-weekly-video] auto-assemble failed", msg);
        return;
      }

      if (overall === "error") {
        return;
      }
    } catch (e) {
      console.warn("[generate-weekly-video] auto-finalize poll failed", e);
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function buildDialogueForPrompt(lines: ScriptLine[]): {
  speakerPlan: string;
  spokenLines: string;
} {
  const speakerPlan = lines
    .map((l, idx) => `Line ${idx + 1}: ${l.speaker}`)
    .join("\n");
  const spokenLines = lines
    .map((l) => String(l.text ?? "").trim())
    .filter(Boolean)
    .map((t, idx) => `Line ${idx + 1}: ${t}`)
    .join("\n");
  return { speakerPlan, spokenLines };
}

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY" },
        { status: 500 },
      );
    }

    const url = new URL(req.url);
    let force = url.searchParams.get("force") === "1";
    try {
      const body = await req.json().catch(() => null);
      if (body && typeof body === "object" && "force" in body) {
        force = Boolean((body as any).force);
      }
    } catch {
      // ignore invalid json
    }

    const weekKey = getWeekKey();

    // If we've already generated this week's episode, return it quickly unless forced.
    if (!force) {
      const existing = await getVideoEpisodeByWeekKey(weekKey);
      if (existing && existing.segments?.length > 0) {
        return NextResponse.json({
          week_key: existing.week_key,
          title: existing.title ?? "",
          logline: existing.logline ?? "",
          segments: existing.segments.map((s) => ({
            segment_index: s.segment_index,
            segment_name: s.segment_name,
            video_url: s.video_url,
            duration_seconds: s.duration_seconds,
          })),
        });
      }
    }

    const tmpRoot = path.join(process.cwd(), ".tmp", "weekly-video", weekKey);
    await fs.mkdir(tmpRoot, { recursive: true });

    const desiredSegmentNames = getDesiredSegmentNames(SEGMENT_COUNT);
    const script = await generateEpisodeScript({
      desiredSegmentNames,
      segmentSeconds: SEGMENT_SECONDS,
    });

    const useReference = getBoolEnv("OPENAI_VIDEO_USE_REFERENCE", true);
    const referenceImagePath = useReference
      ? await buildReferenceImage(tmpRoot, script.title)
      : null;
    const referenceImageBuffer = referenceImagePath
      ? await fs.readFile(referenceImagePath)
      : null;

    // Normalize segments
    const desiredOrder = desiredSegmentNames;

    const segmentByName = new Map<string, SegmentScript>();
    for (const seg of script.segments) segmentByName.set(seg.segment_name, seg);

    const segments: SegmentScript[] = desiredOrder.map((name) => {
      const seg = segmentByName.get(name);
      if (!seg) {
        throw new Error(`Script missing segment: ${name}`);
      }
      return seg;
    });

    const videoModel = (process.env.OPENAI_VIDEO_MODEL || "sora-2") as
      | "sora-2"
      | "sora-2-pro";

    const voiceGuidance = await getVoiceGuidanceForPrompt();

    const jobs = await Promise.all(
      segments.map(async (seg, i) => {
        const { speakerPlan, spokenLines } = buildDialogueForPrompt(
          seg.dialogue,
        );

        const videoPrompt = `2D animated sitcom scene in a living room, with synced audio.

${useReference ? "Characters and layout must match the provided reference image." : "Keep character designs and room layout consistent across the whole episode."}
- Juan and Xero (robots) sit on a couch.
- Lyle sits in a rocking chair next to them holding a drink can.

Shot requirements:
- Keep character designs and room layout consistent.
- Natural small motions (blinks, nods, hand gestures, subtle rocking chair motion).
- No readable text.
- Avoid logos and copyrighted characters.

${
  USE_CAMERA_VARIETY_GUIDANCE
    ? `${CAMERA_VARIETY_GUIDANCE}
`
    : ""
}

Audio/dialogue requirements:
- Speak the dialogue naturally.
- Do NOT read character names out loud (do not say Juan/Xero/Lyle).
- Use distinct voices: Juan and Xero sound robotic; Lyle sounds human.
- No music.
- CRITICAL LIP-SYNC RULE: Only the current line's designated speaker is allowed to visibly speak (mouth movement) during that line.
- If the designated speaker is OFFSCREEN for a line, then NO onscreen character may move their mouth to match that voice. They can react silently, but no ventriloquism.
- If a character is onscreen but not the designated speaker, their mouth must stay closed/neutral for that line.

${
  voiceGuidance
    ? `${voiceGuidance}
`
    : ""
}

Scene setting:
${seg.setting}

Visual action:
${seg.visual_prompt}

Speaker plan (NOT spoken):
${speakerPlan}

Spoken lines (exactly these, in order):
${spokenLines}`;

        const job = await createVideoJob({
          model: videoModel,
          prompt: videoPrompt,
          seconds: SEGMENT_SECONDS,
          inputReferenceBuffer: referenceImageBuffer ?? undefined,
          inputReferenceFileName: "reference-1280x720.png",
        });

        return {
          segment_index: i,
          segment_name: seg.segment_name,
          video_url: `/api/video-content/${job.id}`,
          attempt_count: 1,
          duration_seconds: SEGMENT_SECONDS,
          video_prompt: videoPrompt,
          last_error: null,
        };
      }),
    );

    const segmentResults = jobs.sort(
      (a, b) => a.segment_index - b.segment_index,
    );

    await upsertVideoEpisode({
      week_key: weekKey,
      title: script.title,
      logline: script.logline,
      script,
      segments: segmentResults,
    });

    // Best-effort: finalize in background (cache segments + assemble combined episode).
    // Note: This is reliable in a long-running Node server, but may not run to completion
    // in short-lived serverless runtimes.
    const autoAssemble = getBoolEnv("OPENAI_VIDEO_AUTO_ASSEMBLE", true);
    if (autoAssemble) {
      const origin = new URL(req.url).origin;
      void finalizeEpisodeInBackground({ origin, weekKey });
    }

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
