import { query } from "@/lib/db";

export function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export async function resolveHistoryBatch(snapshot = "latest") {
  const requested = cleanText(snapshot) ?? "latest";

  if (requested.toLowerCase() === "latest") {
    const result = await query(`
      SELECT
        id,
        snapshot_date,
        source_file_name AS file_name,
        status,
        total_rows,
        valid_rows,
        duplicate_rows,
        conflict_rows,
        new_positions,
        changed_positions,
        unchanged_positions,
        ingested_at AS created_at
      FROM ardiles_stock_history.import_batches
      WHERE status = 'PUBLISHED'
      ORDER BY snapshot_date DESC, id DESC
      LIMIT 1
    `);

    return result.rows[0] ?? null;
  }

  const result = await query(
    `
      SELECT
        id,
        snapshot_date,
        source_file_name AS file_name,
        status,
        total_rows,
        valid_rows,
        duplicate_rows,
        conflict_rows,
        new_positions,
        changed_positions,
        unchanged_positions,
        ingested_at AS created_at
      FROM ardiles_stock_history.import_batches
      WHERE status = 'PUBLISHED'
        AND snapshot_date::date = $1::date
      ORDER BY id DESC
      LIMIT 1
    `,
    [requested]
  );

  return result.rows[0] ?? null;
}

export async function latestTwoHistoryBatches() {
  const result = await query(`
    SELECT
      id,
      snapshot_date,
      source_file_name AS file_name,
      status,
      total_rows,
      valid_rows,
      duplicate_rows,
      conflict_rows,
      new_positions,
      changed_positions,
      unchanged_positions,
      ingested_at AS created_at
    FROM ardiles_stock_history.import_batches
    WHERE status = 'PUBLISHED'
    ORDER BY snapshot_date DESC, id DESC
    LIMIT 2
  `);

  return result.rows;
}

export function historyStateCtes(datePlaceholder = "$1", prefix = "h") {
  const p = String(prefix || "h").replace(/[^a-zA-Z0-9_]/g, "_");

  return `
    ${p}_stock_state AS (
      SELECT DISTINCT ON (
        sv.product_id,
        sv.location_id,
        sv.accsys_id
      )
        sv.product_id,
        sv.location_id,
        sv.accsys_id,
        sv.qty,
        sv.hpp,
        sv.rp,
        sv.harga_jual,
        sv.effective_date AS stock_effective_date,
        sv.source_batch_id AS stock_source_batch_id
      FROM ardiles_stock_history.stock_versions sv
      JOIN ardiles_stock_history.import_batches sb
        ON sb.id = sv.source_batch_id
       AND sb.status = 'PUBLISHED'
      WHERE sv.effective_date <= ${datePlaceholder}::date
      ORDER BY
        sv.product_id,
        sv.location_id,
        sv.accsys_id,
        sv.effective_date DESC,
        sv.recorded_at DESC,
        sv.id DESC
    ),

    ${p}_product_state AS (
      SELECT DISTINCT ON (pv.product_id)
        pv.product_id,
        pv.barang,
        pv.model,
        pv.kadivisi,
        pv.supplier,
        pv.ka_pabrik,
        pv.effective_date AS product_effective_date
      FROM ardiles_stock_history.product_versions pv
      JOIN ardiles_stock_history.import_batches pb
        ON pb.id = pv.source_batch_id
       AND pb.status = 'PUBLISHED'
      WHERE pv.effective_date <= ${datePlaceholder}::date
      ORDER BY
        pv.product_id,
        pv.effective_date DESC,
        pv.recorded_at DESC,
        pv.id DESC
    ),

    ${p}_product_accsys_state AS (
      SELECT DISTINCT ON (
        pav.product_id,
        pav.accsys_id
      )
        pav.product_id,
        pav.accsys_id,
        pav.fungsi,
        pav.effective_date AS function_effective_date
      FROM ardiles_stock_history.product_accsys_versions pav
      JOIN ardiles_stock_history.import_batches pab
        ON pab.id = pav.source_batch_id
       AND pab.status = 'PUBLISHED'
      WHERE pav.effective_date <= ${datePlaceholder}::date
      ORDER BY
        pav.product_id,
        pav.accsys_id,
        pav.effective_date DESC,
        pav.recorded_at DESC,
        pav.id DESC
    ),

    ${p}_location_state AS (
      SELECT DISTINCT ON (lv.location_id)
        lv.location_id,
        lv.display_name,
        lv.is_operational,
        lv.valid_from,
        lv.valid_to
      FROM ardiles_stock_history.location_versions lv
      JOIN ardiles_stock_history.import_batches lb
        ON lb.id = lv.source_batch_id
       AND lb.status = 'PUBLISHED'
      WHERE lv.valid_from <= ${datePlaceholder}::date
        AND (
          lv.valid_to IS NULL
          OR lv.valid_to > ${datePlaceholder}::date
        )
      ORDER BY
        lv.location_id,
        lv.valid_from DESC,
        lv.created_at DESC,
        lv.id DESC
    ),

    ${p}_state_rows AS (
      SELECT
        ss.product_id,
        ss.location_id,
        ss.accsys_id,

        ps.barang,
        ps.model,
        ps.kadivisi,
        pas.fungsi,
        ps.supplier,
        ps.ka_pabrik,

        ls.display_name AS lokasi,
        a.code AS accsys,

        ss.qty,
        ss.hpp,
        ss.rp,
        ss.harga_jual,

        ss.stock_effective_date,
        ss.stock_source_batch_id
      FROM ${p}_stock_state ss
      JOIN ${p}_product_state ps
        ON ps.product_id = ss.product_id
      LEFT JOIN ${p}_product_accsys_state pas
        ON pas.product_id = ss.product_id
       AND pas.accsys_id = ss.accsys_id
      JOIN ${p}_location_state ls
        ON ls.location_id = ss.location_id
      JOIN ardiles_stock_history.accsys a
        ON a.id = ss.accsys_id
    )
  `;
}
