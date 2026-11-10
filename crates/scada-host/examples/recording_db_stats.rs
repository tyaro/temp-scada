//! Read-only probe of the recording store for the C5-6 Windows acceptance.
//!
//! `cargo run --locked -p scada-host --example recording_db_stats [-- <store dir>]`
//!
//! Without an argument it reads `%LOCALAPPDATA%\temp-scada\historian`. The
//! store is opened read-only (`mode=ro`), so it may run while the desktop app
//! is recording. Prints `key=value` lines: file sizes, store meta, sessions,
//! per-series counts and reasons, gaps and activations. Times are UTC.
use std::path::PathBuf;

use scada_host::local_data_dir;
use scada_host::recording_runtime::STORE_DIR;
use sqlx::sqlite::{SqliteConnectOptions, SqliteRow};
use sqlx::{ConnectOptions, Connection, Row};

/// A UTC timestamp of a millisecond column, as a literal SQL fragment.
macro_rules! utc {
    ($column:literal) => {
        concat!(
            "strftime('%Y-%m-%dT%H:%M:%fZ', ",
            $column,
            " / 1000.0, 'unixepoch')"
        )
    };
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = match std::env::args().nth(1) {
        Some(path) => PathBuf::from(path),
        None => local_data_dir()?.join(STORE_DIR),
    };
    let db = dir.join("store.sqlite3");
    for name in ["store.sqlite3", "store.sqlite3-wal", "store.sqlite3-shm"] {
        let size = std::fs::metadata(dir.join(name)).map(|m| m.len());
        match size {
            Ok(bytes) => println!("file={name} bytes={bytes}"),
            Err(_) => println!("file={name} missing"),
        }
    }
    let mut c = SqliteConnectOptions::new()
        .filename(&db)
        .read_only(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .connect()
        .await?;
    let mut tx = c.begin().await?;

    let meta =
        sqlx::query("SELECT format_version, store_id, deployment_id, last_commit FROM store_meta")
            .fetch_one(&mut *tx)
            .await?;
    println!(
        "store format={} store_id={} deployment_id={} last_commit={}",
        meta.get::<i64, _>(0),
        meta.get::<String, _>(1),
        meta.get::<String, _>(2),
        meta.get::<i64, _>(3)
    );
    println!("now_utc={}", now(&mut tx).await?);

    let sessions = sqlx::query(concat!(
        "SELECT s.session_id, s.state, s.last_sequence, e.plan_id, e.plan_revision,
                ",
        utc!("e.start_ms"),
        ", ",
        utc!("e.observed_frontier_ms"),
        ", ",
        utc!("e.end_ms"),
        "
           FROM sessions s LEFT JOIN session_evidence e USING (session_id)
          ORDER BY s.begin_commit"
    ))
    .fetch_all(&mut *tx)
    .await?;
    for s in &sessions {
        println!(
            "session={} state={} ticks={} plan={}@{} start={} frontier={} end={}",
            s.get::<String, _>(0),
            s.get::<String, _>(1),
            s.get::<i64, _>(2),
            opt_text(s, 3),
            opt_int(s, 4),
            opt_text(s, 5),
            opt_text(s, 6),
            opt_text(s, 7)
        );
    }

    // One row per tick and member, so `rows` should equal the session's ticks,
    // and the sample-time span divided by the period gives the expected ticks.
    let series = sqlx::query(concat!(
        "SELECT o.session_id, o.series_id,
                json_extract(d.descriptor_json, '$.externalName'),
                json_extract(d.descriptor_json, '$.valueType'),
                json_extract(d.descriptor_json, '$.source'),
                json_extract(d.descriptor_json, '$.periodMs'),
                count(*),
                count(o.number_value) + count(o.bool_value),
                min(o.sample_time_ms), max(o.sample_time_ms),
                ",
        utc!("min(o.sample_time_ms)"),
        ", ",
        utc!("max(o.sample_time_ms)"),
        ",
                min(o.number_value), max(o.number_value),
                sum(o.bool_value = 1), sum(o.bool_value = 0)
           FROM observations o
           JOIN segments d ON d.series_id = o.series_id AND d.segment_id = o.segment_id
          GROUP BY o.session_id, o.series_id
          ORDER BY o.session_id, 3"
    ))
    .fetch_all(&mut *tx)
    .await?;
    for r in &series {
        let rows: i64 = r.get(6);
        let period: i64 = r.get(5);
        let span = r.get::<i64, _>(9) - r.get::<i64, _>(8);
        let expected = if period > 0 { span / period + 1 } else { 0 };
        println!(
            "series session={} series={} name={} type={} source={} period_ms={} rows={} valued={} expected_ticks={} first={} last={} num_min={} num_max={} true={} false={}",
            r.get::<String, _>(0),
            r.get::<String, _>(1),
            opt_text(r, 2),
            opt_text(r, 3),
            opt_text(r, 4),
            period,
            rows,
            r.get::<i64, _>(7),
            expected,
            r.get::<String, _>(10),
            r.get::<String, _>(11),
            opt_real(r, 12),
            opt_real(r, 13),
            opt_int(r, 14),
            opt_int(r, 15)
        );
    }

    let reasons = sqlx::query(
        "SELECT session_id, series_id, coalesce(quality, '-'), coalesce(source, '-'),
                coalesce(reason, '-'), count(*)
           FROM observations
          GROUP BY 1, 2, 3, 4, 5
          ORDER BY 1, 2, 3, 4, 5",
    )
    .fetch_all(&mut *tx)
    .await?;
    for r in &reasons {
        println!(
            "quality session={} series={} quality={} source={} reason={} rows={}",
            r.get::<String, _>(0),
            r.get::<String, _>(1),
            r.get::<String, _>(2),
            r.get::<String, _>(3),
            r.get::<String, _>(4),
            r.get::<i64, _>(5)
        );
    }

    let gaps = sqlx::query(concat!(
        "SELECT session_id, reason, ",
        utc!("from_ms"),
        ", ",
        utc!("to_ms"),
        ", to_ms - from_ms
           FROM recording_gaps ORDER BY session_id, from_ms"
    ))
    .fetch_all(&mut *tx)
    .await?;
    println!("gaps={}", gaps.len());
    for g in &gaps {
        println!(
            "gap session={} reason={} from={} to={} ms={}",
            g.get::<String, _>(0),
            g.get::<String, _>(1),
            g.get::<String, _>(2),
            g.get::<String, _>(3),
            g.get::<i64, _>(4)
        );
    }

    let activations = sqlx::query(
        "SELECT sequence, activation_id, applied_revision, mapping_revision, retention_revision, session_id
           FROM recording_activations ORDER BY sequence",
    )
    .fetch_all(&mut *tx)
    .await?;
    for a in &activations {
        println!(
            "activation seq={} id={} applied_rev={} mapping_rev={} retention_rev={} session={}",
            a.get::<i64, _>(0),
            a.get::<String, _>(1),
            a.get::<i64, _>(2),
            a.get::<i64, _>(3),
            a.get::<i64, _>(4),
            a.get::<String, _>(5)
        );
    }
    tx.rollback().await?;
    Ok(())
}

async fn now(c: &mut sqlx::SqliteConnection) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
        .fetch_one(c)
        .await
}

fn opt_text(row: &SqliteRow, i: usize) -> String {
    row.get::<Option<String>, _>(i)
        .unwrap_or_else(|| "-".into())
}

fn opt_int(row: &SqliteRow, i: usize) -> String {
    row.get::<Option<i64>, _>(i)
        .map_or_else(|| "-".into(), |v| v.to_string())
}

fn opt_real(row: &SqliteRow, i: usize) -> String {
    row.get::<Option<f64>, _>(i)
        .map_or_else(|| "-".into(), |v| v.to_string())
}
