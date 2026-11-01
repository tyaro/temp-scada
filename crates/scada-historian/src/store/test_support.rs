use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) struct TempStore(pub(crate) PathBuf);
impl TempStore {
    pub(crate) fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "scada-h2-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        // Never remove somebody else's directory if a previous test left it.
        assert!(!directory.exists());
        Self(directory)
    }
    pub(crate) fn create(&self) -> SqliteStore {
        SqliteStore::create(&self.0, identity()).unwrap()
    }
    pub(crate) fn open(&self) -> SqliteStore {
        reopen_unowned(&self.0, &identity()).unwrap()
    }
}
/// Fixture opens with no intended owner, including format/identity error checks.
/// Immediate Busy/ownership assertions must call the production API directly.
pub(crate) fn reopen_unowned(
    directory: impl AsRef<Path>,
    expected: &StoreIdentity,
) -> StoreResult<SqliteStore> {
    // A parallel crash test can fork while another test owns a flock. CLOEXEC
    // closes that inherited handle at exec, not at fork. Bound this fixture wait.
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        match SqliteStore::open_existing(directory.as_ref(), expected) {
            Err(StoreError::Busy) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            result => return result,
        }
    }
}

impl Drop for TempStore {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(crate) fn identity() -> StoreIdentity {
    StoreIdentity {
        store_id: "store-a".into(),
        deployment_id: "deployment-a".into(),
    }
}
pub(crate) fn spec(session: &str) -> SessionSpec {
    SessionSpec {
        session_id: session.into(),
        members: vec![
            IdentityDescriptor {
                series_id: "number".into(),
                hub_instance_id: "hub-a".into(),
                incarnation_id: "life-number".into(),
                external_name: "Plant.Value".into(),
                segment_id: "segment-a".into(),
                value_type: ValueType::Number,
                unit: Some("C".into()),
                period_ms: 1000,
                source: Source::Real,
            },
            IdentityDescriptor {
                series_id: "bool".into(),
                hub_instance_id: "hub-a".into(),
                incarnation_id: "life-bool".into(),
                external_name: "Plant.Value".into(),
                segment_id: "segment-a".into(),
                value_type: ValueType::Bool,
                unit: None,
                period_ms: 1000,
                source: Source::Real,
            },
        ],
    }
}
pub(crate) fn tick(session: &str, sequence: u64, time: i64) -> Tick {
    let observations = spec(session)
        .members
        .into_iter()
        .map(|member| TickObservation {
            series_id: member.series_id,
            source_time_ms: Some(time - 10),
            quality: Some(Quality::Good),
            source: Some(Source::Real),
            value: Some(match member.value_type {
                ValueType::Number => ObservationValue::Number(0.0),
                ValueType::Bool => ObservationValue::Bool(false),
            }),
            reason: None,
            source_epoch: Some(SourceEpoch {
                hub_instance_id: "hub-a".into(),
                run_id: Some(u64::MAX),
                catalog_revision: u64::MAX,
                sdk_generation: u64::MAX,
            }),
        })
        .collect();
    Tick {
        session_id: session.into(),
        sequence,
        clock_epoch: "clock-a".into(),
        sample_time_ms: time,
        ingested_at_ms: time + 20,
        observations,
    }
}
pub(crate) fn count(store: &SqliteStore, table: &str) -> i64 {
    assert!([
        "series",
        "segments",
        "sessions",
        "session_members",
        "source_epochs",
        "commits",
        "observations"
    ]
    .contains(&table));
    store
        .connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
pub(crate) fn counter(store: &SqliteStore) -> i64 {
    store
        .connection
        .query_row("SELECT last_commit FROM store_meta", [], |r| r.get(0))
        .unwrap()
}

pub(crate) fn connection(store: &SqliteStore) -> &Connection {
    &store.connection
}
pub(crate) fn connection_mut(store: &mut SqliteStore) -> &mut Connection {
    &mut store.connection
}

pub(crate) fn apply_test_policy(
    store: &mut SqliteStore,
    policy: retention::clock_guard::RetentionClockPolicy,
) {
    use retention::application::{PolicyApplyRequest, PolicyPreparationRequest};
    let control = query::QueryControl::with_timeout(Duration::from_secs(10)).unwrap();
    let prepared = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: policy.clone(),
                reference_wall_ms: 1_000_000,
            },
            &control,
        )
        .unwrap();
    store
        .apply_retention_policy(
            &PolicyApplyRequest {
                request_id: format!("fixture-apply-{}", prepared.snapshot_commit),
                expected_applied_revision: prepared.expected_applied_revision,
                expected_preview_snapshot_commit: prepared.snapshot_commit,
                proposed_policy: policy,
                reference_wall_ms: 1_000_000,
            },
            &control,
        )
        .unwrap();
}

#[cfg(unix)]
#[test]
fn successful_fixture_reopen_waits_for_a_transient_inherited_lock_handle() {
    let directory = TempStore::new();
    let store = directory.create();
    // fork inherits the same open file description until exec closes CLOEXEC
    // handles. A duplicated handle reproduces that lifetime without unsafe fork.
    let inherited = store.ownership._writer_lock.try_clone().unwrap();
    drop(store);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(25));
        drop(inherited);
    });
    let reopened = directory.open();
    release.join().unwrap();
    assert_eq!(counter(&reopened), 0);
}
