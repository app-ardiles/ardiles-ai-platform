import { query } from "@/lib/db";
import {
  cleanText,
  historyStateCtes,
  latestTwoHistoryBatches,
  resolveHistoryBatch,
} from "@/lib/stock-history";

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
  cost_value:
    "COALESCE(SUM(CASE WHEN s.hpp IS NULL THEN 0 ELSE s.qty * s.hpp END), 0)",
  retail_value:
    "COALESCE(SUM(CASE WHEN s.harga_jual IS NULL THEN 0 ELSE s.qty * s.harga_jual END), 0)",
  potential_gross_profit:
    "COALESCE(SUM(CASE WHEN s.hpp IS NULL OR s.harga_jual IS NULL THEN 0 ELSE s.qty * (s.harga_jual - s.hpp) END), 0)",
  missing_cost_rows: "COUNT(*) FILTER (WHERE s.hpp IS NULL)",
  missing_selling_price_rows:
    "COUNT(*) FILTER (WHERE s.harga_jual IS NULL)",
  missing_cost_qty:
    "COALESCE(SUM(s.qty) FILTER (WHERE s.hpp IS NULL), 0)",
  missing_selling_price_qty:
    "COALESCE(SUM(s.qty) FILTER (WHERE s.harga_jual IS NULL), 0)",
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
  const unique = [
    ...new Set(raw.map((x) => String(x).trim()).filter(Boolean)),
  ];

  for (const key of unique) {
    if (!DIMENSIONS[key]) {
      throw new Error(`Unsupported group_by dimension: ${key}`);
    }
  }

  return unique;
}

function normalizeMetrics(value, fallback) {
  const raw = Array.isArray(value) && value.length ? value : fallback;
  const unique = [
    ...new Set(raw.map((x) => String(x).trim()).filter(Boolean)),
  ];

  for (const key of unique) {
    if (!METRICS[key]) {
      throw new Error(`Unsupported metric: ${key}`);
    }
  }

  return unique;
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return 0;

  try {
    const decoded = JSON.parse(
      Buffer.from(String(cursor), "base64url").toString("utf8")
    );

    const offset = Number(decoded?.offset ?? 0);

    return Number.isFinite(offset) && offset >= 0
      ? Math.floor(offset)
      : 0;
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
}

function buildFilters(filters = {}, params = [], startIndex = 2) {
  const where = [];
  const having = [];
  let idx = startIndex;

  const addContains = (key, column) => {
    const value = cleanText(filters[key]);
    if (!value) return;

    where.push(
      `UPPER(COALESCE(${column}, '')) LIKE '%' || UPPER($${idx}) || '%'`
    );

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

  const metricSelect = metrics.map(
    (key) => `${METRICS[key]} AS "${key}"`
  );

  const derived = [];

  if (metrics.includes("retail_value") || metrics.includes("cost_value")) {
    derived.push(`CASE
      WHEN ${METRICS.retail_value} = 0 THEN NULL
      ELSE ROUND(
        ((${METRICS.potential_gross_profit}) /
        NULLIF(${METRICS.retail_value}, 0)) * 100,
        2
      )
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
      key === "from_qty" ||
      key === "to_qty" ||
      key === "change_qty" ||
      key === "change_pct" ||
      key === "abs_change" ||
      key.startsWith("from_total_") ||
      key.startsWith("to_total_") ||
      key.startsWith("increase_") ||
      key.startsWith("decrease_") ||
      key.startsWith("same_") ||
      key.startsWith("new_") ||
      key.startsWith("missing_") ||
      key.endsWith("_count") ||
      key.endsWith("_rows") ||
      key.endsWith("_qty") ||
      key.endsWith("_value") ||
      key.endsWith("_price") ||
      key.endsWith("_pct") ||
      key === "net_qty_change" ||
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
  if (!batch) {
    return {
      found: false,
      message: "No published stock batch found.",
    };
  }

  const safeLimit = clampLimit(limit);
  const offset = decodeCursor(cursor);

  const params = [batch.snapshot_date];
  const { where, having } = buildFilters(filters, params, 2);
  const { select, groupExpressions } = selectParts(groupBy, metrics);

  const allowedSort = new Set([...groupBy, ...metrics]);

  if (metrics.includes("retail_value") || metrics.includes("cost_value")) {
    allowedSort.add("potential_margin_pct");
  }

  const effectiveSort = allowedSort.has(sortBy)
    ? sortBy
    : metrics[0] ?? groupBy[0];

  const direction =
    String(sortDirection).toLowerCase() === "asc" ? "ASC" : "DESC";

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const groupSql = groupExpressions.length
    ? `GROUP BY ${groupExpressions.join(", ")}`
    : "";

  const havingSql = having.length
    ? `HAVING ${having.join(" AND ")}`
    : "";

  const stateCtes = historyStateCtes("$1", "q");

  const baseSql = `
    FROM q_state_rows s
    WHERE TRUE
      ${whereSql}
    ${groupSql}
    ${havingSql}
  `;

  const countResult = await query(
    `
      WITH
      ${stateCtes}
      SELECT COUNT(*) AS total
      FROM (
        SELECT 1
        ${baseSql}
      ) grouped_count
    `,
    params
  );

  const total = Number(countResult.rows[0]?.total ?? 0);

  const pageParams = [...params, safeLimit, offset];
  const limitIndex = pageParams.length - 1;
  const offsetIndex = pageParams.length;

  const result = await query(
    `
      WITH
      ${stateCtes}
      SELECT
        ${select.join(",\n        ")}
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
  const batch = await resolveHistoryBatch(args.snapshot ?? "latest");
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
  const batch = await resolveHistoryBatch(args.snapshot ?? "latest");
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
  const batch = await resolveHistoryBatch(args.snapshot ?? "latest");
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
    metrics.push(
      "retail_value",
      "missing_selling_price_rows",
      "missing_selling_price_qty"
    );
  }

  if (basis === "both") {
    metrics.push("potential_gross_profit");
  }

  const result = await runGroupedQuery({
    batch,
    filters: args.filters ?? {},
    groupBy,
    metrics,
    sortBy:
      args.sort_by ??
      (basis === "cost" ? "cost_value" : "retail_value"),
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
  const batch = await resolveHistoryBatch(args.snapshot ?? "latest");
  const groupBy = normalizeGroupBy(args.group_by, ["article"]);

  if (groupBy.length !== 1) {
    throw new Error(
      "stock_rank requires exactly one group_by dimension."
    );
  }

  const metric = String(args.metric ?? "qty");

  if (!METRICS[metric]) {
    throw new Error(`Unsupported ranking metric: ${metric}`);
  }

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
  if (!METRICS[metric]) {
    throw new Error(`Unsupported comparison metric: ${metric}`);
  }

  return METRICS[metric];
}

export async function stockCompare(args = {}) {
  let fromBatch = null;
  let toBatch = null;

  if (args.from_snapshot || args.to_snapshot) {
    fromBatch = await resolveHistoryBatch(args.from_snapshot);
    toBatch = await resolveHistoryBatch(
      args.to_snapshot ?? "latest"
    );
  } else {
    const batches = await latestTwoHistoryBatches();
    toBatch = batches[0] ?? null;
    fromBatch = batches[1] ?? null;
  }

  if (!fromBatch || !toBatch) {
    return {
      found: false,
      available: false,
      message:
        "At least two published stock snapshots are required for comparison.",
    };
  }

  const groupBy = normalizeGroupBy(args.group_by, ["article"]);

  if (groupBy.length !== 1) {
    throw new Error(
      "stock_compare requires exactly one group_by dimension."
    );
  }

  const groupKey = groupBy[0];
  const dimension = DIMENSIONS[groupKey];
  const metric = String(args.metric ?? "qty");
  const metricExpr = metricExpression(metric);

  const params = [fromBatch.snapshot_date, toBatch.snapshot_date];
  const { where, having } = buildFilters(
    args.filters ?? {},
    params,
    3
  );

  if (having.length) {
    throw new Error(
      "Aggregate filters are not supported by stock_compare."
    );
  }

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const safeLimit = clampLimit(args.limit ?? 20);
  const direction =
    String(args.direction ?? "desc").toLowerCase() === "asc"
      ? "ASC"
      : "DESC";

  params.push(safeLimit);
  const limitIndex = params.length;

  const fromCtes = historyStateCtes("$1", "cf");
  const toCtes = historyStateCtes("$2", "ct");

  const result = await query(
    `
      WITH
      ${fromCtes},
      ${toCtes},

      from_data AS (
        SELECT
          ${dimension.expr} AS key,
          ${metricExpr} AS value
        FROM cf_state_rows s
        WHERE TRUE
          ${whereSql}
        GROUP BY ${dimension.expr}
      ),

      to_data AS (
        SELECT
          ${dimension.expr} AS key,
          ${metricExpr} AS value
        FROM ct_state_rows s
        WHERE TRUE
          ${whereSql}
        GROUP BY ${dimension.expr}
      )

      SELECT
        COALESCE(t.key, f.key) AS "${dimension.label}",
        COALESCE(f.value, 0) AS from_value,
        COALESCE(t.value, 0) AS to_value,
        COALESCE(t.value, 0) - COALESCE(f.value, 0) AS delta,

        CASE
          WHEN COALESCE(f.value, 0) = 0 THEN NULL
          ELSE ROUND(
            (
              (
                COALESCE(t.value, 0) -
                COALESCE(f.value, 0)
              ) /
              NULLIF(f.value, 0)
            ) * 100,
            2
          )
        END AS delta_pct

      FROM from_data f
      FULL OUTER JOIN to_data t
        ON t.key IS NOT DISTINCT FROM f.key

      ORDER BY
        ABS(COALESCE(t.value, 0) - COALESCE(f.value, 0))
        ${direction}
        NULLS LAST

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

function normalizeStockChangeType(value) {
  const type = String(value ?? "all").trim().toLowerCase();

  const allowed = new Set([
    "all",
    "changed",
    "increase",
    "decrease",
    "same",
    "new",
    "missing",
  ]);

  if (!allowed.has(type)) {
    throw new Error(`Unsupported stock change type: ${type}`);
  }

  return type;
}

function stockChangeFilterSql(type) {
  switch (type) {
    case "changed":
      return `
        from_exists = TRUE
        AND to_exists = TRUE
        AND change_qty <> 0
      `;

    case "increase":
      return `
        from_exists = TRUE
        AND to_exists = TRUE
        AND change_qty > 0
      `;

    case "decrease":
      return `
        from_exists = TRUE
        AND to_exists = TRUE
        AND change_qty < 0
      `;

    case "same":
      return `
        from_exists = TRUE
        AND to_exists = TRUE
        AND change_qty = 0
      `;

    case "new":
      return `
        from_exists = FALSE
        AND to_exists = TRUE
      `;

    case "missing":
      return `
        from_exists = TRUE
        AND to_exists = FALSE
      `;

    default:
      return "TRUE";
  }
}

function stockChangeSortSql(value) {
  const sort = String(value ?? "abs_change").trim().toLowerCase();

  const allowed = new Set([
    "abs_change",
    "change",
    "from_qty",
    "to_qty",
  ]);

  if (!allowed.has(sort)) {
    throw new Error(`Unsupported stock change sort: ${sort}`);
  }

  if (sort === "change") return "change_qty";
  if (sort === "from_qty") return "from_qty";
  if (sort === "to_qty") return "to_qty";
  return "ABS(change_qty)";
}

export async function stockChanges(args = {}) {
  let fromBatch = null;
  let toBatch = null;

  if (args.from_snapshot || args.to_snapshot) {
    fromBatch = await resolveHistoryBatch(args.from_snapshot);
    toBatch = await resolveHistoryBatch(
      args.to_snapshot ?? "latest"
    );
  } else {
    const batches = await latestTwoHistoryBatches();
    toBatch = batches[0] ?? null;
    fromBatch = batches[1] ?? null;
  }

  if (!fromBatch || !toBatch) {
    return {
      found: false,
      available: false,
      message:
        "At least two published stock snapshots are required for stock changes.",
    };
  }

  const groupBy = normalizeGroupBy(args.group_by, ["article"]);

  if (!groupBy.length) {
    throw new Error(
      "stock_changes requires at least one group_by dimension."
    );
  }

  if (groupBy.length > 3) {
    throw new Error(
      "stock_changes supports at most three group_by dimensions."
    );
  }

  const changeType = normalizeStockChangeType(
    args.change_type ?? "all"
  );

  const safeLimit = clampLimit(args.limit ?? 20);
  const offset = decodeCursor(args.cursor);

  const params = [fromBatch.snapshot_date, toBatch.snapshot_date];
  const { where, having } = buildFilters(
    args.filters ?? {},
    params,
    3
  );

  if (having.length) {
    throw new Error(
      "Aggregate filters are not supported by stock_changes."
    );
  }

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";

  const dimensionSelect = groupBy.map(
    (key) => `${DIMENSIONS[key].expr} AS "${DIMENSIONS[key].label}"`
  );

  const groupExpressions = groupBy.map(
    (key) => DIMENSIONS[key].expr
  );

  const outputDimensions = groupBy.map(
    (key) => DIMENSIONS[key].label
  );

  const joinConditions = outputDimensions
    .map(
      (label) =>
        `t."${label}" IS NOT DISTINCT FROM f."${label}"`
    )
    .join(" AND ");

  const joinedDimensionSelect = outputDimensions
    .map(
      (label) =>
        `COALESCE(t."${label}", f."${label}") AS "${label}"`
    )
    .join(",\n        ");

  const fromCtes = historyStateCtes("$1", "sf");
  const toCtes = historyStateCtes("$2", "st");

  const commonSql = `
    WITH
    ${fromCtes},
    ${toCtes},

    from_filtered AS (
      SELECT *
      FROM sf_state_rows s
      WHERE TRUE
        ${whereSql}
    ),

    to_filtered AS (
      SELECT *
      FROM st_state_rows s
      WHERE TRUE
        ${whereSql}
    ),

    detail_diff AS (
      SELECT
        f.product_id AS from_product_id,
        f.location_id AS from_location_id,
        f.accsys_id AS from_accsys_id,

        t.product_id AS to_product_id,
        t.location_id AS to_location_id,
        t.accsys_id AS to_accsys_id,

        f.qty AS from_qty,
        t.qty AS to_qty,

        f.hpp AS from_hpp,
        t.hpp AS to_hpp,

        f.rp AS from_rp,
        t.rp AS to_rp,

        f.harga_jual AS from_harga_jual,
        t.harga_jual AS to_harga_jual

      FROM from_filtered f

      FULL OUTER JOIN to_filtered t
        ON t.product_id = f.product_id
       AND t.location_id = f.location_id
       AND t.accsys_id = f.accsys_id
    ),

    detail_summary AS (
      SELECT
        (SELECT COALESCE(SUM(qty), 0) FROM from_filtered)
          AS from_total_qty,

        (SELECT COALESCE(SUM(qty), 0) FROM to_filtered)
          AS to_total_qty,

        COUNT(*) FILTER (
          WHERE from_product_id IS NOT NULL
            AND to_product_id IS NOT NULL
            AND to_qty > from_qty
        ) AS increase_count,

        COUNT(*) FILTER (
          WHERE from_product_id IS NOT NULL
            AND to_product_id IS NOT NULL
            AND to_qty < from_qty
        ) AS decrease_count,

        COUNT(*) FILTER (
          WHERE from_product_id IS NOT NULL
            AND to_product_id IS NOT NULL
            AND to_qty = from_qty
        ) AS same_count,

        COUNT(*) FILTER (
          WHERE from_product_id IS NULL
            AND to_product_id IS NOT NULL
        ) AS new_count,

        COUNT(*) FILTER (
          WHERE from_product_id IS NOT NULL
            AND to_product_id IS NULL
        ) AS missing_count,

        COALESCE(
          SUM(to_qty - from_qty) FILTER (
            WHERE from_product_id IS NOT NULL
              AND to_product_id IS NOT NULL
              AND to_qty > from_qty
          ),
          0
        ) AS increase_qty,

        COALESCE(
          SUM(from_qty - to_qty) FILTER (
            WHERE from_product_id IS NOT NULL
              AND to_product_id IS NOT NULL
              AND to_qty < from_qty
          ),
          0
        ) AS decrease_qty,

        (
          (SELECT COALESCE(SUM(qty), 0) FROM to_filtered) -
          (SELECT COALESCE(SUM(qty), 0) FROM from_filtered)
        ) AS net_qty_change,

        COUNT(*) FILTER (
          WHERE from_product_id IS NOT NULL
            AND to_product_id IS NOT NULL
            AND to_qty = from_qty
            AND (
              to_hpp IS DISTINCT FROM from_hpp
              OR to_rp IS DISTINCT FROM from_rp
              OR to_harga_jual IS DISTINCT FROM from_harga_jual
            )
        ) AS price_only_changed_count

      FROM detail_diff
    ),

    from_grouped AS (
      SELECT
        ${dimensionSelect.join(",\n        ")},
        COALESCE(SUM(s.qty), 0) AS qty,
        TRUE AS exists_flag

      FROM from_filtered s

      GROUP BY
        ${groupExpressions.join(", ")}
    ),

    to_grouped AS (
      SELECT
        ${dimensionSelect.join(",\n        ")},
        COALESCE(SUM(s.qty), 0) AS qty,
        TRUE AS exists_flag

      FROM to_filtered s

      GROUP BY
        ${groupExpressions.join(", ")}
    ),

    joined_groups AS (
      SELECT
        ${joinedDimensionSelect},

        (f.exists_flag IS TRUE) AS from_exists,
        (t.exists_flag IS TRUE) AS to_exists,

        COALESCE(f.qty, 0) AS from_qty,
        COALESCE(t.qty, 0) AS to_qty,

        COALESCE(t.qty, 0) - COALESCE(f.qty, 0)
          AS change_qty,

        ABS(
          COALESCE(t.qty, 0) - COALESCE(f.qty, 0)
        ) AS abs_change,

        CASE
          WHEN f.exists_flag IS NOT TRUE
            AND t.exists_flag IS TRUE
            THEN 'NEW'

          WHEN f.exists_flag IS TRUE
            AND t.exists_flag IS NOT TRUE
            THEN 'MISSING'

          WHEN COALESCE(t.qty, 0) > COALESCE(f.qty, 0)
            THEN 'INCREASE'

          WHEN COALESCE(t.qty, 0) < COALESCE(f.qty, 0)
            THEN 'DECREASE'

          ELSE 'SAME'
        END AS change_type,

        CASE
          WHEN COALESCE(f.qty, 0) = 0
            THEN NULL
          ELSE ROUND(
            (
              (
                COALESCE(t.qty, 0) -
                COALESCE(f.qty, 0)
              ) /
              NULLIF(f.qty, 0)
            ) * 100,
            2
          )
        END AS change_pct

      FROM from_grouped f

      FULL OUTER JOIN to_grouped t
        ON ${joinConditions}
    ),

    filtered_groups AS (
      SELECT *
      FROM joined_groups
      WHERE ${stockChangeFilterSql(changeType)}
    )
  `;

  const countResult = await query(
    `
      ${commonSql}
      SELECT COUNT(*) AS total
      FROM filtered_groups
    `,
    params
  );

  const total = Number(countResult.rows[0]?.total ?? 0);

  const summaryResult = await query(
    `
      ${commonSql}
      SELECT *
      FROM detail_summary
    `,
    params
  );

  const direction =
    String(args.direction ?? "desc").toLowerCase() === "asc"
      ? "ASC"
      : "DESC";

  const sortSql = stockChangeSortSql(
    args.sort_by ?? "abs_change"
  );

  const pageParams = [...params, safeLimit, offset];
  const limitIndex = pageParams.length - 1;
  const offsetIndex = pageParams.length;

  const itemsResult = await query(
    `
      ${commonSql}
      SELECT *
      FROM filtered_groups
      ORDER BY
        ${sortSql} ${direction} NULLS LAST,
        ${outputDimensions
          .map((label) => `"${label}" ASC NULLS LAST`)
          .join(", ")}
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
    `,
    pageParams
  );

  const returned = itemsResult.rows.length;
  const nextOffset = offset + returned;

  return {
    found: true,
    available: true,

    from_snapshot: fromBatch.snapshot_date,
    to_snapshot: toBatch.snapshot_date,

    from_batch_id: Number(fromBatch.id),
    to_batch_id: Number(toBatch.id),

    group_by: groupBy,
    change_type: changeType,

    summary: coerceRow(summaryResult.rows[0] ?? {}),

    total,
    returned,
    limit: safeLimit,
    has_more: nextOffset < total,
    next_cursor: nextOffset < total
      ? encodeCursor(nextOffset)
      : null,

    items: itemsResult.rows.map(coerceRow),

    interpretation: {
      language:
        "Use user-facing phrases such as perubahan stok, stok bertambah, stok berkurang, stok tetap, and selisih stok.",
      avoid_terms: ["movement", "position", "delta"],
      causality:
        "These are net differences between stock snapshots. Do not infer sales, purchase receipts, returns, transfers, or other causes without supporting transaction data.",
    },
  };
}

export async function stockDataHealth(args = {}) {
  const batch = await resolveHistoryBatch(args.snapshot ?? "latest");

  if (!batch) {
    return {
      found: false,
      message: "No published stock batch found.",
    };
  }

  const stateCtes = historyStateCtes("$1", "dh");

  const result = await query(
    `
      WITH
      ${stateCtes},

      rows AS (
        SELECT *
        FROM dh_state_rows
      ),

      article_price_variance AS (
        SELECT barang
        FROM rows
        GROUP BY barang
        HAVING
          COUNT(DISTINCT hpp)
            FILTER (WHERE hpp IS NOT NULL) > 1
          OR
          COUNT(DISTINCT harga_jual)
            FILTER (WHERE harga_jual IS NOT NULL) > 1
      )

      SELECT
        COUNT(*) AS total_rows,
        COUNT(DISTINCT barang) AS unique_articles,
        COUNT(DISTINCT model) AS unique_models,
        COUNT(DISTINCT lokasi) AS unique_locations,
        COALESCE(SUM(qty), 0) AS total_qty,

        COUNT(*) FILTER (
          WHERE barang IS NULL OR BTRIM(barang) = ''
        ) AS missing_article_rows,

        COUNT(*) FILTER (
          WHERE lokasi IS NULL OR BTRIM(lokasi) = ''
        ) AS missing_location_rows,

        COUNT(*) FILTER (
          WHERE hpp IS NULL
        ) AS missing_cost_rows,

        COUNT(*) FILTER (
          WHERE harga_jual IS NULL
        ) AS missing_selling_price_rows,

        COUNT(*) FILTER (
          WHERE qty < 0
        ) AS negative_qty_rows,

        COUNT(*) FILTER (
          WHERE qty = 0
        ) AS zero_qty_rows,

        COALESCE(
          SUM(qty) FILTER (WHERE hpp IS NULL),
          0
        ) AS qty_without_cost,

        COALESCE(
          SUM(qty) FILTER (
            WHERE harga_jual IS NULL
          ),
          0
        ) AS qty_without_selling_price,

        (
          SELECT COUNT(*)
          FROM article_price_variance
        ) AS articles_with_inconsistent_prices

      FROM rows
    `,
    [batch.snapshot_date]
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

    case "changes":
      return stockChanges(args);

    case "data_health":
      return stockDataHealth(args);

    default:
      throw new Error(
        `Unsupported stock domain operation: ${operation}`
      );
  }
}
