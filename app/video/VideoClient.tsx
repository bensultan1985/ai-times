"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Segment = {
  segment_index: number;
  segment_name: string;
  video_url: string;
  duration_seconds: number;
};

type Episode = {
  week_key: string;
  title: string;
  logline: string;
  segments: Segment[];
};

type Props = {
  initialEpisode: Episode | null;
};

type SegmentStatus = {
  status: string;
  progress: number | null;
  error: string | null;
};

type EpisodeStatusResponse = {
  overall_status?: string;
  combined?: { available?: boolean; url?: string | null };
  segments?: Array<{
    segment_index: number;
    segment_name: string;
    status: string;
    progress: number | null;
    error: any;
  }>;
};

function extractVideoId(videoUrl: string): string | null {
  // Expect /api/video-content/<video_id>
  const m = /^\/api\/video-content\/([^/?#]+)\/?$/.exec(videoUrl);
  return m?.[1] ?? null;
}

export function VideoClient({ initialEpisode }: Props) {
  const [episode, setEpisode] = useState<Episode | null>(initialEpisode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [segmentStatus, setSegmentStatus] = useState<
    Record<string, SegmentStatus>
  >({});
  const [overallStatus, setOverallStatus] = useState<string | null>(null);
  const [combinedUrl, setCombinedUrl] = useState<string | null>(null);
  const [combinedAvailable, setCombinedAvailable] = useState<boolean>(false);
  const [combinedError, setCombinedError] = useState<string | null>(null);

  const combineRequestedRef = useRef<string | null>(null);

  const orderedSegments = useMemo(() => {
    const segments = episode?.segments ?? [];
    return [...segments].sort((a, b) => a.segment_index - b.segment_index);
  }, [episode]);

  const refreshStatus = async () => {
    const segments = orderedSegments;
    if (!episode || segments.length === 0) return;

    try {
      const res = await fetch(
        `/api/video-episode-status?week_key=${encodeURIComponent(episode.week_key)}`,
      );
      const json = (await res.json()) as EpisodeStatusResponse;

      setOverallStatus(
        json?.overall_status ? String(json.overall_status) : "unknown",
      );
      const combined = json?.combined;
      const statusStr = json?.overall_status
        ? String(json.overall_status)
        : "unknown";

      const isAvailable = Boolean(combined?.available);
      setCombinedAvailable(isAvailable);

      const candidateUrl =
        statusStr === "completed" && isAvailable
          ? combined?.url
            ? String(combined.url)
            : episode
              ? `/api/video-episode-content?week_key=${encodeURIComponent(episode.week_key)}`
              : null
          : null;
      setCombinedUrl(candidateUrl);

      const updates: Record<string, SegmentStatus> = {};
      for (const s of json?.segments ?? []) {
        updates[String(s.segment_name)] = {
          status: String(s.status ?? "unknown"),
          progress: (s.progress as any) ?? null,
          error: s?.error?.message
            ? String(s.error.message)
            : s?.error
              ? String(s.error)
              : null,
        };
      }

      if (Object.keys(updates).length > 0) {
        setSegmentStatus((prev) => ({ ...prev, ...updates }));
        return;
      }
    } catch {
      // fall through
    }

    // Fallback: per-segment status.
    const updates: Record<string, SegmentStatus> = {};
    await Promise.all(
      segments.map(async (seg) => {
        const videoId = extractVideoId(seg.video_url);
        if (!videoId) {
          updates[seg.segment_name] = {
            status: "unknown",
            progress: null,
            error: "Unrecognized video_url",
          };
          return;
        }

        try {
          const res = await fetch(`/api/video-status/${videoId}`);
          const json = await res.json();
          updates[seg.segment_name] = {
            status: String(json?.status ?? "unknown"),
            progress: json?.progress ?? null,
            error: json?.error?.message ? String(json.error.message) : null,
          };
        } catch (e: any) {
          updates[seg.segment_name] = {
            status: "error",
            progress: null,
            error: e?.message ?? String(e),
          };
        }
      }),
    );

    setSegmentStatus((prev) => ({ ...prev, ...updates }));
  };

  const assembleCombined = async () => {
    if (!episode) return;
    setCombinedError(null);
    setBusy(true);
    try {
      const url = `/api/video-episode-content?week_key=${encodeURIComponent(episode.week_key)}`;
      const res = await fetch(url);
      const ct = res.headers.get("content-type") || "";

      if (!res.ok) {
        let msg = `Failed to assemble combined episode (${res.status})`;
        if (ct.includes("application/json")) {
          try {
            const j: any = await res.json();
            if (j?.error) msg = String(j.error);
          } catch {
            // ignore
          }
        }
        throw new Error(msg);
      }

      if (!ct.includes("video/mp4")) {
        throw new Error(
          `Unexpected response while assembling episode (content-type: ${ct || "unknown"})`,
        );
      }

      // Assembly succeeded; the endpoint also caches the output to disk.
      setCombinedAvailable(true);
      setCombinedUrl(url);
      await refreshStatus();
    } catch (e: any) {
      setCombinedError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => {
      void refreshStatus();
    }, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode?.week_key, orderedSegments.length]);

  useEffect(() => {
    // If the segments finished but the combined artifact isn't available yet, kick off an
    // assembly attempt once (best-effort).
    if (!episode) return;
    if (overallStatus !== "completed") return;
    if (combinedAvailable) return;

    if (combineRequestedRef.current === episode.week_key) return;
    combineRequestedRef.current = episode.week_key;
    void assembleCombined();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode?.week_key, overallStatus, combinedAvailable]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-weekly-video", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to generate");
      setEpisode(json);
      setSegmentStatus({});
      setOverallStatus(null);
      setCombinedUrl(null);
      setCombinedAvailable(false);
      setCombinedError(null);
      combineRequestedRef.current = null;
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="border rounded-md bg-white p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-serif text-2xl">Weekly Sitcom (36s)</h2>
            <p className="text-sm text-zinc-600">
              Juan & Xero (AI breadwinners) + Lyle (roommate)
            </p>
            {episode ? (
              <p className="text-xs text-zinc-500 mt-1">
                Week: <span className="font-mono">{episode.week_key}</span>
                {overallStatus ? (
                  <span className="ml-2">• Status: {overallStatus}</span>
                ) : null}
              </p>
            ) : (
              <p className="text-xs text-zinc-500 mt-1">
                No episode generated yet.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={generate}
              disabled={busy}
              className="px-3 py-2 text-sm rounded-md bg-black text-white disabled:opacity-50"
            >
              {busy ? "Generating…" : "Generate This Week"}
            </button>
            <button
              type="button"
              onClick={refreshStatus}
              disabled={!episode || orderedSegments.length === 0}
              className="px-3 py-2 text-sm rounded-md border bg-white disabled:opacity-50"
            >
              Refresh Status
            </button>
          </div>
        </div>

        {episode && (
          <div className="mt-3">
            <p className="font-semibold">{episode.title}</p>
            <p className="text-sm text-zinc-700">{episode.logline}</p>
          </div>
        )}

        {error && (
          <p className="mt-3 text-sm text-red-600">
            Error: <span className="font-mono">{error}</span>
          </p>
        )}
      </header>

      {episode && combinedUrl && overallStatus === "completed" && (
        <div className="border rounded-md bg-white">
          <div className="px-4 py-2 border-b bg-zinc-50">
            <p className="text-sm font-semibold">
              Full Episode (combined + title)
            </p>
            <p className="text-xs text-zinc-500">
              Single video assembled from title sequence + segments
            </p>
          </div>
          <video
            src={combinedUrl}
            controls
            playsInline
            preload="metadata"
            className="w-full bg-black"
          />
        </div>
      )}

      {episode && overallStatus === "completed" && !combinedUrl && (
        <div className="border rounded-md bg-white">
          <div className="px-4 py-2 border-b bg-zinc-50">
            <p className="text-sm font-semibold">Finishing up…</p>
            <p className="text-xs text-zinc-500">
              Segments are done; assembling the final combined episode.
            </p>
          </div>
          <div className="p-4 space-y-2">
            {combinedError ? (
              <p className="text-sm text-red-600">
                Combine error:{" "}
                <span className="font-mono">{combinedError}</span>
              </p>
            ) : (
              <p className="text-sm text-zinc-700">
                Combining now… this can take ~10–30 seconds.
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={assembleCombined}
                disabled={busy}
                className="px-3 py-2 text-sm rounded-md bg-black text-white disabled:opacity-50"
              >
                {busy ? "Assembling…" : "Assemble Full Episode"}
              </button>
              <button
                type="button"
                onClick={refreshStatus}
                disabled={busy}
                className="px-3 py-2 text-sm rounded-md border bg-white disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
            {combinedError?.includes("Downloads expire") ? (
              <p className="text-xs text-zinc-500">
                This episode looks too old to assemble from OpenAI downloads.
                Generate a new week (or force regenerate) and keep this page
                open until it finishes.
              </p>
            ) : null}
          </div>
        </div>
      )}

      {episode &&
        overallStatus !== "completed" &&
        orderedSegments.length > 0 && (
          <div className="border rounded-md bg-white">
            <div className="px-4 py-2 border-b bg-zinc-50">
              <p className="text-sm font-semibold">Rendering episode…</p>
              <p className="text-xs text-zinc-500">
                Segments are generated in the background and then combined into
                a single final video.
              </p>
            </div>
            <div className="p-4 space-y-2">
              {orderedSegments.map((seg, idx) => {
                const st = segmentStatus[seg.segment_name];
                return (
                  <div
                    key={seg.segment_name}
                    className="flex items-start justify-between gap-4"
                  >
                    <div>
                      <p className="text-sm font-semibold">
                        {idx + 1}. {seg.segment_name.replace(/_/g, " ")}
                      </p>
                      {st?.error ? (
                        <p className="text-xs text-red-600 mt-1">
                          Error: {st.error}
                        </p>
                      ) : null}
                    </div>
                    <p className="text-xs text-zinc-500 whitespace-nowrap">
                      {st?.status ?? "queued"}
                      {typeof st?.progress === "number"
                        ? ` (${st.progress}%)`
                        : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
    </section>
  );
}
