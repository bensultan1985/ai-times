import path from "node:path";
import fs from "node:fs/promises";

type EnsureSegmentCachedOpts = {
  weekKey: string;
  segmentIndex: number;
  videoId: string;
  download: () => Promise<Buffer>;
};

type SegmentMeta = {
  videoId: string;
  cachedAt: string;
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function tmpRootForWeek(weekKey: string): string {
  return path.join(process.cwd(), ".tmp", "weekly-video", weekKey);
}

function segmentsDirForWeek(weekKey: string): string {
  return path.join(tmpRootForWeek(weekKey), "segments");
}

function segmentMp4Path(weekKey: string, segmentIndex: number): string {
  return path.join(segmentsDirForWeek(weekKey), `${segmentIndex}.mp4`);
}

function segmentMetaPath(weekKey: string, segmentIndex: number): string {
  return path.join(segmentsDirForWeek(weekKey), `${segmentIndex}.json`);
}

function segmentLockPath(weekKey: string, segmentIndex: number): string {
  return path.join(segmentsDirForWeek(weekKey), `${segmentIndex}.lock`);
}

async function readSegmentMeta(
  weekKey: string,
  segmentIndex: number,
): Promise<SegmentMeta | null> {
  const p = segmentMetaPath(weekKey, segmentIndex);
  if (!(await fileExists(p))) return null;
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(raw);
    if (json && typeof json.videoId === "string") {
      return {
        videoId: json.videoId,
        cachedAt: typeof json.cachedAt === "string" ? json.cachedAt : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeSegmentCacheAtomic(opts: {
  weekKey: string;
  segmentIndex: number;
  videoId: string;
  mp4: Buffer;
}): Promise<string> {
  const dir = segmentsDirForWeek(opts.weekKey);
  await fs.mkdir(dir, { recursive: true });

  const mp4Path = segmentMp4Path(opts.weekKey, opts.segmentIndex);
  const metaPath = segmentMetaPath(opts.weekKey, opts.segmentIndex);

  const tmpMp4 = `${mp4Path}.tmp-${process.pid}-${Date.now()}`;
  const tmpMeta = `${metaPath}.tmp-${process.pid}-${Date.now()}`;

  await fs.writeFile(tmpMp4, opts.mp4);
  await fs.writeFile(
    tmpMeta,
    JSON.stringify(
      {
        videoId: opts.videoId,
        cachedAt: new Date().toISOString(),
      } satisfies SegmentMeta,
      null,
      2,
    ),
    "utf8",
  );

  await fs.rename(tmpMp4, mp4Path);
  await fs.rename(tmpMeta, metaPath);

  return mp4Path;
}

async function withBestEffortLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  let handle: fs.FileHandle | null = null;
  let acquired = false;
  try {
    handle = await fs.open(lockPath, "wx");
    acquired = true;
    return await fn();
  } catch {
    // Someone else holds the lock; proceed without it.
    return await fn();
  } finally {
    try {
      await handle?.close();
    } catch {
      // ignore
    }
    if (acquired) {
      try {
        await fs.unlink(lockPath);
      } catch {
        // ignore
      }
    }
  }
}

export async function ensureWeeklyVideoSegmentCached(
  opts: EnsureSegmentCachedOpts,
): Promise<string> {
  if (!opts.weekKey) throw new Error("Missing weekKey");
  if (!Number.isFinite(opts.segmentIndex)) throw new Error("Bad segmentIndex");
  if (!opts.videoId) throw new Error("Missing videoId");

  const mp4Path = segmentMp4Path(opts.weekKey, opts.segmentIndex);
  const meta = await readSegmentMeta(opts.weekKey, opts.segmentIndex);

  if (meta?.videoId === opts.videoId && (await fileExists(mp4Path))) {
    return mp4Path;
  }

  const lockPath = segmentLockPath(opts.weekKey, opts.segmentIndex);
  return await withBestEffortLock(lockPath, async () => {
    const meta2 = await readSegmentMeta(opts.weekKey, opts.segmentIndex);
    if (meta2?.videoId === opts.videoId && (await fileExists(mp4Path))) {
      return mp4Path;
    }

    const mp4 = await opts.download();
    return await writeSegmentCacheAtomic({
      weekKey: opts.weekKey,
      segmentIndex: opts.segmentIndex,
      videoId: opts.videoId,
      mp4,
    });
  });
}

export async function getWeeklyVideoSegmentCachedPathIfFresh(opts: {
  weekKey: string;
  segmentIndex: number;
  videoId: string;
}): Promise<string | null> {
  if (!opts.weekKey) return null;
  if (!Number.isFinite(opts.segmentIndex)) return null;
  if (!opts.videoId) return null;

  const mp4Path = segmentMp4Path(opts.weekKey, opts.segmentIndex);
  const meta = await readSegmentMeta(opts.weekKey, opts.segmentIndex);
  if (meta?.videoId !== opts.videoId) return null;
  if (!(await fileExists(mp4Path))) return null;
  return mp4Path;
}

export async function getCombinedEpisodePath(weekKey: string): Promise<string> {
  return path.join(tmpRootForWeek(weekKey), "episode-with-title.mp4");
}
