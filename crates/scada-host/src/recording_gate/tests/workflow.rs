//! The workflow entry points (§9 step 4-2-2): reservation, stage leases,
//! admissions and admission inspection through the gate alone, the tickets'
//! binding to the reserving principal, and the audit of registrations.
use std::time::Duration;

use scada_model::recording_admission::{
    RecordingAdmissionInspectionRequest, RecordingAdmissionRequest,
};
use scada_model::recording_operations::RecordingChangeRequest;

use super::*;

const BUDGET_MS: u64 = 5000;

pub(super) fn stage_lease(scope: &Value, id: &str, role: &str) -> RecordingWireLeaseRequest {
    RecordingWireLeaseRequest::from_value(json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":format!("{id}-lease"), "admissionId":id, "role":role,
        "requestedBudgetMs":BUDGET_MS
    }))
    .unwrap()
}

pub(super) fn admission(
    scope: &Value,
    id: &str,
    lease: &Bound<RecordingWireLeaseReply>,
    action: Value,
) -> RecordingAdmissionRequest {
    RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":id, "context":scope["context"],
        "deadlineLeaseRef":lease.reply.as_value()["outcome"]["deadlineLeaseRef"],
        "action":action
    }))
    .unwrap()
}

pub(super) fn operation(change: &RecordingChangeRequest, id: &str, stage: &str) -> Value {
    json!({"version":1, "kind":"recordingOperationRequest", "operationId":id,
        "stage":stage, "change":change.as_value()})
}

pub(super) fn handle(reply: &Bound<RecordingAdmissionReply>, field: &str) -> String {
    reply.reply.as_value()["outcome"]["handle"][field]
        .as_str()
        .unwrap()
        .to_owned()
}

fn admission_inspection(
    original: &RecordingAdmissionRequest,
    id: &str,
) -> RecordingAdmissionInspectionRequest {
    RecordingAdmissionInspectionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionInspectionRequest",
        "inspectionId":id, "original":original.as_value()
    }))
    .unwrap()
}

/// Retry a call the registry answers `Busy` until the native stage it waits
/// for has completed.
macro_rules! when_ready {
    ($call:expr) => {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match $call {
                    Err(GateError::Registry(LeaseError::Busy)) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    other => break other,
                }
            }
        })
        .await
        .expect("the native stage completes")
    };
}

/// The audit rows of the recording registry, as (action, resource, entity,
/// result, actor).
pub(super) async fn recording_audit(
    dir: &TempDir,
) -> Vec<(String, String, String, String, String)> {
    sqlx::query_as(
        "SELECT action, resource, COALESCE(entity_id, ''), result, actor_username FROM audit_log \
         WHERE resource LIKE 'recording_%' ORDER BY id",
    )
    .fetch_all(&dir.raw().await)
    .await
    .unwrap()
}

pub(super) fn row(
    action: &str,
    resource: &str,
    entity: &str,
    result: &str,
    actor: &str,
) -> (String, String, String, String, String) {
    (
        action.into(),
        resource.into(),
        entity.into(),
        result.into(),
        actor.into(),
    )
}

/// A reserved workflow with its preflight accepted and its Candidate ready.
pub(super) struct Preflighted {
    pub(super) change: RecordingChangeRequest,
    request: RecordingAdmissionRequest,
    pub(super) accepted: Bound<RecordingAdmissionReply>,
}

pub(super) async fn preflighted(f: &Fixture, change_id: &str) -> Preflighted {
    let change = test_support::change(change_id);
    f.gate.workflow_reserve(change.clone()).await.unwrap();
    let lease = f
        .gate
        .workflow_lease(
            WorkflowStage::Preflight,
            stage_lease(&f.scope, "preflight", "mutation"),
        )
        .await
        .unwrap();
    let request = admission(
        &f.scope,
        "preflight",
        &lease,
        json!({"kind":"preflight", "change":change.as_value()}),
    );
    let accepted = f.gate.admission(request.clone()).await.unwrap();
    assert_eq!(outcome_kind(&accepted, |r| r.as_value()), "accepted");
    Preflighted {
        change,
        request,
        accepted,
    }
}

#[tokio::test]
async fn the_gate_alone_runs_a_workflow_from_reservation_to_the_original_apply_reconcile() {
    let f = initializing().await;
    let seq = f.auth.auth().seq();

    // A mutation lease outside the workflow is refused and does not block
    // the reservation (design §5).
    assert!(matches!(
        f.gate
            .lease(stage_lease(&f.scope, "stray", "mutation"))
            .await,
        Err(GateError::Forbidden)
    ));
    // No stage before the reservation.
    assert!(matches!(
        f.gate
            .workflow_lease(
                WorkflowStage::Preflight,
                stage_lease(&f.scope, "early", "mutation")
            )
            .await,
        Err(GateError::Registry(LeaseError::InvalidInput))
    ));

    let change = test_support::change("gate-change");
    let reserved = f.gate.workflow_reserve(change.clone()).await.unwrap();
    assert_eq!(reserved.seq, seq);
    assert_eq!(reserved.reply.change_id, "gate-change");
    // The same request is the same reservation; another one is refused.
    assert_eq!(
        f.gate.workflow_reserve(change.clone()).await.unwrap(),
        reserved
    );
    assert!(matches!(
        f.gate
            .workflow_reserve(test_support::change("other-change"))
            .await,
        Err(GateError::Registry(LeaseError::Busy))
    ));

    // Preflight: the stage lease, then the admission, dispatched once.
    let lease = f
        .gate
        .workflow_lease(
            WorkflowStage::Preflight,
            stage_lease(&f.scope, "preflight", "mutation"),
        )
        .await
        .unwrap();
    assert_eq!(lease.seq, seq);
    let preflight = admission(
        &f.scope,
        "preflight",
        &lease,
        json!({"kind":"preflight", "change":change.as_value()}),
    );
    let accepted = f.gate.admission(preflight.clone()).await.unwrap();
    assert_eq!(accepted.seq, seq);
    assert_eq!(outcome_kind(&accepted, |r| r.as_value()), "accepted");
    assert_eq!(f.gate.admission(preflight.clone()).await.unwrap(), accepted);
    let inspected = f
        .gate
        .admission_inspection(admission_inspection(&preflight, "inspect-preflight"))
        .await
        .unwrap();
    assert_eq!(inspected.seq, seq);

    // Pause/join, once the Candidate is ready.
    let pause_stage = WorkflowStage::PauseJoin {
        operation_id: "pause:gate".into(),
    };
    let lease = when_ready!(
        f.gate
            .workflow_lease(
                pause_stage.clone(),
                stage_lease(&f.scope, "pause", "mutation")
            )
            .await
    )
    .unwrap();
    let paused = f
        .gate
        .admission(admission(
            &f.scope,
            "pause",
            &lease,
            json!({"kind":"pauseJoin", "changeRef":handle(&accepted, "changeRef"),
                "operation":operation(&change, "pause:gate", "pauseJoin")}),
        ))
        .await
        .unwrap();
    assert_eq!(outcome_kind(&paused, |r| r.as_value()), "accepted");

    // Apply, once paused. Its native response is lost, so the original
    // apply needs a reconcile.
    let lease = when_ready!(
        f.gate
            .workflow_lease(
                WorkflowStage::Apply {
                    operation_id: "apply:gate".into()
                },
                stage_lease(&f.scope, "apply", "mutation")
            )
            .await
    )
    .unwrap();
    f.gate
        .with_root(|root| test_support::lose_next_apply_response(root));
    let apply = admission(
        &f.scope,
        "apply",
        &lease,
        json!({"kind":"apply", "changeRef":handle(&paused, "changeRef"),
            "operation":operation(&change, "apply:gate", "apply")}),
    );
    let applied = f.gate.admission(apply.clone()).await.unwrap();
    assert_eq!(outcome_kind(&applied, |r| r.as_value()), "accepted");

    // Reconcile the original apply with a read lease and the held apply ticket.
    let lease = f
        .gate
        .lease(stage_lease(&f.scope, "reconcile", "reconciliation"))
        .await
        .unwrap();
    let reconcile = admission(
        &f.scope,
        "reconcile",
        &lease,
        json!({"kind":"reconcile", "changeRef":handle(&applied, "changeRef"),
            "operationRef":handle(&applied, "operationRef"),
            "reconciliation":{"version":1, "kind":"recordingReconciliationRequest",
                "reconciliationId":"read:original-apply",
                "operation":apply.as_value()["action"]["operation"]}}),
    );
    let reconciled = when_ready!(f.gate.admission(reconcile.clone()).await).unwrap();
    assert_eq!(reconciled.seq, seq);
    assert_eq!(outcome_kind(&reconciled, |r| r.as_value()), "accepted");
    assert_eq!(f.gate.admission(reconcile).await.unwrap(), reconciled);

    // The reservation and each mutation registration are audited once (the
    // replays register nothing); reads are not.
    let local = f.auth.auth().current().await.unwrap().unwrap();
    let actor = local.session.identity().username.clone();
    assert_eq!(
        recording_audit(&f.dir).await,
        vec![
            row("reserve", "recording_workflow", "gate-change", "ok", &actor),
            row(
                "reserve",
                "recording_workflow",
                "other-change",
                "failed",
                &actor
            ),
            row("register", "recording_admission", "preflight", "ok", &actor),
            row("register", "recording_admission", "pause", "ok", &actor),
            row("register", "recording_admission", "apply", "ok", &actor),
        ]
    );
}

#[tokio::test]
async fn the_workflow_tickets_serve_only_the_principal_that_reserved_them() {
    let f = operational().await;
    let p = preflighted(&f, "admin-change").await;
    f.auth
        .auth()
        .users()
        .create_user("admin2", PASSWORD, "管理者2", Role::Admin)
        .await
        .unwrap();

    // Another Admin: the registry refuses another principal's workflow.
    f.auth.auth().logout().await;
    login(&f.auth, "admin2").await;
    let pause_stage = WorkflowStage::PauseJoin {
        operation_id: "pause:admin".into(),
    };
    assert!(matches!(
        f.gate
            .workflow_lease(
                pause_stage.clone(),
                stage_lease(&f.scope, "pause", "mutation")
            )
            .await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));
    assert!(matches!(
        f.gate.admission(p.request.clone()).await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));
    assert!(matches!(
        f.gate
            .admission_inspection(admission_inspection(&p.request, "inspect-admin2"))
            .await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));
    assert!(matches!(
        f.gate
            .workflow_reserve(test_support::change("admin2-change"))
            .await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));

    // A Viewer: no mutation entry at all, and no other principal's reads.
    f.auth.auth().logout().await;
    login(&f.auth, "viewer").await;
    assert!(matches!(
        f.gate
            .workflow_lease(
                pause_stage.clone(),
                stage_lease(&f.scope, "pause", "mutation")
            )
            .await,
        Err(GateError::Forbidden)
    ));
    assert!(matches!(
        f.gate
            .admission_inspection(admission_inspection(&p.request, "inspect-viewer"))
            .await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));

    // The reserving Admin continues after logging in again.
    f.auth.auth().logout().await;
    login(&f.auth, "admin").await;
    assert_eq!(
        f.gate.admission(p.request.clone()).await.unwrap().reply,
        p.accepted.reply
    );
    f.gate
        .admission_inspection(admission_inspection(&p.request, "inspect-admin"))
        .await
        .unwrap();
    let lease = when_ready!(
        f.gate
            .workflow_lease(
                pause_stage.clone(),
                stage_lease(&f.scope, "pause", "mutation")
            )
            .await
    )
    .unwrap();
    let paused = f
        .gate
        .admission(admission(
            &f.scope,
            "pause",
            &lease,
            json!({"kind":"pauseJoin", "changeRef":handle(&p.accepted, "changeRef"),
                "operation":operation(&p.change, "pause:admin", "pauseJoin")}),
        ))
        .await
        .unwrap();
    assert_eq!(outcome_kind(&paused, |r| r.as_value()), "accepted");

    // The other principal's attempts are audited as denied, and the role
    // refusal by `require_role`.
    assert_eq!(
        recording_audit(&f.dir).await,
        vec![
            row(
                "reserve",
                "recording_workflow",
                "admin-change",
                "ok",
                "admin"
            ),
            row(
                "register",
                "recording_admission",
                "preflight",
                "ok",
                "admin"
            ),
            row(
                "register",
                "recording_admission",
                "preflight",
                "denied",
                "admin2"
            ),
            row(
                "reserve",
                "recording_workflow",
                "admin2-change",
                "denied",
                "admin2"
            ),
            row("denied", "recording_workflow_lease", "", "denied", "viewer"),
            row("register", "recording_admission", "pause", "ok", "admin"),
        ]
    );
}

#[tokio::test]
async fn a_stage_before_its_earlier_stage_is_invalid_and_registers_nothing() {
    let f = initializing().await;
    let change = test_support::change("early-change");
    f.gate.workflow_reserve(change.clone()).await.unwrap();
    for stage in [
        WorkflowStage::PauseJoin {
            operation_id: "pause:early".into(),
        },
        WorkflowStage::Apply {
            operation_id: "apply:early".into(),
        },
        WorkflowStage::Discard,
    ] {
        assert!(matches!(
            f.gate
                .workflow_lease(stage, stage_lease(&f.scope, "early", "mutation"))
                .await,
            Err(GateError::Registry(LeaseError::InvalidInput))
        ));
    }
    // An admission whose earlier stage was never registered: the lease ref
    // is irrelevant, the gate has no ticket to register it with.
    let read = f
        .gate
        .lease(stage_lease(&f.scope, "read", "reconciliation"))
        .await
        .unwrap();
    for action in [
        json!({"kind":"pauseJoin", "changeRef":"change",
            "operation":operation(&change, "pause:early", "pauseJoin")}),
        json!({"kind":"apply", "changeRef":"change",
            "operation":operation(&change, "apply:early", "apply")}),
        json!({"kind":"discard", "changeRef":"change", "change":change.as_value()}),
    ] {
        assert!(matches!(
            f.gate
                .admission(admission(&f.scope, "early", &read, action))
                .await,
            Err(GateError::Registry(LeaseError::InvalidInput))
        ));
    }
    let audit = recording_audit(&f.dir).await;
    assert_eq!(audit.len(), 4, "{audit:?}");
    assert!(audit[1..]
        .iter()
        .all(|(action, _, _, result, _)| action == "register" && result == "failed"));
}

/// Discard the Candidate of `p` (after its preflight completed).
pub(super) async fn discard(f: &Fixture, p: &Preflighted, id: &str) {
    let lease = when_ready!(
        f.gate
            .workflow_lease(
                WorkflowStage::Discard,
                stage_lease(&f.scope, id, "mutation")
            )
            .await
    )
    .unwrap();
    let request = admission(
        &f.scope,
        id,
        &lease,
        json!({"kind":"discard", "changeRef":handle(&p.accepted, "changeRef"),
            "change":p.change.as_value()}),
    );
    let discarded = f.gate.admission(request).await.unwrap();
    assert_eq!(
        outcome_kind(&discarded, |r| r.as_value()),
        "completedDiscard"
    );
}

#[tokio::test]
async fn a_candidate_is_discarded_through_the_held_preflight_ticket() {
    let f = initializing().await;
    let p = preflighted(&f, "discard-change").await;
    let lease = when_ready!(
        f.gate
            .workflow_lease(
                WorkflowStage::Discard,
                stage_lease(&f.scope, "discard", "mutation")
            )
            .await
    )
    .unwrap();
    let discard = admission(
        &f.scope,
        "discard",
        &lease,
        json!({"kind":"discard", "changeRef":handle(&p.accepted, "changeRef"),
            "change":p.change.as_value()}),
    );
    // A discard completes synchronously in its reply.
    let discarded = f.gate.admission(discard.clone()).await.unwrap();
    assert_eq!(
        outcome_kind(&discarded, |r| r.as_value()),
        "completedDiscard"
    );
    assert_eq!(f.gate.admission(discard).await.unwrap(), discarded);
}

/// The admissions of a held resumption, as (admission ID, outcome kind).
fn resumed_admissions(resumption: &WorkflowResumption) -> Vec<(String, String)> {
    let WorkflowResumption::Held { admissions, .. } = resumption else {
        panic!("no held workflow: {resumption:?}");
    };
    admissions
        .iter()
        .map(|(request, reply)| {
            (
                request.as_value()["admissionId"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                reply.as_value()["outcome"]["kind"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_new_page_reads_its_own_workflow_with_the_stored_replies() {
    let f = initializing().await;
    assert_eq!(
        f.gate.workflow_resumption().await.unwrap().reply,
        WorkflowResumption::None
    );

    // Reserved only: the change is there, with no admission yet.
    let reserved = test_support::change("reserved-change");
    f.gate.workflow_reserve(reserved.clone()).await.unwrap();
    assert_eq!(
        f.gate.workflow_resumption().await.unwrap().reply,
        WorkflowResumption::Held {
            change: reserved,
            admissions: vec![],
        }
    );
}

#[tokio::test]
async fn the_resumption_holds_each_stage_in_execution_order() {
    let f = initializing().await;
    let p = preflighted(&f, "resume-change").await;
    let resumption = f.gate.workflow_resumption().await.unwrap().reply;
    let WorkflowResumption::Held { change, admissions } = &resumption else {
        panic!("no held workflow");
    };
    assert_eq!(change, &p.change);
    assert_eq!(
        admissions,
        &vec![(p.request.clone(), p.accepted.reply.clone())]
    );

    let operation_id = "pause:resume".to_owned();
    let lease = when_ready!(
        f.gate
            .workflow_lease(
                WorkflowStage::PauseJoin {
                    operation_id: operation_id.clone()
                },
                stage_lease(&f.scope, "pause", "mutation")
            )
            .await
    )
    .unwrap();
    let pause = admission(
        &f.scope,
        "pause",
        &lease,
        json!({"kind":"pauseJoin", "changeRef":handle(&p.accepted, "changeRef"),
            "operation":operation(&p.change, &operation_id, "pauseJoin")}),
    );
    // A replay of the same request stays one record.
    f.gate.admission(pause.clone()).await.unwrap();
    f.gate.admission(pause).await.unwrap();
    assert_eq!(
        resumed_admissions(&f.gate.workflow_resumption().await.unwrap().reply),
        vec![
            ("preflight".to_owned(), "accepted".to_owned()),
            ("pause".to_owned(), "accepted".to_owned()),
        ]
    );
}

#[tokio::test]
async fn a_completed_discard_ends_the_resumption() {
    let f = initializing().await;
    let p = preflighted(&f, "discarded-change").await;
    let lease = when_ready!(
        f.gate
            .workflow_lease(
                WorkflowStage::Discard,
                stage_lease(&f.scope, "discard", "mutation")
            )
            .await
    )
    .unwrap();
    let discard = admission(
        &f.scope,
        "discard",
        &lease,
        json!({"kind":"discard", "changeRef":handle(&p.accepted, "changeRef"),
            "change":p.change.as_value()}),
    );
    f.gate.admission(discard).await.unwrap();
    assert_eq!(
        f.gate.workflow_resumption().await.unwrap().reply,
        WorkflowResumption::None
    );
}

#[tokio::test]
async fn the_resumption_follows_the_principal_across_logins() {
    let f = operational().await;
    let p = preflighted(&f, "login-change").await;

    // Another principal sees nothing of it, not even a refusal.
    f.auth.auth().logout().await;
    login(&f.auth, "viewer").await;
    assert_eq!(
        f.gate.workflow_resumption().await.unwrap().reply,
        WorkflowResumption::None
    );

    // The same principal after a new login gets its replies back, and its
    // new generation observes the operation through them.
    f.auth.auth().logout().await;
    login(&f.auth, "admin").await;
    let resumption = f.gate.workflow_resumption().await.unwrap();
    let WorkflowResumption::Held { admissions, .. } = &resumption.reply else {
        panic!("no held workflow");
    };
    assert_eq!(admissions[0].1, p.accepted.reply);
    let observed = f
        .gate
        .observation(
            RecordingWireObservationRequest::from_value(json!({
                "version":1, "kind":"recordingWireObservationRequest", "scope":f.scope,
                "observationId":"resumed-observation",
                "target":{"kind":"operation",
                    "operationRef":handle(&p.accepted, "operationRef"),
                    "request":p.accepted.reply.as_value()["outcome"]["handle"]["request"]}
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(outcome_kind(&observed, |r| r.as_value()), "unavailable");
}

#[tokio::test]
async fn a_withheld_admission_reply_stays_registered_for_its_principal() {
    let f = operational().await;
    let change = test_support::change("withheld-change");
    f.gate.workflow_reserve(change.clone()).await.unwrap();
    let lease = f
        .gate
        .workflow_lease(
            WorkflowStage::Preflight,
            stage_lease(&f.scope, "preflight", "mutation"),
        )
        .await
        .unwrap();
    let request = admission(
        &f.scope,
        "preflight",
        &lease,
        json!({"kind":"preflight", "change":change.as_value()}),
    );

    // A logout and another user's login while the reply is on its way.
    let auth = f.auth.clone();
    f.gate.after_next_call(async move {
        auth.auth().logout().await;
        login(&auth, "viewer").await;
    });
    assert!(matches!(
        f.gate.admission(request.clone()).await,
        Err(GateError::Unauthorized)
    ));

    // Registered and dispatched all the same, and audited once.
    f.auth.auth().logout().await;
    let admin = login(&f.auth, "admin").await;
    let recovered = f.gate.admission(request).await.unwrap();
    assert_eq!(recovered.seq, admin.seq);
    assert_eq!(outcome_kind(&recovered, |r| r.as_value()), "accepted");
    assert_eq!(
        recording_audit(&f.dir).await,
        vec![
            row(
                "reserve",
                "recording_workflow",
                "withheld-change",
                "ok",
                "admin"
            ),
            row(
                "register",
                "recording_admission",
                "preflight",
                "ok",
                "admin"
            ),
        ]
    );
}

#[tokio::test]
async fn a_dropped_admission_command_is_still_audited_once() {
    let f = initializing().await;
    let change = test_support::change("dropped-change");
    f.gate.workflow_reserve(change.clone()).await.unwrap();
    let lease = f
        .gate
        .workflow_lease(
            WorkflowStage::Preflight,
            stage_lease(&f.scope, "preflight", "mutation"),
        )
        .await
        .unwrap();
    let request = admission(
        &f.scope,
        "preflight",
        &lease,
        json!({"kind":"preflight", "change":change.as_value()}),
    );

    // The command's future is dropped while its audit is being written: the
    // registration is audited all the same.
    f.gate.after_next_call(std::future::pending());
    assert!(tokio::time::timeout(
        Duration::from_millis(200),
        f.gate.admission(request.clone())
    )
    .await
    .is_err());
    let registered = row("register", "recording_admission", "preflight", "ok", "");
    let audited = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let audit = recording_audit(&f.dir).await;
            if audit.len() == 2 {
                break audit;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        (&audited[1].0, &audited[1].1, &audited[1].2, &audited[1].3),
        (&registered.0, &registered.1, &registered.2, &registered.3)
    );

    // The replay returns the original reply and records nothing more.
    let replayed = f.gate.admission(request).await.unwrap();
    assert_eq!(outcome_kind(&replayed, |r| r.as_value()), "accepted");
    assert_eq!(recording_audit(&f.dir).await.len(), 2);
}
