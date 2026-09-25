import { query } from "@/lib/db";
import {
  historyStateCtes,
  resolveHistoryBatch,
} from "@/lib/stock-history";

export async function latestPublishedBatch() {
  return resolveHistoryBatch("latest");
}

export async function searchStockItem(rawQuery) {
  const q = String(rawQuery ?? "").trim();

  if (!q) {
    return {
      query: q,
      found: false,
      count: 0,
      needs_confirmation: false,
      message: "Model atau barang tidak ditemukan.",
      candidates: [],
    };
  }

  const batch = await resolveHistoryBatch("latest");

  if (!batch) {
    return {
      query: q,
      found: false,
      count: 0,
      needs_confirmation: false,
      message: "Belum ada snapshot stok yang dipublish.",
      candidates: [],
    };
  }

  const stateCtes = historyStateCtes("$1", "ss");

  const result = await query(
    `
      WITH
      ${stateCtes},

      params AS (
        SELECT UPPER(TRIM($2::text)) AS q
      ),

      catalog AS (
        SELECT DISTINCT
          $1::date AS snapshot_date,
          s.model,

          REGEXP_REPLACE(
            s.model,
            '(\\s*\\([^)]*\\))+\\s*$',
            '',
            'g'
          ) AS base_model,

          REGEXP_REPLACE(
            REGEXP_REPLACE(
              s.model,
              '(\\s*\\([^)]*\\))+\\s*$',
              '',
              'g'
            ),
            '^[A-Z0-9]+-',
            ''
          ) AS search_name,

          s.barang

        FROM ss_state_rows s
      ),

      model_summary AS (
        SELECT
          snapshot_date,
          base_model,
          search_name,
          COUNT(DISTINCT model) AS model_variants,
          COUNT(DISTINCT barang) AS item_variants

        FROM catalog

        GROUP BY
          snapshot_date,
          base_model,
          search_name
      ),

      direct_matches AS (
        SELECT
          snapshot_date,
          base_model,
          search_name,
          model_variants,
          item_variants,
          1.0::NUMERIC AS similarity_score,
          'direct'::TEXT AS match_type

        FROM model_summary
        CROSS JOIN params

        WHERE
          UPPER(base_model) LIKE '%' || params.q || '%'
          OR UPPER(search_name) LIKE '%' || params.q || '%'
      ),

      token_candidates AS (
        SELECT
          m.snapshot_date,
          m.base_model,
          m.search_name,
          m.model_variants,
          m.item_variants,
          token,
          params.q

        FROM model_summary m
        CROSS JOIN params

        CROSS JOIN LATERAL regexp_split_to_table(
          UPPER(
            COALESCE(m.search_name, '') || ' ' ||
            COALESCE(m.base_model, '')
          ),
          '[^A-Z0-9]+'
        ) AS token

        WHERE LENGTH(token) >= 4
          AND token !~ '^[0-9]+$'
          AND ABS(LENGTH(token) - LENGTH(params.q)) <= 4
      ),

      fuzzy_scored AS (
        SELECT
          snapshot_date,
          base_model,
          search_name,
          model_variants,
          item_variants,

          MAX(
            1.0 -
            LEVENSHTEIN(token, q)::NUMERIC /
            GREATEST(LENGTH(token), LENGTH(q))
          ) AS similarity_score

        FROM token_candidates

        GROUP BY
          snapshot_date,
          base_model,
          search_name,
          model_variants,
          item_variants
      ),

      fuzzy_matches AS (
        SELECT
          snapshot_date,
          base_model,
          search_name,
          model_variants,
          item_variants,
          similarity_score,
          'fuzzy'::TEXT AS match_type

        FROM fuzzy_scored

        WHERE similarity_score >= 0.65

        ORDER BY
          similarity_score DESC,
          base_model

        LIMIT 5
      )

      SELECT *
      FROM direct_matches

      UNION ALL

      SELECT *
      FROM fuzzy_matches

      WHERE NOT EXISTS (
        SELECT 1
        FROM direct_matches
      )

      ORDER BY
        similarity_score DESC,
        base_model

      LIMIT 10
    `,
    [batch.snapshot_date, q]
  );

  const rows = result.rows;

  if (!rows.length) {
    return {
      query: q,
      found: false,
      count: 0,
      needs_confirmation: false,
      message: "Model atau barang tidak ditemukan.",
      candidates: [],
    };
  }

  const best = rows[0];
  const isFuzzy = best.match_type === "fuzzy";
  const multiple = rows.length > 1;

  return {
    query: q,
    found: true,
    count: rows.length,
    snapshot_date: best.snapshot_date,
    match_type: best.match_type,
    needs_confirmation: isFuzzy || multiple,

    message: isFuzzy
      ? "Ditemukan model yang kemungkinan sesuai."
      : multiple
      ? "Ditemukan beberapa kelompok model."
      : "Model ditemukan.",

    candidates: rows.map((row) => ({
      base_model: row.base_model,
      search_name: row.search_name,
      model_variants: Number(row.model_variants),
      item_variants: Number(row.item_variants),
      similarity_score: Number(row.similarity_score),
      match_type: row.match_type,
    })),
  };
}

export async function getModelVariants(baseModel) {
  const batch = await resolveHistoryBatch("latest");

  if (!batch) {
    return {
      base_model: baseModel,
      found: false,
      variant_count: 0,
      sizes: [],
      colors: [],
      variants: [],
    };
  }

  const stateCtes = historyStateCtes("$1", "mv");

  const result = await query(
    `
      WITH
      ${stateCtes},

      stock AS (
        SELECT
          $1::date AS snapshot_date,
          s.model,
          s.barang,
          s.lokasi,
          s.qty,

          REGEXP_REPLACE(
            s.model,
            '(\\s*\\([^)]*\\))+\\s*$',
            '',
            'g'
          ) AS base_model

        FROM mv_state_rows s
      ),

      location_totals AS (
        SELECT
          snapshot_date,
          model,
          barang,
          lokasi,
          SUM(qty) AS location_qty

        FROM stock

        WHERE UPPER(base_model) = UPPER($2)

        GROUP BY
          snapshot_date,
          model,
          barang,
          lokasi
      ),

      variants AS (
        SELECT
          snapshot_date,
          model,
          barang,

          SUM(location_qty) AS total_qty,
          COUNT(*) AS total_locations,

          ARRAY_AGG(
            lokasi
            ORDER BY lokasi
          ) AS locations,

          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'lokasi',
              lokasi,
              'qty',
              location_qty
            )
            ORDER BY lokasi
          ) AS location_details

        FROM location_totals

        GROUP BY
          snapshot_date,
          model,
          barang
      )

      SELECT *
      FROM variants

      ORDER BY
        model,
        barang
    `,
    [batch.snapshot_date, baseModel]
  );

  const rows = result.rows;

  if (!rows.length) {
    return {
      base_model: baseModel,
      found: false,
      variant_count: 0,
      sizes: [],
      colors: [],
      variants: [],
    };
  }

  const getSize = (model) => {
    const match = String(model ?? "").match(/\((\d+)\)/);
    return match ? Number(match[1]) : null;
  };

  const getColor = (model, barang) => {
    const m = String(model ?? "").trim();
    const b = String(barang ?? "").trim();
    return b.startsWith(m) ? b.slice(m.length).trim() : null;
  };

  const variants = rows.map((row) => ({
    model: row.model,
    barang: row.barang,
    size: getSize(row.model),
    color: getColor(row.model, row.barang),
    total_qty: Number(row.total_qty),
    total_locations: Number(row.total_locations),
    locations: row.locations ?? [],
    location_details: row.location_details ?? [],
  }));

  const sizes = [
    ...new Set(
      variants
        .map((x) => x.size)
        .filter((x) => x !== null)
    ),
  ].sort((a, b) => a - b);

  const colors = [
    ...new Set(
      variants
        .map((x) => x.color)
        .filter(Boolean)
    ),
  ].sort();

  return {
    base_model: baseModel,
    found: true,
    snapshot_date: rows[0].snapshot_date,
    variant_count: variants.length,
    sizes,
    colors,

    total_qty_all_variants: variants.reduce(
      (sum, x) => sum + x.total_qty,
      0
    ),

    variants,
  };
}

export async function getStockDetail(barang) {
  const batch = await resolveHistoryBatch("latest");

  if (!batch) {
    return {
      barang,
      found: false,
    };
  }

  const stateCtes = historyStateCtes("$1", "sd");

  const result = await query(
    `
      WITH
      ${stateCtes},

      stock_rows AS (
        SELECT
          $1::date AS snapshot_date,
          s.model,
          s.barang,
          s.lokasi,
          s.accsys,
          s.qty

        FROM sd_state_rows s

        WHERE UPPER(s.barang) = UPPER($2)
      ),

      location_totals AS (
        SELECT
          lokasi,
          SUM(qty) AS qty

        FROM stock_rows

        GROUP BY lokasi
      ),

      accsys_totals AS (
        SELECT
          accsys,
          SUM(qty) AS qty

        FROM stock_rows

        GROUP BY accsys
      )

      SELECT
        MIN(snapshot_date) AS snapshot_date,
        MIN(model) AS model,
        MIN(barang) AS barang,
        SUM(qty) AS total_qty,
        COUNT(DISTINCT lokasi) AS total_locations,

        (
          SELECT JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'lokasi',
              lokasi,
              'qty',
              qty
            )
            ORDER BY lokasi
          )
          FROM location_totals
        ) AS location_details,

        (
          SELECT JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'accsys',
              accsys,
              'qty',
              qty
            )
            ORDER BY accsys
          )
          FROM accsys_totals
        ) AS accsys_details

      FROM stock_rows
    `,
    [batch.snapshot_date, barang]
  );

  const row = result.rows[0];

  if (!row?.barang) {
    return {
      barang,
      found: false,
    };
  }

  return {
    found: true,
    snapshot_date: row.snapshot_date,
    model: row.model,
    barang: row.barang,
    total_qty: Number(row.total_qty),
    total_locations: Number(row.total_locations),
    location_details: row.location_details ?? [],
    accsys_details: row.accsys_details ?? [],
  };
}

export async function getStockByLocation(barang, lokasi) {
  const batch = await resolveHistoryBatch("latest");

  if (!batch) {
    return {
      found: false,
      barang,
      location_query: lokasi,
      matches: [],
    };
  }

  const stateCtes = historyStateCtes("$1", "sl");

  const result = await query(
    `
      WITH
      ${stateCtes}

      SELECT
        $1::date AS snapshot_date,
        s.model,
        s.barang,
        s.lokasi,
        SUM(s.qty) AS qty,

        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'accsys',
            s.accsys,
            'qty',
            s.qty
          )
          ORDER BY s.accsys
        ) AS accsys_details

      FROM sl_state_rows s

      WHERE UPPER(s.barang) = UPPER($2)
        AND UPPER(s.lokasi) LIKE '%' || UPPER($3) || '%'

      GROUP BY
        s.model,
        s.barang,
        s.lokasi

      ORDER BY s.lokasi
    `,
    [batch.snapshot_date, barang, lokasi]
  );

  return {
    found: result.rows.length > 0,
    barang,
    location_query: lokasi,

    matches: result.rows.map((row) => ({
      snapshot_date: row.snapshot_date,
      model: row.model,
      barang: row.barang,
      lokasi: row.lokasi,
      qty: Number(row.qty),
      accsys_details: row.accsys_details ?? [],
    })),
  };
}

export async function getStockByAccsys(barang, accsys) {
  const batch = await resolveHistoryBatch("latest");

  if (!batch) {
    return {
      found: false,
      barang,
      accsys_query: accsys,
      matches: [],
    };
  }

  const stateCtes = historyStateCtes("$1", "sa");

  const result = await query(
    `
      WITH
      ${stateCtes}

      SELECT
        $1::date AS snapshot_date,
        s.model,
        s.barang,
        s.accsys,
        SUM(s.qty) AS qty,

        JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'lokasi',
            s.lokasi,
            'qty',
            s.qty
          )
          ORDER BY s.lokasi
        ) AS location_details

      FROM sa_state_rows s

      WHERE UPPER(s.barang) = UPPER($2)
        AND UPPER(s.accsys) LIKE '%' || UPPER($3) || '%'

      GROUP BY
        s.model,
        s.barang,
        s.accsys

      ORDER BY s.accsys
    `,
    [batch.snapshot_date, barang, accsys]
  );

  return {
    found: result.rows.length > 0,
    barang,
    accsys_query: accsys,

    matches: result.rows.map((row) => ({
      snapshot_date: row.snapshot_date,
      model: row.model,
      barang: row.barang,
      accsys: row.accsys,
      qty: Number(row.qty),
      location_details: row.location_details ?? [],
    })),
  };
}

export async function getLocationSummary(lokasi) {
  const batch = await resolveHistoryBatch("latest");

  if (!batch) {
    return {
      found: false,
      location_query: lokasi,
      snapshot_date: null,
      matched_locations: 0,
      unique_items: 0,
      total_qty: 0,
      top_items: [],
    };
  }

  const stateCtes = historyStateCtes("$1", "ls");

  const result = await query(
    `
      WITH
      ${stateCtes},

      matched AS (
        SELECT
          $1::date AS snapshot_date,
          s.lokasi,
          s.barang,
          s.model,
          s.qty

        FROM ls_state_rows s

        WHERE UPPER(s.lokasi) LIKE '%' || UPPER($2) || '%'
      ),

      totals AS (
        SELECT
          MIN(snapshot_date) AS snapshot_date,
          COUNT(DISTINCT lokasi) AS matched_locations,
          COUNT(DISTINCT barang) AS unique_items,
          SUM(qty) AS total_qty

        FROM matched
      ),

      top_items AS (
        SELECT
          barang,
          model,
          SUM(qty) AS qty

        FROM matched

        GROUP BY
          barang,
          model

        ORDER BY qty DESC

        LIMIT 20
      )

      SELECT
        t.snapshot_date,
        t.matched_locations,
        t.unique_items,
        t.total_qty,

        COALESCE(
          (
            SELECT JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'barang',
                barang,
                'model',
                model,
                'qty',
                qty
              )
              ORDER BY qty DESC
            )
            FROM top_items
          ),
          '[]'::jsonb
        ) AS top_items

      FROM totals t
    `,
    [batch.snapshot_date, lokasi]
  );

  const row = result.rows[0];

  return {
    found: Number(row?.matched_locations ?? 0) > 0,
    location_query: lokasi,
    snapshot_date: row?.snapshot_date ?? null,
    matched_locations: Number(row?.matched_locations ?? 0),
    unique_items: Number(row?.unique_items ?? 0),
    total_qty: Number(row?.total_qty ?? 0),
    top_items: row?.top_items ?? [],
  };
}

export async function getStockDataStatus() {
  const batch = await latestPublishedBatch();

  if (!batch) {
    return {
      found: false,
      message: "No published stock batch found.",
    };
  }

  const stateCtes = historyStateCtes("$1", "st");

  const totals = await query(
    `
      WITH
      ${stateCtes}

      SELECT
        COUNT(*) AS total_stock_rows,
        SUM(qty) AS total_qty,
        COUNT(DISTINCT barang) AS unique_items,
        COUNT(DISTINCT lokasi) AS unique_locations

      FROM st_state_rows
    `,
    [batch.snapshot_date]
  );

  const t = totals.rows[0];

  return {
    found: true,
    batch_id: Number(batch.id),
    snapshot_date: batch.snapshot_date,
    file_name: batch.file_name,
    status: batch.status,

    total_rows_declared:
      batch.total_rows === null
        ? null
        : Number(batch.total_rows),

    valid_rows:
      batch.valid_rows === null
        ? null
        : Number(batch.valid_rows),

    duplicate_rows:
      batch.duplicate_rows === null
        ? null
        : Number(batch.duplicate_rows),

    conflict_rows:
      batch.conflict_rows === null
        ? null
        : Number(batch.conflict_rows),

    total_stock_rows:
      Number(t?.total_stock_rows ?? 0),

    total_qty:
      Number(t?.total_qty ?? 0),

    unique_items:
      Number(t?.unique_items ?? 0),

    unique_locations:
      Number(t?.unique_locations ?? 0),

    imported_at:
      batch.created_at,

    source:
      "ardiles_stock_history",
  };
}
