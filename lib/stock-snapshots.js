import { query } from "@/lib/db";


function numberOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const num = Number(value);

  return Number.isFinite(num)
    ? num
    : null;
}


export async function getStockSnapshots() {
  const result = await query(`
    WITH observation_counts AS (
      SELECT
        o.batch_id,
        COUNT(*)::bigint AS observed_rows

      FROM ardiles_stock_history.stock_observations o

      GROUP BY
        o.batch_id
    )

    SELECT
      b.id AS batch_id,
      b.snapshot_date::date AS snapshot_date,
      b.source_file_name AS file_name,
      b.status,

      b.total_rows,
      b.valid_rows,
      b.duplicate_rows,
      b.conflict_rows,

      b.new_positions,
      b.changed_positions,
      b.unchanged_positions,

      COALESCE(
        oc.observed_rows,
        0
      ) AS observed_rows,

      b.ingested_at

    FROM ardiles_stock_history.import_batches b

    LEFT JOIN observation_counts oc
      ON oc.batch_id = b.id

    WHERE b.status = 'PUBLISHED'

    ORDER BY
      b.snapshot_date ASC,
      b.id ASC
  `);


  const rows = result.rows ?? [];


  if (!rows.length) {
    return {
      found: false,
      published_count: 0,
      earliest_snapshot: null,
      latest_snapshot: null,
      available_dates: [],
      snapshots: [],
      source: "ardiles_stock_history",
    };
  }


  const snapshots = rows.map(
    (row, index) => ({
      batch_id:
        Number(row.batch_id),

      snapshot_date:
        row.snapshot_date,

      file_name:
        row.file_name,

      status:
        row.status,

      total_rows:
        numberOrNull(row.total_rows),

      valid_rows:
        numberOrNull(row.valid_rows),

      observed_rows:
        Number(row.observed_rows ?? 0),

      duplicate_rows:
        numberOrNull(row.duplicate_rows),

      conflict_rows:
        numberOrNull(row.conflict_rows),

      new_positions:
        numberOrNull(row.new_positions),

      changed_positions:
        numberOrNull(row.changed_positions),

      unchanged_positions:
        numberOrNull(row.unchanged_positions),

      ingested_at:
        row.ingested_at,

      is_earliest:
        index === 0,

      is_latest:
        index === rows.length - 1,
    })
  );


  return {
    found: true,

    published_count:
      snapshots.length,

    earliest_snapshot:
      snapshots[0].snapshot_date,

    latest_snapshot:
      snapshots[snapshots.length - 1].snapshot_date,

    available_dates:
      snapshots.map(
        (item) => item.snapshot_date
      ),

    snapshots,

    source:
      "ardiles_stock_history",
  };
}
