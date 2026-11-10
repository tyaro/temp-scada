//! The exit's discard of a Candidate (product-owner design §6.1, C5-3b): a
//! session of the reserving principal whatever the desktop session is, the
//! principal's own discard lease taken over, an expired one replaced, a
//! Paused change left alone, and the host's audit row.
use std::time::Duration;

use scada_runtime::recording_operations::OperationsPhase;

use super::workflow::{
    admission, handle, operation, preflighted, recording_audit, row, stage_lease, Preflighted,
};
use super::*;

/// Retry `call` while the registry answers `Busy` (a native stage still
/// running).
async fn when_ready<T, F, Fut>(mut call: F) -> Result<T, GateError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, GateError>>,
{
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match call().await {
                Err(GateError::Registry(LeaseError::Busy)) => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                other => break other,
            }
        }
    })
    .await
    .expect("the native stage completes")
}

async fn until_phase(f: &Fixture, phase: OperationsPhase) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while f.gate.owner_phase() != Some(phase) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the owner reaches the phase");
}

/// A workflow whose preflight completed as a Candidate.
async fn candidate(f: &Fixture, change_id: &str) -> Preflighted {
    let p = preflighted(f, change_id).await;
    until_phase(f, OperationsPhase::Candidate).await;
    p
}

/// The exit's discard, with the exit's first steps before it.
async fn shutdown_discard(f: &Fixture) -> ShutdownDiscard {
    f.gate.begin_shutdown();
    let phase = f.auth.gate().await;
    f.gate.shutdown_discard(&phase, Duration::from_secs(5))
}

fn done(discard: ShutdownDiscard) -> ShutdownDiscarded {
    match discard {
        ShutdownDiscard::Done(done) => done,
        other => panic!("not discarded: {other:?}"),
    }
}

/// The detail of the last audit row.
async fn last_detail(dir: &TempDir) -> Value {
    let (detail,): (String,) =
        sqlx::query_as("SELECT detail FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_one(&dir.raw().await)
            .await
            .unwrap();
    serde_json::from_str(&detail).unwrap()
}

/// Hand the root off, as the exit does once the owner is back to `Idle`.
async fn handed_off(f: &Fixture) -> bool {
    let phase = f.auth.gate().await;
    f.gate.try_take(&phase, NO_RECORDING_RUN).unwrap().is_some()
}

#[tokio::test]
async fn the_exit_discards_the_candidate_of_a_principal_who_logged_out() {
    let f = operational().await;
    let admin = f.auth.auth().current().await.unwrap().unwrap();
    let principal = admin.session.principal();
    candidate(&f, "exit-change").await;
    // The reserving Admin logs out and a Viewer logs in: neither session can
    // discard, and the exit needs neither.
    f.gate.logout().await;
    f.gate.login("viewer", PASSWORD).await.unwrap();

    let done = done(shutdown_discard(&f).await);
    assert!(done.completed(), "{done:?}");
    let admission_id = done.admission_id().unwrap().to_owned();
    assert!(
        admission_id.starts_with("shutdown-discard:"),
        "{admission_id}"
    );
    assert_eq!(f.gate.owner_phase(), Some(OperationsPhase::Idle));
    // Nothing more to discard.
    assert!(matches!(
        shutdown_discard(&f).await,
        ShutdownDiscard::NotCandidate
    ));

    // Audited as the host, with the reserving principal in the detail.
    f.gate.audit_shutdown_discard(&done).await;
    let audit = recording_audit(&f.dir).await;
    assert_eq!(
        audit.last().unwrap(),
        &row(
            "register",
            "recording_admission",
            &admission_id,
            "ok",
            SHUTDOWN_ACTOR
        )
    );
    assert_eq!(
        last_detail(&f.dir).await,
        json!({"stage": "discard", "origin": "shutdown", "principal": principal.as_str()})
    );
    assert!(handed_off(&f).await);
}

#[tokio::test]
async fn the_exit_takes_over_the_discard_lease_the_principal_holds() {
    let f = initializing().await;
    candidate(&f, "held-lease-change").await;
    when_ready(|| {
        f.gate.workflow_lease(
            WorkflowStage::Discard,
            stage_lease(&f.scope, "user-discard", "mutation"),
        )
    })
    .await
    .unwrap();

    let done = done(shutdown_discard(&f).await);
    assert!(done.completed(), "{done:?}");
    assert_eq!(done.admission_id(), Some("user-discard"));
    assert!(handed_off(&f).await);
}

#[tokio::test]
async fn the_exit_replaces_a_discard_lease_that_expired_unregistered() {
    let f = initializing().await;
    candidate(&f, "expired-lease-change").await;
    let short = RecordingWireLeaseRequest::from_value(json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":f.scope,
        "leaseRequestId":"user-discard-lease", "admissionId":"user-discard",
        "role":"mutation", "requestedBudgetMs":1
    }))
    .unwrap();
    when_ready(|| f.gate.workflow_lease(WorkflowStage::Discard, short.clone()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;

    let done = done(shutdown_discard(&f).await);
    assert!(done.completed(), "{done:?}");
    let admission_id = done.admission_id().unwrap();
    assert!(
        admission_id.starts_with("shutdown-discard:"),
        "{admission_id}"
    );
    assert!(handed_off(&f).await);
}

#[tokio::test]
async fn the_exit_leaves_a_paused_change_alone() {
    let f = initializing().await;
    let p = candidate(&f, "paused-change").await;
    let stage = WorkflowStage::PauseJoin {
        operation_id: "pause:exit".into(),
    };
    let lease = when_ready(|| {
        f.gate
            .workflow_lease(stage.clone(), stage_lease(&f.scope, "pause", "mutation"))
    })
    .await
    .unwrap();
    let paused = f
        .gate
        .admission(admission(
            &f.scope,
            "pause",
            &lease,
            json!({"kind":"pauseJoin", "changeRef":handle(&p.accepted, "changeRef"),
                "operation":operation(&p.change, "pause:exit", "pauseJoin")}),
        ))
        .await
        .unwrap();
    assert_eq!(
        paused.reply.as_value()["outcome"]["kind"],
        "accepted",
        "{:?}",
        paused.reply
    );
    until_phase(&f, OperationsPhase::Paused).await;

    assert!(matches!(
        shutdown_discard(&f).await,
        ShutdownDiscard::NotCandidate
    ));
    assert_eq!(f.gate.owner_phase(), Some(OperationsPhase::Paused));
    // The handoff stays refused: the exit ends without it (design §6).
    let phase = f.auth.gate().await;
    assert!(matches!(
        f.gate.try_take(&phase, NO_RECORDING_RUN),
        Err(OwnerError::Busy)
    ));
}

#[tokio::test]
async fn a_refused_discard_is_audited_as_the_host_and_leaves_the_candidate() {
    let f = initializing().await;
    candidate(&f, "refused-change").await;
    f.gate.refuse_next_shutdown_discard();

    let done = done(shutdown_discard(&f).await);
    assert!(!done.completed());
    assert_eq!(f.gate.owner_phase(), Some(OperationsPhase::Candidate));
    f.gate.audit_shutdown_discard(&done).await;
    assert_eq!(
        recording_audit(&f.dir).await.last().unwrap(),
        &row(
            "register",
            "recording_admission",
            "",
            "denied",
            SHUTDOWN_ACTOR
        )
    );
    assert_eq!(
        last_detail(&f.dir).await,
        json!({"stage": "discard", "origin": "shutdown",
            "principal": "banto-local:auth-disabled", "error": "Forbidden"})
    );
}

#[tokio::test]
async fn the_close_check_asks_for_a_candidate_only() {
    let f = initializing().await;
    // An idle root is quiescent: the window closes at once.
    assert_eq!(f.gate.close_check(), CloseCheck::Close);
    let p = candidate(&f, "close-change").await;
    assert_eq!(f.gate.close_check(), CloseCheck::Candidate);

    // A Paused change is left to the next start: no question.
    let stage = WorkflowStage::PauseJoin {
        operation_id: "pause:close".into(),
    };
    let lease = when_ready(|| {
        f.gate
            .workflow_lease(stage.clone(), stage_lease(&f.scope, "pause", "mutation"))
    })
    .await
    .unwrap();
    f.gate
        .admission(admission(
            &f.scope,
            "pause",
            &lease,
            json!({"kind":"pauseJoin", "changeRef":handle(&p.accepted, "changeRef"),
                "operation":operation(&p.change, "pause:close", "pauseJoin")}),
        ))
        .await
        .unwrap();
    until_phase(&f, OperationsPhase::Paused).await;
    assert_eq!(f.gate.close_check(), CloseCheck::Close);

    // Without a root (handed off) there is nothing to ask.
    let empty = RecordingGate::empty(f.auth.clone(), NO_RECORDING_RUN);
    assert_eq!(empty.close_check(), CloseCheck::Close);
}

#[test]
fn the_close_check_waits_for_unsettled_work_but_not_for_a_paused_change() {
    use OperationsPhase::*;
    for phase in [Preflighting, Pausing, Applying, Uncertain, Blocked, Idle] {
        assert_eq!(CloseCheck::of(Some(phase), false), CloseCheck::Waiting);
        assert_eq!(CloseCheck::of(Some(phase), true), CloseCheck::Close);
    }
    assert_eq!(CloseCheck::of(Some(Paused), false), CloseCheck::Close);
    assert_eq!(
        CloseCheck::of(Some(Candidate), false),
        CloseCheck::Candidate
    );
    // A handed-off root.
    assert_eq!(CloseCheck::of(None, true), CloseCheck::Close);
}
