//! Test support for crates that compose the recording registry (feature `test-support`).
//! It builds a pristine native owner over a closed, joined recording in a temporary store,
//! like the crate's own unit tests, without a Hub. Never enabled by a product build.
use super::{preflight::PreflightOwner, resume::ResumeOwner, RecordingSupervisor};
use crate::{
    recorder_source::{SdkBindingPin, SdkGenerationPin, SdkRecorderPlan},
    recording_host::{
        operations::RecordingOperationsOwner, RecordingCompletion, RecordingHost, RecordingPhase,
        RecordingRun,
    },
};
use banto_tagclient::{CollectionMode, StableTagId};
use scada_historian::{
    recorder::{
        CleanupOutcome, RecorderCounters, RecorderReport, RecorderState, StopCause, TerminalReport,
    },
    store::{
        evidence::{ClockStamp, PlanRef, TimedStart},
        IdentityDescriptor, SessionSpec, Source, SqliteStore, StoreIdentity, ValueType,
    },
};
use scada_model::recording_operations::RecordingOperationsContext;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

/// A temporary store directory, removed on drop. Keep it alive as long as the owner.
pub struct TestStoreDir(PathBuf);

impl TestStoreDir {
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestStoreDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The operations context of [`joined_owner`]'s recording (session `recording`).
pub fn context() -> RecordingOperationsContext {
    let fixtures: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/recording-operations-cases.json"
    )))
    .expect("operations fixtures");
    let mut context = fixtures["bases"]["context"].clone();
    context["sessionId"] = Value::from("recording");
    RecordingOperationsContext::from_value(context).expect("fixture context")
}

/// A pristine native owner (no client issued) of a joined recording, ready for
/// `RecordingRegistryOwnerSeed::try_from_owner`.
pub fn joined_owner() -> (RecordingOperationsOwner, TestStoreDir) {
    let (host, dir) = joined_host();
    let reader = host
        .store
        .as_ref()
        .expect("idle host owns its store")
        .reader()
        .expect("store reader");
    let supervisor = RecordingSupervisor {
        host,
        preflight: PreflightOwner::new(reader),
        resume: ResumeOwner::default(),
        receipt_read: None,
    };
    let run = supervisor
        .state()
        .recording
        .run
        .clone()
        .expect("joined recording run");
    let owner = RecordingOperationsOwner::try_new(supervisor, context(), run)
        .expect("pristine native owner");
    (owner, dir)
}

fn joined_host() -> (RecordingHost, TestStoreDir) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = TestStoreDir(std::env::temp_dir().join(format!(
        "scada-runtime-test-support-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    let mut store = SqliteStore::create(
        &dir.0,
        StoreIdentity {
            store_id: "test-support".into(),
            deployment_id: "test".into(),
        },
    )
    .expect("test store");
    store
        .begin_timed_session(
            plan().session().clone(),
            TimedStart {
                clock_epoch: "record-epoch".into(),
                at_ms: 1000,
                plan: PlanRef {
                    plan_id: "plan".into(),
                    revision: 1,
                },
            },
        )
        .expect("test session");
    let closed = store
        .close_timed_session(
            "recording",
            ClockStamp {
                clock_epoch: "record-epoch".into(),
                at_ms: 2000,
            },
        )
        .expect("closed test session");
    let mut host = RecordingHost::new(store);
    let run = RecordingRun(Arc::new(()));
    host.completion = Some(Arc::new(RecordingCompletion {
        activation_receipt: None,
        run: run.clone(),
        progress: None,
        report: Some(RecorderReport {
            state: RecorderState::Stopped,
            already_stopped: false,
            counters: RecorderCounters::default(),
            observation: None,
            tick_receipt: None,
            gap_receipt: None,
            terminal: Some(TerminalReport {
                cause: StopCause::Cancelled,
                cleanup: CleanupOutcome::Closed(closed),
            }),
        }),
        start_error: None,
        source_shutdown: Ok(()),
    }));
    host.status.send_modify(|status| {
        let status = Arc::make_mut(status);
        status.run = Some(run);
        status.phase = RecordingPhase::Joined;
        status.session_id = Some("recording".into());
    });
    host.last_clock_epoch = Some("record-epoch".into());
    (host, dir)
}

fn plan() -> SdkRecorderPlan {
    // The tag of the crate's unit-test catalog (revision 3, run 7, configured).
    let external_name = "PLC01.Fast.Tank01.Level";
    let stable_id = StableTagId::new(1, 2, 3);
    SdkRecorderPlan::new(
        SessionSpec {
            session_id: "recording".into(),
            members: vec![IdentityDescriptor {
                series_id: "number".into(),
                hub_instance_id: "hub-a".into(),
                incarnation_id: "life-a".into(),
                external_name: external_name.into(),
                segment_id: "segment-a".into(),
                value_type: ValueType::Number,
                unit: Some("%".into()),
                period_ms: 1000,
                source: Source::Real,
            }],
        },
        SdkGenerationPin {
            catalog_revision: 3,
            run_id: Some(7),
            collection_mode: CollectionMode::Configured,
        },
        vec![SdkBindingPin {
            series_id: "number".into(),
            stable_id,
            tag_key: "key".into(),
            data_type: "f64".into(),
        }],
    )
    .expect("test plan")
}
