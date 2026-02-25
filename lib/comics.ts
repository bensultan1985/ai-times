import { query } from "./db.ts";

export type Comic = {
  id: number;
  comic_type: "family" | "ai_dog";
  title: string | null;
  caption: string | null;
  image_url: string;
  published_at: string;
  created_at: string;
  test_data?: boolean;
};

export async function getComicsForToday(): Promise<Comic[]> {
  return query<Comic>(
    "SELECT * FROM comics WHERE published_at = CURRENT_DATE ORDER BY comic_type ASC",
  );
}

export async function insertComic(opts: {
  comic_type: "family" | "ai_dog";
  title?: string;
  caption?: string;
  image_url: string;
  published_at: string;
  test_data?: boolean;
}) {
  const { comic_type, title, caption, image_url, published_at, test_data } =
    opts;

  await query(
    `
    INSERT INTO comics (comic_type, title, caption, image_url, published_at, test_data)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      comic_type,
      title ?? null,
      caption ?? null,
      image_url,
      published_at,
      test_data ?? false,
    ],
  );
}

export async function upsertComic(opts: {
  comic_type: "family" | "ai_dog";
  title?: string;
  caption?: string;
  image_url: string;
  published_at: string;
  test_data?: boolean;
}) {
  const { comic_type, published_at } = opts;

  // Prevent duplicates if the generation endpoint is hit multiple times.
  await query(
    `
    DELETE FROM comics
    WHERE comic_type = $1 AND published_at = $2
    `,
    [comic_type, published_at],
  );

  await insertComic(opts);
}
