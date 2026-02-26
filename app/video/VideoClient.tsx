"use client";

import { useMemo, useRef, useState } from "react";

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

export function VideoClient({ initialEpisode }: Props) {
  const [episode, setEpisode] = useState<Episode | null>(initialEpisode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orderedSegments = useMemo(() => {
    const segments = episode?.segments ?? [];
    return [...segments].sort((a, b) => a.segment_index - b.segment_index);
  }, [episode]);

  const videoRefs = useRef<Array<HTMLVideoElement | null>>([]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/generate-weekly-video", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Failed to generate");
      setEpisode(json);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const playAll = async () => {
    if (orderedSegments.length === 0) return;
    for (let i = 0; i < orderedSegments.length; i += 1) {
      const v = videoRefs.current[i];
      if (!v) continue;
      v.currentTime = 0;
      // eslint-disable-next-line no-await-in-loop
      await v.play();
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        const onEnded = () => {
          v.removeEventListener("ended", onEnded);
          resolve();
        };
        v.addEventListener("ended", onEnded);
      });
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
              onClick={playAll}
              disabled={!episode || orderedSegments.length === 0}
              className="px-3 py-2 text-sm rounded-md border bg-white disabled:opacity-50"
            >
              Play Episode
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

      {episode && orderedSegments.length > 0 && (
        <div className="grid gap-6">
          {orderedSegments.map((seg, idx) => (
            <div key={seg.segment_name} className="border rounded-md bg-white">
              <div className="px-4 py-2 border-b bg-zinc-50 flex items-center justify-between">
                <p className="text-sm font-semibold">
                  {idx + 1}. {seg.segment_name.replace(/_/g, " ")}
                </p>
                <p className="text-xs text-zinc-500">{seg.duration_seconds}s</p>
              </div>
              <video
                ref={(el) => {
                  videoRefs.current[idx] = el;
                }}
                src={seg.video_url}
                controls
                playsInline
                preload="metadata"
                className="w-full bg-black"
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
