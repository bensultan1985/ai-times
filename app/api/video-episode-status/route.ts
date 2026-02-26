import { NextResponse } from "next/server";
import OpenAI from "openai";
import {
  getLatestVideoEpisode,
  getVideoEpisodeByWeekKey,
  type VideoSegment,
} from "@/lib/videos";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    return {
      segment_index: seg.segment_index,
      segment_name: seg.segment_name,
      video_url: seg.video_url,
      video_id: String(video?.id ?? videoId),
      status: String(video?.status ?? "unknown"),
      progress: video?.progress ?? null,
      seconds: video?.seconds ?? seg.duration_seconds ?? null,
      size: video?.size ?? null,
      error: video?.error ?? null,
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
  const allStatuses = segments.map((s) => s.status);
  const anyError =
    allStatuses.includes("error") || segments.some((s) => s.error);
  const allCompleted =
    allStatuses.length > 0 && allStatuses.every((s) => s === "completed");

  return NextResponse.json({
    week_key: episode.week_key,
    title: episode.title ?? "",
    logline: episode.logline ?? "",
    overall_status: allCompleted
      ? "completed"
      : anyError
        ? "error"
        : "rendering",
    segments,
  });
}
