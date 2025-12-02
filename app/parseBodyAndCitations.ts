import type { Article } from "@/lib/articles";

export type ParsedArticleBody = {
  mainText: string;
  citations: { label: string; url: string }[];
};

export function parseBodyAndCitations(body: string): ParsedArticleBody {
  if (!body) {
    return { mainText: "", citations: [] };
  }

  const citationMap = new Map<
    string,
    { index: number; label: string; url: string }
  >();
  let citationCounter = 0;

  const markdownLinkRegex = /\(?\[([^\]]+)\]\(([^)]+)\)\)?/g;

  let transformed = body.replace(markdownLinkRegex, (_match, label, url) => {
    const trimmedUrl = String(url).trim();
    const normalizedUrl = trimmedUrl.startsWith("http")
      ? trimmedUrl
      : `https://${trimmedUrl}`;

    if (!citationMap.has(normalizedUrl)) {
      citationMap.set(normalizedUrl, {
        index: ++citationCounter,
        label: String(label).trim() || normalizedUrl,
        url: normalizedUrl,
      });
    }

    const { index } = citationMap.get(normalizedUrl)!;
    return `[[CITE:${index}]]`;
  });

  const urlRegex = /(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/g;
  transformed = transformed.replace(urlRegex, (match) => {
    const raw = match.trim();
    const normalizedUrl = raw.startsWith("http") ? raw : `https://${raw}`;

    if (!citationMap.has(normalizedUrl)) {
      citationMap.set(normalizedUrl, {
        index: ++citationCounter,
        label: normalizedUrl,
        url: normalizedUrl,
      });
    }

    const { index } = citationMap.get(normalizedUrl)!;
    return `[[CITE:${index}]]`;
  });

  const citations = Array.from(citationMap.values())
    .sort((a, b) => a.index - b.index)
    .map(({ label, url }) => ({ label, url }));

  return { mainText: transformed.trim(), citations };
}
