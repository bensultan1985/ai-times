import { getArticlesForToday } from "@/lib/articles";

export default async function Page() {
  const articles: any[] = await getArticlesForToday();

  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
      {articles.map((a) => (
        <article key={a.id} className="border-t pt-3">
          <p className="text-xs uppercase text-zinc-500">{a.department}</p>
          <h2 className="font-serif font-semibold">{a.title}</h2>
          <p className="italic text-sm">{a.subtitle}</p>
          <p className="mt-2">{a.body}</p>
          <p className="text-xs mt-2 text-zinc-500">{a.author}</p>
        </article>
      ))}
    </div>
  );
}
