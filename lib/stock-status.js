import { query } from "@/lib/db";
import {
  historyStateCtes,
  resolveHistoryBatch,
} from "@/lib/stock-history";


export async function getStockDataStatus() {
  const batch = await resolveHistoryBatch("latest");

  if (!batch) {
    return {
      found: false,
      message: "No published stock batch found.",
    };
  }


  const stateCtes = historyStateCtes(
    "$1",
    "st"
  );


  const result = await query(
    `
      WITH
      ${stateCtes},

      latest_seen AS (
        SELECT DISTINCT ON (
          o.product_id,
          o.location_id,
          o.accsys_id
        )
          o.product_id,
          o.location_id,
          o.accsys_id,
          o.snapshot_date::date AS last_seen_date

        FROM ardiles_stock_history.stock_observations o

        JOIN ardiles_stock_history.import_batches b
          ON b.id = o.batch_id
         AND b.status = 'PUBLISHED'

        WHERE o.snapshot_date::date <= $1::date

        ORDER BY
          o.product_id,
          o.location_id,
          o.accsys_id,
          o.snapshot_date DESC,
          o.batch_id DESC,
          o.source_row DESC,
          o.id DESC
      ),

      effective_summary AS (
        SELECT
          COUNT(*) AS effective_stock_keys,

          COALESCE(
            SUM(s.qty),
            0
          ) AS total_qty,

          COUNT(
            DISTINCT s.barang
          ) AS unique_items,

          COUNT(
            DISTINCT s.lokasi
          ) AS unique_locations,

          COUNT(*) FILTER (
            WHERE ls.last_seen_date = $1::date
          ) AS explicitly_seen_keys,

          COUNT(*) FILTER (
            WHERE ls.last_seen_date < $1::date
          ) AS carried_forward_keys,

          COALESCE(
            SUM(s.qty) FILTER (
              WHERE ls.last_seen_date < $1::date
            ),
            0
          ) AS carried_forward_qty

        FROM st_state_rows s

        JOIN latest_seen ls
          ON ls.product_id = s.product_id
         AND ls.location_id = s.location_id
         AND ls.accsys_id = s.accsys_id
      ),

      observed_summary AS (
        SELECT
          COUNT(*) AS observed_rows

        FROM ardiles_stock_history.stock_observations o

        WHERE o.batch_id = $2::bigint
      )

      SELECT
        e.effective_stock_keys,
        e.total_qty,
        e.unique_items,
        e.unique_locations,
        e.explicitly_seen_keys,
        e.carried_forward_keys,
        e.carried_forward_qty,
        o.observed_rows

      FROM effective_summary e
      CROSS JOIN observed_summary o
    `,
    [
      batch.snapshot_date,
      batch.id,
    ]
  );


  const row = result.rows[0] ?? {};


  const effectiveStockKeys =
    Number(
      row.effective_stock_keys ?? 0
    );


  return {
    found: true,

    batch_id:
      Number(batch.id),

    snapshot_date:
      batch.snapshot_date,

    file_name:
      batch.file_name,

    status:
      batch.status,


    // =====================================================
    // FILE / OBSERVATION
    // =====================================================

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

    observed_rows:
      Number(
        row.observed_rows ?? 0
      ),

    explicitly_seen_keys:
      Number(
        row.explicitly_seen_keys ?? 0
      ),


    // =====================================================
    // EFFECTIVE HISTORY STATE
    // =====================================================

    effective_stock_keys:
      effectiveStockKeys,

    carried_forward_keys:
      Number(
        row.carried_forward_keys ?? 0
      ),

    carried_forward_qty:
      Number(
        row.carried_forward_qty ?? 0
      ),


    // =====================================================
    // BUSINESS TOTALS
    // =====================================================

    total_qty:
      Number(
        row.total_qty ?? 0
      ),

    unique_items:
      Number(
        row.unique_items ?? 0
      ),

    unique_locations:
      Number(
        row.unique_locations ?? 0
      ),


    // =====================================================
    // LEGACY COMPATIBILITY
    //
    // Dipertahankan supaya client lama tidak langsung rusak.
    // Nilainya sama dengan effective_stock_keys.
    // =====================================================

    total_stock_rows:
      effectiveStockKeys,


    imported_at:
      batch.created_at,

    source:
      "ardiles_stock_history",
  };
}
