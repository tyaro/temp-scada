use super::*;
use crate::recorder::{
    ClockError, ClockReading, ManagedRecorderStart, Recorder, RecorderClock, RecorderConfig,
    RecorderStartError,
};
struct Clock;
impl RecorderClock for Clock {
    fn read(&mut self) -> Result<ClockReading, ClockError> {
        Ok(ClockReading {
            monotonic_ms: 0,
            wall_time_ms: 1000,
            clock_epoch: "managed-clock".into(),
        })
    }
    fn wait_until(&mut self, _: u64, _: &query::CancellationToken) -> Result<(), ClockError> {
        unreachable!()
    }
}
#[test]
fn managed_recorder_preserves_real_full_and_reopen_requirement_before_first_capture() {
    let (d, mut store) = setup();
    let applied = store
        .recording_plan_state(&control())
        .unwrap()
        .applied
        .unwrap();
    let config = RecorderConfig {
        session: SessionSpec {
            session_id: "managed".into(),
            members: applied
                .resolution
                .unwrap()
                .members
                .into_iter()
                .map(|m| m.identity)
                .collect(),
        },
        plan: applied.receipt.plan,
        period_ms: 1000,
        slot_count: Some(1),
        max_clock_skew_ms: 5,
    };
    let binding = ManagedRecorderStart {
        activation_id: "first".into(),
        expected_applied_revision: 1,
        expected_mapping_revision: 1,
        expected_retention_applied_revision: 1,
    };
    store.connection.execute_batch("CREATE TABLE managed_pressure(value BLOB); CREATE TEMP TRIGGER managed_full AFTER INSERT ON session_members BEGIN INSERT INTO managed_pressure VALUES(zeroblob(1048576)); END;").unwrap();
    let maximum: i64 = store
        .connection
        .query_row("PRAGMA max_page_count", [], |r| r.get(0))
        .unwrap();
    let pages: i64 = store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let before = counter(&store);
    assert!(
        matches!(Recorder::start_managed(&mut store,config.clone(),binding.clone(),&mut Clock,&control()),Err(RecorderStartError::ActivationUnconfirmed(StoreError::Sqlite(ref e))) if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    );
    assert!(store.needs_reopen);
    assert_eq!(counter(&store), before);
    assert!(store.connection.is_autocommit());
    store
        .connection
        .pragma_update(None, "max_page_count", maximum)
        .unwrap();
    drop(store);
    let mut store = d.open();
    assert!(store
        .recording_activation_state(&control())
        .unwrap()
        .latest
        .is_none());
    let (_recorder, r) =
        Recorder::start_managed(&mut store, config, binding, &mut Clock, &control()).unwrap();
    assert_eq!(r.sequence, 1);
}
