// lib/db.ts
import { Pool } from "pg";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
//if seeding locally, load env vars from .env.local
dotenv.config({ path: `.env.local`, override: true });

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      },
);

let schemaEnsured: Promise<void> | null = null;

export async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return schemaEnsured;

  schemaEnsured = (async () => {
    const schemaPath = path.join(process.cwd(), "prisma", "schema.sql");
    const sql = await fs.readFile(schemaPath, "utf8");
    await pool.query(sql);

    // Keep local/dev schema resilient to incremental changes.
    // (schema.sql is CREATE TABLE IF NOT EXISTS so it won't add new columns.)
    await pool.query(
      "ALTER TABLE comics ADD COLUMN IF NOT EXISTS metadata JSONB",
    );
  })().catch((err) => {
    // Allow a future retry if schema init failed for a transient reason.
    schemaEnsured = null;
    throw err;
  });

  return schemaEnsured;
}

export async function query<T = any>(
  text: string,
  params: any[] = [],
): Promise<T[]> {
  try {
    const res = await pool.query(text, params);
    return res.rows;
  } catch (err: any) {
    const code = err?.code;

    // 42P01 = undefined_table
    // In local/dev it's easy to forget to run the schema SQL; auto-create once.
    if (code === "42P01" && process.env.NODE_ENV !== "production") {
      await ensureSchema();
      const res = await pool.query(text, params);
      return res.rows;
    }

    throw err;
  }
}
