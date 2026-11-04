use super::*;

#[tokio::test]
async fn all_callers_share_read_loan_and_drop_wait_does_not_cancel() {
    let (mut owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let gate = Arc::new(mutation::TestGate::default());
    *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let h = c.reconcile(&a.change, &op, "first", control()).unwrap();
    gate.entered.notified().await;
    for peer in [c.clone(), owner.client()] {
        assert_eq!(
            peer.reconcile(&a.change, &op, "second", control())
                .unwrap_err()
                .code,
            OperationErrorCode::Busy
        );
        assert_eq!(
            peer.discard(&a.change).unwrap_err().code,
            OperationErrorCode::Busy
        );
        assert_eq!(
            peer.preflight(fixtures::change("next"), control())
                .unwrap_err()
                .code,
            OperationErrorCode::Busy
        );
    }
    assert!(matches!(owner.try_handoff(), Err(OwnerError::Busy)));
    assert!(tokio::time::timeout(Duration::from_millis(1), h.wait())
        .await
        .is_err());
    assert!(!h.0.cancel.is_cancelled());
    drop(c.clone());
    gate.release.notify_one();
    h.wait().await.unwrap();
    assert!(owner.try_handoff().is_ok());
}
#[tokio::test]
async fn invalid_controls_ids_and_foreign_tokens_are_rejected_without_registration() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let (other, _otherdir) = fixtures::setup();
    let foreign = fixtures::candidate(&other.client(), "foreign").await;
    assert_eq!(
        c.reconcile(&foreign.change, &op, "foreign", control())
            .unwrap_err()
            .code,
        OperationErrorCode::WrongOwner
    );
    assert_eq!(
        c.reconcile(&a.change, &a.operation, "preflight", control())
            .unwrap_err()
            .code,
        OperationErrorCode::WrongOwner
    );
    assert_eq!(
        c.reconcile(&a.change, &op, "bad id", control())
            .unwrap_err()
            .code,
        OperationErrorCode::InvalidRequest
    );
    let mut ctl = control();
    ctl.limits.max_output_bytes = 0;
    assert_eq!(
        c.reconcile(&a.change, &op, "badcontrol", ctl)
            .unwrap_err()
            .code,
        OperationErrorCode::InvalidRequest
    );
    let ctl = control();
    ctl.cancellation.cancel();
    assert_eq!(
        c.reconcile(&a.change, &op, "cancelled", ctl)
            .unwrap_err()
            .code,
        OperationErrorCode::Cancelled
    );
    assert!(c.shared.core.lock().unwrap().read.used.is_empty());
    let h = c.reconcile(&a.change, &op, "valid", control()).unwrap();
    h.wait().await.unwrap();
    assert_eq!(
        c.reconcile(&a.change, &op, "valid", control())
            .unwrap_err()
            .code,
        OperationErrorCode::Consumed
    );
}
#[tokio::test]
async fn normal_success_and_native_not_dispatched_are_not_read_candidates() {
    for fault in [None, Some(mutation::TestFault::NativeReject)] {
        let (owner, _dir) = fixtures::setup();
        let c = owner.client();
        let a = fixtures::paused(&c, "ok").await;
        *c.shared.fault.lock().unwrap() = fault;
        let op = c.apply(&a.change, "ok:apply", control()).unwrap();
        op.wait().await.unwrap();
        assert_eq!(
            c.reconcile(&a.change, &op, "forbidden", control())
                .unwrap_err()
                .code,
            OperationErrorCode::InvalidRequest
        );
        assert!(c.shared.core.lock().unwrap().read.used.is_empty());
    }
}
#[tokio::test]
async fn independent_read_registry_reserves_no_mutation_credits_and_stops_at_capacity() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    {
        let mut core = c.shared.core.lock().unwrap();
        for i in 0..MAX_OWNER_IDS {
            core.registry.used.insert((true, format!("m:{i}")));
        }
        for i in 0..MAX_RECONCILIATION_IDS - 1 {
            core.read.used.insert(format!("r:{i}"));
        }
    }
    c.reconcile(&a.change, &op, "last", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(
        c.shared.core.lock().unwrap().read.used.len(),
        MAX_RECONCILIATION_IDS
    );
    assert_eq!(
        c.reconcile(&a.change, &op, "overflow", control())
            .unwrap_err()
            .code,
        OperationErrorCode::BudgetExceeded
    );
    assert_eq!(
        c.reconcile(&a.change, &op, "last", control())
            .unwrap_err()
            .code,
        OperationErrorCode::Consumed
    );
}
#[tokio::test]
async fn missing_supervisor_or_poisoned_reader_is_not_reported_as_absence() {
    for missing in [true, false] {
        let (owner, _dir) = fixtures::setup();
        let c = owner.client();
        let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
        {
            let mut core = c.shared.core.lock().unwrap();
            if missing {
                core.supervisor.take();
            } else {
                core.supervisor.as_mut().unwrap().preflight.unusable = true;
            }
        }
        let code = if missing {
            OperationErrorCode::WorkerFailure
        } else {
            OperationErrorCode::ReaderUnusable
        };
        assert_eq!(
            c.reconcile(&a.change, &op, "missing", control())
                .unwrap_err()
                .code,
            code
        );
        assert!(c.shared.core.lock().unwrap().read.used.is_empty());
    }
}
#[tokio::test]
async fn read_uses_existing_lease_and_never_releases_writer_ownership() {
    let (mut owner, dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let identity = crate::recording_host::retention::tests::identity();
    let extra = {
        let core = c.shared.core.lock().unwrap();
        let store = core
            .supervisor
            .as_ref()
            .unwrap()
            .host
            .store
            .as_ref()
            .unwrap();
        let extra = store.reader().unwrap();
        assert!(store.reader().is_err());
        extra
    };
    c.reconcile(&a.change, &op, "lease", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(SqliteStore::open_existing(&dir.0, &identity).is_err());
    let handoff = owner.try_handoff().unwrap();
    drop(handoff);
    drop(c);
    assert!(SqliteStore::open_existing(&dir.0, &identity).is_err());
    drop(extra);
    assert!(SqliteStore::open_existing(&dir.0, &identity).is_ok());
}
#[tokio::test]
async fn racing_threads_accept_one_read_and_no_request_queue() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let gate = Arc::new(mutation::TestGate::default());
    *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let mut threads = Vec::new();
    for i in 0..8 {
        let c = c.clone();
        let change = a.change.clone();
        let op = op.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            c.reconcile(&change, &op, &format!("racer:{i}"), control())
        }));
    }
    let mut accepted = Vec::new();
    for t in threads {
        match t.join().unwrap() {
            Ok(h) => accepted.push(h),
            Err(e) => assert_eq!(e.code, OperationErrorCode::Busy),
        }
    }
    assert_eq!(accepted.len(), 1);
    gate.entered.notified().await;
    gate.release.notify_one();
    accepted[0].wait().await.unwrap();
    assert_eq!(c.shared.core.lock().unwrap().read.used.len(), 1);
}
