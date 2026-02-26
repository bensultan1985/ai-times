import path from "node:path";
import fs from "node:fs/promises";

type VoicesConfig = {
  version?: number;
  global?: any;
  characters?: Record<
    string,
    {
      role?: string;
      voice?: any;
      do?: string[];
      dont?: string[];
    }
  >;
};

let cachedPromise: Promise<VoicesConfig | null> | null = null;

async function loadVoicesConfig(): Promise<VoicesConfig | null> {
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async () => {
    const voicesPath = path.join(
      process.cwd(),
      "lib",
      "video-modeling",
      "voices.json",
    );

    try {
      const raw = await fs.readFile(voicesPath, "utf8");
      const json = JSON.parse(raw);
      if (!json || typeof json !== "object") return null;
      return json as VoicesConfig;
    } catch {
      return null;
    }
  })();

  return cachedPromise;
}

function summarizeVoice(v: any): string {
  if (!v || typeof v !== "object") return "";
  const parts: string[] = [];

  const pick = (k: string, label?: string) => {
    const val = (v as any)[k];
    if (typeof val === "string" && val.trim()) {
      parts.push(`${label ?? k}: ${val.trim()}`);
    }
  };

  pick("ageImpression", "age");
  pick("tone");
  pick("pitch");
  pick("timbre");
  pick("accent");
  pick("texture");

  const prosody = (v as any).prosody;
  if (prosody && typeof prosody === "object") {
    const pros: string[] = [];
    for (const key of ["cadence", "emphasis", "humorStyle"]) {
      const val = prosody[key];
      if (typeof val === "string" && val.trim())
        pros.push(`${key}: ${val.trim()}`);
    }
    if (pros.length) parts.push(`prosody: ${pros.join("; ")}`);
  }

  const signature = (v as any).signature;
  if (Array.isArray(signature) && signature.length) {
    const sig = signature
      .map((s: any) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean);
    if (sig.length) parts.push(`signature: ${sig.join(", ")}`);
  }

  return parts.join(" | ");
}

export async function getVoiceGuidanceForPrompt(): Promise<string> {
  const cfg = await loadVoicesConfig();
  if (!cfg?.characters) return "";

  const juan = cfg.characters["Juan"];
  const xero = cfg.characters["Xero"];
  const lyle = cfg.characters["Lyle"];

  const lines: string[] = [];
  lines.push("Voice consistency guide (direction, NOT spoken):");

  if (juan) {
    const role = typeof juan.role === "string" ? juan.role.trim() : "";
    const summary = summarizeVoice(juan.voice);
    lines.push(`- Juan: ${role ? role + "; " : ""}${summary}`.trim());
    if (Array.isArray(juan.do) && juan.do.length)
      lines.push(`  Juan do: ${juan.do.join("; ")}`);
    if (Array.isArray(juan.dont) && juan.dont.length)
      lines.push(`  Juan don't: ${juan.dont.join("; ")}`);
  }

  if (xero) {
    const role = typeof xero.role === "string" ? xero.role.trim() : "";
    const summary = summarizeVoice(xero.voice);
    lines.push(`- Xero: ${role ? role + "; " : ""}${summary}`.trim());
    if (Array.isArray(xero.do) && xero.do.length)
      lines.push(`  Xero do: ${xero.do.join("; ")}`);
    if (Array.isArray(xero.dont) && xero.dont.length)
      lines.push(`  Xero don't: ${xero.dont.join("; ")}`);
  }

  if (lyle) {
    const role = typeof lyle.role === "string" ? lyle.role.trim() : "";
    const summary = summarizeVoice(lyle.voice);
    lines.push(`- Lyle: ${role ? role + "; " : ""}${summary}`.trim());
    if (Array.isArray(lyle.do) && lyle.do.length)
      lines.push(`  Lyle do: ${lyle.do.join("; ")}`);
    if (Array.isArray(lyle.dont) && lyle.dont.length)
      lines.push(`  Lyle don't: ${lyle.dont.join("; ")}`);
  }

  return lines.join("\n");
}
