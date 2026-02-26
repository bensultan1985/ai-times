import { query, ensureSchema } from "./db";

export type VideoEpisode = {
  id: number;
  week_key: string;
  title: string | null;
  logline: string | null;
  script: unknown | null;
  created_at: string;
};

export type VideoSegment = {
  id: number;
  episode_id: number;
  segment_index: number;
  segment_name: string;
  video_url: string;
  duration_seconds: number;
  created_at: string;
};

export async function getLatestVideoEpisode(): Promise<
  (VideoEpisode & { segments: VideoSegment[] }) | null
> {
  await ensureSchema();
  const episodes = await query<VideoEpisode>(
    "SELECT * FROM video_episodes ORDER BY created_at DESC LIMIT 1",
  );
  const episode = episodes[0];
  if (!episode) return null;

  const segments = await query<VideoSegment>(
    "SELECT * FROM video_segments WHERE episode_id = $1 ORDER BY segment_index ASC",
    [episode.id],
  );

  return { ...episode, segments };
}

export async function getVideoEpisodeByWeekKey(
  weekKey: string,
): Promise<(VideoEpisode & { segments: VideoSegment[] }) | null> {
  await ensureSchema();
  const episodes = await query<VideoEpisode>(
    "SELECT * FROM video_episodes WHERE week_key = $1 LIMIT 1",
    [weekKey],
  );
  const episode = episodes[0];
  if (!episode) return null;

  const segments = await query<VideoSegment>(
    "SELECT * FROM video_segments WHERE episode_id = $1 ORDER BY segment_index ASC",
    [episode.id],
  );

  return { ...episode, segments };
}

export async function upsertVideoEpisode(opts: {
  week_key: string;
  title?: string;
  logline?: string;
  script?: unknown;
  segments: Array<{
    segment_index: number;
    segment_name: string;
    video_url: string;
    duration_seconds?: number;
  }>;
}): Promise<VideoEpisode> {
  await ensureSchema();
  const { week_key, title, logline, script, segments } = opts;

  // Replace episode+segments for the week.
  const existing = await query<VideoEpisode>(
    "SELECT * FROM video_episodes WHERE week_key = $1 LIMIT 1",
    [week_key],
  );

  let episodeId: number;
  if (existing[0]) {
    episodeId = existing[0].id;
    await query(
      "UPDATE video_episodes SET title = $2, logline = $3, script = $4 WHERE id = $1",
      [episodeId, title ?? null, logline ?? null, script ?? null],
    );
    await query("DELETE FROM video_segments WHERE episode_id = $1", [
      episodeId,
    ]);
  } else {
    const rows = await query<VideoEpisode>(
      "INSERT INTO video_episodes (week_key, title, logline, script) VALUES ($1, $2, $3, $4) RETURNING *",
      [week_key, title ?? null, logline ?? null, script ?? null],
    );
    episodeId = rows[0]!.id;
  }

  for (const seg of segments) {
    await query(
      "INSERT INTO video_segments (episode_id, segment_index, segment_name, video_url, duration_seconds) VALUES ($1, $2, $3, $4, $5)",
      [
        episodeId,
        seg.segment_index,
        seg.segment_name,
        seg.video_url,
        seg.duration_seconds ?? 12,
      ],
    );
  }

  const episode = await query<VideoEpisode>(
    "SELECT * FROM video_episodes WHERE id = $1",
    [episodeId],
  );
  return episode[0]!;
}
