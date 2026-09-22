import pg from "pg";

const { Pool } = pg;

const globalForPg = globalThis;

function makePool() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const ssl =
    process.env.PG_SSL === "require"
      ? { rejectUnauthorized: false }
      : false;

  return new Pool({
    connectionString,
    ssl,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export const pool =
  globalForPg.__ardilesPgPool ??
  makePool();

if (process.env.NODE_ENV !== "production") {
  globalForPg.__ardilesPgPool = pool;
}

export async function query(text, params = []) {
  return pool.query(text, params);
}
