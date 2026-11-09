use super::*;
use scada_historian::store::query::QueryControl;
use scada_historian::store::recording_plan::{
    ApplyRecordingPlanRequest, RecordingMappingMember, RegisterMappingRequest,
};
use scada_historian::store::{
    IdentityDescriptor, ObservationValue, Quality, SessionSpec, Source, SourceEpoch, Tick,
    TickObservation, ValueType,
};
use std::path::PathBuf;

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("scada-host-historian-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn identity_path(&self) -> PathBuf {
        self.0.join(STORE_IDENTITY_FILE)
    }

    fn saved(&self) -> StoreIdentityFile {
        serde_json::from_slice(&std::fs::read(self.identity_path()).unwrap()).unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

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

fn desired(plan_id: &str, enabled: bool) -> Value {
    json!({"version":1,"kind":"recordingPlan","planId":plan_id,"revision":1,"enabled":enabled,
        "group":{"groupId":"group","hubRef":"hub","periodMs":1000,
            "members":[{"memberId":"member-0","externalName":"Line1.Temperature",
                "valueType":"number"}]}})
}

/// Records three ticks of `series-0`, then registers its mapping and applies
/// plan `plan-a`, disabled, as the recording DB holds after a recorded run
/// and an apply that stopped recording. (An enabled plan also needs an
/// applied retention policy, which C5-2's first setup adds.)
fn seed(dir: &TempDir) {
    let identity = StoreIdentityFile::generate("deployment-a");
    std::fs::write(dir.identity_path(), serde_json::to_vec(&identity).unwrap()).unwrap();
    let mut store = SqliteStore::create(dir.0.join(STORE_DIR), identity.store_identity()).unwrap();
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

fn project(plan_id: Option<&str>) -> Project {
    let mut value: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/minimal.project.json"
    )))
    .unwrap();
    if let Some(plan_id) = plan_id {
        value["recordingPlan"] = desired(plan_id, true);
    }
    Project::from_json(&value.to_string()).unwrap()
}

fn raw(from: i64, to: i64) -> Value {
    json!({"version":1,"kind":"query","requestId":"history-preview","seriesIds":["series-0"],
        "fromMs":from,"toMs":to,"mode":"raw","maxPointsPerSeries":100})
}

#[tokio::test]
async fn first_start_saves_the_identity_creates_the_store_and_reopens_it() {
    let dir = TempDir::new();
    let first = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(first.unavailable_reason(), None);
    let saved = dir.saved();
    assert_eq!(first.identity(), Some(&saved));
    assert_eq!(saved.version, 1);
    assert_eq!(saved.deployment_id, "deployment-a");
    assert!(saved.store_id.starts_with("store:"));
    assert!(saved.historian_namespace.starts_with("historian:"));
    assert_ne!(saved.store_id, saved.historian_namespace);
    assert!(dir.0.join(STORE_DIR).join("store.sqlite3").is_file());
    // No applied plan yet: no History service for any Project.
    assert_eq!(first.history_context(&project(Some("plan-a"))), Ok(None));
    drop(first);

    // A restart keeps the identity, whatever deployment it is started with.
    let second = RecordingRuntime::start(&dir.0, "deployment-b");
    assert_eq!(second.unavailable_reason(), None);
    assert_eq!(second.identity(), Some(&saved));
    assert_eq!(dir.saved(), saved);
}

#[tokio::test]
async fn a_second_runtime_on_the_same_store_is_locked_out() {
    let dir = TempDir::new();
    let first = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(first.unavailable_reason(), None);
    let second = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(second.unavailable_reason(), Some(STORE_LOCKED));
    assert_eq!(second.history_context(&project(None)), Err(STORE_LOCKED));
    assert_eq!(
        second.history_query("call", raw(0, 4000)).await,
        Err(HistoryFailure::Unavailable)
    );
}

#[tokio::test]
async fn a_store_without_its_identity_is_never_adopted() {
    let dir = TempDir::new();
    drop(RecordingRuntime::start(&dir.0, "deployment-a"));
    std::fs::remove_file(dir.identity_path()).unwrap();
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(runtime.unavailable_reason(), Some(IDENTITY_MISSING));
    assert!(!dir.identity_path().exists());
}

#[tokio::test]
async fn an_invalid_or_foreign_identity_is_refused_and_left_as_it_is() {
    let dir = TempDir::new();
    drop(RecordingRuntime::start(&dir.0, "deployment-a"));
    let saved = dir.saved();
    let rewrite = |value: Value| {
        std::fs::write(dir.identity_path(), value.to_string()).unwrap();
    };
    let base = serde_json::to_value(&saved).unwrap();
    for (name, broken) in [
        ("not JSON", Value::from("{")),
        ("unknown version", {
            let mut v = base.clone();
            v["version"] = json!(2);
            v
        }),
        ("unknown field", {
            let mut v = base.clone();
            v["extra"] = json!(true);
            v
        }),
        ("invalid namespace", {
            let mut v = base.clone();
            v["historianNamespace"] = json!("archive/other");
            v
        }),
        ("missing namespace", {
            let mut v = base.clone();
            v.as_object_mut().unwrap().remove("historianNamespace");
            v
        }),
    ] {
        let body = if name == "not JSON" {
            "{".to_owned()
        } else {
            broken.to_string()
        };
        std::fs::write(dir.identity_path(), &body).unwrap();
        let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
        assert_eq!(
            runtime.unavailable_reason(),
            Some(IDENTITY_INVALID),
            "{name}"
        );
        assert_eq!(std::fs::read_to_string(dir.identity_path()).unwrap(), body);
    }
    let mut foreign = base.clone();
    foreign["storeId"] = json!("store:other");
    rewrite(foreign.clone());
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(runtime.unavailable_reason(), Some(IDENTITY_MISMATCH));
    assert_eq!(
        std::fs::read_to_string(dir.identity_path()).unwrap(),
        foreign.to_string()
    );
    // The original identity still opens the untouched store.
    rewrite(base);
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(runtime.unavailable_reason(), None);
}

#[tokio::test]
async fn a_start_stopped_after_saving_the_identity_creates_the_store_with_it() {
    let dir = TempDir::new();
    let identity = StoreIdentityFile::generate("deployment-a");
    std::fs::write(dir.identity_path(), serde_json::to_vec(&identity).unwrap()).unwrap();
    let runtime = RecordingRuntime::start(&dir.0, "deployment-b");
    assert_eq!(runtime.unavailable_reason(), None);
    assert_eq!(runtime.identity(), Some(&identity));
    drop(runtime);
    assert_eq!(
        RecordingRuntime::start(&dir.0, "deployment-b").unavailable_reason(),
        None
    );
}

#[tokio::test]
async fn an_unsupported_store_directory_is_reported_and_kept() {
    let dir = TempDir::new();
    drop(RecordingRuntime::start(&dir.0, "deployment-a"));
    std::fs::write(
        dir.0.join(STORE_DIR).join("store.sqlite3"),
        b"not a database",
    )
    .unwrap();
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    assert!(
        matches!(
            runtime.unavailable_reason(),
            Some(STORE_UNSUPPORTED | STORE_UNAVAILABLE)
        ),
        "{:?}",
        runtime.unavailable_reason()
    );
    assert_eq!(
        std::fs::read(dir.0.join(STORE_DIR).join("store.sqlite3")).unwrap(),
        b"not a database"
    );
}

#[tokio::test]
async fn the_context_lists_the_applied_series_for_the_same_plan_only() {
    let dir = TempDir::new();
    seed(&dir);
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(runtime.unavailable_reason(), None);
    let namespace = dir.saved().historian_namespace;
    let project = project(Some("plan-a"));
    assert_eq!(
        runtime.history_context(&project),
        Ok(Some(json!({
            "version": 2,
            "kind": "historyContext",
            "contextId": "applied:1",
            "historianNamespace": namespace,
            "projectId": project.id(),
            "projectRevision": project.revision(),
            "series": [{"seriesId": "series-0", "label": "Line1.Temperature"}],
        })))
    );
    assert_eq!(
        runtime.history_context(&self::project(Some("plan-b"))),
        Ok(None)
    );
    assert_eq!(runtime.history_context(&self::project(None)), Ok(None));
}

#[tokio::test]
async fn a_query_reads_the_recorded_ticks_and_failures_keep_the_reader() {
    let dir = TempDir::new();
    seed(&dir);
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let result = runtime.history_query("call-1", raw(0, 4000)).await.unwrap();
    assert_eq!(result["kind"], "result");
    assert_eq!(result["query"], raw(0, 4000));
    scada_historian::validate_history_contract(&result).unwrap();
    let values: Vec<f64> = result["series"][0]["raw"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["value"].as_f64().unwrap())
        .collect();
    assert_eq!(values, [0.0, 1.0, 2.0]);

    let mut invalid = raw(0, 4000);
    invalid["mode"] = json!("average");
    assert_eq!(
        runtime.history_query("call-2", invalid).await,
        Err(HistoryFailure::InvalidRequest)
    );
    let mut many = raw(0, 4000);
    many["maxPointsPerSeries"] = json!(1);
    assert_eq!(
        runtime.history_query("call-3", many).await,
        Err(HistoryFailure::TooManyPoints)
    );
    // The reader survives each failure.
    assert!(runtime.history_query("call-4", raw(0, 4000)).await.is_ok());
}

#[tokio::test]
async fn a_cancel_before_its_query_keeps_it_from_running() {
    let dir = TempDir::new();
    seed(&dir);
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    runtime.history_cancel("early");
    assert_eq!(
        runtime.history_query("early", raw(0, 4000)).await,
        Err(HistoryFailure::Cancelled)
    );
    // The early cancel is used once; another call is not affected.
    assert!(runtime.history_query("later", raw(0, 4000)).await.is_ok());
    assert!(runtime.history_query("early", raw(0, 4000)).await.is_ok());
}

#[test]
fn the_cancel_book_targets_only_the_running_call() {
    let mut book = CancelBook::default();
    let token = CancellationToken::default();
    assert!(book.begin("a", token.clone()));
    book.cancel("b");
    assert!(!token.is_cancelled());
    book.cancel("a");
    assert!(token.is_cancelled());
    book.end("a");
    assert!(book.current.is_none());
    for n in 0..EARLY_CANCELS + 1 {
        book.cancel(&format!("early-{n}"));
    }
    assert_eq!(book.early.len(), EARLY_CANCELS);
    assert!(book.begin("early-0", CancellationToken::default()));
    assert!(!book.begin("early-1", CancellationToken::default()));
}

#[test]
fn store_errors_map_to_fixed_reasons() {
    assert_eq!(store_reason(StoreError::Busy), STORE_LOCKED);
    assert_eq!(
        store_reason(StoreError::IdentityMismatch),
        IDENTITY_MISMATCH
    );
    assert_eq!(
        store_reason(StoreError::UnsupportedStore),
        STORE_UNSUPPORTED
    );
    assert_eq!(
        store_reason(StoreError::Io(std::io::ErrorKind::Other.into())),
        STORE_UNAVAILABLE
    );
}
