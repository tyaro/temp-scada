use super::*;
use crate::store::{recording_plan::tests as ledger, test_support::*};
use ledger::{control, counter};
use serde_json::json;
fn request(id: &str) -> ActivateRecordingPlanRequest {
    ActivateRecordingPlanRequest {
        activation_id: id.into(),
        expected_applied_revision: 1,
        expected_mapping_revision: 1,
        expected_retention_applied_revision: 1,
        session_id: format!("session:{id}"),
        start: evidence::ClockStamp {
            clock_epoch: format!("clock:{id}"),
            at_ms: 1000,
        },
    }
}
fn setup() -> (TempStore, SqliteStore) {
    let (d, mut s) = ledger::enabled_store();
    s.apply_recording_plan(&ledger::apply("apply", None, true), &control())
        .unwrap();
    (d, s)
}
fn close(store: &mut SqliteStore, r: &RecordingActivationReceipt) {
    store
        .close_timed_session(
            &r.spec.session_id,
            evidence::ClockStamp {
                clock_epoch: r.start.clock_epoch.clone(),
                at_ms: 3000,
            },
        )
        .unwrap();
}
fn raw(store: &SqliteStore, mode: &str) -> serde_json::Value {
    let query = json!({"version":1,"kind":"query","requestId":"read","seriesIds":["number","bool"],"fromMs":0,"toMs":4000,"mode":mode,"maxPointsPerSeries":100});
    let mut reader = store.reader().unwrap();
    if mode == "raw" {
        reader.query_raw(&query, &control()).unwrap()
    } else {
        reader.query_minmax(&query, &control()).unwrap()
    }
}

#[test]
fn activation_atomically_materializes_session_and_records_using_existing_tick_contract() {
    let (_d, mut store) = setup();
    assert!(raw(&store, "raw")["series"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["status"] == "unknownSeries"));
    let before = counter(&store);
    let r = store
        .activate_recording_plan(&request("first"), &control())
        .unwrap();
    assert_eq!(r.commit_version, before as u64 + 1);
    assert_eq!(r.spec.members.len(), 2);
    assert_eq!(r.plan.revision, 1);
    let s = store
        .recording_activation("first", &control())
        .unwrap()
        .unwrap();
    assert_eq!(s.receipt, r);
    assert_eq!(s.session.state, SessionState::Active);
    assert_eq!(s.session.committed_through, 0);
    for mode in ["raw", "minmax"] {
        let result = raw(&store, mode);
        assert!(result["series"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["status"] != "unknownSeries"));
    }
    let mut t = tick(&r.spec.session_id, 1, 2000);
    t.clock_epoch = r.start.clock_epoch.clone();
    store.append_tick(t.clone()).unwrap();
    assert_eq!(
        store
            .recording_activation("first", &control())
            .unwrap()
            .unwrap()
            .session
            .committed_through,
        1
    );
    close(&mut store, &r);
    assert_eq!(
        store
            .recording_activation("first", &control())
            .unwrap()
            .unwrap()
            .session
            .state,
        SessionState::Closed
    );
    assert_eq!(
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap(),
        r
    );
    assert!(store.append_tick(t).is_ok());
    assert_eq!(
        raw(&store, "raw")["series"][0]["raw"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn old_replays_never_reopen_sessions_and_manual_starts_remain_gated() {
    let (_d, mut store) = setup();
    let r = store
        .activate_recording_plan(&request("first"), &control())
        .unwrap();
    assert!(matches!(
        store.activate_recording_plan(&request("second"), &control()),
        Err(StoreError::Busy)
    ));
    let mut changed = request("first");
    changed.start.at_ms += 1;
    assert!(matches!(
        store.activate_recording_plan(&changed, &control()),
        Err(StoreError::Conflict)
    ));
    close(&mut store, &r);
    let mut reused = request("reuse");
    reused.session_id = r.spec.session_id.clone();
    assert!(matches!(
        store.activate_recording_plan(&reused, &control()),
        Err(StoreError::Conflict)
    ));
    reused.session_id = "fresh-session".into();
    reused.start.clock_epoch = r.start.clock_epoch.clone();
    assert!(matches!(
        store.activate_recording_plan(&reused, &control()),
        Err(StoreError::Conflict)
    ));
    assert!(store
        .begin_timed_session(
            r.spec.clone(),
            evidence::TimedStart {
                clock_epoch: r.start.clock_epoch.clone(),
                at_ms: r.start.at_ms,
                plan: r.plan.clone()
            }
        )
        .is_ok());
    assert!(matches!(
        store.begin_timed_session(
            spec("manual-new"),
            evidence::TimedStart {
                clock_epoch: "manual-clock".into(),
                at_ms: 4000,
                plan: r.plan.clone()
            }
        ),
        Err(StoreError::ManagedRecordingRequired)
    ));
    assert!(matches!(
        store.begin_session(spec("untimed-new")),
        Err(StoreError::ManagedRecordingRequired)
    ));
    let next = store
        .activate_recording_plan(&request("second"), &control())
        .unwrap();
    assert_eq!(next.sequence, 2);
    close(&mut store, &next);
    let mut disabled = ledger::apply("disable", Some(1), false);
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
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap(),
        r
    );
    assert_eq!(counter(&store), before);
    assert_eq!(
        store
            .recording_activation_state(&control())
            .unwrap()
            .latest
            .unwrap()
            .receipt,
        next
    );
    assert!(store
        .recording_activation("unknown", &control())
        .unwrap()
        .is_none());
}
#[test]
fn restart_preserves_receipt_but_requires_fresh_session_and_epoch() {
    let (d, mut store) = setup();
    let r = store
        .activate_recording_plan(&request("first"), &control())
        .unwrap();
    drop(store);
    let mut store = d.open();
    let state = store.recording_activation_state(&control()).unwrap();
    assert_eq!(state.latest.as_ref().unwrap().receipt, r);
    assert_eq!(
        state.latest.unwrap().session.state,
        SessionState::Interrupted
    );
    assert_eq!(
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap(),
        r
    );
    let mut reused = request("second");
    reused.start.clock_epoch = r.start.clock_epoch.clone();
    assert!(matches!(
        store.activate_recording_plan(&reused, &control()),
        Err(StoreError::Conflict)
    ));
    let second = store
        .activate_recording_plan(&request("second"), &control())
        .unwrap();
    assert_eq!(second.sequence, 2);
}
#[test]
fn absent_disabled_and_invalid_requests_do_not_start_recording() {
    let d = TempStore::new();
    let mut s = d.create();
    assert!(s
        .recording_activation_state(&control())
        .unwrap()
        .latest
        .is_none());
    assert!(matches!(
        s.activate_recording_plan(&request("first"), &control()),
        Err(StoreError::Conflict)
    ));
    s.apply_recording_plan(&ledger::apply("disabled", None, false), &control())
        .unwrap();
    assert!(matches!(
        s.activate_recording_plan(&request("first"), &control()),
        Err(StoreError::Conflict)
    ));
    let before = counter(&s);
    for kind in 0..7 {
        let mut r = request("bad");
        match kind {
            0 => r.activation_id = "bad id".into(),
            1 => r.session_id = "bad id".into(),
            2 => r.expected_applied_revision = 0,
            3 => r.expected_mapping_revision = u64::MAX,
            4 => r.expected_retention_applied_revision = 0,
            5 => r.start.clock_epoch = "bad epoch".into(),
            _ => r.start.at_ms = i64::MAX,
        }
        assert!(matches!(
            s.activate_recording_plan(&r, &control()),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(counter(&s), before);
    }
}
#[test]
fn mapping_and_retention_drift_require_reapply_before_new_activation() {
    for mapping_drift in [false, true] {
        let (_d, mut store) = setup();
        let mut r = request("first");
        if mapping_drift {
            store
                .register_recording_mapping(&ledger::register("map2", Some(1)), &control())
                .unwrap();
        } else {
            use retention::application::{PolicyApplyRequest, PolicyPreparationRequest};
            let mut policy = store
                .recovery_state(&control())
                .unwrap()
                .applied_retention_policy
                .unwrap()
                .policy;
            policy.revision = 2;
            let preview = store
                .preview_retention_policy_application(
                    &PolicyPreparationRequest {
                        proposed_policy: policy.clone(),
                        reference_wall_ms: 3000,
                    },
                    &control(),
                )
                .unwrap();
            store
                .apply_retention_policy(
                    &PolicyApplyRequest {
                        request_id: "retention2".into(),
                        expected_applied_revision: Some(1),
                        expected_preview_snapshot_commit: preview.snapshot_commit,
                        reference_wall_ms: 3000,
                        proposed_policy: policy,
                    },
                    &control(),
                )
                .unwrap();
        }
        assert!(matches!(
            store.activate_recording_plan(&r, &control()),
            Err(StoreError::Conflict)
        ));
        if mapping_drift {
            r.expected_mapping_revision = 2;
        } else {
            r.expected_retention_applied_revision = 2;
        }
        assert!(matches!(
            store.activate_recording_plan(&r, &control()),
            Err(StoreError::Conflict)
        ));
        let mut a = ledger::apply("reapply", Some(1), true);
        a.expected_mapping_revision = Some(r.expected_mapping_revision);
        a.expected_retention_applied_revision = Some(r.expected_retention_applied_revision);
        store.apply_recording_plan(&a, &control()).unwrap();
        r.expected_applied_revision = 2;
        let receipt = store.activate_recording_plan(&r, &control()).unwrap();
        close(&mut store, &receipt);
        store
            .apply_recording_plan(
                &ApplyRecordingPlanRequest {
                    request_id: "third".into(),
                    expected_applied_revision: Some(2),
                    ..a
                },
                &control(),
            )
            .unwrap();
        let mut next = request("next");
        next.expected_applied_revision = 3;
        next.expected_mapping_revision = r.expected_mapping_revision;
        next.expected_retention_applied_revision = r.expected_retention_applied_revision;
        store.activate_recording_plan(&next, &control()).unwrap();
    }
}
#[test]
fn active_job_and_retention_fence_block_new_activation_without_clamping_clock() {
    let (_d, mut store) = setup();
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
    assert!(matches!(
        store.activate_recording_plan(&request("first"), &control()),
        Err(StoreError::Busy)
    ));
    let (_d, mut store) = setup();
    store
        .trim(
            retention::TrimRequest {
                request_id: "trim".into(),
                cutoff_ms: 1000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let mut r = request("first");
    r.start.at_ms = 999;
    assert!(matches!(
        store.activate_recording_plan(&r, &control()),
        Err(StoreError::Conflict)
    ));
    r.start.at_ms = 1000;
    assert_eq!(
        store
            .activate_recording_plan(&r, &control())
            .unwrap()
            .start
            .at_ms,
        1000
    );
}
#[test]
fn prior_manual_clock_epochs_are_never_reused_by_managed_activation() {
    let d = TempStore::new();
    let mut store = d.create();
    let r = request("first");
    let m = ledger::mapping();
    store
        .begin_timed_session(
            SessionSpec {
                session_id: "manual".into(),
                members: m.members.iter().map(|m| m.identity.clone()).collect(),
            },
            evidence::TimedStart {
                clock_epoch: r.start.clock_epoch.clone(),
                at_ms: 1000,
                plan: evidence::PlanRef {
                    plan_id: "manual-plan".into(),
                    revision: 1,
                },
            },
        )
        .unwrap();
    store
        .close_timed_session(
            "manual",
            evidence::ClockStamp {
                clock_epoch: r.start.clock_epoch.clone(),
                at_ms: 3000,
            },
        )
        .unwrap();
    store
        .register_recording_mapping(&ledger::register("map", None), &control())
        .unwrap();
    ledger::retention(&mut store);
    store
        .apply_recording_plan(&ledger::apply("apply", None, true), &control())
        .unwrap();
    assert!(matches!(
        store.activate_recording_plan(&r, &control()),
        Err(StoreError::Conflict)
    ));
}
mod failures;

#[test]
fn eight_members_with_one_or_eight_first_use_origins_fit_activation_and_read_budgets() {
    for separate in [false, true] {
        let d = TempStore::new();
        let mut store = d.create();
        let mut all = ledger::mapping();
        all.members = (0..8)
            .map(|n| {
                let mut m = ledger::mapping().members[0].clone();
                m.member_id = format!("m:{n}");
                m.identity.series_id = format!("s:{n}");
                m.identity.incarnation_id = format!("inc:{n}");
                m.identity.external_name = format!("Plant.Value{n}");
                m
            })
            .collect();
        store
            .begin_session(SessionSpec {
                session_id: "manual".into(),
                members: all.members.iter().map(|m| m.identity.clone()).collect(),
            })
            .unwrap();
        store.close_session("manual").unwrap();
        ledger::retention(&mut store);
        let count = if separate { 9 } else { 1 };
        let mut last = None;
        for n in 1..=count {
            let mut r = ledger::register(&format!("map:{n}"), (n > 1).then_some(n - 1));
            r.mapping = all.clone();
            if separate && n < 9 {
                r.mapping.members = vec![all.members[n as usize - 1].clone()];
            }
            store.register_recording_mapping(&r, &control()).unwrap();
            let mut a = ledger::apply(&format!("apply:{n}"), (n > 1).then_some(n - 1), true);
            a.expected_mapping_revision = Some(n);
            a.desired["revision"] = json!(n);
            a.desired["group"]["members"]=json!(r.mapping.members.iter().map(|m|json!({"memberId":m.member_id,"externalName":m.identity.external_name,"valueType":m.identity.value_type})).collect::<Vec<_>>());
            store.apply_recording_plan(&a, &control()).unwrap();
            last = Some(a);
        }
        let mut first = request("first");
        first.expected_applied_revision = count;
        first.expected_mapping_revision = count;
        let receipt = store.activate_recording_plan(&first, &control()).unwrap();
        assert_eq!(receipt.spec.members.len(), 8);
        assert_eq!(
            store
                .recording_activation_state(&control())
                .unwrap()
                .latest
                .unwrap()
                .receipt,
            receipt
        );
        close(&mut store, &receipt);
        let mut second = first.clone();
        second.activation_id = "second".into();
        second.session_id = "session:second".into();
        second.start.clock_epoch = "clock:second".into();
        let receipt = store.activate_recording_plan(&second, &control()).unwrap();
        assert_eq!(receipt.sequence, 2);
        close(&mut store, &receipt);
        let mut a = last.unwrap();
        a.request_id = "reapply".into();
        a.expected_applied_revision = Some(count);
        store.apply_recording_plan(&a, &control()).unwrap();
        second.activation_id = "third".into();
        second.session_id = "session:third".into();
        second.start.clock_epoch = "clock:third".into();
        second.expected_applied_revision = count + 1;
        let receipt = store.activate_recording_plan(&second, &control()).unwrap();
        assert_eq!(receipt.sequence, 3);
        assert_eq!(
            store
                .recording_activation_state(&control())
                .unwrap()
                .latest
                .unwrap()
                .receipt,
            receipt
        );
        assert!(store.activate_recording_plan(&first, &control()).is_ok());
    }
}
