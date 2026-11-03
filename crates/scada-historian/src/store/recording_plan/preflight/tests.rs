use super::*;
use crate::store::recording_plan::tests::{apply, control, counter, enabled_store, register};
use crate::store::{
    test_support::{identity, tick, TempStore},
    SessionState,
};
use query::QueryError;
use serde_json::json;

fn candidate(result: RecordingPlanPreflight, active: Option<&str>) {
    assert_eq!(
        result.outcome,
        PlanPreflightOutcome::Candidate {
            active_session_id: active.map(str::to_owned),
        }
    );
}
fn running_store() -> (TempStore, SqliteStore) {
    let (dir, mut store) = enabled_store();
    store
        .apply_recording_plan(&apply("first", None, true), &control())
        .unwrap();
    store
        .activate_recording_plan(
            &ActivateRecordingPlanRequest {
                activation_id: "activation".into(),
                expected_applied_revision: 1,
                expected_mapping_revision: 1,
                expected_retention_applied_revision: 1,
                session_id: "running".into(),
                start: evidence::ClockStamp {
                    clock_epoch: "clock".into(),
                    at_ms: 1000,
                },
            },
            &control(),
        )
        .unwrap();
    (dir, store)
}
#[test]
fn active_recording_is_only_an_advisory_stop_requirement_and_never_changes_db() {
    let (_dir, mut store) = running_store();
    let mut reader = store.reader().unwrap();
    let before = counter(&store);
    let changes = store.connection.total_changes();
    let proposal = apply("next", Some(1), true);
    let result = reader
        .preflight_recording_plan(&proposal, &control())
        .unwrap();
    assert_eq!(result.snapshot_commit, before as u64);
    candidate(result, Some("running"));
    assert_eq!(
        reader
            .preflight_recording_mapping(&register("map:2", Some(1)), &control())
            .unwrap()
            .outcome,
        MappingPreflightOutcome::Candidate {
            active_session_id: Some("running".into())
        }
    );
    assert_eq!(counter(&store), before);
    assert_eq!(store.connection.total_changes(), changes);
    assert!(matches!(
        store.apply_recording_plan(&proposal, &control()),
        Err(StoreError::Busy)
    ));
    assert_eq!(
        store.session_status("running").unwrap().unwrap().state,
        SessionState::Active
    );
    // No recording progress or snapshot state has been altered by either read.
    store
        .close_timed_session(
            "running",
            evidence::ClockStamp {
                clock_epoch: "clock".into(),
                at_ms: 2000,
            },
        )
        .unwrap();
    candidate(
        reader
            .preflight_recording_plan(&proposal, &control())
            .unwrap(),
        None,
    );
    assert_eq!(
        store
            .apply_recording_plan(&proposal, &control())
            .unwrap()
            .applied_revision,
        2
    );
}
#[test]
fn one_snapshot_survives_writer_commit_and_cannot_authorize_later_apply() {
    let (_dir, mut store) = enabled_store();
    let mut reader = store.reader().unwrap();
    let proposed = apply("candidate", None, true);
    let before = counter(&store);
    let result = reader
        .plan_preflight_with_hook(&proposed, &control(), &mut || {
            store.apply_recording_plan(&apply("competing", None, true), &control())?;
            Ok(())
        })
        .unwrap();
    assert_eq!(result.snapshot_commit, before as u64);
    candidate(result, None);
    assert!(matches!(
        store.apply_recording_plan(&proposed, &control()),
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        reader.preflight_recording_plan(&proposed, &control()),
        Err(StoreError::Conflict)
    ));
    let map = register("map:candidate", Some(1));
    let before = counter(&store);
    let result = reader
        .mapping_preflight_with_hook(&map, &control(), &mut || {
            store.register_recording_mapping(&register("competing:map", Some(1)), &control())?;
            Ok(())
        })
        .unwrap();
    assert_eq!(result.snapshot_commit, before as u64);
    assert!(matches!(
        result.outcome,
        MappingPreflightOutcome::Candidate { .. }
    ));
    assert!(matches!(
        store.register_recording_mapping(&map, &control()),
        Err(StoreError::Conflict)
    ));
}
#[test]
fn replay_is_canonical_and_precedes_current_heads_active_session_and_job() {
    let (_dir, mut store) = running_store();
    let mut reader = store.reader().unwrap();
    let original = apply("first", None, true);
    let receipt = store
        .recording_plan_receipt("first", &control())
        .unwrap()
        .unwrap();
    let map_receipt = store
        .recording_mapping_receipt("map", &control())
        .unwrap()
        .unwrap();
    let mut reordered = original.clone();
    reordered.desired["group"]["members"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reordered.desired["revision"] = json!(1.0);
    assert_eq!(
        reader
            .preflight_recording_plan(&reordered, &control())
            .unwrap()
            .outcome,
        PlanPreflightOutcome::Replay(receipt.clone())
    );
    store
        .close_timed_session(
            "running",
            evidence::ClockStamp {
                clock_epoch: "clock".into(),
                at_ms: 2000,
            },
        )
        .unwrap();
    store
        .register_recording_mapping(&register("map:2", Some(1)), &control())
        .unwrap();
    let mut disabled = apply("disabled", Some(1), false);
    disabled.desired["revision"] = json!(2);
    store.apply_recording_plan(&disabled, &control()).unwrap();
    store
        .begin_retention_job(
            retention::jobs::JobRequest {
                job_id: "job".into(),
                cutoff_ms: 1000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let before = counter(&store);
    assert_eq!(
        reader
            .preflight_recording_plan(&original, &control())
            .unwrap()
            .outcome,
        PlanPreflightOutcome::Replay(receipt)
    );
    let mut m = register("map", None);
    m.mapping.members.reverse();
    assert_eq!(
        reader
            .preflight_recording_mapping(&m, &control())
            .unwrap()
            .outcome,
        MappingPreflightOutcome::Replay(map_receipt)
    );
    assert!(matches!(
        reader.preflight_recording_mapping(&register("new", Some(2)), &control()),
        Err(StoreError::Busy)
    ));
    disabled.request_id = "next".into();
    disabled.expected_applied_revision = Some(2);
    assert!(matches!(
        reader.preflight_recording_plan(&disabled, &control()),
        Err(StoreError::Busy)
    ));
    assert_eq!(counter(&store), before);
}
#[test]
fn all_cas_resolution_immutable_and_reservation_conflicts_match_writer() {
    let (_dir, mut store) = enabled_store();
    store
        .apply_recording_plan(&apply("first", None, true), &control())
        .unwrap();
    let mut reader = store.reader().unwrap();
    let before = counter(&store);
    for kind in 0..9 {
        let mut p = apply("next", Some(1), true);
        match kind {
            0 => p.expected_applied_revision = None,
            1 => p.expected_mapping_revision = Some(2),
            2 => p.expected_retention_applied_revision = Some(2),
            3 => p.desired["group"]["hubRef"] = json!("other"),
            4 => p.desired["group"]["periodMs"] = json!(500),
            5 => p.desired["group"]["members"][0]["externalName"] = json!("other"),
            6 => p.desired["group"]["members"][0]["memberId"] = json!("missing"),
            7 => p.desired["group"]["groupId"] = json!("different"), // same immutable desired revision
            _ => p.request_id = "first".into(),
        }
        assert!(
            matches!(
                reader.preflight_recording_plan(&p, &control()),
                Err(StoreError::Conflict)
            ),
            "preflight {kind}"
        );
        assert!(
            matches!(
                store.apply_recording_plan(&p, &control()),
                Err(StoreError::Conflict)
            ),
            "writer {kind}"
        );
    }
    for kind in 0..4 {
        let mut m = register("next:map", Some(1));
        match kind {
            0 => m.mapping.members[0].identity.incarnation_id = "new-life".into(),
            1 => m.mapping.members[0].identity.series_id = "other-series".into(),
            2 => m.mapping.members[0].identity.unit = Some("F".into()),
            _ => m.expected_mapping_revision = None,
        }
        assert!(
            matches!(
                reader.preflight_recording_mapping(&m, &control()),
                Err(StoreError::Conflict)
            ),
            "map {kind}"
        );
        assert!(matches!(
            store.register_recording_mapping(&m, &control()),
            Err(StoreError::Conflict)
        ));
    }
    assert_eq!(counter(&store), before);
}
#[test]
fn a_mapping_candidate_never_creates_a_revision_or_reserves_new_identities() {
    let (_dir, mut store) = enabled_store();
    let mut reader = store.reader().unwrap();
    let mut m = register("map:2", Some(1));
    for row in &mut m.mapping.members {
        row.identity.period_ms = 500;
        row.identity.segment_id = "new-segment".into();
    }
    let before = counter(&store);
    assert!(matches!(
        reader
            .preflight_recording_mapping(&m, &control())
            .unwrap()
            .outcome,
        MappingPreflightOutcome::Candidate {
            active_session_id: None
        }
    ));
    let mut a = apply("new", None, true);
    a.expected_mapping_revision = Some(2);
    a.desired["group"]["periodMs"] = json!(500);
    assert!(matches!(
        reader.preflight_recording_plan(&a, &control()),
        Err(StoreError::Conflict)
    ));
    assert_eq!(counter(&store), before);
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT count(*) FROM recording_series_reservations",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    store.register_recording_mapping(&m, &control()).unwrap();
    candidate(
        reader.preflight_recording_plan(&a, &control()).unwrap(),
        None,
    );
    assert!(store.apply_recording_plan(&a, &control()).is_ok());
}
#[test]
fn each_original_control_budget_is_enforced_and_reader_recovers_after_errors() {
    let (_dir, store) = enabled_store();
    let mut reader = store.reader().unwrap();
    let before = counter(&store);
    for kind in 0..6 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_decoded_rows = 1,
            3 => c.limits.max_vm_steps = 1000,
            4 => c.limits.max_output_bytes = 1,
            _ => c.limits.max_vm_steps = 0,
        }
        assert!(
            matches!(
                reader.preflight_recording_plan(&apply("new", None, true), &c),
                Err(StoreError::Control(_))
            ),
            "plan {kind}"
        );
        assert!(
            matches!(
                reader.preflight_recording_mapping(&register("new", Some(1)), &c),
                Err(StoreError::Control(_))
            ),
            "map {kind}"
        );
        candidate(
            reader
                .preflight_recording_plan(&apply("new", None, true), &control())
                .unwrap(),
            None,
        );
    }
    assert_eq!(counter(&store), before);
}
#[test]
fn late_cancel_and_panics_cleanup_the_snapshot_before_reader_reuse() {
    let (_dir, store) = enabled_store();
    let mut reader = store.reader().unwrap();
    let c = control();
    assert!(matches!(
        reader.plan_preflight_with_hook(&apply("new", None, true), &c, &mut || {
            c.cancellation.cancel();
            Ok(())
        }),
        Err(StoreError::Control(QueryError::Cancelled))
    ));
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ =
            reader.mapping_preflight_with_hook(&register("new", Some(1)), &control(), &mut || {
                panic!("snapshot boundary")
            });
    }));
    assert!(panic.is_err());
    candidate(
        reader
            .preflight_recording_plan(&apply("new", None, true), &control())
            .unwrap(),
        None,
    );
}
#[test]
fn history_and_management_share_two_leases_and_hold_writer_lock_until_drop() {
    let (dir, mut store) = enabled_store();
    let mut management = store.reader().unwrap();
    let history = store.reader().unwrap();
    assert!(matches!(store.reader(), Err(StoreError::Busy)));
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        2
    );
    candidate(
        management
            .preflight_recording_plan(&apply("new", None, true), &control())
            .unwrap(),
        None,
    );
    drop(store);
    assert!(matches!(
        SqliteStore::open_existing(&dir.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(management);
    assert!(matches!(
        SqliteStore::open_existing(&dir.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(history);
    assert!(dir
        .open()
        .recording_plan_state(&control())
        .unwrap()
        .applied
        .is_none());
}
#[test]
fn corrupt_saved_evidence_is_never_a_candidate_and_invalid_input_is_not_replay() {
    let (_dir, mut store) = enabled_store();
    let original = apply("first", None, true);
    store.apply_recording_plan(&original, &control()).unwrap();
    let mut reader = store.reader().unwrap();
    let mut invalid = original.clone();
    invalid.desired["password"] = json!("forbidden");
    assert!(matches!(
        reader.preflight_recording_plan(&invalid, &control()),
        Err(StoreError::Invalid(_))
    ));
    let mut invalid = register("map", None);
    invalid.mapping.members[0].member_id = "".into();
    assert!(matches!(
        reader.preflight_recording_mapping(&invalid, &control()),
        Err(StoreError::Invalid(_))
    ));
    store
        .connection
        .execute(
            "UPDATE recording_plan_applications SET receipt_json='{}' WHERE applied_revision=1",
            [],
        )
        .unwrap();
    assert!(matches!(
        reader.preflight_recording_plan(&original, &control()),
        Err(StoreError::CorruptData)
    ));
    assert!(matches!(
        reader.preflight_recording_plan(&apply("new", Some(1), true), &control()),
        Err(StoreError::CorruptData)
    ));
}

#[test]
fn append_during_preflight_keeps_one_snapshot_and_worker_writes_continue() {
    let (_dir, mut store) = running_store();
    let mut reader = store.reader().unwrap();
    let before = counter(&store);
    let result = reader
        .plan_preflight_with_hook(&apply("next", Some(1), true), &control(), &mut || {
            let mut t = tick("running", 1, 1500);
            t.clock_epoch = "clock".into();
            store.append_tick(t)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(result.snapshot_commit, before as u64);
    candidate(result, Some("running"));
    assert_eq!(
        store
            .session_status("running")
            .unwrap()
            .unwrap()
            .committed_through,
        1
    );
    assert!(
        reader
            .preflight_recording_plan(&apply("next", Some(1), true), &control())
            .unwrap()
            .snapshot_commit
            > before as u64
    );
}

#[test]
fn full_application_ledger_rejects_new_candidates_but_keeps_replay() {
    let dir = TempStore::new();
    let mut store = dir.create();
    let original = apply("first", None, false);
    let first = store.apply_recording_plan(&original, &control()).unwrap();
    // Seed canonical disabled application history without 4,095 disk commits.
    let tx = store.connection.transaction().unwrap();
    for n in 2..=MAX_LEDGER_ENTRIES {
        let r = apply(&format!("apply:{n}"), Some(n - 1), false);
        let receipt = RecordingPlanReceipt {
            request_id: r.request_id.clone(),
            applied_revision: n,
            commit_version: n,
            plan: evidence::PlanRef {
                plan_id: first.plan.plan_id.clone(),
                revision: n,
            },
            ..first.clone()
        };
        tx.execute("INSERT INTO recording_plan_applications SELECT ?1,?2,?3,?4,plan_id,desired_revision,mapping_revision,retention_revision,resolved_json,resolved_hash,?1,?5 FROM recording_plan_applications WHERE applied_revision=1", params![n as i64, r.request_id, (n - 1) as i64, canonical::encode(&r).unwrap(), canonical::encode(&receipt).unwrap()]).unwrap();
    }
    tx.execute(
        "UPDATE recording_plan_state SET applied_revision=?1,application_count=?1",
        [MAX_LEDGER_ENTRIES as i64],
    )
    .unwrap();
    tx.execute(
        "UPDATE store_meta SET last_commit=?1",
        [MAX_LEDGER_ENTRIES as i64],
    )
    .unwrap();
    tx.commit().unwrap();
    let mut reader = store.reader().unwrap();
    assert_eq!(
        reader
            .preflight_recording_plan(&original, &control())
            .unwrap()
            .outcome,
        PlanPreflightOutcome::Replay(first)
    );
    let request = apply("overflow", Some(MAX_LEDGER_ENTRIES), false);
    assert!(matches!(
        reader.preflight_recording_plan(&request, &control()),
        Err(StoreError::RecordingPlanCapacity)
    ));
    assert!(matches!(
        store.apply_recording_plan(&request, &control()),
        Err(StoreError::RecordingPlanCapacity)
    ));
    assert_eq!(counter(&store), MAX_LEDGER_ENTRIES as i64);
}
