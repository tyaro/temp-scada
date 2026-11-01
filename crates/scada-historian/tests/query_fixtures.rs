use std::{fs, path::PathBuf, time::Duration};

use scada_historian::{
    store::{
        query::{QueryControl, QueryError},
        SqliteStore, StoreIdentity,
    },
    validate_history_contract,
};
use serde_json::{json, Value};

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn sqlite_raw_results_match_the_shared_browser_fixtures() {
    check_cases(
        include_str!("../../../examples/history-query-cases.json"),
        "raw",
    );
}

#[test]
fn sqlite_minmax_results_match_the_shared_browser_fixtures() {
    check_cases(
        include_str!("../../../examples/history-minmax-cases.json"),
        "minmax",
    );
}

#[test]
fn sqlite_coverage_results_match_the_shared_browser_fixtures() {
    check_cases(
        include_str!("../../../examples/history-coverage-cases.json"),
        "coverage",
    );
}

#[test]
fn sqlite_retention_results_match_the_shared_browser_fixtures() {
    check_cases(
        include_str!("../../../examples/history-retention-cases.json"),
        "retention",
    );
}

fn check_cases(source: &str, mode: &str) {
    let cases: Vec<Value> = serde_json::from_str(source).unwrap();
    for (index, case) in cases.into_iter().enumerate() {
        let path = std::env::temp_dir().join(format!(
            "scada-query-fixture-{mode}-{}-{index}",
            std::process::id()
        ));
        assert!(!path.exists());
        let directory = Directory(path);
        let mut store = SqliteStore::create(
            &directory.0,
            StoreIdentity {
                store_id: "fixture-store".into(),
                deployment_id: "fixture-deployment".into(),
            },
        )
        .unwrap();
        for session in case["sessions"].as_array().unwrap() {
            let plan = serde_json::from_value(session["spec"].clone()).unwrap();
            if session["start"].is_null() {
                store.begin_session(plan).unwrap();
            } else {
                store
                    .begin_timed_session(
                        plan,
                        serde_json::from_value(session["start"].clone()).unwrap(),
                    )
                    .unwrap();
            }
            for tick in session["ticks"].as_array().unwrap() {
                store
                    .append_tick(serde_json::from_value(tick.clone()).unwrap())
                    .unwrap();
            }
            if let Some(gaps) = session["gaps"].as_array() {
                for gap in gaps {
                    store
                        .record_gap(serde_json::from_value(gap.clone()).unwrap())
                        .unwrap();
                }
            }
            if !session["end"].is_null() {
                store
                    .close_timed_session(
                        session["spec"]["sessionId"].as_str().unwrap(),
                        serde_json::from_value(session["end"].clone()).unwrap(),
                    )
                    .unwrap();
            } else if session["interrupt"] == true {
                store
                    .interrupt_session(session["spec"]["sessionId"].as_str().unwrap())
                    .unwrap();
            } else if session["close"] == true {
                store
                    .close_session(session["spec"]["sessionId"].as_str().unwrap())
                    .unwrap();
            }
        }
        if let Some(trims) = case["trims"].as_array() {
            for request in trims {
                store
                    .trim(
                        serde_json::from_value(request.clone()).unwrap(),
                        &QueryControl::with_timeout(Duration::from_secs(10)).unwrap(),
                    )
                    .unwrap();
            }
        }
        let mut reader = store.reader().unwrap();
        let control = QueryControl::with_timeout(Duration::from_secs(10)).unwrap();
        let result = if case["query"]["mode"] == "raw" {
            reader.query_raw(&case["query"], &control)
        } else {
            reader.query_minmax(&case["query"], &control)
        };
        if case["error"] == "MetadataAmbiguous" {
            assert_eq!(
                result,
                Err(QueryError::MetadataAmbiguous),
                "{}",
                case["name"]
            );
            continue;
        }
        let mut result = result.unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
        assert_eq!(
            uuid::Uuid::parse_str(result["snapshotId"].as_str().unwrap())
                .unwrap()
                .get_version_num(),
            4
        );
        assert_eq!(validate_history_contract(&result), Ok(()));
        // Only the per-execution opaque ID is normalized; every data field is exact.
        result["snapshotId"] = json!("fixture-snapshot");
        assert_eq!(result, case["expected"], "{}", case["name"]);
    }
}
