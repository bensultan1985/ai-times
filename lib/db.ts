// lib/db.ts
import { Pool } from "pg";
import dotenv from "dotenv";
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
      }
);

export async function query<T = any>(
  text: string,
  params: any[] = []
): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows;
}
