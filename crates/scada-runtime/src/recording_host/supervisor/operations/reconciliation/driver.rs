use super::*;
use scada_historian::store::recording_plan::RecordingPlanReceiptSnapshot;
use scada_model::recording_operations::same_recording_operation_request;
use serde_json::Value;

#[cfg(test)]
#[derive(Clone)]
pub(in super::super) enum TestFault {
    DriverPanic,
    WorkerPanic,
    BlockingGate(Arc<BlockingGate>),
    Gate(Arc<super::super::driver::TestGate>),
    NotFound,
    DifferentReceipt,
    ReceiptOverflow,
    SnapshotOverflow,
    LateCancel,
}
#[cfg(test)]
#[derive(Default)]
pub(in super::super) struct BlockingGate {
    pub entered: tokio::sync::Notify,
    released: Mutex<bool>,
    changed: std::sync::Condvar,
}
#[cfg(test)]
impl BlockingGate {
    pub fn open(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
    fn wait(&self) {
        self.entered.notify_one();
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
    }
}
struct Loan {
    shared: Arc<Shared>,
    supervisor: Option<RecordingSupervisor>,
    handle: RecordingReconciliationHandle,
    original: RecordingOperationHandle,
    apply: ApplyRecordingPlanRequest,
    control: QueryControl,
    #[cfg(test)]
    fault: Option<TestFault>,
    done: bool,
}
pub(super) fn dispatch(
    shared: Arc<Shared>,
    supervisor: RecordingSupervisor,
    handle: RecordingReconciliationHandle,
    original: RecordingOperationHandle,
    apply: ApplyRecordingPlanRequest,
    control: QueryControl,
) {
    let loan = Loan {
        #[cfg(test)]
        fault: shared.read_fault.lock().unwrap().take(),
        shared: shared.clone(),
        supervisor: Some(supervisor),
        handle: handle.clone(),
        original,
        apply,
        control,
        done: false,
    };
    let task = shared.runtime.spawn(async move {
        loan.run().await;
    });
    let runtime = shared.runtime.clone();
    runtime.spawn(async move {
        if task.await.is_err() {
            uncertain(&shared, &handle, None, OwnerError::Unavailable, None);
        }
    });
}
fn result(
    handle: &RecordingReconciliationHandle,
    outcome: Value,
    confirmed: bool,
    recovery: bool,
) -> Result<Arc<RecordingReconciliationResult>, OperationErrorCode> {
    RecordingReconciliationResult::from_value(json!({"version":1,"kind":"recordingReconciliationResult","request":handle.request().as_value(),"outcome":outcome,"quiescence":if confirmed{"confirmed"}else{"unknown"},"recoveryRequired":recovery})).map(Arc::new).map_err(|_| OperationErrorCode::ProjectionFailed)
}
impl Loan {
    async fn run(mut self) {
        #[cfg(test)]
        match &self.fault {
            Some(TestFault::DriverPanic) => panic!("receipt dispatcher fault"),
            Some(TestFault::Gate(g)) => {
                g.entered.notify_one();
                g.release.notified().await;
            }
            _ => {}
        }
        if let Err(code) = projection::control(&self.control) {
            self.finish(Err(code));
            return;
        }
        let s = self.supervisor.as_mut().expect("owned supervisor");
        #[cfg(test)]
        let started = if matches!(self.fault, Some(TestFault::WorkerPanic)) {
            s.start_receipt_read_with(self.apply.clone(), self.control.clone(), |_, _, _| {
                panic!("receipt worker fault")
            })
        } else if let Some(TestFault::BlockingGate(gate)) = self.fault.clone() {
            s.start_receipt_read_with(
                self.apply.clone(),
                self.control.clone(),
                move |reader, request, control| {
                    gate.wait();
                    reader.recording_plan_receipt_for_request(request, control)
                },
            )
        } else {
            s.start_receipt_read(self.apply.clone(), self.control.clone())
        };
        #[cfg(not(test))]
        let started = s.start_receipt_read(self.apply.clone(), self.control.clone());
        if let Err(e) = started {
            self.finish(Err(projection::supervisor_error(&e)));
            return;
        }
        match s.join_receipt_read().await {
            Ok(outcome) => {
                #[cfg(test)]
                let outcome = outcome.map(|mut snapshot| {
                    match &self.fault {
                        Some(TestFault::NotFound) => snapshot.receipt = None,
                        Some(TestFault::DifferentReceipt) => {
                            if let Some(r) = &mut snapshot.receipt {
                                r.commit_version += 1;
                            }
                        }
                        Some(TestFault::ReceiptOverflow) => {
                            if let Some(r) = &mut snapshot.receipt {
                                r.commit_version = projection::MAX_SAFE + 1;
                            }
                        }
                        Some(TestFault::SnapshotOverflow) => {
                            snapshot.snapshot_commit = projection::MAX_SAFE + 1
                        }
                        Some(TestFault::LateCancel) => self.control.cancellation.cancel(),
                        _ => {}
                    }
                    snapshot
                });
                self.finish(outcome.map_err(|e| projection::store_error(&e)));
            }
            Err(_) => {
                uncertain(
                    &self.shared,
                    &self.handle,
                    self.supervisor.take(),
                    OwnerError::Unavailable,
                    None,
                );
                self.done = true;
            }
        }
    }
    fn finish(&mut self, outcome: Result<RecordingPlanReceiptSnapshot, OperationErrorCode>) {
        let mut supervisor = self.supervisor.take().expect("owned supervisor");
        let mut core = match self.shared.core.lock() {
            Ok(core) => core,
            Err(error) => {
                drop(error.into_inner());
                uncertain(
                    &self.shared,
                    &self.handle,
                    Some(supervisor),
                    OwnerError::Internal,
                    outcome
                        .as_ref()
                        .ok()
                        .and_then(|s| s.receipt.clone())
                        .map(|receipt| NativeReceiptEvidence {
                            request: self.original.request().clone(),
                            receipt,
                        }),
                );
                self.done = true;
                return;
            }
        };
        let original = self
            .original
            .0
            .completion
            .borrow()
            .clone()
            .expect("settled original apply");
        let latest = core.latest.clone().unwrap_or_else(|| original.clone());
        let confirmed = original.as_value()["quiescence"] == "confirmed"
            || latest.as_value()["quiescence"] == "confirmed";
        let mut recovery = core.recovery
            || original.as_value()["recoveryRequired"] == true
            || supervisor.recording_plan_guard_state().recovery_required
            || !confirmed;
        let mut receipt = None;
        let projected = match outcome {
            Ok(snapshot) => match snapshot.receipt {
                Some(native) => {
                    let same = |e: &NativeReceiptEvidence| {
                        same_recording_operation_request(&e.request, self.original.request())
                    };
                    let conflict = core
                        .native_receipt
                        .as_ref()
                        .is_some_and(|e| same(e) && e.receipt != native)
                        || core.last_applied.as_ref().is_some_and(|e| {
                            same_recording_operation_request(&e.request, self.original.request())
                                && e.receipt != native
                        });
                    if conflict {
                        Err(OperationErrorCode::ProjectionFailed)
                    } else {
                        // Keep raw evidence before any bounded/safe-integer DTO projection.
                        core.native_receipt = Some(NativeReceiptEvidence {
                            request: self.original.request().clone(),
                            receipt: native.clone(),
                        });
                        let projected = result(
                            &self.handle,
                            json!({"kind":"receiptFound","receipt":native}),
                            confirmed,
                            recovery,
                        );
                        receipt = Some(native);
                        projected
                    }
                }
                None => result(
                    &self.handle,
                    json!({"kind":"notFound"}),
                    confirmed,
                    recovery,
                ),
            },
            Err(code) => {
                recovery |= !projection::recoverable(code);
                result(
                    &self.handle,
                    json!({"kind":"failed","error":code.as_str()}),
                    confirmed,
                    recovery,
                )
            }
        };
        let read_result = match projected {
            Ok(value) => value,
            Err(_) => {
                recovery = true;
                receipt = None;
                result(
                    &self.handle,
                    json!({"kind":"failed","error":"projectionFailed"}),
                    confirmed,
                    true,
                )
                .expect("bounded finite failure")
            }
        };
        if let Some(receipt) = receipt {
            match projection::result(
                self.original.request(),
                json!({"kind":"applied","receipt":receipt}),
                confirmed,
                recovery,
            ) {
                Ok(applied) => {
                    core.latest = Some(applied);
                    core.last_applied = Some(AppliedSuccess {
                        request: self.original.request().clone(),
                        receipt,
                    });
                }
                Err(_) => unreachable!(
                    "receipt and identical original request validated in reconciliation"
                ),
            }
        }
        // NotFound/failed preserves a known success and the original failure outcome.
        if recovery {
            supervisor.latch_recording_operations_recovery();
        }
        core.recovery |= recovery;
        if let Some(latest) = &core.latest {
            let mut value = latest.as_value().clone();
            value["recoveryRequired"] = json!(core.recovery);
            core.latest = Some(Arc::new(
                RecordingOperationResult::from_value(value).expect("monotone recovery"),
            ));
        }
        core.phase = if !confirmed {
            OperationsPhase::Uncertain
        } else if core.recovery {
            OperationsPhase::Blocked
        } else {
            OperationsPhase::Completed
        };
        core.in_flight = false;
        core.read.phase = ReconciliationPhase::Completed;
        core.read.last = Some(read_result.clone());
        core.read.failure = None;
        let retired = if core.closed {
            Some(supervisor)
        } else {
            core.supervisor = Some(supervisor);
            None
        };
        self.shared.publish(&core);
        self.handle.0.finish(Ok(read_result));
        self.done = true;
        drop(core);
        drop(retired);
    }
}
impl Drop for Loan {
    fn drop(&mut self) {
        if !self.done {
            uncertain(
                &self.shared,
                &self.handle,
                self.supervisor.take(),
                OwnerError::Unavailable,
                None,
            );
        }
    }
}
fn uncertain(
    shared: &Shared,
    handle: &RecordingReconciliationHandle,
    mut supervisor: Option<RecordingSupervisor>,
    error: OwnerError,
    evidence: Option<NativeReceiptEvidence>,
) {
    let (mut core, poisoned) = match shared.core.lock() {
        Ok(core) => (core, false),
        Err(e) => (e.into_inner(), true),
    };
    if poisoned {
        core.closed = true;
    }
    if let Some(evidence) = evidence {
        let keep = core.native_receipt.as_ref().is_some_and(|known| {
            same_recording_operation_request(&known.request, &evidence.request)
                && known.receipt != evidence.receipt
        });
        if !keep {
            core.native_receipt = Some(evidence);
        }
    }
    if handle.0.completion.borrow().is_some() {
        if poisoned {
            core.recovery = true;
            shared.publish(&core);
        }
        return;
    }
    core.recovery = true;
    core.in_flight = false;
    core.phase = OperationsPhase::Uncertain;
    core.read.phase = ReconciliationPhase::Uncertain;
    let error = if poisoned {
        OwnerError::Internal
    } else {
        error
    };
    core.read.failure = Some(error);
    if let Some(s) = supervisor.as_mut() {
        s.latch_recording_operations_recovery();
    }
    let retired = if core.closed {
        supervisor
    } else {
        if core.supervisor.is_none() {
            core.supervisor = supervisor.take();
        }
        supervisor
    };
    shared.publish(&core);
    handle.0.finish(Err(error));
    drop(core);
    drop(retired);
}
