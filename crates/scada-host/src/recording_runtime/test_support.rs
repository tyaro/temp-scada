//! Test support (feature `test-support`): a recording DB as a recorded run
//! and an apply leave it, for the command tests of the desktop host.
use super::{StoreIdentityFile, STORE_DIR, STORE_IDENTITY_FILE};
use scada_historian::store::query::QueryControl;
use scada_historian::store::recording_plan::{
    ApplyRecordingPlanRequest, RecordingMapping, RecordingMappingMember, RegisterMappingRequest,
};
use scada_historian::store::{
    IdentityDescriptor, ObservationValue, Quality, SessionSpec, Source, SourceEpoch, SqliteStore,
    Tick, TickObservation, ValueType,
};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}

fn descriptor() -> IdentityDescriptor {
    IdentityDescriptor {
        series_id: "series-0".into(),
        hub_instance_id: "hub-a".into(),
        incarnation_id: "incarnation-0".into(),
        external_name: "Line1.Temperature".into(),
        segment_id: "segment-0".into(),
        value_type: ValueType::Number,
        unit: None,
        period_ms: 1000,
        source: Source::Real,
    }
}

pub fn desired(plan_id: &str, enabled: bool) -> Value {
    json!({"version":1,"kind":"recordingPlan","planId":plan_id,"revision":1,"enabled":enabled,
        "group":{"groupId":"group","hubRef":"hub","periodMs":1000,
            "members":[{"memberId":"member-0","externalName":"Line1.Temperature",
                "valueType":"number"}]}})
}

/// Records three ticks of `series-0`, then registers its mapping and applies
/// plan `plan-a`, disabled, as the recording DB holds after a recorded run
/// and an apply that stopped recording. (An enabled plan also needs an
/// applied retention policy, which C5-2's first setup adds.)
pub fn seed_applied_plan(data_dir: &Path) {
    let identity = StoreIdentityFile::generate("deployment-a");
    std::fs::write(
        data_dir.join(STORE_IDENTITY_FILE),
        serde_json::to_vec(&identity).unwrap(),
    )
    .unwrap();
    let mut store =
        SqliteStore::create(data_dir.join(STORE_DIR), identity.store_identity()).unwrap();
    store
        .begin_session(SessionSpec {
            session_id: "recording".into(),
            members: vec![descriptor()],
        })
        .unwrap();
    for (n, at) in [1000, 2000, 3000].into_iter().enumerate() {
        store
            .append_tick(Tick {
                session_id: "recording".into(),
                sequence: n as u64 + 1,
                clock_epoch: "epoch".into(),
                sample_time_ms: at,
                ingested_at_ms: at,
                observations: vec![TickObservation {
                    series_id: "series-0".into(),
                    source_time_ms: Some(at),
                    quality: Some(Quality::Good),
                    source: Some(Source::Real),
                    value: Some(ObservationValue::Number(n as f64)),
                    reason: None,
                    source_epoch: Some(SourceEpoch {
                        hub_instance_id: "hub-a".into(),
                        run_id: Some(1),
                        catalog_revision: 1,
                        sdk_generation: 1,
                    }),
                }],
            })
            .unwrap();
    }
    store.close_session("recording").unwrap();
    store
        .register_recording_mapping(
            &RegisterMappingRequest {
                request_id: "mapping-1".into(),
                expected_mapping_revision: None,
                mapping: RecordingMapping {
                    hub_ref: "hub".into(),
                    hub_instance_id: "hub-a".into(),
                    members: vec![RecordingMappingMember {
                        member_id: "member-0".into(),
                        identity: descriptor(),
                    }],
                },
            },
            &control(),
        )
        .unwrap();
    store
        .apply_recording_plan(
            &ApplyRecordingPlanRequest {
                request_id: "apply-1".into(),
                expected_applied_revision: None,
                desired: desired("plan-a", false),
                expected_mapping_revision: None,
                expected_retention_applied_revision: None,
            },
            &control(),
        )
        .unwrap();
}
