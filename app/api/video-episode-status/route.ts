import { NextResponse } from "next/server";
import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs/promises";
import { toFile } from "openai";
import sharp from "sharp";
import {
  getLatestVideoEpisode,
  getVideoEpisodeByWeekKey,
  type VideoSegment,
  recordSegmentRetry,
} from "@/lib/videos";
import { ensureWeeklyVideoSegmentCached } from "@/lib/videoCache";
import { getVoiceGuidanceForPrompt } from "@/lib/videoVoices";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VIDEO_SIZE_16_9 = "1280x720" as const;
const additional = `- Continuity constraints: stay in the same living room and keep character designs consistent. Do not teleport characters or change the room layout between cuts.`;

// Toggleable prompt block: encourages shot variety without breaking continuity.
// Set env OPENAI_VIDEO_CAMERA_VARIETY=false to disable.
const USE_CAMERA_VARIETY_GUIDANCE =
  (process.env.OPENAI_VIDEO_CAMERA_VARIETY ?? "true").toLowerCase() !== "false";

console.log(USE_CAMERA_VARIETY_GUIDANCE);
const CAMERA_VARIETY_GUIDANCE = `Cinematography (direction, NOT spoken):
- You may change camera angle, shot size, and framing to match the moment.
- Allowed examples: wide establishing shot, medium two-shot on the couch, close-up reaction, over-the-shoulder, cutaways to hands/tablet/drink can.
- Allowed movement: subtle push-in, gentle pan/tilt, very light handheld feel (optional).`;

function buildDialogueForPrompt(
  lines: Array<{ speaker: string; text: string }>,
): {
  speakerPlan: string;
  spokenLines: string;
} {
  const speakerPlan = lines
    .map((l, idx) => `Line ${idx + 1}: ${String(l.speaker ?? "").trim()}`)
    .join("\n");
  const spokenLines = lines
    .map((l) => String(l.text ?? "").trim())
    .filter(Boolean)
    .map((t, idx) => `Line ${idx + 1}: ${t}`)
    .join("\n");
  return { speakerPlan, spokenLines };
}

function buildVideoPromptFromEpisodeScript(opts: {
  episodeScript: any;
  segmentName: string;
  useReference: boolean;
  voiceGuidance?: string;
}): string | null {
  const episodeScript = opts.episodeScript;
  const segments: any[] = Array.isArray(episodeScript?.segments)
    ? episodeScript.segments
    : [];
  const seg = segments.find((s) => s?.segment_name === opts.segmentName);
  if (!seg) return null;

  const setting = String(seg?.setting ?? "").trim();
  const visualPrompt = String(seg?.visual_prompt ?? "").trim();
  const dialogue = Array.isArray(seg?.dialogue) ? seg.dialogue : [];
  const { speakerPlan, spokenLines } = buildDialogueForPrompt(dialogue);

  return `2D animated sitcom scene in a living room, with synced audio.

${opts.useReference ? "Characters and layout must match the provided reference image." : "Keep character designs and room layout consistent across the whole episode."}
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
  opts.voiceGuidance
    ? `${opts.voiceGuidance}
`
    : ""
}

Scene setting:
${setting}

Visual action:
${visualPrompt}

Speaker plan (NOT spoken):
${speakerPlan}

Spoken lines (exactly these, in order):
${spokenLines}`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function buildReferenceImageForWeek(
  weekKey: string,
): Promise<Buffer | null> {
  const useReference =
    (process.env.OPENAI_VIDEO_USE_REFERENCE ?? "true").toLowerCase() !==
    "false";
  if (!useReference) return null;

  const tmpRoot = path.join(process.cwd(), ".tmp", "weekly-video", weekKey);
  await fs.mkdir(tmpRoot, { recursive: true });
  const outPath = path.join(tmpRoot, "reference-1280x720.png");

  if (!(await fileExists(outPath))) {
    const modelingRoot = path.join(process.cwd(), "lib", "video-modeling");
    const livingRoomPath = path.join(
      modelingRoot,
      "settings",
      "living room.png",
    );
    const juanPath = path.join(modelingRoot, "characters", "juan.png");
    const xeroPath = path.join(modelingRoot, "characters", "xero.png");
    const lylePath = path.join(modelingRoot, "characters", "lyle.png");

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
    } else {
      // If modeling assets aren't present, skip reference rather than generating here.
      return null;
    }
  }

  return await fs.readFile(outPath);
}

async function createVideoJobFromPrompt(opts: {
  prompt: string;
  referencePng?: Buffer | null;
}): Promise<{ id: string; status: string }> {
  const model = (process.env.OPENAI_VIDEO_MODEL || "sora-2") as
    | "sora-2"
    | "sora-2-pro";

  const createArgs: any = {
    model,
    prompt: opts.prompt,
    seconds: 12,
    // Explicitly request 16:9 from the generator.
    size: VIDEO_SIZE_16_9,
  };

  if (opts.referencePng) {
    createArgs.input_reference = await toFile(
      opts.referencePng,
      "reference-1280x720.png",
      { type: "image/png" },
    );
  }

  const video: any = await (openai as any).videos.create(createArgs);
  return { id: String(video.id), status: String(video.status ?? "queued") };
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

function parseVideoIdFromUrl(videoUrl: string): string | null {
  const raw = String(videoUrl ?? "").trim();
  if (!raw) return null;

  // Most commonly: /api/video-content/<id>
  const parts = raw.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;

  // Remove any query string fragment if present.
  return last.split("?")[0] ?? null;
}

async function getSegmentStatus(seg: VideoSegment) {
  const videoId = parseVideoIdFromUrl(seg.video_url);
  if (!videoId) {
    return {
      segment_index: seg.segment_index,
      segment_name: seg.segment_name,
      video_url: seg.video_url,
      video_id: null,
      status: "unknown",
      progress: null,
      seconds: seg.duration_seconds ?? null,
      size: null,
      error: "Could not parse video id from video_url",
    };
  }

  try {
    const video: any = await (openai as any).videos.retrieve(videoId);
    const status = String(video?.status ?? "unknown");
    const error = video?.error ?? null;

    return {
      segment_index: seg.segment_index,
      segment_name: seg.segment_name,
      video_url: seg.video_url,
      video_id: String(video?.id ?? videoId),
      status,
      progress: video?.progress ?? null,
      seconds: video?.seconds ?? seg.duration_seconds ?? null,
      size: video?.size ?? null,
      error,
    };
  } catch (err: any) {
    return {
      segment_index: seg.segment_index,
      segment_name: seg.segment_name,
      video_url: seg.video_url,
      video_id: videoId,
      status: "error",
      progress: null,
      seconds: seg.duration_seconds ?? null,
      size: null,
      error: err?.message ? String(err.message) : String(err),
    };
  }
}

export async function GET(req: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY" },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const weekKey = url.searchParams.get("week_key")?.trim() || null;

  const episode = weekKey
    ? await getVideoEpisodeByWeekKey(weekKey)
    : await getLatestVideoEpisode();

  if (!episode) {
    return NextResponse.json(
      {
        error: "No video episode found",
        week_key: weekKey ?? getWeekKey(),
      },
      { status: 404 },
    );
  }

  const segments = await Promise.all(episode.segments.map(getSegmentStatus));

  // Second-chance retry pass: if any segment is moderation_blocked + attempt_count < 2,
  // create a replacement job and update DB, then report it as queued.
  const referencePng = await buildReferenceImageForWeek(episode.week_key);
  const useReference =
    (process.env.OPENAI_VIDEO_USE_REFERENCE ?? "true").toLowerCase() !==
    "false";
  const voiceGuidance = await getVoiceGuidanceForPrompt();
  for (let i = 0; i < episode.segments.length; i += 1) {
    const seg = episode.segments[i]!;
    const st = segments[i]!;
    const status = String((st as any).status ?? "unknown");
    const err = (st as any).error;

    if (
      status === "failed" &&
      err?.code === "moderation_blocked" &&
      (seg.attempt_count ?? 1) < 2
    ) {
      const episodeScript = episode.script as any;
      const prompt =
        seg.video_prompt ??
        buildVideoPromptFromEpisodeScript({
          episodeScript,
          segmentName: seg.segment_name,
          useReference,
          voiceGuidance,
        });

      if (!prompt) continue;

      try {
        const job = await createVideoJobFromPrompt({
          prompt,
          referencePng,
        });
        const newUrl = `/api/video-content/${job.id}`;

        const updated = await recordSegmentRetry({
          segment_id: seg.id,
          new_video_url: newUrl,
          last_error: err,
          video_prompt: prompt,
        });

        // Only if we won the atomic update (prevents double-retry from concurrent polls).
        if (updated) {
          segments[i] = {
            ...(segments[i] as any),
            video_url: newUrl,
            video_id: job.id,
            status: job.status,
            progress: 0,
            error: null,
          } as any;
        }
      } catch (e: any) {
        segments[i] = {
          ...(segments[i] as any),
          status: "error",
          error: e?.message ? String(e.message) : String(e),
        } as any;
      }
    }
  }

  // Cache completed segment MP4s immediately (prevents 1-hour download expiry from breaking combine).
  await Promise.all(
    segments.map(async (st, idx) => {
      try {
        if (String((st as any).status ?? "").toLowerCase() !== "completed")
          return;
        const videoId = String((st as any).video_id ?? "").trim();
        if (!videoId) return;

        const seg = episode.segments[idx]!;
        await ensureWeeklyVideoSegmentCached({
          weekKey: episode.week_key,
          segmentIndex: seg.segment_index,
          videoId,
          download: async () => {
            const content: any = await (openai as any).videos.downloadContent(
              videoId,
            );
            const ab = await content.arrayBuffer();
            return Buffer.from(ab);
          },
        });
      } catch (e) {
        // Best-effort; don't fail the whole status request due to caching.
        console.warn("[video-episode-status] segment cache failed", e);
      }
    }),
  );
  const allStatuses = segments.map((s) => s.status);
  const anyError =
    allStatuses.includes("error") || segments.some((s) => s.error);
  const allCompleted =
    allStatuses.length > 0 && allStatuses.every((s) => s === "completed");

  const tmpRoot = path.join(
    process.cwd(),
    ".tmp",
    "weekly-video",
    episode.week_key,
  );
  const combinedPath = path.join(tmpRoot, "episode-with-title.mp4");
  let combinedAvailable = false;
  try {
    await fs.access(combinedPath);
    combinedAvailable = true;
  } catch {
    combinedAvailable = false;
  }

  return NextResponse.json({
    week_key: episode.week_key,
    title: episode.title ?? "",
    logline: episode.logline ?? "",
    overall_status: allCompleted
      ? "completed"
      : anyError
        ? "error"
        : "rendering",
    combined: {
      available: combinedAvailable,
      // Provide the URL as soon as segments are completed.
      url: allCompleted
        ? `/api/video-episode-content?week_key=${encodeURIComponent(episode.week_key)}`
        : null,
    },
    segments,
  });
}
