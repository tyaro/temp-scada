use scada_historian::{
    recorder::ManagedRecorderStart,
    store::{
        query::QueryControl,
        recording_plan::*,
        retention::{
            application::{PolicyApplyRequest, PolicyPreparationRequest},
            clock_guard::RetentionClockPolicy,
            policy::CutoffRule,
        },
        SqliteStore,
    },
};
use serde_json::json;
use std::time::Duration;
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}
pub fn apply(
    store: &mut SqliteStore,
    session: &scada_historian::store::SessionSpec,
) -> (
    scada_historian::store::evidence::PlanRef,
    ManagedRecorderStart,
) {
    let members: Vec<_> = session
        .members
        .iter()
        .enumerate()
        .map(|(n, m)| RecordingMappingMember {
            member_id: format!("member:{n}"),
            identity: m.clone(),
        })
        .collect();
    store
        .register_recording_mapping(
            &RegisterMappingRequest {
                request_id: "map".into(),
                expected_mapping_revision: None,
                mapping: RecordingMapping {
                    hub_ref: "hub".into(),
                    hub_instance_id: members[0].identity.hub_instance_id.clone(),
                    members: members.clone(),
                },
            },
            &control(),
        )
        .unwrap();
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
                request_id: "retention".into(),
                expected_applied_revision: None,
                expected_preview_snapshot_commit: preview.snapshot_commit,
                reference_wall_ms: 3000,
                proposed_policy: policy,
            },
            &control(),
        )
        .unwrap();
    let applied=store.apply_recording_plan(&ApplyRecordingPlanRequest{request_id:"apply".into(),expected_applied_revision:None,expected_mapping_revision:Some(1),expected_retention_applied_revision:Some(1),desired:json!({"version":1,"kind":"recordingPlan","planId":"desired","revision":1,"enabled":true,"group":{"groupId":"group","hubRef":"hub","periodMs":members[0].identity.period_ms,"members":members.iter().map(|m|json!({"memberId":m.member_id,"externalName":m.identity.external_name,"valueType":m.identity.value_type})).collect::<Vec<_>>()}})},&control()).unwrap();
    (
        applied.plan,
        ManagedRecorderStart {
            activation_id: "managed-first".into(),
            expected_applied_revision: 1,
            expected_mapping_revision: 1,
            expected_retention_applied_revision: 1,
        },
    )
}
