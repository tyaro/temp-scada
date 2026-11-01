use super::test_support::*;
use super::*;
use std::process::Command;

fn child(directory: &Path, mode: &str) -> std::process::ExitStatus {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "store::tests::process_worker", "--nocapture"])
        .env("SCADA_H2_TEST_DIRECTORY", directory)
        .env("SCADA_H2_TEST_MODE", mode)
        .status()
        .unwrap()
}

#[test]
fn typed_observations_metadata_and_receipt_survive_reopen() {
    let directory = TempStore::new();
    let mut store = directory.create();
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let begun = store.begin_session(spec("session-a")).unwrap();
    let first = tick("session-a", 1, 1000);
    let receipt = store.append_tick(first.clone()).unwrap();
    assert!(receipt.commit_version > begun.begin_commit_version);
    assert_eq!(receipt.committed_through, 1);
    assert_eq!(count(&store, "observations"), 2);
    assert_eq!(count(&store, "source_epochs"), 1);
    let number: (Option<f64>, Option<i64>, String, String) = store.connection.query_row(
        "SELECT number_value, bool_value, quality, source FROM observations WHERE series_id = 'number'", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
    assert_eq!(number, (Some(0.0), None, "good".into(), "real".into()));
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT bool_value FROM observations WHERE series_id = 'bool'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    let epoch: (String, String, String) = store
        .connection
        .query_row(
            "SELECT run_id, catalog_revision, sdk_generation FROM source_epochs",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        epoch,
        (
            u64::MAX.to_string(),
            u64::MAX.to_string(),
            u64::MAX.to_string()
        )
    );
    let closed = store.close_session("session-a").unwrap();
    assert_eq!(closed.state, SessionState::Closed);
    drop(store);
    let mut store = directory.open();
    assert_eq!(store.session_status("session-a").unwrap().unwrap(), closed);
    assert_eq!(store.append_tick(first).unwrap(), receipt);
    assert_eq!(store.begin_session(spec("session-a")).unwrap(), closed);
    assert!(matches!(
        store.append_tick(tick("session-a", 2, 2000)),
        Err(StoreError::SessionInactive)
    ));
    assert_eq!(count(&store, "observations"), 2);
}

#[test]
fn complete_group_and_contiguous_sequence_are_required_before_any_write() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut bad_spec = spec("bad");
    bad_spec.members[0].period_ms = 2000;
    assert!(store.begin_session(bad_spec).is_err());
    assert_eq!(count(&store, "series"), 0);
    store.begin_session(spec("session-a")).unwrap();
    assert!(matches!(
        store.begin_session(spec("session-b")),
        Err(StoreError::Busy)
    ));
    let baseline = counter(&store);
    for kind in 0..6 {
        let mut bad = tick("session-a", 1, 1000);
        match kind {
            0 => {
                bad.observations.pop();
            }
            1 => bad.observations.push(bad.observations[0].clone()),
            2 => bad.observations[0] = bad.observations[1].clone(),
            3 => bad.observations[0].source_epoch = None,
            4 => {
                bad.observations[0]
                    .source_epoch
                    .as_mut()
                    .unwrap()
                    .hub_instance_id = "other-hub".into()
            }
            _ => bad.observations[0].value = Some(ObservationValue::Number(f64::NAN)),
        }
        assert!(store.append_tick(bad).is_err(), "invalid case {kind}");
        assert_eq!(counter(&store), baseline);
        assert_eq!(count(&store, "observations"), 0);
        assert_eq!(count(&store, "source_epochs"), 0);
    }
    assert!(matches!(
        store.append_tick(tick("session-a", 2, 1000)),
        Err(StoreError::Sequence { expected: 1 })
    ));
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    assert!(matches!(
        store.append_tick(tick("session-a", 3, 3000)),
        Err(StoreError::Sequence { expected: 2 })
    ));
    assert!(store.append_tick(tick("session-a", 2, 2000)).is_ok());
    assert_eq!(count(&store, "observations"), 4);
}

#[test]
fn bad_stale_simulation_and_unavailable_remain_distinct_null_observations() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut plan = spec("session-a");
    plan.members[0].source = Source::Simulation;
    store.begin_session(plan).unwrap();
    for (sequence, quality, reason) in [
        (1, Quality::Bad, Reason::Bad),
        (2, Quality::Stale, Reason::Stale),
    ] {
        let mut input = tick("session-a", sequence, 1000);
        input.observations[0].source = Some(Source::Simulation);
        input.observations[0].value = None;
        input.observations[0].reason = Some(Reason::SimulationExcluded);
        input.observations[1].quality = Some(quality);
        input.observations[1].value = None;
        input.observations[1].reason = Some(reason);
        store.append_tick(input).unwrap();
    }
    let mut unavailable = tick("session-a", 3, 2000);
    for observation in &mut unavailable.observations {
        observation.quality = None;
        observation.source = None;
        observation.value = None;
        observation.source_time_ms = None;
        observation.source_epoch = None;
        observation.reason = Some(Reason::SourceUnavailable);
    }
    store.append_tick(unavailable).unwrap();
    assert_eq!(count(&store, "observations"), 6);
    assert_eq!(store.connection.query_row("SELECT count(*) FROM observations WHERE number_value IS NULL AND bool_value IS NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 6);
    let mut reasons = store
        .connection
        .prepare("SELECT reason FROM observations ORDER BY sequence, series_id")
        .unwrap();
    assert_eq!(
        reasons
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap(),
        [
            "bad",
            "simulationExcluded",
            "stale",
            "simulationExcluded",
            "sourceUnavailable",
            "sourceUnavailable"
        ]
    );
}

#[test]
fn same_timestamp_and_clock_rollback_keep_all_record_ids() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    for (sequence, time) in [(1, 2000), (2, 2000), (3, 1000)] {
        let mut input = tick("session-a", sequence, time);
        if sequence == 3 {
            input.clock_epoch = "clock-b".into();
        }
        store.append_tick(input).unwrap();
    }
    assert_eq!(count(&store, "observations"), 6);
    let mut query = store.connection.prepare("SELECT sequence, sample_time_ms, source_time_ms, ingested_at_ms, clock_epoch FROM observations WHERE series_id = 'number' ORDER BY sample_time_ms, session_id, sequence").unwrap();
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (3, 1000, 990, 1020, "clock-b".into()),
            (1, 2000, 1990, 2020, "clock-a".into()),
            (2, 2000, 1990, 2020, "clock-a".into())
        ]
    );
}

#[test]
fn logical_retries_ignore_member_order_and_signed_zero_but_conflict_on_changed_facts() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let plan = store.begin_session(spec("session-a")).unwrap();
    let mut reordered_spec = spec("session-a");
    reordered_spec.members.reverse();
    assert_eq!(store.begin_session(reordered_spec).unwrap(), plan);
    let original = tick("session-a", 1, 1000);
    let receipt = store.append_tick(original.clone()).unwrap();
    let baseline = counter(&store);
    let mut retry = original.clone();
    retry.observations.reverse();
    retry
        .observations
        .iter_mut()
        .find(|o| o.series_id == "number")
        .unwrap()
        .value = Some(ObservationValue::Number(-0.0));
    assert_eq!(store.append_tick(retry).unwrap(), receipt);
    for kind in 0..7 {
        let mut changed = original.clone();
        match kind {
            0 => changed.sample_time_ms += 1,
            1 => changed.observations[0].value = Some(ObservationValue::Number(42.0)),
            2 => changed.observations[0].source_time_ms = Some(1),
            3 => changed.clock_epoch = "clock-b".into(),
            4 => {
                for observation in &mut changed.observations {
                    observation.source_epoch.as_mut().unwrap().catalog_revision -= 1;
                }
            }
            5 => changed.ingested_at_ms += 1,
            _ => {
                changed.observations[0].value = None;
                changed.observations[0].quality = Some(Quality::Bad);
                changed.observations[0].reason = Some(Reason::Bad);
            }
        }
        assert!(
            matches!(store.append_tick(changed), Err(StoreError::Conflict)),
            "conflict case {kind}"
        );
        assert_eq!(counter(&store), baseline);
    }
    assert_eq!(count(&store, "observations"), 2);
    let mut wrong_type = original;
    wrong_type.observations[0].value = Some(ObservationValue::Bool(true));
    assert!(matches!(
        store.append_tick(wrong_type),
        Err(StoreError::Contract(_))
    ));
}

#[test]
fn source_epoch_counters_above_f64_integer_precision_are_never_aliased() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut input = tick("session-a", 1, 1000);
    for observation in &mut input.observations {
        observation.source_epoch.as_mut().unwrap().catalog_revision = 9_007_199_254_740_992;
    }
    let receipt = store.append_tick(input.clone()).unwrap();
    for observation in &mut input.observations {
        observation.source_epoch.as_mut().unwrap().catalog_revision += 1;
    }
    assert!(matches!(
        store.append_tick(input.clone()),
        Err(StoreError::Conflict)
    ));
    input.sequence = 2;
    store.append_tick(input).unwrap();
    assert_eq!(count(&store, "source_epochs"), 2);
    assert_eq!(receipt.committed_through, 1);
    let revisions = store
        .connection
        .prepare("SELECT catalog_revision FROM source_epochs ORDER BY catalog_revision")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(revisions.contains(&"9007199254740992".into()));
    assert!(revisions.contains(&"9007199254740993".into()));
}

#[test]
fn source_epochs_are_consistent_within_each_hub_but_independent_across_hubs() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut mixed = tick("session-a", 1, 1000);
    mixed.observations[0]
        .source_epoch
        .as_mut()
        .unwrap()
        .sdk_generation -= 1;
    assert!(matches!(
        store.append_tick(mixed),
        Err(StoreError::Invalid(_))
    ));
    assert_eq!(count(&store, "observations"), 0);
    store.close_session("session-a").unwrap();
    let mut separate = spec("session-b");
    // Preserve the original series identity; add a genuinely different Hub series.
    separate.members[1].series_id = "other-bool".into();
    separate.members[1].hub_instance_id = "hub-b".into();
    store.begin_session(separate).unwrap();
    let mut input = tick("session-b", 1, 1000);
    input.observations[1].series_id = "other-bool".into();
    let epoch = input.observations[1].source_epoch.as_mut().unwrap();
    epoch.hub_instance_id = "hub-b".into();
    epoch.run_id = None;
    epoch.catalog_revision = 0;
    epoch.sdk_generation = 0;
    store.append_tick(input).unwrap();
    assert_eq!(count(&store, "source_epochs"), 2);
}

#[test]
fn typed_logical_retry_is_independent_of_json_field_order_and_numeric_spelling() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut input = tick("session-a", 1, 1000);
    input.observations[0].value = Some(ObservationValue::Number(1.0));
    let receipt = store.append_tick(input.clone()).unwrap();
    let text = serde_json::to_string(&input)
        .unwrap()
        .replace("\"value\":1.0", "\"value\":1");
    assert!(text.contains("\"value\":1,"));
    let reordered =
        serde_json::to_string(&serde_json::from_str::<serde_json::Value>(&text).unwrap()).unwrap();
    assert_ne!(text, reordered);
    let retry: Tick = serde_json::from_str(&reordered).unwrap();
    assert_eq!(store.append_tick(retry).unwrap(), receipt);
    assert_eq!(count(&store, "observations"), 2);
}

#[test]
fn database_checks_reject_nonfinite_values_wrong_types_and_missing_provenance() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    for assignment in [
        "bool_value = 2",
        "bool_value = 1, number_value = 2.0",
        "source = NULL",
        "quality = 'bad'",
        "source_epoch_id = NULL",
    ] {
        assert!(store
            .connection
            .execute(
                &format!("UPDATE observations SET {assignment} WHERE series_id = 'number'"),
                []
            )
            .is_err());
    }
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(store
            .connection
            .execute(
                "UPDATE observations SET number_value = ?1 WHERE series_id = 'number'",
                [number]
            )
            .is_err());
    }
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT number_value FROM observations WHERE series_id = 'number'",
                [],
                |r| r.get::<_, f64>(0)
            )
            .unwrap(),
        0.0
    );
}

#[test]
fn persistent_series_identity_and_segment_metadata_cannot_be_rewritten() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.close_session("session-a").unwrap();
    let baseline = counter(&store);
    for kind in 0..4 {
        let mut changed = spec("session-b");
        match kind {
            0 => changed.members[0].hub_instance_id = "other-hub".into(),
            1 => changed.members[0].incarnation_id = "recreated".into(),
            2 => changed.members[0].series_id = "other-series".into(),
            _ => changed.members[0].unit = Some("F".into()),
        }
        assert!(matches!(
            store.begin_session(changed),
            Err(StoreError::Conflict)
        ));
        assert_eq!(counter(&store), baseline);
        assert_eq!(count(&store, "sessions"), 1);
        assert_eq!(count(&store, "segments"), 2);
    }
    let mut renamed = spec("session-b");
    renamed.members[0].segment_id = "segment-b".into();
    renamed.members[0].external_name = "Plant.Renamed".into();
    store.begin_session(renamed.clone()).unwrap();
    assert_eq!(count(&store, "segments"), 3);
    assert!(matches!(
        store.begin_session(spec("session-b")),
        Err(StoreError::Conflict)
    ));
    store.close_session("session-b").unwrap();
    renamed.session_id = "session-c".into();
    renamed.members[0].series_id = "recreated-series".into();
    renamed.members[0].incarnation_id = "recreated".into();
    store.begin_session(renamed).unwrap();
    assert_eq!(count(&store, "series"), 3);
}

#[test]
fn interrupted_sessions_cannot_resume_but_committed_retries_are_available() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let first = tick("session-a", 1, 1000);
    let receipt = store.append_tick(first.clone()).unwrap();
    drop(store);
    let mut store = directory.open();
    let interrupted = store.session_status("session-a").unwrap().unwrap();
    assert_eq!(interrupted.state, SessionState::Interrupted);
    assert_eq!(interrupted.committed_through, 1);
    assert_eq!(store.begin_session(spec("session-a")).unwrap(), interrupted);
    assert_eq!(store.append_tick(first).unwrap(), receipt);
    assert!(matches!(
        store.append_tick(tick("session-a", 2, 2000)),
        Err(StoreError::SessionInactive)
    ));
    assert_eq!(store.close_session("session-a").unwrap(), interrupted);
    store.begin_session(spec("session-b")).unwrap();
    assert!(store.append_tick(tick("session-b", 1, 2000)).is_ok());
}

#[test]
fn every_precommit_boundary_rolls_back_all_tables_and_counters() {
    for boundary in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        let result = store.begin_with_hook(spec("session-a"), &mut |_| invalid("injected"));
        assert!(result.is_err());
        for table in ["series", "segments", "sessions", "session_members"] {
            assert_eq!(count(&store, table), 0);
        }
        assert_eq!(counter(&store), 0);
        store.begin_session(spec("session-a")).unwrap();
        let baseline = counter(&store);
        let result = store.append_with_hook(tick("session-a", 1, 1000), &mut |at| {
            if at == boundary {
                invalid("injected")
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        for table in ["observations", "source_epochs", "commits"] {
            assert_eq!(count(&store, table), 0);
        }
        assert_eq!(counter(&store), baseline);
        assert_eq!(
            store
                .session_status("session-a")
                .unwrap()
                .unwrap()
                .committed_through,
            0
        );
        assert!(store.append_tick(tick("session-a", 1, 1000)).is_ok());
    }
}

#[test]
fn response_loss_after_commit_retries_with_the_same_receipt() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    assert!(store
        .append_with_hook(tick("session-a", 1, 1000), &mut |at| {
            if at == Boundary::AfterCommit {
                invalid("response lost")
            } else {
                Ok(())
            }
        })
        .is_err());
    let baseline = counter(&store);
    assert_eq!(
        store
            .append_tick(tick("session-a", 1, 1000))
            .unwrap()
            .commit_version,
        baseline as u64
    );
    assert_eq!(count(&store, "observations"), 2);
    assert_eq!(counter(&store), baseline);
}

#[test]
fn sql_failure_poisons_writes_until_reopen_instead_of_claiming_not_committed() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.connection.execute_batch("CREATE TEMP TRIGGER fail_second BEFORE INSERT ON observations WHEN NEW.series_id = 'number' BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END;").unwrap();
    assert!(matches!(
        store.append_tick(tick("session-a", 1, 1000)),
        Err(StoreError::Sqlite(_))
    ));
    assert_eq!(count(&store, "observations"), 0);
    assert_eq!(count(&store, "source_epochs"), 0);
    assert!(matches!(
        store.append_tick(tick("session-a", 1, 1000)),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store.session_status("session-a").unwrap().unwrap().state,
        SessionState::Interrupted
    );
    store.begin_session(spec("session-b")).unwrap();
    assert!(store.append_tick(tick("session-b", 1, 1000)).is_ok());
}

#[test]
fn process_exit_during_transaction_or_after_commit_has_atomic_outcome() {
    for mode in [
        "crash-metadata",
        "crash-observation",
        "crash-watermark",
        "crash-before",
        "crash-after",
    ] {
        let directory = TempStore::new();
        drop(directory.create());
        assert_eq!(child(&directory.0, mode).code(), Some(73));
        let mut store = directory.open();
        let committed = mode == "crash-after";
        assert_eq!(count(&store, "observations"), if committed { 2 } else { 0 });
        assert_eq!(count(&store, "source_epochs"), i64::from(committed));
        assert_eq!(count(&store, "commits"), i64::from(committed));
        let session = store.session_status("child-session").unwrap().unwrap();
        assert_eq!(session.state, SessionState::Interrupted);
        assert_eq!(session.committed_through, u64::from(committed));
        if committed {
            let version = counter(&store);
            let receipt = store.append_tick(tick("child-session", 1, 1000)).unwrap();
            assert!(receipt.commit_version < version as u64);
            assert_eq!(counter(&store), version);
        } else {
            assert!(matches!(
                store.append_tick(tick("child-session", 1, 1000)),
                Err(StoreError::SessionInactive)
            ));
        }
    }
}

#[test]
fn only_one_process_owns_the_directory_and_lock_inode_is_retained() {
    let directory = TempStore::new();
    let store = directory.create();
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    assert_eq!(child(&directory.0, "busy").code(), Some(0));
    drop(store);
    assert_eq!(child(&directory.0, "open").code(), Some(0));
    drop(directory.open());
    assert!(directory.0.join("writer.lock").is_file());
}

#[test]
fn create_open_format_and_identity_failures_do_not_initialize_existing_data() {
    let directory = TempStore::new();
    assert!(SqliteStore::open_existing(&directory.0, &identity()).is_err());
    assert!(!directory.0.exists());
    drop(directory.create());
    assert!(SqliteStore::create(&directory.0, identity()).is_err());
    let mut wrong = identity();
    wrong.deployment_id = "other".into();
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &wrong),
        Err(StoreError::IdentityMismatch)
    ));
    let path = directory.0.join("store.sqlite3");
    let raw = Connection::open(&path).unwrap();
    raw.execute_batch("PRAGMA user_version = 999").unwrap();
    drop(raw);
    let before = fs::read(&path).unwrap();
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::UnsupportedStore)
    ));
    assert_eq!(fs::read(&path).unwrap(), before);
    let raw = Connection::open(&path).unwrap();
    raw.execute_batch("PRAGMA user_version = 1; PRAGMA application_id = 0")
        .unwrap();
    drop(raw);
    let before = fs::read(&path).unwrap();
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::UnsupportedStore)
    ));
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::write(&path, b"corrupt database fixture").unwrap();
    assert!(SqliteStore::open_existing(&directory.0, &identity()).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"corrupt database fixture");
}

#[cfg(unix)]
#[test]
fn canonical_directory_alias_obeys_lock_and_file_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;
    let directory = TempStore::new();
    let store = directory.create();
    let alias = TempStore::new();
    symlink(&directory.0, &alias.0).unwrap();
    assert!(matches!(
        SqliteStore::open_existing(&alias.0, &identity()),
        Err(StoreError::Busy)
    ));
    fs::remove_file(&alias.0).unwrap();
    drop(store);
    for file in ["writer.lock", "store.sqlite3"] {
        let path = directory.0.join(file);
        let moved = directory.0.join(format!("original-{file}"));
        fs::rename(&path, &moved).unwrap();
        symlink(&moved, &path).unwrap();
        assert!(matches!(
            SqliteStore::open_existing(&directory.0, &identity()),
            Err(StoreError::Invalid(_))
        ));
        fs::remove_file(&path).unwrap();
        fs::rename(moved, path).unwrap();
    }
}

// Invoked only by the tests above. process::exit skips Rust Drop/rollback.
#[test]
fn process_worker() {
    let Some(directory) = std::env::var_os("SCADA_H2_TEST_DIRECTORY") else {
        return;
    };
    let mode = std::env::var("SCADA_H2_TEST_MODE").unwrap();
    if mode == "busy" {
        assert!(matches!(
            SqliteStore::open_existing(&directory, &identity()),
            Err(StoreError::Busy)
        ));
        return;
    }
    let mut store = SqliteStore::open_existing(&directory, &identity()).unwrap();
    if mode == "open" {
        return;
    }
    store.begin_session(spec("child-session")).unwrap();
    store
        .append_with_hook(tick("child-session", 1, 1000), &mut |at| {
            let stop = matches!(
                (mode.as_str(), at),
                ("crash-metadata", Boundary::Metadata)
                    | ("crash-observation", Boundary::Observation)
                    | ("crash-watermark", Boundary::Watermark)
                    | ("crash-before", Boundary::BeforeCommit)
                    | ("crash-after", Boundary::AfterCommit)
            );
            if stop {
                std::process::exit(73);
            }
            Ok(())
        })
        .unwrap();
    panic!("child fault boundary was not reached");
}
