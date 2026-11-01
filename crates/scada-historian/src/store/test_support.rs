use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

pub(super) struct TempStore(pub(super) PathBuf);
impl TempStore {
    pub(super) fn new() -> Self {
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
    pub(super) fn create(&self) -> SqliteStore {
        SqliteStore::create(&self.0, identity()).unwrap()
    }
    pub(super) fn open(&self) -> SqliteStore {
        SqliteStore::open_existing(&self.0, &identity()).unwrap()
    }
}
impl Drop for TempStore {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(super) fn identity() -> StoreIdentity {
    StoreIdentity {
        store_id: "store-a".into(),
        deployment_id: "deployment-a".into(),
    }
}
pub(super) fn spec(session: &str) -> SessionSpec {
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
pub(super) fn tick(session: &str, sequence: u64, time: i64) -> Tick {
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
pub(super) fn count(store: &SqliteStore, table: &str) -> i64 {
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
pub(super) fn counter(store: &SqliteStore) -> i64 {
    store
        .connection
        .query_row("SELECT last_commit FROM store_meta", [], |r| r.get(0))
        .unwrap()
}
