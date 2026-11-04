use super::*;

#[tokio::test]
async fn read_worker_and_dispatcher_panic_keep_a_finite_error_and_uncertain_read_gate() {
    for fault in [
        driver::TestFault::WorkerPanic,
        driver::TestFault::DriverPanic,
    ] {
        let (mut owner, _dir) = fixtures::setup();
        let c = owner.client();
        let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
        let original = op.wait().await.unwrap();
        *c.shared.read_fault.lock().unwrap() = Some(fault);
        let h = c.reconcile(&a.change, &op, "panic", control()).unwrap();
        assert_eq!(h.wait().await, Err(OwnerError::Unavailable));
        assert_eq!(
            h.watch().borrow().clone(),
            Some(Err(OwnerError::Unavailable))
        );
        assert_eq!(
            c.state().reconciliation_phase,
            ReconciliationPhase::Uncertain
        );
        assert_eq!(op.wait().await.unwrap(), original);
        assert_eq!(
            c.reconcile(&a.change, &op, "more", control())
                .unwrap_err()
                .code,
            OperationErrorCode::Busy
        );
        assert!(matches!(owner.try_handoff(), Err(OwnerError::Busy)));
    }
}
#[tokio::test]
async fn owner_drop_cancels_only_read_and_late_failure_remains_observable() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let gate = Arc::new(mutation::TestGate::default());
    *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let h = c.reconcile(&a.change, &op, "drop", control()).unwrap();
    gate.entered.notified().await;
    let original_cancel = op.0.cancel.is_cancelled();
    drop(owner);
    assert!(h.0.cancel.is_cancelled());
    assert_eq!(op.0.cancel.is_cancelled(), original_cancel);
    gate.release.notify_one();
    let r = h.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "cancelled");
    assert!(c.state().closed);
    assert!(c.shared.core.lock().unwrap().supervisor.is_none());
}
#[tokio::test]
async fn late_cancel_keeps_found_and_completion_without_receivers() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::LateCancel);
    let h = c.reconcile(&a.change, &op, "late", control()).unwrap();
    let r = h.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "receiptFound");
    assert!(h.0.cancel.is_cancelled());
    assert_eq!(h.request_cancel(), CancelDisposition::AlreadyCompleted);
    assert_eq!(h.watch().borrow().as_ref().unwrap().as_ref().unwrap(), &r);
}
#[tokio::test]
async fn in_flight_core_poison_closes_the_owner_and_keeps_internal_failure() {
    let (mut owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let gate = Arc::new(mutation::TestGate::default());
    *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let h = c.reconcile(&a.change, &op, "poison", control()).unwrap();
    gate.entered.notified().await;
    let shared = c.shared.clone();
    let _ = std::thread::spawn(move || {
        let _guard = shared.core.lock().unwrap();
        panic!("poison");
    })
    .join();
    gate.release.notify_one();
    assert_eq!(h.wait().await, Err(OwnerError::Internal));
    assert!(c.state().closed);
    assert_eq!(
        c.state().reconciliation_phase,
        ReconciliationPhase::Uncertain
    );
    assert!(matches!(owner.try_handoff(), Err(OwnerError::Internal)));
    let core = match c.shared.core.lock() {
        Err(e) => e.into_inner(),
        Ok(_) => panic!("expected poison"),
    };
    assert!(core.native_receipt.is_some());
}
#[test]
fn runtime_shutdown_preserves_unpolled_read_error_and_blocks_handoff() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (mut owner, dir, a, op) = runtime.block_on(async {
        let (owner, dir) = fixtures::setup();
        let c = owner.client();
        let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
        (owner, dir, a, op)
    });
    let c = owner.client();
    let h = c.reconcile(&a.change, &op, "unpolled", control()).unwrap();
    drop(runtime);
    assert_eq!(
        h.watch().borrow().clone(),
        Some(Err(OwnerError::Unavailable))
    );
    assert_eq!(
        c.state().reconciliation_phase,
        ReconciliationPhase::Uncertain
    );
    assert!(matches!(owner.try_handoff(), Err(OwnerError::Busy)));
    drop(owner);
    drop(c);
    drop(dir);
}
#[tokio::test]
async fn owner_drop_retains_actual_blocking_reader_and_writer_until_cleanup() {
    let (owner, dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let gate = Arc::new(driver::BlockingGate::default());
    *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::BlockingGate(gate.clone()));
    let h = c.reconcile(&a.change, &op, "blocked", control()).unwrap();
    gate.entered.notified().await;
    drop(owner);
    assert!(h.watch().borrow().is_none());
    assert!(SqliteStore::open_existing(
        &dir.0,
        &crate::recording_host::retention::tests::identity()
    )
    .is_err());
    gate.open();
    let r = h.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "cancelled");
    assert!(SqliteStore::open_existing(
        &dir.0,
        &crate::recording_host::retention::tests::identity()
    )
    .is_ok());
}
#[tokio::test]
async fn accepted_read_deadline_expires_without_restarting_at_dispatch() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let gate = Arc::new(mutation::TestGate::default());
    *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let mut ctl = control();
    ctl.deadline = std::time::Instant::now() + Duration::from_secs(1);
    let deadline = ctl.deadline;
    let h = c.reconcile(&a.change, &op, "deadline", ctl).unwrap();
    gate.entered.notified().await;
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
    gate.release.notify_one();
    let r = h.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "deadlineExceeded");
    assert_eq!(r.as_value()["quiescence"], "confirmed");
    assert_eq!(
        c.state().reconciliation_phase,
        ReconciliationPhase::Completed
    );
}
#[tokio::test]
async fn cancellation_and_deadline_inside_blocking_worker_require_join_before_next_read() {
    for expired in [false, true] {
        let (owner, _dir) = fixtures::setup();
        let c = owner.client();
        let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
        let gate = Arc::new(driver::BlockingGate::default());
        *c.shared.read_fault.lock().unwrap() = Some(driver::TestFault::BlockingGate(gate.clone()));
        let mut ctl = control();
        ctl.deadline = std::time::Instant::now() + Duration::from_secs(1);
        let deadline = ctl.deadline;
        let h = c.reconcile(&a.change, &op, "blocked", ctl).unwrap();
        gate.entered.notified().await;
        if expired {
            tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
        } else {
            assert_eq!(h.request_cancel(), CancelDisposition::Requested);
        }
        assert!(h.watch().borrow().is_none());
        assert!(!op.0.cancel.is_cancelled());
        assert_eq!(
            c.reconcile(&a.change, &op, "early", control())
                .unwrap_err()
                .code,
            OperationErrorCode::Busy
        );
        gate.open();
        let r = h.wait().await.unwrap();
        assert_eq!(
            r.as_value()["outcome"]["error"],
            if expired {
                "deadlineExceeded"
            } else {
                "cancelled"
            }
        );
        let again = c.reconcile(&a.change, &op, "joined", control()).unwrap();
        assert_eq!(
            again.wait().await.unwrap().as_value()["outcome"]["kind"],
            "receiptFound"
        );
    }
}
