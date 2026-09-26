import { pool } from "@/lib/db";


const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;


// =========================================================
// SQL SAFETY
// =========================================================

function cleanSqlForInspection(sql) {
  return String(sql ?? "")
    // remove /* ... */ comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // remove -- comments
    .replace(/--.*$/gm, " ")
    // remove single quoted string contents
    .replace(/'(?:''|[^'])*'/g, "''")
    // normalize whitespace
    .replace(/\s+/g, " ")
    .trim();
}


function validateReadOnlySql(rawSql) {
  const sql = String(rawSql ?? "").trim();

  if (!sql) {
    throw new Error("SQL query is required.");
  }

  // One statement only.
  // Hermes should send SQL without trailing semicolon.
  if (sql.includes(";")) {
    throw new Error(
      "Only one SQL statement is allowed. Do not include semicolons."
    );
  }

  const inspected =
    cleanSqlForInspection(sql).toLowerCase();

  if (
    !inspected.startsWith("select ") &&
    !inspected.startsWith("with ")
  ) {
    throw new Error(
      "Only SELECT or WITH ... SELECT queries are allowed."
    );
  }


  // Block anything that can mutate DB structure/data/session.
  const blockedKeywords = [
    "insert",
    "update",
    "delete",
    "merge",
    "create",
    "alter",
    "drop",
    "truncate",
    "grant",
    "revoke",
    "copy",
    "call",
    "do",
    "execute",
    "prepare",
    "deallocate",
    "vacuum",
    "reindex",
    "cluster",
    "refresh",
    "comment",
    "set",
    "reset",
    "listen",
    "notify",
    "unlisten",
    "lock",
  ];

  for (const keyword of blockedKeywords) {
    const pattern =
      new RegExp(`\\b${keyword}\\b`, "i");

    if (pattern.test(inspected)) {
      throw new Error(
        `SQL keyword not allowed in AI read-only query: ${keyword}`
      );
    }
  }


  // SELECT ... INTO creates a table.
  if (/\bselect\b[\s\S]*\binto\b/i.test(inspected)) {
    throw new Error(
      "SELECT INTO is not allowed."
    );
  }


  // Block PostgreSQL functions that can affect the server/session,
  // lock resources, manipulate sequences, or access server files.
  const blockedFunctions = [
    "pg_sleep",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_stat_file",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_advisory_lock",
    "pg_advisory_xact_lock",
    "pg_try_advisory_lock",
    "pg_try_advisory_xact_lock",
    "set_config",
    "nextval",
    "setval",
    "lo_import",
    "lo_export",
    "dblink",
  ];

  for (const fn of blockedFunctions) {
    const pattern =
      new RegExp(`\\b${fn}\\s*\\(`, "i");

    if (pattern.test(inspected)) {
      throw new Error(
        `SQL function not allowed in AI read-only query: ${fn}`
      );
    }
  }


  // For the Stock AI pilot, business data must come from
  // Ardiles Stock History. Metadata discovery is also allowed.
  //
  // Explicit references to unrelated schemas are rejected.
  const schemaMatches =
    inspected.matchAll(
      /\b([a-z_][a-z0-9_]*)\s*\./gi
    );

  const allowedSchemas = new Set([
    "ardiles_stock_history",
    "information_schema",
  ]);

  for (const match of schemaMatches) {
    const schema =
      String(match[1]).toLowerCase();

    // Ignore aliases such as s.qty, x.model, etc.
    // Only known schema-like names are evaluated here.
    if (
      schema.startsWith("ardiles_") &&
      !allowedSchemas.has(schema)
    ) {
      throw new Error(
        `Schema not allowed for Stock AI: ${schema}`
      );
    }

    if (
      schema === "pg_catalog" ||
      schema.startsWith("pg_")
    ) {
      throw new Error(
        `System schema not allowed: ${schema}`
      );
    }
  }

  return sql;
}


// =========================================================
// RESULT LIMIT
// =========================================================

function normalizeLimit(value) {
  const number =
    Number(value ?? DEFAULT_LIMIT);

  if (!Number.isFinite(number)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(
    1,
    Math.min(
      MAX_LIMIT,
      Math.floor(number)
    )
  );
}


// =========================================================
// AI READ-ONLY QUERY RUNNER
// =========================================================

export async function runAiReadQuery({
  sql,
  params = [],
  limit = DEFAULT_LIMIT,
} = {}) {

  const safeSql =
    validateReadOnlySql(sql);

  const safeLimit =
    normalizeLimit(limit);

  if (!Array.isArray(params)) {
    throw new Error(
      "params must be an array."
    );
  }


  const client =
    await pool.connect();


  try {

    // PostgreSQL itself enforces read-only for this transaction.
    await client.query(
      "BEGIN READ ONLY"
    );


    // Prevent expensive accidental AI queries.
    await client.query(
      "SET LOCAL statement_timeout = '20000ms'"
    );

    await client.query(
      "SET LOCAL lock_timeout = '3000ms'"
    );

    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '30000ms'"
    );


    // Unqualified business table names resolve to Stock History.
    await client.query(
      "SET LOCAL search_path = ardiles_stock_history, information_schema"
    );


    // Wrap the AI query so the returned row count is always bounded.
    const result =
      await client.query(
        `
          SELECT *
          FROM (
            ${safeSql}
          ) AS ardiles_ai_result
          LIMIT ${safeLimit + 1}
        `,
        params
      );


    await client.query(
      "COMMIT"
    );


    const hasMore =
      result.rows.length > safeLimit;

    const rows =
      hasMore
        ? result.rows.slice(0, safeLimit)
        : result.rows;


    return {
      found: rows.length > 0,

      row_count: rows.length,

      limit: safeLimit,

      has_more: hasMore,

      fields:
        result.fields
          ?.map((field) => field.name)
          ?? [],

      rows,
    };

  }
  catch (error) {

    try {
      await client.query(
        "ROLLBACK"
      );
    }
    catch {
      // Ignore rollback failure.
    }

    throw error;

  }
  finally {

    client.release();

  }
}
