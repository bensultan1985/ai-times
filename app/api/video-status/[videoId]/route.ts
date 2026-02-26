import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ videoId: string }> },
) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY" },
      { status: 500 },
    );
  }

  const { videoId } = await params;
  if (!videoId) {
    return NextResponse.json({ error: "Missing videoId" }, { status: 400 });
  }

  const video: any = await (openai as any).videos.retrieve(videoId);

  return NextResponse.json({
    id: String(video?.id ?? videoId),
    status: String(video?.status ?? "unknown"),
    progress: video?.progress ?? null,
    seconds: video?.seconds ?? null,
    size: video?.size ?? null,
    error: video?.error ?? null,
  });
}
