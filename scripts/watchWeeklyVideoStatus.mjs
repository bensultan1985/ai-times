const baseUrl = process.env.VIDEO_STATUS_BASE_URL || "http://localhost:3000";
const weekKey = process.argv
  .find((a) => a.startsWith("--week="))
  ?.slice("--week=".length);
const intervalMs = Number(process.env.VIDEO_STATUS_INTERVAL_MS || 15000);

function fmtProgress(p) {
  if (p == null) return "-";
  if (typeof p === "number") {
    // Some APIs return 0..1, others 0..100. Handle both.
    const v = p <= 1 ? p * 100 : p;
    return `${Math.round(v)}%`;
  }
  return String(p);
}

function padRight(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function tick() {
  const url = new URL("/api/video-episode-status", baseUrl);
  if (weekKey) url.searchParams.set("week_key", weekKey);

  const res = await fetch(url);
  const text = await res.text();

  const now = new Date();
  const ts = now.toISOString().replace("T", " ").replace("Z", "Z");

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(`\n[${ts}] Status: HTTP ${res.status}`);
    console.log(text.slice(0, 2000));
    return false;
  }

  console.log(`\n[${ts}] ${data.week_key} — ${data.overall_status}`);
  if (data.title) console.log(`Title: ${data.title}`);
  if (data.logline) console.log(`Logline: ${data.logline}`);

  const segments = Array.isArray(data.segments) ? data.segments : [];
  for (const s of segments) {
    const name = padRight(s.segment_name ?? "?", 9);
    const status = padRight(s.status ?? "unknown", 10);
    const prog = padRight(fmtProgress(s.progress), 6);
    const vid = s.video_id ?? "-";
    const err = s.error ? ` | error: ${String(s.error).slice(0, 120)}` : "";
    console.log(`- ${name} ${status} progress=${prog} id=${vid}${err}`);
  }

  const done =
    data.overall_status === "completed" || data.overall_status === "error";
  return done;
}

console.log(`Watching weekly video status every ${intervalMs}ms`);
console.log(`Base URL: ${baseUrl}`);
if (weekKey) console.log(`Week: ${weekKey}`);

// Run immediately, then every interval.
let timer;
(async () => {
  const done = await tick();
  if (done) process.exit(0);

  timer = setInterval(async () => {
    try {
      const finished = await tick();
      if (finished) {
        clearInterval(timer);
        process.exit(0);
      }
    } catch (e) {
      console.error("watch tick failed", e);
    }
  }, intervalMs);
})();
