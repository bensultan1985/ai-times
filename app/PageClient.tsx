"use client";

import { useEffect, useState } from "react";
import type { Article } from "@/lib/articles";

import { parseBodyAndCitations } from "./parseBodyAndCitations";

type Props = {
  articles: Article[];
};

export function PageClient({ articles }: Props) {
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const handleNavClick = (id: number) => {
    setHighlightId(id);
    const el = document.getElementById(`article-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  useEffect(() => {
    if (highlightId === null) return;
    const timeout = setTimeout(() => setHighlightId(null), 1000);
    return () => clearTimeout(timeout);
  }, [highlightId]);

  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
      {/* Index / navigation box in first slot */}
      <aside className="border rounded-md p-2 bg-zinc-50/60">
        <div
          style={{ background: "rgb(240, 240, 240)" }}
          className="p-4 rounded-md"
        >
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 mb-2 mt-4">
            Today&apos;s Headlines
          </h2>
          <ol className="space-y-3 text-sm">
            {articles.map((a: Article) => {
              const navTitle = a.title?.slice(0, 50);
              const ellipsis = a.title && a.title.length > 50 ? "..." : "";
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => handleNavClick(a.id)}
                    className="w-full text-left  max-w-xs hover:underline text-zinc-800 text-overflow-wrap cursor-pointer"
                  >
                    {a.title?.slice(0, 80) ?? "Untitled Article"}
                    {ellipsis}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="p-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 mb-2 mt-8">
            About The AI Times
          </h2>
          <p>
            The purpose of the AI Times is to demonstrate the concept of
            delivering content via an automated, templated pipeline. Each day at
            midnight, new articles are generated and published automatically. No
            human assistance required.
          </p>
        </div>
      </aside>

      {articles.map((a: Article) => {
        const { mainText, citations } = parseBodyAndCitations(a.body ?? "");
        const isHighlighted = highlightId === a.id;

        return (
          <article
            key={a.id}
            id={`article-${a.id}`}
            className="border-t pt-3 scroll-mt-6"
          >
            <p className="text-xs uppercase text-zinc-500">{a.department}</p>
            <h2
              className={`font-serif font-semibold transition-colors duration-700 ${
                isHighlighted ? "bg-amber-100" : ""
              }`}
            >
              {a.title}
            </h2>
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
              {mainText
                .split(/(\[\[CITE:\d+\]\])/g)
                .map((chunk: string, idx: number) => {
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
                  {citations.map((c: any, i: number) => (
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
