import { getArticlesForToday } from "@/lib/articles";
import { PageClient } from "./PageClient";

export default async function Page() {
  const articles = await getArticlesForToday();
  return <PageClient articles={articles as any} />;
}
