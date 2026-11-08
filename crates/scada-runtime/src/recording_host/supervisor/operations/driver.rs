use super::*;
use crate::recording_host::{
    PreflightPhase, PreflightReport, RecordingPhase, RecordingPlanTurnIntent,
    RecordingPlanTurnReceipt,
};
use scada_historian::store::recording_plan::PlanPreflightOutcome;
use serde_json::{json, Value};

/// Constructed before spawning, so even an unpolled/dropped stage future retains
/// a failure guard. A consumer never owns this task or its AbortHandle.
/// Test faults. Only the lost apply response is reachable from `test_support`.
#[cfg(any(test, feature = "test-support"))]
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone)]
pub(super) enum TestFault {
    DriverPanic,
    NativeReject,
    WorkerPanic,
    Full,
    LostResponse,
    CommitThenPanic,
    LateCancel,
    Gate(Arc<TestGate>),
}
#[cfg(any(test, feature = "test-support"))]
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Default)]
pub(super) struct TestGate {
    pub entered: tokio::sync::Notify,
    pub release: tokio::sync::Notify,
}

struct Loan {
    #[cfg(any(test, feature = "test-support"))]
    fault: Option<TestFault>,
    shared: Arc<Shared>,
    supervisor: Option<RecordingSupervisor>,
    operation: RecordingOperationHandle,
    control: QueryControl,
    apply: ApplyRecordingPlanRequest,
    preflight: Option<PreflightRun>,
    turn: Option<RecordingPlanTurnRun>,
    done: bool,
}
pub(super) fn dispatch(
    shared: Arc<Shared>,
    supervisor: RecordingSupervisor,
    operation: RecordingOperationHandle,
    control: QueryControl,
) {
    let (apply, preflight) = {
        let core = shared.core.lock().unwrap_or_else(|e| e.into_inner());
        let w = core.workflow.as_ref().expect("registered before dispatch");
        (w.apply.clone(), w.preflight.clone())
    };
    let loan = Loan {
        #[cfg(any(test, feature = "test-support"))]
        fault: shared.fault.lock().unwrap().take(),
        shared: shared.clone(),
        supervisor: Some(supervisor),
        operation: operation.clone(),
        control,
        apply,
        preflight,
        turn: None,
        done: false,
    };
    let task = shared.runtime.spawn(async move {
        loan.run().await;
    });
    let runtime = shared.runtime.clone();
    runtime.spawn(async move {
        if task.await.is_err() {
            fail(&shared, &operation);
        }
    });
}
impl Loan {
    async fn run(mut self) {
        #[cfg(test)]
        match &self.fault {
            Some(TestFault::DriverPanic) => panic!("owner stage fault"),
            Some(TestFault::Gate(gate)) => {
                gate.entered.notify_one();
                gate.release.notified().await;
            }
            _ => {}
        }
        if let Err(code) = projection::control(&self.control) {
            let recovery = self.operation.0.stage != Stage::Preflight;
            self.failure(code, "notDispatched", true, recovery);
            return;
        }
        let state = self
            .supervisor
            .as_ref()
            .expect("owned supervisor")
            .state()
            .recording;
        if state.run.as_ref() != Some(&self.shared.run)
            || state.session_id.as_deref() != self.shared.context.as_value()["sessionId"].as_str()
        {
            self.failure(OperationErrorCode::StaleRun, "notDispatched", true, true);
            return;
        }
        match self.operation.0.stage {
            Stage::Preflight => self.preflight().await,
            Stage::Pause => self.pause().await,
            Stage::Apply => self.apply().await,
        }
    }
    async fn preflight(&mut self) {
        let s = self.supervisor.as_mut().expect("owned supervisor");
        let run = match s.start_preflight(
            RecordingPlanTurnIntent::Apply(self.apply.clone()),
            self.control.clone(),
        ) {
            Ok(run) => run,
            Err(e) => {
                let code = projection::supervisor_error(&e);
                self.failure(code, "notDispatched", true, !projection::recoverable(code));
                return;
            }
        };
        self.preflight = Some(run.clone());
        match s.join_preflight(&run).await {
            Ok(completion)=>match &completion.outcome {
                Ok(PreflightReport::Plan(report))=>match &report.outcome {
                    PlanPreflightOutcome::Candidate{active_session_id}=>self.finish(json!({"kind":"candidate","snapshotCommit":report.snapshot_commit,"activeSessionId":active_session_id}),true,false,None),
                    PlanPreflightOutcome::Replay(receipt)=>self.finish(json!({"kind":"replay","snapshotCommit":report.snapshot_commit,"receipt":receipt}),true,false,Some(receipt.clone())),
                },
                Ok(_)=>self.failure(OperationErrorCode::ProjectionFailed,"unconfirmed",true,true),
                Err(e)=>{let code=projection::store_error(e);let healthy=!matches!(s.state().preflight_phase,PreflightPhase::ReaderUnusable|PreflightPhase::Faulted|PreflightPhase::NoReader);self.failure(code,"notCommitted",true,!healthy||!projection::recoverable(code));}
            },
            Err(e)=>self.failure(projection::supervisor_error(&e),"unconfirmed",false,true),
        }
    }
    async fn pause(&mut self) {
        let Some(run) = self.preflight.clone() else {
            self.failure(OperationErrorCode::NoCandidate, "notDispatched", true, true);
            return;
        };
        let s = self.supervisor.as_mut().expect("owned supervisor");
        if let Err(e) = s.request_pause(&run) {
            self.failure(
                projection::supervisor_error(&e),
                "notDispatched",
                true,
                true,
            );
            return;
        }
        // Once stop has been sent, a UI deadline or token must not truncate join.
        match s.join_pause(&run).await {
            Ok(_) => self.finish(
                json!({"kind":"paused","sessionId":self.shared.context.as_value()["sessionId"]}),
                true,
                false,
                None,
            ),
            Err(e) => {
                let state = s.state().recording;
                let confirmed = state.phase == RecordingPhase::Joined
                    && state.source_shutdown.as_ref().is_some_and(Result::is_ok);
                self.failure(
                    projection::supervisor_error(&e),
                    "unconfirmed",
                    confirmed,
                    true,
                );
            }
        }
    }
    async fn apply(&mut self) {
        let Some(run) = self.preflight.clone() else {
            self.failure(OperationErrorCode::NoCandidate, "notDispatched", true, true);
            return;
        };
        let s = self.supervisor.as_mut().expect("owned supervisor");
        #[cfg(test)]
        if matches!(self.fault, Some(TestFault::NativeReject)) {
            s.latch_recording_operations_recovery();
        }
        #[cfg(any(test, feature = "test-support"))]
        let started = match self.fault.clone() {
            Some(
                TestFault::WorkerPanic
                | TestFault::Full
                | TestFault::LostResponse
                | TestFault::CommitThenPanic
                | TestFault::LateCancel,
            ) => {
                let fault = self.fault.clone();
                s.execute_candidate_with(
                    &run,
                    self.control.clone(),
                    move |host, recording, intent, control| {
                        host.start_plan_turn_with(
                            recording,
                            intent,
                            control,
                            move |intent, store, control| match fault {
                                Some(TestFault::WorkerPanic) => panic!("native worker fault"),
                                // rusqlite is a dev-dependency only.
                                #[cfg(test)]
                                Some(TestFault::Full) => {
                                    Err(scada_historian::store::StoreError::Sqlite(
                                        rusqlite::Error::SqliteFailure(
                                            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_FULL),
                                            None,
                                        ),
                                    ))
                                }
                                Some(
                                    TestFault::LostResponse
                                    | TestFault::CommitThenPanic
                                    | TestFault::LateCancel,
                                ) => {
                                    let RecordingPlanTurnIntent::Apply(request) = intent else {
                                        unreachable!()
                                    };
                                    let receipt = store.apply_recording_plan(request, control)?;
                                    if matches!(fault, Some(TestFault::CommitThenPanic)) {
                                        panic!("native response lost after commit");
                                    }
                                    if matches!(fault, Some(TestFault::LostResponse)) {
                                        Err(scada_historian::store::StoreError::Invalid(
                                            "lost native response",
                                        ))
                                    } else {
                                        control.cancellation.cancel();
                                        Ok(RecordingPlanTurnReceipt::Applied(receipt))
                                    }
                                }
                                _ => unreachable!(),
                            },
                        )
                    },
                )
            }
            _ => s.execute_candidate(&run, self.control.clone()),
        };
        #[cfg(not(any(test, feature = "test-support")))]
        let started = s.execute_candidate(&run, self.control.clone());
        let turn = match started {
            Ok(turn) => turn,
            Err(e) => {
                self.failure(
                    projection::supervisor_error(&e),
                    "notDispatched",
                    true,
                    true,
                );
                return;
            }
        };
        self.turn = Some(turn.clone());
        match s.join_recording_plan_turn(&turn).await {
            Ok(completion) => match &completion.outcome {
                Ok(RecordingPlanTurnReceipt::Applied(receipt)) => self.finish(
                    json!({"kind":"applied","receipt":receipt}),
                    true,
                    false,
                    Some(receipt.clone()),
                ),
                Ok(_) => self.failure(
                    OperationErrorCode::ProjectionFailed,
                    "unconfirmed",
                    true,
                    true,
                ),
                Err(e) => self.failure(projection::store_error(e), "unconfirmed", true, true),
            },
            Err(e) => self.failure(projection::supervisor_error(&e), "unconfirmed", false, true),
        }
    }
    fn failure(&mut self, code: OperationErrorCode, effect: &str, confirmed: bool, recovery: bool) {
        self.finish(
            json!({"kind":"failed","error":code.as_str(),"effect":effect}),
            confirmed,
            recovery,
            None,
        );
    }
    fn finish(
        &mut self,
        outcome: Value,
        confirmed: bool,
        recovery: bool,
        native_receipt: Option<RecordingPlanReceipt>,
    ) {
        let mut supervisor = self.supervisor.take().expect("owned supervisor");
        let (mut core, poisoned) = match self.shared.core.lock() {
            Ok(core) => (core, false),
            Err(error) => (error.into_inner(), true),
        };
        if poisoned {
            core.closed = true;
        }
        let recovery =
            recovery || poisoned || supervisor.recording_plan_guard_state().recovery_required;
        let (result, recovery) =
            match projection::result(self.operation.request(), outcome, confirmed, recovery) {
                Ok(result) => (result, recovery),
                Err(_) => (
                    projection::failed(
                        self.operation.request(),
                        OperationErrorCode::ProjectionFailed,
                        "unconfirmed",
                        confirmed,
                        true,
                    ),
                    true,
                ),
            };
        // No other stage can be accepted while this loan is outstanding.
        core.recovery |= recovery;
        if core.recovery {
            supervisor.latch_recording_operations_recovery();
        }
        if let Some(receipt) = native_receipt {
            core.native_receipt = Some(NativeReceiptEvidence {
                request: self.operation.request().clone(),
                receipt,
            });
        }
        if result.as_value()["outcome"]["kind"] == "applied" {
            // The native receipt was preserved even when projection failed.
            if let Some(evidence) = &core.native_receipt {
                core.last_applied = Some(AppliedSuccess {
                    request: self.operation.request().clone(),
                    receipt: evidence.receipt.clone(),
                });
            }
        }
        core.phase = if !confirmed {
            OperationsPhase::Uncertain
        } else if core.recovery {
            OperationsPhase::Blocked
        } else {
            match result.as_value()["outcome"]["kind"].as_str() {
                Some("candidate") => OperationsPhase::Candidate,
                Some("paused") => OperationsPhase::Paused,
                _ => OperationsPhase::Completed,
            }
        };
        let release = core.closed
            || !matches!(
                core.phase,
                OperationsPhase::Candidate | OperationsPhase::Paused
            );
        if let Some(w) = core.workflow.as_mut() {
            w.preflight = self.preflight.clone();
            w.turn = self.turn.clone();
            if release && !poisoned {
                let credits = w.credits;
                w.credits = 0;
                core.registry.release(credits);
            }
        }
        core.in_flight = false;
        core.latest = Some(result.clone());
        let retired = if core.closed {
            Some(supervisor)
        } else {
            core.supervisor = Some(supervisor);
            None
        };
        self.shared.publish(&core);
        self.operation.0.finish(result);
        self.done = true;
        drop(core);
        drop(retired);
    }
}
impl Drop for Loan {
    fn drop(&mut self) {
        if !self.done {
            fail(&self.shared, &self.operation);
        }
    }
}
fn fail(shared: &Shared, operation: &RecordingOperationHandle) {
    if operation.0.completion.borrow().is_some() {
        return;
    }
    let result = projection::failed(
        operation.request(),
        OperationErrorCode::WorkerFailure,
        "unconfirmed",
        false,
        true,
    );
    let (mut core, poisoned) = match shared.core.lock() {
        Ok(core) => (core, false),
        Err(error) => (error.into_inner(), true),
    };
    if poisoned {
        core.closed = true;
    }
    if operation.0.completion.borrow().is_some() {
        return;
    }
    core.recovery = true;
    core.in_flight = false;
    core.phase = OperationsPhase::Uncertain;
    core.latest = Some(result.clone());
    if !poisoned {
        if let Some(w) = core.workflow.as_mut() {
            let credits = w.credits;
            w.credits = 0;
            core.registry.release(credits);
        }
    }
    // Native resources may have been lost while unwinding. Never call them healthy.
    let retired = core.supervisor.take();
    shared.publish(&core);
    operation.0.finish(result);
    drop(core);
    drop(retired);
}
