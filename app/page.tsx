import { getArticlesForToday } from "@/lib/articles";

type ParsedArticleBody = {
  mainText: string;
  citations: { label: string; url: string }[];
};

function parseBodyAndCitations(body: string): ParsedArticleBody {
  if (!body) {
    return { mainText: "", citations: [] };
  }

  // Map from normalized URL to citation index & data
  const citationMap = new Map<
    string,
    { index: number; label: string; url: string }
  >();
  let citationCounter = 0;

  // Handle Markdown-style inline citations: [label](url) or ([label](url))
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
    // Explicit placeholder marker; later rendered as a numbered superscript
    return `[[CITE:${index}]]`;
  });

  // Also capture bare URLs that aren't already mapped
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

export default async function Page() {
  const articles: any[] = await getArticlesForToday();

  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
      {articles.map((a) => {
        const { mainText, citations } = parseBodyAndCitations(a.body ?? "");

        return (
          <article key={a.id} className="border-t pt-3">
            <p className="text-xs uppercase text-zinc-500">{a.department}</p>
            <h2 className="font-serif font-semibold">{a.title}</h2>
            <p className="italic text-sm">{a.subtitle}</p>
            {Array.isArray(a.image_urls) && a.image_urls.length > 0 && (
              <div className="mt-3 mb-2">
                <img
                  src={a.image_urls[0]}
                  alt={a.title}
                  className="w-full h-48 object-cover rounded-md border border-zinc-200"
                />
              </div>
            )}
            <p className="mt-2 whitespace-pre-wrap">
              {mainText.split(/(\[\[CITE:\d+\]\])/g).map((chunk, idx) => {
                const match = chunk.match(/^\[\[CITE:(\d+)\]\]$/);
                if (match) {
                  const num = match[1];
                  return (
                    <sup
                      key={`sup-${idx}`}
                      className="align-super text-[0.6em] ml-0.5"
                    >
                      {num}
                    </sup>
                  );
                }
                return <span key={`txt-${idx}`}>{chunk}</span>;
              })}
            </p>
            {citations.length > 0 && (
              <div className="mt-3 text-xs text-zinc-500 space-y-1">
                <p className="font-semibold uppercase tracking-wide">Sources</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {citations.map((c, i) => (
                    <li key={c.url}>
                      <span className="mr-1">[{i + 1}]</span>
                      <a
                        href={c.url}
                        className="underline hover:text-zinc-700"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {c.label || c.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs mt-2 text-zinc-500">{a.author}</p>
          </article>
        );
      })}
    </div>
  );
}
