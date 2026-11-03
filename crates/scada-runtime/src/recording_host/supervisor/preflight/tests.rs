use super::super::{
    tests::{mapping, setup},
    RecordingSupervisor,
};
use super::*;
use crate::recording_host::retention::tests::{control, identity};
use futures_util::FutureExt;
use std::time::{Duration, Instant};

fn bound(s: &RecordingSupervisor) -> BoundRequest {
    let state = s.host.state();
    BoundRequest {
        recording_run: state.run.clone().unwrap(),
        session_id: state.session_id.clone().unwrap(),
        intent: mapping("map", None),
    }
}
#[test]
fn queued_preflight_retains_exact_token_deadline_limits_and_the_physical_reader_slot() {
    for kind in 0..5 {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut s, _dir) = setup();
            let (release, receive) = std::sync::mpsc::sync_channel(0);
            let (entered, ready) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                entered.send(()).unwrap();
                receive.recv().unwrap();
            });
            ready.await.unwrap();
            let mut c = control();
            match kind {
                1 => c.deadline = Instant::now() + Duration::from_millis(30),
                2 => c.limits.max_decoded_rows = 1,
                3 => c.limits.max_vm_steps = 1000,
                4 => c.limits.max_output_bytes = 1,
                _ => {}
            }
            let cancel = c.cancellation.clone();
            let run = s.start_preflight(mapping("map", None), c).unwrap();
            let wrong = PreflightRun(Arc::new(()));
            assert!(matches!(
                s.cancel_preflight(&wrong),
                Err(SupervisorError::WrongPreflight)
            ));
            assert!(!cancel.is_cancelled());
            assert!(matches!(
                s.join_preflight(&wrong).await,
                Err(SupervisorError::WrongPreflight)
            ));
            assert!(s.join_preflight(&run).now_or_never().is_none());
            assert!(matches!(s.take_store(), Err(SupervisorError::Busy)));
            assert!(matches!(
                s.start_preflight(mapping("second", None), control()),
                Err(SupervisorError::Busy)
            ));
            assert!(matches!(s.request_pause(&run), Err(SupervisorError::Busy)));
            assert!(matches!(
                s.discard_candidate(&run),
                Err(SupervisorError::Busy)
            ));
            if kind == 0 {
                s.cancel_preflight(&run).unwrap();
                assert!(cancel.is_cancelled());
            } else if kind == 1 {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            release.send(()).unwrap();
            blocker.await.unwrap();
            let result = s.join_preflight(&run).await.unwrap();
            assert!(
                matches!(&result.outcome, Err(StoreError::Control(_))),
                "case {kind}"
            );
            if kind == 0 {
                assert!(matches!(
                    &result.outcome,
                    Err(StoreError::Control(QueryError::Cancelled))
                ));
            }
            if kind == 1 {
                assert!(matches!(
                    &result.outcome,
                    Err(StoreError::Control(QueryError::Deadline))
                ));
            }
            assert!(Arc::ptr_eq(&result, &s.join_preflight(&run).await.unwrap()));
            assert!(!s.state().recording.stop_requested);
            let next = s
                .start_preflight(mapping("fresh", None), control())
                .unwrap();
            assert!(s.join_preflight(&next).await.unwrap().outcome.is_ok());
        });
    }
}
#[tokio::test]
async fn completed_unjoined_and_late_cancel_preserve_the_result_and_stale_cancel_cannot_reach_new_work(
) {
    let (mut s, _dir) = setup();
    let c = control();
    let cancel = c.cancellation.clone();
    let run = s
        .preflight
        .start_with(bound(&s), c, |intent, reader, c| {
            let result = evaluate(intent, reader, c);
            c.cancellation.cancel();
            result
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !s.preflight.running.as_ref().unwrap().task.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(s.take_store(), Err(SupervisorError::Busy)));
    let result = s.join_preflight(&run).await.unwrap();
    assert!(cancel.is_cancelled());
    assert!(result.outcome.is_ok());
    s.cancel_preflight(&run).unwrap();
    s.discard_candidate(&run).unwrap();
    let (release, receive) = std::sync::mpsc::sync_channel(0);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let c = control();
    let cancel = c.cancellation.clone();
    let next = s
        .preflight
        .start_with(bound(&s), c, move |intent, reader, c| {
            entered.send(()).unwrap();
            receive.recv().unwrap();
            evaluate(intent, reader, c)
        })
        .unwrap();
    ready.await.unwrap();
    assert!(matches!(
        s.cancel_preflight(&run),
        Err(SupervisorError::WrongPreflight)
    ));
    assert!(!cancel.is_cancelled());
    release.send(()).unwrap();
    assert!(s.join_preflight(&next).await.unwrap().outcome.is_ok());
}
#[tokio::test]
async fn reader_panic_keeps_recording_state_intact_and_allows_safety_join_and_writer_recovery() {
    let (mut s, _dir) = setup();
    let recording = s.host.state().run.clone().unwrap();
    let run = s
        .preflight
        .start_with(bound(&s), control(), |_, _, _| panic!("preflight boundary"))
        .unwrap();
    assert!(matches!(
        s.join_preflight(&run).await,
        Err(SupervisorError::ReaderFailed)
    ));
    assert!(!s.state().recording.stop_requested);
    assert!(s.preflight.reader.is_none());
    assert!(matches!(
        s.start_preflight(mapping("blocked", None), control()),
        Err(SupervisorError::ReaderFailed)
    ));
    s.request_stop_recording(&recording).unwrap();
    s.join_recording(&recording).await.unwrap();
    let mut store = s.take_store().unwrap();
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        0
    );
}
#[tokio::test]
async fn unusable_reader_is_sticky_but_does_not_poison_or_lose_the_writer() {
    let (mut s, _dir) = setup();
    let recording = s.host.state().run.clone().unwrap();
    let run = s
        .preflight
        .start_with(bound(&s), control(), |_, _, _| {
            Err(StoreError::Control(QueryError::ReaderUnusable))
        })
        .unwrap();
    assert!(s.join_preflight(&run).await.unwrap().outcome.is_err());
    assert_eq!(s.state().preflight_phase, PreflightPhase::ReaderUnusable);
    assert!(matches!(
        s.start_preflight(mapping("blocked", None), control()),
        Err(SupervisorError::ReaderUnusable)
    ));
    assert!(!s.state().recording.stop_requested);
    s.request_stop_recording(&recording).unwrap();
    s.join_recording(&recording).await.unwrap();
    assert!(s
        .take_store()
        .unwrap()
        .recording_plan_state(&control())
        .unwrap()
        .applied
        .is_none());
}
#[tokio::test]
async fn drop_cancels_without_aborting_the_reader_and_keeps_lock_until_all_leases_end() {
    let (mut s, dir) = setup();
    let external = s.host.store.as_ref().unwrap().reader().unwrap();
    let (release, receive) = std::sync::mpsc::sync_channel(0);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let c = control();
    let cancel = c.cancellation.clone();
    s.preflight
        .start_with(bound(&s), c, move |intent, reader, c| {
            entered.send(()).unwrap();
            receive.recv().unwrap();
            evaluate(intent, reader, c)
        })
        .unwrap();
    ready.await.unwrap();
    drop(s);
    assert!(cancel.is_cancelled());
    assert!(matches!(
        scada_historian::store::SqliteStore::open_existing(&dir.0, &identity()),
        Err(StoreError::Busy)
    ));
    release.send(()).unwrap();
    assert!(matches!(
        scada_historian::store::SqliteStore::open_existing(&dir.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(external);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match scada_historian::store::SqliteStore::open_existing(&dir.0, &identity()) {
            Err(StoreError::Busy) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
            result => {
                drop(result.unwrap());
                break;
            }
        }
    }
}
