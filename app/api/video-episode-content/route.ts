import { NextResponse } from "next/server";
import OpenAI from "openai";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { getLatestVideoEpisode, getVideoEpisodeByWeekKey } from "@/lib/videos";
import {
  ensureWeeklyVideoSegmentCached,
  getWeeklyVideoSegmentCachedPathIfFresh,
} from "@/lib/videoCache";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ASSEMBLE_LOCK_TTL_MS = 45 * 60_000;

async function tryAcquireAssembleLock(lockPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(lockPath).catch(() => null);
    if (st && Date.now() - st.mtimeMs > ASSEMBLE_LOCK_TTL_MS) {
      await fs.rm(lockPath, { force: true }).catch(() => null);
    }

    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const h = await fs.open(lockPath, "wx");
    await h.close();
    return true;
  } catch {
    return false;
  }
}

async function releaseAssembleLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true }).catch(() => null);
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
  const parts = raw.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  return last.split("?")[0] ?? null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function runFfmpeg(args: string[], cwd?: string): Promise<void> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide a binary path");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(String(ffmpegPath), args, {
      stdio: ["ignore", "ignore", "pipe"],
      cwd,
    });

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (code ${code}): ${stderr}`));
    });
  });
}

async function probeHasAudio(inputPath: string): Promise<boolean> {
  if (!ffmpegPath) return true;

  return await new Promise<boolean>((resolve) => {
    const child = spawn(String(ffmpegPath), ["-hide_banner", "-i", inputPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });

    child.on("close", () => {
      // ffmpeg prints streams like: "Stream #0:1: Audio: aac ..."
      // The previous regex used a word-boundary after ':' which never matches.
      resolve(/Audio:/.test(stderr));
    });

    child.on("error", () => resolve(true));
  });
}

async function normalizeTo16x9(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const hasAudio = await probeHasAudio(inputPath);

  const vf =
    "scale=1280:720:force_original_aspect_ratio=decrease," +
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black," +
    "setsar=1";

  if (hasAudio) {
    await runFfmpeg(
      [
        "-y",
        "-i",
        inputPath,
        "-vf",
        vf,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      path.dirname(outputPath),
    );
    return;
  }

  // Add silent audio so concat always has an audio track.
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-shortest",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      vf,
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    path.dirname(outputPath),
  );
}

export async function GET(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "Missing OPENAI_API_KEY" },
        { status: 500 },
      );
    }

    const url = new URL(req.url);
    const weekKeyParam = url.searchParams.get("week_key")?.trim() || null;
    const metaOnly =
      url.searchParams.get("meta") === "1" ||
      url.searchParams.get("meta") === "true";
    const force =
      url.searchParams.get("force") === "1" ||
      url.searchParams.get("force") === "true";

    const episode = weekKeyParam
      ? await getVideoEpisodeByWeekKey(weekKeyParam)
      : await getLatestVideoEpisode();

    if (!episode) {
      return NextResponse.json(
        {
          error: "No video episode found",
          week_key: weekKeyParam ?? getWeekKey(),
        },
        { status: 404 },
      );
    }

    const weekKey = episode.week_key;
    const tmpRoot = path.join(process.cwd(), ".tmp", "weekly-video", weekKey);
    const outPath = path.join(tmpRoot, "episode-with-title.mp4");
    const lockPath = path.join(tmpRoot, "assemble.lock");

    if (force) {
      try {
        await fs.unlink(outPath);
      } catch {
        // ignore
      }
      try {
        await fs.rm(path.join(tmpRoot, "normalized"), {
          recursive: true,
          force: true,
        });
      } catch {
        // ignore
      }
      try {
        await fs.rm(path.join(tmpRoot, "concat-list.txt"), { force: true });
      } catch {
        // ignore
      }
    }

    // If already assembled, serve it.
    if (await fileExists(outPath)) {
      if (metaOnly) {
        const st = await fs.stat(outPath);
        return NextResponse.json({
          week_key: weekKey,
          status: "completed",
          url: `/api/video-episode-content?week_key=${encodeURIComponent(weekKey)}`,
          bytes: st.size,
        });
      }

      const buf = await fs.readFile(outPath);
      return new NextResponse(buf, {
        headers: {
          "Content-Type": "video/mp4",
          "Cache-Control": "no-store",
        },
      });
    }

    await fs.mkdir(tmpRoot, { recursive: true });
    const locked = await tryAcquireAssembleLock(lockPath);
    if (!locked) {
      // Another request is assembling right now.
      // Return 202 so callers can poll until the output exists.
      return NextResponse.json(
        {
          week_key: weekKey,
          status: "assembling",
        },
        { status: 202 },
      );
    }

    try {
      // Prefer assembling from cached segment MP4s (no OpenAI calls required).
      const orderedSegments = [...episode.segments].sort(
        (a, b) => a.segment_index - b.segment_index,
      );

      const segmentVideoIds = orderedSegments.map((s) => {
        const id = parseVideoIdFromUrl(s.video_url);
        return {
          segment_name: s.segment_name,
          segment_index: s.segment_index,
          id,
        };
      });

      if (segmentVideoIds.some((s) => !s.id)) {
        return NextResponse.json(
          {
            week_key: weekKey,
            status: "error",
            error:
              "One or more segments has an unrecognized video_url; cannot assemble episode",
          },
          { status: 500 },
        );
      }

      const cachedPaths = await Promise.all(
        segmentVideoIds.map((s) =>
          getWeeklyVideoSegmentCachedPathIfFresh({
            weekKey,
            segmentIndex: s.segment_index,
            videoId: String(s.id),
          }),
        ),
      );

      const haveAllCached = cachedPaths.every(Boolean);

      const statuses = haveAllCached
        ? segmentVideoIds.map((s) => ({
            ...s,
            status: "completed",
            progress: 1,
            error: null,
          }))
        : await Promise.all(
            segmentVideoIds.map(async (s) => {
              const video: any = await (openai as any).videos.retrieve(s.id);
              return {
                ...s,
                status: String(video?.status ?? "unknown"),
                progress: video?.progress ?? null,
                error: video?.error ?? null,
              };
            }),
          );

      const incomplete = statuses.filter((s) => s.status !== "completed");
      if (incomplete.length > 0) {
        return NextResponse.json(
          {
            week_key: weekKey,
            status: "rendering",
            segments: statuses,
          },
          { status: 202 },
        );
      }

      const segmentsDir = path.join(tmpRoot, "segments");
      await fs.mkdir(segmentsDir, { recursive: true });

      const titleSequencePath = process.env.OPENAI_VIDEO_TITLE_SEQUENCE
        ? path.isAbsolute(process.env.OPENAI_VIDEO_TITLE_SEQUENCE)
          ? process.env.OPENAI_VIDEO_TITLE_SEQUENCE
          : path.join(process.cwd(), process.env.OPENAI_VIDEO_TITLE_SEQUENCE)
        : path.join(
            process.cwd(),
            "lib",
            "video-modeling",
            "title-sequence",
            "juan and xero title sequence.mp4",
          );

      // Download each segment mp4 once.
      const clipPaths: string[] = [];

      if (await fileExists(titleSequencePath)) {
        clipPaths.push(titleSequencePath);
      }

      for (const s of statuses.sort(
        (a, b) => a.segment_index - b.segment_index,
      )) {
        const cached = await getWeeklyVideoSegmentCachedPathIfFresh({
          weekKey,
          segmentIndex: s.segment_index,
          videoId: String(s.id),
        });
        const segmentPath =
          cached ??
          (await ensureWeeklyVideoSegmentCached({
            weekKey,
            segmentIndex: s.segment_index,
            videoId: String(s.id),
            download: async () => {
              const content: any = await (openai as any).videos.downloadContent(
                s.id,
              );
              const ab = await content.arrayBuffer();
              return Buffer.from(ab);
            },
          }));

        clipPaths.push(segmentPath);
      }

      // Normalize all clips to 16:9 1280x720 so concat is reliable.
      const normalizedDir = path.join(tmpRoot, "normalized");
      await fs.mkdir(normalizedDir, { recursive: true });
      const normalizedPaths: string[] = [];
      for (let i = 0; i < clipPaths.length; i += 1) {
        const inPath = clipPaths[i]!;
        const normPath = path.join(
          normalizedDir,
          `${String(i).padStart(2, "0")}.mp4`,
        );
        normalizedPaths.push(normPath);

        if (!(await fileExists(normPath))) {
          const tmpNorm = path.join(
            normalizedDir,
            `${String(i).padStart(2, "0")}.tmp-${process.pid}-${Date.now()}.mp4`,
          );
          await normalizeTo16x9(inPath, tmpNorm);
          await fs.rename(tmpNorm, normPath);
        }
      }

      // Build concat list file.
      const listPath = path.join(tmpRoot, "concat-list.txt");
      const list = normalizedPaths
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n");
      await fs.writeFile(listPath, list, "utf8");

      // Assemble into one mp4. Re-encode for maximum reliability.
      const tmpOutPath = path.join(
        tmpRoot,
        `episode-with-title.tmp-${process.pid}-${Date.now()}.mp4`,
      );
      await runFfmpeg(
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ac",
          "2",
          "-ar",
          "48000",
          "-movflags",
          "+faststart",
          tmpOutPath,
        ],
        tmpRoot,
      );

      await fs.rename(tmpOutPath, outPath);

      if (metaOnly) {
        const st = await fs.stat(outPath);
        return NextResponse.json({
          week_key: weekKey,
          status: "completed",
          url: `/api/video-episode-content?week_key=${encodeURIComponent(weekKey)}`,
          bytes: st.size,
        });
      }

      const outBuf = await fs.readFile(outPath);
      return new NextResponse(outBuf, {
        headers: {
          "Content-Type": "video/mp4",
          "Cache-Control": "no-store",
        },
      });
    } finally {
      await releaseAssembleLock(lockPath);
    }
  } catch (err: any) {
    console.error("[video-episode-content] failed", err);
    const message = err?.message ? String(err.message) : String(err);
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
