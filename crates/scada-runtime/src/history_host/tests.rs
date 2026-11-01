use super::*;
use futures_util::FutureExt;
use scada_historian::store::{SqliteStore, StoreError, StoreIdentity};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn identity() -> StoreIdentity {
    StoreIdentity {
        store_id: "history-host-unit".into(),
        deployment_id: "test".into(),
    }
}
fn setup() -> (SqliteStore, HistoryHost, Directory) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = Directory(std::env::temp_dir().join(format!(
        "scada-history-host-unit-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    let store = SqliteStore::create(&directory.0, identity()).unwrap();
    let host = HistoryHost::new(store.reader().unwrap());
    (store, host, directory)
}
fn query() -> Value {
    json!({"version":1,"kind":"query","requestId":"same-id","seriesIds":["unknown"],"fromMs":1000,"toMs":2000,"mode":"raw","maxPointsPerSeries":4})
}
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}

#[test]
fn bounded_shared_request_validation_and_runtime_rejection_do_not_lose_reader() {
    let (_store, mut host, _directory) = setup();
    for change in 0..5 {
        let mut query = query();
        match change {
            0 => query["requestId"] = Value::String("x".repeat(9000)),
            1 => query["mode"] = "future".into(),
            2 => query["seriesIds"] = json!(["duplicate", "duplicate"]),
            3 => query["toMs"] = 1000.into(),
            _ => query["kind"] = "result".into(),
        }
        let expected = validate_query_request(&query).unwrap_err();
        assert_eq!(
            host.start_query(query, control()),
            Err(HistoryHostError::Request(expected))
        );
        assert_eq!(host.state().phase, HistoryPhase::Idle);
    }
    assert_eq!(
        host.start_query(query(), control()),
        Err(HistoryHostError::NoRuntime)
    );
    drop(host.take_reader().unwrap());
    assert_eq!(host.state().phase, HistoryPhase::NoReader);
    assert_eq!(
        host.start_query(query(), control()),
        Err(HistoryHostError::NoReader)
    );
}

fn controlled(
    host: &mut HistoryHost,
) -> (
    HistoryRequest,
    std::sync::mpsc::SyncSender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let reader = host.reader.take().unwrap();
    let request = HistoryRequest(Arc::new(()));
    let worker_request = request.clone();
    let (release, receive) = std::sync::mpsc::sync_channel(0);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let task = tokio::task::spawn_blocking(move || {
        let _ = entered.send(());
        receive.recv().unwrap();
        QueryResult {
            reader,
            completion: HistoryCompletion {
                request: worker_request,
                result: Err(QueryError::Cancelled),
            },
        }
    });
    host.running = Some(Running {
        request: request.clone(),
        cancel: CancellationToken::default(),
        task,
    });
    (request, release, ready)
}

#[tokio::test]
async fn exact_token_and_cancelled_join_preserve_busy_slot_reader_and_result() {
    let (_store, mut host, _directory) = setup();
    let (request, release, ready) = controlled(&mut host);
    ready.await.unwrap();
    let wrong = HistoryRequest(Arc::new(()));
    assert_eq!(
        host.cancel_query(&wrong),
        Err(HistoryHostError::WrongRequest)
    );
    assert!(matches!(
        host.join_query(&wrong).await,
        Err(HistoryHostError::WrongRequest)
    ));
    assert!(!host.running.as_ref().unwrap().cancel.is_cancelled());
    assert!(host.join_query(&request).now_or_never().is_none());
    assert!(matches!(host.take_reader(), Err(HistoryHostError::Busy)));
    assert_eq!(
        host.start_query(query(), control()),
        Err(HistoryHostError::Busy)
    );
    host.cancel_query(&request).unwrap();
    assert!(host.running.as_ref().unwrap().cancel.is_cancelled());
    release.send(()).unwrap();
    let result = host.join_query(&request).await.unwrap();
    assert_eq!(result.result, Err(QueryError::Cancelled));
    assert!(Arc::ptr_eq(
        &result,
        &host.join_query(&request).await.unwrap()
    ));
    host.cancel_query(&request).unwrap();
    drop(host.take_reader().unwrap());
    assert!(matches!(
        host.join_query(&request).await,
        Err(HistoryHostError::NoRequest)
    ));
}

#[tokio::test]
async fn dropped_host_cancels_without_releasing_inflight_reader_lease() {
    let (store, mut host, directory) = setup();
    let (_request, release, ready) = controlled(&mut host);
    ready.await.unwrap();
    let cancellation = host.running.as_ref().unwrap().cancel.clone();
    drop(store);
    drop(host);
    assert!(cancellation.is_cancelled());
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match SqliteStore::open_existing(&directory.0, &identity()) {
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

#[tokio::test]
async fn worker_panic_faults_host_instead_of_returning_a_reusable_reader() {
    let (_store, mut host, _directory) = setup();
    let reader = host.reader.take().unwrap();
    let request = HistoryRequest(Arc::new(()));
    let task = tokio::task::spawn_blocking(move || {
        let _reader = reader;
        panic!("test history worker panic")
    });
    host.running = Some(Running {
        request: request.clone(),
        cancel: CancellationToken::default(),
        task,
    });
    assert!(matches!(
        host.join_query(&request).await,
        Err(HistoryHostError::WorkerFailed)
    ));
    assert_eq!(host.state().phase, HistoryPhase::Faulted);
    assert_eq!(
        host.start_query(query(), control()),
        Err(HistoryHostError::WorkerFailed)
    );
    assert!(matches!(
        host.take_reader(),
        Err(HistoryHostError::WorkerFailed)
    ));
}

#[tokio::test]
async fn reader_unusable_completion_blocks_reuse_and_can_be_taken_for_disposal() {
    let (_store, mut host, _directory) = setup();
    let reader = host.reader.take().unwrap();
    let request = HistoryRequest(Arc::new(()));
    let token = request.clone();
    // Controlled classification transfer. Real SQLite cleanup failure is
    // injected by the historian core tests, rather than duplicated here.
    let task = tokio::task::spawn_blocking(move || QueryResult {
        reader,
        completion: HistoryCompletion {
            request: token,
            result: Err(QueryError::ReaderUnusable),
        },
    });
    host.running = Some(Running {
        request: request.clone(),
        cancel: CancellationToken::default(),
        task,
    });
    assert_eq!(
        host.join_query(&request).await.unwrap().result,
        Err(QueryError::ReaderUnusable)
    );
    assert_eq!(host.state().phase, HistoryPhase::ReaderUnusable);
    assert_eq!(
        host.start_query(query(), control()),
        Err(HistoryHostError::ReaderUnusable)
    );
    drop(host.take_reader().unwrap());
    assert_eq!(host.state().phase, HistoryPhase::NoReader);
}

#[test]
fn queued_worker_uses_original_deadline_and_finished_unjoined_remains_busy() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let (_store, mut host, _directory) = setup();
        let (release, receive) = std::sync::mpsc::sync_channel(0);
        let (entered, ready) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            let _ = entered.send(());
            receive.recv().unwrap();
        });
        ready.await.unwrap();
        let request = host
            .start_query(
                query(),
                QueryControl::with_timeout(Duration::from_millis(5)).unwrap(),
            )
            .unwrap();
        tokio::time::sleep(Duration::from_millis(15)).await;
        release.send(()).unwrap();
        blocker.await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !host.running.as_ref().unwrap().task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(host.state().phase, HistoryPhase::InFlight);
        assert_eq!(
            host.start_query(query(), control()),
            Err(HistoryHostError::Busy)
        );
        assert_eq!(
            host.join_query(&request).await.unwrap().result,
            Err(QueryError::Deadline)
        );
        let next = host.start_query(query(), control()).unwrap();
        assert!(host.join_query(&next).await.unwrap().result.is_ok());
    });
}

#[tokio::test]
async fn ordinary_control_errors_leave_reader_reusable_and_completed_cancel_preserves_result() {
    let (_store, mut host, _directory) = setup();
    for change in 0..5 {
        let mut control = control();
        let expected = match change {
            0 => {
                control.cancellation.cancel();
                QueryError::Cancelled
            }
            1 => {
                control.deadline = Instant::now() - Duration::from_millis(1);
                QueryError::Deadline
            }
            2 => {
                control.limits.max_decoded_rows = 0;
                QueryError::InvalidLimits
            }
            3 => {
                control.limits.max_vm_steps = 1;
                QueryError::WorkLimit
            }
            _ => {
                control.limits.max_output_bytes = 1;
                QueryError::ByteLimit
            }
        };
        let request = host.start_query(query(), control).unwrap();
        assert_eq!(
            host.join_query(&request).await.unwrap().result,
            Err(expected)
        );
        assert_eq!(host.state().phase, HistoryPhase::Idle);
    }
    let request = host.start_query(query(), control()).unwrap();
    let completed = host.join_query(&request).await.unwrap();
    assert!(completed.result.is_ok());
    host.cancel_query(&request).unwrap();
    assert!(Arc::ptr_eq(
        &completed,
        &host.join_query(&request).await.unwrap()
    ));
    let next = host.start_query(query(), control()).unwrap();
    assert_ne!(next, request);
    assert_eq!(
        host.cancel_query(&request),
        Err(HistoryHostError::WrongRequest)
    );
    assert!(matches!(
        host.join_query(&request).await,
        Err(HistoryHostError::WrongRequest)
    ));
    assert!(host.join_query(&next).await.unwrap().result.is_ok());
}
