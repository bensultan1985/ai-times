import { query } from "./db.ts";

export type Comic = {
  id: number;
  comic_type: "family" | "ai_dog" | "teen_bot";
  title: string | null;
  caption: string | null;
  image_url: string;
  published_at: string;
  created_at: string;
  test_data?: boolean;
  metadata?: unknown;
};

export async function getComicsForToday(): Promise<Comic[]> {
  return query<Comic>(
    "SELECT * FROM comics WHERE published_at = CURRENT_DATE ORDER BY comic_type ASC",
  );
}

export async function insertComic(opts: {
  comic_type: "family" | "ai_dog" | "teen_bot";
  title?: string;
  caption?: string;
  image_url: string;
  published_at: string;
  test_data?: boolean;
  metadata?: unknown;
}) {
  const {
    comic_type,
    title,
    caption,
    image_url,
    published_at,
    test_data,
    metadata,
  } = opts;

  if (metadata != null && process.env.NODE_ENV !== "production") {
    try {
      await query("ALTER TABLE comics ADD COLUMN IF NOT EXISTS metadata JSONB");
    } catch {
      // Best-effort in dev/local; fall back to legacy insert if it fails.
    }
  }

  // Prefer writing metadata if the column exists.
  // If the DB hasn't been migrated yet, fall back to the older insert.
  try {
    await query(
      `
      INSERT INTO comics (comic_type, title, caption, image_url, published_at, test_data, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        comic_type,
        title ?? null,
        caption ?? null,
        image_url,
        published_at,
        test_data ?? false,
        metadata ?? null,
      ],
    );
    return;
  } catch (err: any) {
    // 42703 = undefined_column
    if (err?.code !== "42703") throw err;
  }

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
  comic_type: "family" | "ai_dog" | "teen_bot";
  title?: string;
  caption?: string;
  image_url: string;
  published_at: string;
  test_data?: boolean;
  metadata?: unknown;
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
