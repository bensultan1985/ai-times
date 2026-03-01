import { getArticlesForToday } from "@/lib/articles";
import { getComicsForToday } from "@/lib/comics";
import { PageClient } from "./PageClient";

export default async function Page() {
  const [articles, comics] = await Promise.all([
    getArticlesForToday(),
    getComicsForToday(),
  ]);
  return <PageClient articles={articles} comics={comics} />;
}
