use super::*;
use crate::store::{
    retention::{
        application::{PolicyApplyRequest, PolicyPreparationRequest},
        clock_guard::RetentionClockPolicy,
        policy::CutoffRule,
    },
    test_support::*,
};
use serde_json::json;
use std::time::Duration;
pub(super) fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
pub(super) fn mapping() -> RecordingMapping {
    let mut members = spec("validation").members;
    members[1].external_name = "Plant.Run".into();
    RecordingMapping {
        hub_ref: "hub:1".into(),
        hub_instance_id: "hub-a".into(),
        members: members
            .into_iter()
            .map(|identity| RecordingMappingMember {
                member_id: format!("m:{}", identity.series_id),
                identity,
            })
            .collect(),
    }
}
pub(super) fn register(key: &str, expected: Option<u64>) -> RegisterMappingRequest {
    RegisterMappingRequest {
        request_id: key.into(),
        expected_mapping_revision: expected,
        mapping: mapping(),
    }
}
pub(super) fn desired(enabled: bool) -> serde_json::Value {
    json!({"version":1,"kind":"recordingPlan","planId":"desired:1","revision":1,"enabled":enabled,"group":{"groupId":"group:1","hubRef":"hub:1","periodMs":1000,"members":mapping().members.into_iter().map(|m|json!({"memberId":m.member_id,"externalName":m.identity.external_name,"valueType":m.identity.value_type})).collect::<Vec<_>>()}})
}
pub(super) fn apply(key: &str, previous: Option<u64>, enabled: bool) -> ApplyRecordingPlanRequest {
    ApplyRecordingPlanRequest {
        request_id: key.into(),
        expected_applied_revision: previous,
        desired: desired(enabled),
        expected_mapping_revision: enabled.then_some(1),
        expected_retention_applied_revision: enabled.then_some(1),
    }
}
pub(super) fn retention(store: &mut SqliteStore) -> u64 {
    let policy = RetentionClockPolicy {
        policy_id: "retention".into(),
        revision: 1,
        cutoff_rule: CutoffRule::Elapsed {
            retain_for_ms: 1000,
        },
        tolerance_ms: 10,
        max_observation_gap_ms: 1000,
        max_cutoff_advance_ms: 500,
        initial_cutoff_ceiling_ms: Some(2000),
    };
    let prep = store
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
                request_id: "retention-apply".into(),
                expected_applied_revision: None,
                expected_preview_snapshot_commit: prep.snapshot_commit,
                reference_wall_ms: 3000,
                proposed_policy: policy,
            },
            &control(),
        )
        .unwrap()
        .applied_revision
}
pub(super) fn counter(store: &SqliteStore) -> i64 {
    store
        .connection
        .query_row("SELECT last_commit FROM store_meta", [], |r| r.get(0))
        .unwrap()
}
pub(super) fn enabled_store() -> (TempStore, SqliteStore) {
    let dir = TempStore::new();
    let mut store = dir.create();
    store
        .register_recording_mapping(&register("map", None), &control())
        .unwrap();
    retention(&mut store);
    (dir, store)
}
#[test]
fn mapping_receipts_cas_order_and_request_pools_are_independent() {
    let dir = TempStore::new();
    let mut store = dir.create();
    let initial = store.recording_plan_state(&control()).unwrap();
    assert_eq!(initial.snapshot_commit, 0);
    assert!(initial.activation_supported);
    let r = register("shared", None);
    let first = store.register_recording_mapping(&r, &control()).unwrap();
    let count = counter(&store);
    let mut reordered = r.clone();
    reordered.mapping.members.reverse();
    assert_eq!(
        store
            .register_recording_mapping(&reordered, &control())
            .unwrap(),
        first
    );
    assert_eq!(counter(&store), count);
    let mut bad = r.clone();
    bad.mapping.hub_ref = "other".into();
    assert!(matches!(
        store.register_recording_mapping(&bad, &control()),
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        store.register_recording_mapping(&register("stale", None), &control()),
        Err(StoreError::Conflict)
    ));
    let second = store
        .register_recording_mapping(&register("second", Some(1)), &control())
        .unwrap();
    assert_eq!(second.mapping_revision, 2);
    assert_eq!(
        store
            .recording_mapping_receipt("shared", &control())
            .unwrap(),
        Some(first)
    );
    assert!(store
        .recording_mapping_receipt("unknown", &control())
        .unwrap()
        .is_none());
    let receipt = store
        .apply_recording_plan(&apply("shared", None, false), &control())
        .unwrap();
    assert_eq!(receipt.applied_revision, 1);
}
#[test]
fn apply_is_durable_atomic_and_keeps_query_reservations_private() {
    let (dir, mut store) = enabled_store();
    let r = apply("apply", None, true);
    let before = counter(&store);
    let receipt = store.apply_recording_plan(&r, &control()).unwrap();
    assert_eq!(receipt.commit_version, before as u64 + 1);
    let state = store.recording_plan_state(&control()).unwrap();
    assert_eq!(state.applied.as_ref().unwrap().receipt, receipt);
    assert_eq!(state.applied.unwrap().resolution.unwrap().members.len(), 2);
    let mut reader = store.reader().unwrap();
    let result=reader.query_raw(&json!({"version":1,"kind":"query","requestId":"read","seriesIds":["number","bool"],"fromMs":0,"toMs":10,"mode":"raw","maxPointsPerSeries":10}),&control()).unwrap();
    assert!(result["series"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["status"] == "unknownSeries"));
    drop(reader);
    drop(store);
    let mut store = dir.open();
    assert_eq!(store.apply_recording_plan(&r, &control()).unwrap(), receipt);
    assert_eq!(
        store.recording_plan_receipt("apply", &control()).unwrap(),
        Some(receipt)
    );
}
#[test]
fn disabled_head_blocks_every_new_session_but_preserves_original_begin_and_tick_receipts() {
    let dir = TempStore::new();
    let mut store = dir.create();
    let s = spec("old");
    store.begin_session(s.clone()).unwrap();
    let t = tick("old", 1, 1000);
    let receipt = store.append_tick(t.clone()).unwrap();
    store.close_session("old").unwrap();
    let plan = store
        .apply_recording_plan(&apply("disabled", None, false), &control())
        .unwrap();
    assert!(store.begin_session(s).is_ok());
    assert_eq!(store.append_tick(t).unwrap(), receipt);
    assert!(matches!(
        store.begin_session(spec("new")),
        Err(StoreError::ManagedRecordingRequired)
    ));
    assert!(matches!(
        store.begin_timed_session(
            spec("new-timed"),
            evidence::TimedStart {
                plan: plan.plan,
                clock_epoch: "new-clock".into(),
                at_ms: 2000
            }
        ),
        Err(StoreError::ManagedRecordingRequired)
    ));
}
#[test]
fn mismatches_and_immutable_definitions_do_not_advance_any_pointer() {
    let (_dir, mut store) = enabled_store();
    let first = store
        .apply_recording_plan(&apply("first", None, true), &control())
        .unwrap();
    let before = counter(&store);
    let mut next = apply("next", Some(1), true);
    next.expected_mapping_revision = Some(2);
    assert!(matches!(
        store.apply_recording_plan(&next, &control()),
        Err(StoreError::Conflict)
    ));
    next.expected_mapping_revision = Some(1);
    next.expected_retention_applied_revision = Some(2);
    assert!(matches!(
        store.apply_recording_plan(&next, &control()),
        Err(StoreError::Conflict)
    ));
    next.expected_retention_applied_revision = Some(1);
    next.desired["group"]["periodMs"] = json!(500);
    assert!(matches!(
        store.apply_recording_plan(&next, &control()),
        Err(StoreError::Conflict)
    ));
    assert_eq!(counter(&store), before);
    let mut disable = apply("disabled", Some(1), false);
    disable.desired["revision"] = json!(2);
    store.apply_recording_plan(&disable, &control()).unwrap();
    assert_eq!(
        store
            .apply_recording_plan(&apply("first", None, true), &control())
            .unwrap(),
        first
    );
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .unwrap()
            .receipt
            .applied_revision,
        2
    );
}
#[test]
fn active_recording_blocks_new_management_but_not_mapping_replays() {
    let dir = TempStore::new();
    let mut store = dir.create();
    let r = register("first", None);
    let old = store.register_recording_mapping(&r, &control()).unwrap();
    store.begin_session(spec("active")).unwrap();
    assert!(matches!(
        store.apply_recording_plan(&apply("disabled", None, false), &control()),
        Err(StoreError::Busy)
    ));
    assert!(matches!(
        store.register_recording_mapping(&register("new", Some(1)), &control()),
        Err(StoreError::Busy)
    ));
    assert_eq!(
        store.register_recording_mapping(&r, &control()).unwrap(),
        old
    );
}
#[test]
fn rollback_hooks_late_cancellation_and_response_loss_are_distinct() {
    let (_dir, mut store) = enabled_store();
    let r = apply("first", None, true);
    let before = counter(&store);
    for at in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
    ] {
        assert!(store
            .apply_recording_plan_with_hook(&r, &control(), &mut |point| if point == at {
                Err(StoreError::Invalid("injected"))
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(counter(&store), before);
        assert!(store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .is_none());
    }
    let c = control();
    let token = c.cancellation.clone();
    let result = store
        .apply_recording_plan_with_hook(&r, &c, &mut |point| {
            if point == Boundary::AfterCommit {
                token.cancel();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(store.apply_recording_plan(&r, &control()).unwrap(), result);
    let mut next = apply("second", Some(1), true);
    next.desired["revision"] = json!(2);
    assert!(store
        .apply_recording_plan_with_hook(&next, &control(), &mut |point| if point
            == Boundary::AfterCommit
        {
            Err(StoreError::Invalid("lost response"))
        } else {
            Ok(())
        })
        .is_err());
    assert_eq!(
        store
            .apply_recording_plan(&next, &control())
            .unwrap()
            .applied_revision,
        2
    );
}
#[test]
fn all_query_budgets_cancel_before_mutation() {
    let (_dir, mut store) = enabled_store();
    let before = counter(&store);
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_vm_steps = 1000,
            3 => c.limits.max_decoded_rows = 1,
            _ => c.limits.max_output_bytes = 1,
        }
        assert!(matches!(
            store.apply_recording_plan(&apply("first", None, true), &c),
            Err(StoreError::Control(_))
        ));
        assert_eq!(counter(&store), before);
    }
}
#[test]
fn invalid_mapping_and_disabled_expectations_fail_before_commit() {
    let dir = TempStore::new();
    let mut store = dir.create();
    let before = counter(&store);
    for kind in 0..4 {
        let mut r = register("map", None);
        match kind {
            0 => r.mapping.members[1].member_id = r.mapping.members[0].member_id.clone(),
            1 => {
                r.mapping.members[1].identity.external_name =
                    r.mapping.members[0].identity.external_name.clone()
            }
            2 => r.mapping.members[0].identity.hub_instance_id = "other".into(),
            _ => r.mapping.members[0].identity.period_ms = 10,
        }
        assert!(store.register_recording_mapping(&r, &control()).is_err());
    }
    let mut r = apply("disabled", None, false);
    r.expected_mapping_revision = Some(1);
    assert!(store.apply_recording_plan(&r, &control()).is_err());
    assert_eq!(counter(&store), before);
}

mod failures;
mod validation;
