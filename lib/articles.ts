import { query } from "./db";

export type Article = {
  id: number;
  title: string;
  subtitle: string | null;
  body: string;
  author: string | null;
  department: string | null;
  created_at: string;
  published_at: string;
  test_data?: boolean;
  metadata?: any;
};

export async function getArticlesForToday(): Promise<Article[]> {
  return query<Article>(
    "SELECT * FROM articles WHERE published_at = CURRENT_DATE ORDER BY created_at ASC"
  );
}

export async function insertArticle(opts: {
  title: string;
  subtitle?: string;
  body: string;
  author: string;
  department: string;
  published_at: string; // 'YYYY-MM-DD'
  test_data: boolean;
  metadata?: any;
}) {
  const {
    title,
    subtitle,
    body,
    author,
    department,
    published_at,
    test_data,
    metadata,
  } = opts;

  await query(
    `
    INSERT INTO articles (title, subtitle, body, author, department, published_at, test_data, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      title,
      subtitle ?? null,
      body,
      author,
      department,
      published_at,
      test_data,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}
