import { query } from "@/lib/db";

const DIMENSIONS = {
  article: { expr: "s.barang", label: "article" },
  model: { expr: "s.model", label: "model" },
  location: { expr: "s.lokasi", label: "location" },
  accsys: { expr: "s.accsys", label: "accsys" },
  division: { expr: "s.kadivisi", label: "division" },
  function: { expr: "s.fungsi", label: "function" },
  supplier: { expr: "s.supplier", label: "supplier" },
};

const METRICS = {
  qty: "COALESCE(SUM(s.qty), 0)",
  article_count: "COUNT(DISTINCT s.barang)",
  model_count: "COUNT(DISTINCT s.model)",
  location_count: "COUNT(DISTINCT s.lokasi)",
  accsys_count: "COUNT(DISTINCT s.accsys)",
  cost_value: "COALESCE(SUM(CASE WHEN s.hpp IS NULL THEN 0 ELSE s.qty * s.hpp END), 0)",
  retail_value: "COALESCE(SUM(CASE WHEN s.harga_jual IS NULL THEN 0 ELSE s.qty * s.harga_jual END), 0)",
  potential_gross_profit: "COALESCE(SUM(CASE WHEN s.hpp IS NULL OR s.harga_jual IS NULL THEN 0 ELSE s.qty * (s.harga_jual - s.hpp) END), 0)",
  missing_cost_rows: "COUNT(*) FILTER (WHERE s.hpp IS NULL)",
  missing_selling_price_rows: "COUNT(*) FILTER (WHERE s.harga_jual IS NULL)",
  missing_cost_qty: "COALESCE(SUM(s.qty) FILTER (WHERE s.hpp IS NULL), 0)",
  missing_selling_price_qty: "COALESCE(SUM(s.qty) FILTER (WHERE s.harga_jual IS NULL), 0)",
  min_cost_price: "MIN(s.hpp)",
  max_cost_price: "MAX(s.hpp)",
  min_selling_price: "MIN(s.harga_jual)",
  max_selling_price: "MAX(s.harga_jual)",
};

const DEFAULT_QUERY_METRICS = ["qty", "cost_value", "retail_value"];
const DEFAULT_SUMMARY_METRICS = [
  "qty",
  "article_count",
  "model_count",
  "location_count",
  "cost_value",
  "retail_value",
  "potential_gross_profit",
  "missing_cost_rows",
  "missing_selling_price_rows",
];

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampLimit(value, fallback = 20, max = 100) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(num)));
}

function normalizeGroupBy(value, fallback = []) {
  const raw = Array.isArray(value) ? value : value ? [value] : fallback;
  const unique = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  for (const key of unique) {
    if (!DIMENSIONS[key]) throw new Error(`Unsupported group_by dimension: ${key}`);
  }
  return unique;
}

function normalizeMetrics(value, fallback) {
  const raw = Array.isArray(value) && value.length ? value : fallback;
  const unique = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  for (const key of unique) {
    if (!METRICS[key]) throw new Error(`Unsupported metric: ${key}`);
  }
  return unique;
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const offset = Number(decoded?.offset ?? 0);
    return Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
}

async function resolveBatch(snapshot = "latest") {
  const requested = cleanText(snapshot) ?? "latest";
  if (requested.toLowerCase() === "latest") {
    const result = await query(`
      SELECT id, snapshot_date, file_name, status, created_at
      FROM ardiles_stock.import_batches
      WHERE status = 'PUBLISHED'
      ORDER BY snapshot_date DESC, id DESC
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  const result = await query(
    `
      SELECT id, snapshot_date, file_name, status, created_at
      FROM ardiles_stock.import_batches
      WHERE status = 'PUBLISHED'
        AND snapshot_date::date = $1::date
      ORDER BY id DESC
      LIMIT 1
    `,
    [requested]
  );
  return result.rows[0] ?? null;
}

async function latestTwoBatches() {
  const result = await query(`
    SELECT id, snapshot_date, file_name, status, created_at
    FROM ardiles_stock.import_batches
    WHERE status = 'PUBLISHED'
    ORDER BY snapshot_date DESC, id DESC
    LIMIT 2
  `);
  return result.rows;
}

function buildFilters(filters = {}, params = [], startIndex = 2) {
  const where = [];
  const having = [];
  let idx = startIndex;

  const addContains = (key, column) => {
    const value = cleanText(filters[key]);
    if (!value) return;
    where.push(`UPPER(COALESCE(${column}, '')) LIKE '%' || UPPER($${idx}) || '%'`);
    params.push(value);
    idx += 1;
  };

  addContains("article", "s.barang");
  addContains("model", "s.model");
  addContains("location", "s.lokasi");
  addContains("accsys", "s.accsys");
  addContains("division", "s.kadivisi");
  addContains("function", "s.fungsi");
  addContains("supplier", "s.supplier");

  const q = cleanText(filters.q);
  if (q) {
    where.push(`(
      UPPER(COALESCE(s.barang, '')) LIKE '%' || UPPER($${idx}) || '%'
      OR UPPER(COALESCE(s.model, '')) LIKE '%' || UPPER($${idx}) || '%'
      OR UPPER(COALESCE(s.lokasi, '')) LIKE '%' || UPPER($${idx}) || '%'
      OR UPPER(COALESCE(s.accsys, '')) LIKE '%' || UPPER($${idx}) || '%'
    )`);
    params.push(q);
    idx += 1;
  }

  const rowRanges = [
    ["cost_price_min", "s.hpp", ">="],
    ["cost_price_max", "s.hpp", "<="],
    ["selling_price_min", "s.harga_jual", ">="],
    ["selling_price_max", "s.harga_jual", "<="],
  ];

  for (const [key, column, op] of rowRanges) {
    const value = asNumber(filters[key]);
    if (value === null) continue;
    where.push(`${column} ${op} $${idx}`);
    params.push(value);
    idx += 1;
  }

  const aggregateRanges = [
    ["qty_lt", "COALESCE(SUM(s.qty), 0)", "<"],
    ["qty_lte", "COALESCE(SUM(s.qty), 0)", "<="],
    ["qty_gt", "COALESCE(SUM(s.qty), 0)", ">"],
    ["qty_gte", "COALESCE(SUM(s.qty), 0)", ">="],
    ["cost_value_lt", METRICS.cost_value, "<"],
    ["cost_value_gt", METRICS.cost_value, ">"],
    ["retail_value_lt", METRICS.retail_value, "<"],
    ["retail_value_gt", METRICS.retail_value, ">"],
  ];

  for (const [key, expr, op] of aggregateRanges) {
    const value = asNumber(filters[key]);
    if (value === null) continue;
    having.push(`${expr} ${op} $${idx}`);
    params.push(value);
    idx += 1;
  }

  if (filters.zero_stock === true) {
    having.push("COALESCE(SUM(s.qty), 0) = 0");
  }

  if (filters.positive_stock === true) {
    having.push("COALESCE(SUM(s.qty), 0) > 0");
  }

  return { where, having };
}

function selectParts(groupBy, metrics) {
  const dimensionSelect = groupBy.map(
    (key) => `${DIMENSIONS[key].expr} AS "${DIMENSIONS[key].label}"`
  );
  const metricSelect = metrics.map((key) => `${METRICS[key]} AS "${key}"`);

  const derived = [];
  if (metrics.includes("retail_value") || metrics.includes("cost_value")) {
    derived.push(`CASE
      WHEN ${METRICS.retail_value} = 0 THEN NULL
      ELSE ROUND(((${METRICS.potential_gross_profit}) / NULLIF(${METRICS.retail_value}, 0)) * 100, 2)
    END AS "potential_margin_pct"`);
  }

  return {
    select: [...dimensionSelect, ...metricSelect, ...derived],
    groupExpressions: groupBy.map((key) => DIMENSIONS[key].expr),
  };
}

function coerceRow(row) {
  const out = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (value === null || value === undefined) continue;
    if (
      key === "qty" ||
      key.endsWith("_count") ||
      key.endsWith("_rows") ||
      key.endsWith("_qty") ||
      key.endsWith("_value") ||
      key.endsWith("_price") ||
      key.endsWith("_pct") ||
      key === "potential_gross_profit"
    ) {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = num;
    }
  }
  return out;
}

async function runGroupedQuery({
  batch,
  filters = {},
  groupBy,
  metrics,
  sortBy,
  sortDirection = "desc",
  limit = 20,
  cursor = null,
}) {
  if (!batch) return { found: false, message: "No published stock batch found." };

  const safeLimit = clampLimit(limit);
  const offset = decodeCursor(cursor);
  const params = [batch.id];
  const { where, having } = buildFilters(filters, params, 2);
  const { select, groupExpressions } = selectParts(groupBy, metrics);

  const allowedSort = new Set([...groupBy, ...metrics, "potential_margin_pct"]);
  const effectiveSort = allowedSort.has(sortBy) ? sortBy : metrics[0] ?? groupBy[0];
  const direction = String(sortDirection).toLowerCase() === "asc" ? "ASC" : "DESC";

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const groupSql = groupExpressions.length ? `GROUP BY ${groupExpressions.join(", ")}` : "";
  const havingSql = having.length ? `HAVING ${having.join(" AND ")}` : "";

  const baseSql = `
    FROM ardiles_stock.stock_snapshot_rows s
    WHERE s.batch_id = $1
      ${whereSql}
    ${groupSql}
    ${havingSql}
  `;

  const countResult = await query(
    `SELECT COUNT(*) AS total FROM (SELECT 1 ${baseSql}) grouped_count`,
    params
  );
  const total = Number(countResult.rows[0]?.total ?? 0);

  const pageParams = [...params, safeLimit, offset];
  const limitIndex = pageParams.length - 1;
  const offsetIndex = pageParams.length;

  const result = await query(
    `
      SELECT ${select.join(",\n             ")}
      ${baseSql}
      ORDER BY "${effectiveSort}" ${direction} NULLS LAST
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
    `,
    pageParams
  );

  const returned = result.rows.length;
  const nextOffset = offset + returned;

  return {
    found: total > 0,
    snapshot_date: batch.snapshot_date,
    batch_id: Number(batch.id),
    total,
    returned,
    limit: safeLimit,
    has_more: nextOffset < total,
    next_cursor: nextOffset < total ? encodeCursor(nextOffset) : null,
    items: result.rows.map(coerceRow),
  };
}

export async function stockQuery(args = {}) {
  const batch = await resolveBatch(args.snapshot ?? "latest");
  const groupBy = normalizeGroupBy(args.group_by, ["article"]);
  const metrics = normalizeMetrics(args.metrics, DEFAULT_QUERY_METRICS);
  return runGroupedQuery({
    batch,
    filters: args.filters ?? {},
    groupBy,
    metrics,
    sortBy: args.sort_by ?? "qty",
    sortDirection: args.sort_direction ?? "asc",
    limit: args.limit,
    cursor: args.cursor,
  });
}

export async function stockSummary(args = {}) {
  const batch = await resolveBatch(args.snapshot ?? "latest");
  const groupBy = normalizeGroupBy(args.group_by, []);
  const metrics = normalizeMetrics(args.metrics, DEFAULT_SUMMARY_METRICS);

  const result = await runGroupedQuery({
    batch,
    filters: args.filters ?? {},
    groupBy,
    metrics,
    sortBy: args.sort_by ?? metrics[0],
    sortDirection: args.sort_direction ?? "desc",
    limit: groupBy.length ? args.limit ?? 100 : 1,
    cursor: groupBy.length ? args.cursor : null,
  });

  if (!groupBy.length) {
    return {
      found: result.found,
      snapshot_date: result.snapshot_date,
      batch_id: result.batch_id,
      summary: result.items?.[0] ?? {},
    };
  }
  return result;
}

export async function stockValuation(args = {}) {
  const batch = await resolveBatch(args.snapshot ?? "latest");
  const groupBy = normalizeGroupBy(args.group_by, []);
  const basis = String(args.basis ?? "both").toLowerCase();
  if (!["cost", "retail", "both"].includes(basis)) {
    throw new Error("Unsupported valuation basis.");
  }

  const metrics = ["qty"];
  if (basis === "cost" || basis === "both") {
    metrics.push("cost_value", "missing_cost_rows", "missing_cost_qty");
  }
  if (basis === "retail" || basis === "both") {
    metrics.push("retail_value", "missing_selling_price_rows", "missing_selling_price_qty");
  }
  if (basis === "both") metrics.push("potential_gross_profit");

  const result = await runGroupedQuery({
    batch,
    filters: args.filters ?? {},
    groupBy,
    metrics,
    sortBy: args.sort_by ?? (basis === "cost" ? "cost_value" : "retail_value"),
    sortDirection: args.sort_direction ?? "desc",
    limit: groupBy.length ? args.limit ?? 20 : 1,
    cursor: groupBy.length ? args.cursor : null,
  });

  if (!groupBy.length) {
    return {
      found: result.found,
      snapshot_date: result.snapshot_date,
      batch_id: result.batch_id,
      valuation: result.items?.[0] ?? {},
    };
  }
  return result;
}

export async function stockRank(args = {}) {
  const batch = await resolveBatch(args.snapshot ?? "latest");
  const groupBy = normalizeGroupBy(args.group_by, ["article"]);
  if (groupBy.length !== 1) throw new Error("stock_rank requires exactly one group_by dimension.");

  const metric = String(args.metric ?? "qty");
  if (!METRICS[metric]) throw new Error(`Unsupported ranking metric: ${metric}`);

  const metrics = normalizeMetrics(
    args.metrics,
    [...new Set(["qty", metric, "cost_value", "retail_value"])]
  );

  return runGroupedQuery({
    batch,
    filters: args.filters ?? {},
    groupBy,
    metrics,
    sortBy: metric,
    sortDirection: args.direction ?? "desc",
    limit: args.limit ?? 10,
    cursor: args.cursor,
  });
}

function metricExpression(metric) {
  if (!METRICS[metric]) throw new Error(`Unsupported comparison metric: ${metric}`);
  return METRICS[metric];
}

export async function stockCompare(args = {}) {
  let fromBatch = null;
  let toBatch = null;

  if (args.from_snapshot || args.to_snapshot) {
    fromBatch = await resolveBatch(args.from_snapshot);
    toBatch = await resolveBatch(args.to_snapshot ?? "latest");
  } else {
    const batches = await latestTwoBatches();
    toBatch = batches[0] ?? null;
    fromBatch = batches[1] ?? null;
  }

  if (!fromBatch || !toBatch) {
    return {
      found: false,
      available: false,
      message: "At least two published stock snapshots are required for comparison.",
    };
  }

  const groupBy = normalizeGroupBy(args.group_by, ["article"]);
  if (groupBy.length !== 1) throw new Error("stock_compare requires exactly one group_by dimension.");
  const groupKey = groupBy[0];
  const dimension = DIMENSIONS[groupKey];
  const metric = String(args.metric ?? "qty");
  const metricExpr = metricExpression(metric);
  const params = [fromBatch.id, toBatch.id];
  const { where, having } = buildFilters(args.filters ?? {}, params, 3);
  if (having.length) {
    throw new Error("Aggregate filters are not supported by stock_compare yet.");
  }
  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const safeLimit = clampLimit(args.limit ?? 20);
  const direction = String(args.direction ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  params.push(safeLimit);
  const limitIndex = params.length;

  const result = await query(
    `
      WITH from_data AS (
        SELECT ${dimension.expr} AS key, ${metricExpr} AS value
        FROM ardiles_stock.stock_snapshot_rows s
        WHERE s.batch_id = $1 ${whereSql}
        GROUP BY ${dimension.expr}
      ),
      to_data AS (
        SELECT ${dimension.expr} AS key, ${metricExpr} AS value
        FROM ardiles_stock.stock_snapshot_rows s
        WHERE s.batch_id = $2 ${whereSql}
        GROUP BY ${dimension.expr}
      )
      SELECT
        COALESCE(t.key, f.key) AS "${dimension.label}",
        COALESCE(f.value, 0) AS from_value,
        COALESCE(t.value, 0) AS to_value,
        COALESCE(t.value, 0) - COALESCE(f.value, 0) AS delta,
        CASE
          WHEN COALESCE(f.value, 0) = 0 THEN NULL
          ELSE ROUND(((COALESCE(t.value, 0) - COALESCE(f.value, 0)) / NULLIF(f.value, 0)) * 100, 2)
        END AS delta_pct
      FROM from_data f
      FULL OUTER JOIN to_data t ON t.key IS NOT DISTINCT FROM f.key
      ORDER BY ABS(COALESCE(t.value, 0) - COALESCE(f.value, 0)) ${direction} NULLS LAST
      LIMIT $${limitIndex}
    `,
    params
  );

  return {
    found: true,
    available: true,
    metric,
    group_by: groupKey,
    from_snapshot: fromBatch.snapshot_date,
    to_snapshot: toBatch.snapshot_date,
    items: result.rows.map(coerceRow),
  };
}

export async function stockDataHealth(args = {}) {
  const batch = await resolveBatch(args.snapshot ?? "latest");
  if (!batch) return { found: false, message: "No published stock batch found." };

  const result = await query(
    `
      WITH rows AS (
        SELECT *
        FROM ardiles_stock.stock_snapshot_rows
        WHERE batch_id = $1
      ),
      article_price_variance AS (
        SELECT barang
        FROM rows
        GROUP BY barang
        HAVING COUNT(DISTINCT hpp) FILTER (WHERE hpp IS NOT NULL) > 1
            OR COUNT(DISTINCT harga_jual) FILTER (WHERE harga_jual IS NOT NULL) > 1
      )
      SELECT
        COUNT(*) AS total_rows,
        COUNT(DISTINCT barang) AS unique_articles,
        COUNT(DISTINCT model) AS unique_models,
        COUNT(DISTINCT lokasi) AS unique_locations,
        COALESCE(SUM(qty), 0) AS total_qty,
        COUNT(*) FILTER (WHERE barang IS NULL OR BTRIM(barang) = '') AS missing_article_rows,
        COUNT(*) FILTER (WHERE lokasi IS NULL OR BTRIM(lokasi) = '') AS missing_location_rows,
        COUNT(*) FILTER (WHERE hpp IS NULL) AS missing_cost_rows,
        COUNT(*) FILTER (WHERE harga_jual IS NULL) AS missing_selling_price_rows,
        COUNT(*) FILTER (WHERE qty < 0) AS negative_qty_rows,
        COUNT(*) FILTER (WHERE qty = 0) AS zero_qty_rows,
        COALESCE(SUM(qty) FILTER (WHERE hpp IS NULL), 0) AS qty_without_cost,
        COALESCE(SUM(qty) FILTER (WHERE harga_jual IS NULL), 0) AS qty_without_selling_price,
        (SELECT COUNT(*) FROM article_price_variance) AS articles_with_inconsistent_prices
      FROM rows
    `,
    [batch.id]
  );

  return {
    found: true,
    batch_id: Number(batch.id),
    snapshot_date: batch.snapshot_date,
    file_name: batch.file_name,
    ...coerceRow(result.rows[0] ?? {}),
  };
}

export async function runStockDomain(operation, args = {}) {
  switch (operation) {
    case "query":
      return stockQuery(args);
    case "summary":
      return stockSummary(args);
    case "valuation":
      return stockValuation(args);
    case "rank":
      return stockRank(args);
    case "compare":
      return stockCompare(args);
    case "data_health":
      return stockDataHealth(args);
    default:
      throw new Error(`Unsupported stock domain operation: ${operation}`);
  }
}
