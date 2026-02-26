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
  const status = String(video?.status ?? "unknown");

  if (status !== "completed") {
    return NextResponse.json(
      {
        id: videoId,
        status,
        progress: video?.progress ?? null,
        error: video?.error?.message ?? null,
      },
      { status: 202 },
    );
  }

  const content: any = await (openai as any).videos.downloadContent(videoId);
  const ab = await content.arrayBuffer();
  const buf = Buffer.from(ab);

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "video/mp4",
      // Avoid caching since OpenAI download URLs are time-limited.
      "Cache-Control": "no-store",
    },
  });
}
