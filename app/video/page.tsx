import { getLatestVideoEpisode } from "@/lib/videos";
import { VideoClient } from "./VideoClient";

export default async function VideoPage() {
  const episode = await getLatestVideoEpisode();

  const initialEpisode = episode
    ? {
        week_key: episode.week_key,
        title: episode.title ?? "Untitled",
        logline: episode.logline ?? "",
        segments: episode.segments.map((s) => ({
          segment_index: s.segment_index,
          segment_name: s.segment_name,
          video_url: s.video_url,
          duration_seconds: s.duration_seconds,
        })),
      }
    : null;

  return <VideoClient initialEpisode={initialEpisode} />;
}
