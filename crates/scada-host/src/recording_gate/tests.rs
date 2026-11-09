use std::path::PathBuf;

use scada_runtime::recording_host::test_support::{self, TestStoreDir};
use scada_runtime::recording_registry::RecordingRegistryOwnerSeed;
use serde_json::{json, Value};

use super::*;
use crate::auth::{LoginOutcome, AUTH_DB_FILE};
use crate::auth_phase::AUTH_PHASE_FILE;
use crate::recording_epoch::create_recording_root;

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    async fn raw(&self) -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(self.0.join(AUTH_DB_FILE)),
        )
        .await
        .unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PASSWORD: &str = "correct-horse-1";

struct Fixture {
    gate: Arc<RecordingGate>,
    auth: Arc<AuthHost>,
    scope: Value,
    _store: TestStoreDir,
    dir: TempDir,
}

/// A gate over a native owner, its root built by `create_recording_root`
/// in the same data dir as the auth (design §7, §9 step 3).
async fn gate_in(dir: TempDir) -> Fixture {
    let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    let (owner, store) = test_support::joined_owner();
    let seed = RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap();
    let context = test_support::context().as_value().clone();
    let (root, issuer, generation) = create_recording_root(&dir.0, seed, context.clone()).unwrap();
    Fixture {
        gate: Arc::new(RecordingGate::new(
            auth.clone(),
            root,
            issuer,
            generation.scope(context.clone()),
        )),
        auth,
        scope: generation.scope(context),
        _store: store,
        dir,
    }
}

/// `initializing`: auth-disabled mode on, the synthetic session is Admin.
async fn initializing() -> Fixture {
    gate_in(TempDir::new()).await
}

/// `operational` with the administrator `admin` logged in and a Viewer
/// account `viewer`.
async fn operational() -> Fixture {
    let fixture = initializing().await;
    fixture
        .auth
        .transition_to_operational("admin", PASSWORD, "管理者", || {
            fixture.gate.lock().is_quiescent()
        })
        .await
        .unwrap();
    fixture
        .auth
        .auth()
        .users()
        .create_user("viewer", PASSWORD, "閲覧者", Role::Viewer)
        .await
        .unwrap();
    fixture
}

async fn login(auth: &AuthHost, username: &str) -> CurrentSession {
    match auth.auth().login(username, PASSWORD).await.unwrap() {
        LoginOutcome::LoggedIn(current) => current,
        other => panic!("login failed: {other:?}"),
    }
}

fn lease(scope: &Value, id: &str, role: &str) -> RecordingWireLeaseRequest {
    RecordingWireLeaseRequest::from_value(json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":id, "admissionId":format!("admission-{id}"), "role":role,
        "requestedBudgetMs":1000
    }))
    .unwrap()
}

fn attach(scope: &Value, id: &str) -> RecordingWireAttachRequest {
    RecordingWireAttachRequest::from_value(json!({
        "version":1, "kind":"recordingWireAttachRequest", "scope":scope,
        "attachId":id, "afterRevision":null
    }))
    .unwrap()
}

fn control(scope: &Value, id: &str, reference: &str) -> RecordingWireControlRequest {
    RecordingWireControlRequest::from_value(json!({
        "version":1, "kind":"recordingWireControlRequest", "scope":scope,
        "controlId":id, "subscriptionRef":reference, "action":"snapshot"
    }))
    .unwrap()
}

fn cancel(scope: &Value, id: &str, kind: &str) -> RecordingWireCancelRequest {
    RecordingWireCancelRequest::from_value(json!({
        "version":1, "kind":"recordingWireCancelRequest", "scope":scope,
        "cancelId":id, "target":{"kind":kind, "ref":"missing"}
    }))
    .unwrap()
}

fn inspect(scope: &Value, id: &str, original: &Value) -> RecordingWireCallInspectionRequest {
    RecordingWireCallInspectionRequest::from_value(json!({
        "version":1, "kind":"recordingWireCallInspectionRequest", "scope":scope,
        "callInspectionId":id, "original":original
    }))
    .unwrap()
}

fn outcome_kind<T>(bound: &Bound<T>, value: impl Fn(&T) -> &Value) -> String {
    value(&bound.reply)["outcome"]["kind"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn the_auth_disabled_admin_reads_with_replies_bound_to_its_generation() {
    let f = initializing().await;
    let seq = f.auth.auth().seq();

    let attached = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(attached.seq, seq);
    assert_eq!(outcome_kind(&attached, |r| r.reply.as_value()), "attached");
    let reference = attached.reply.reply.as_value()["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned();
    // The same ID and body is a re-fetch of the same reply.
    let again = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(
        again.reply.reply.as_value(),
        attached.reply.reply.as_value()
    );
    let snapshot = f
        .gate
        .control(control(&f.scope, "control-1", &reference))
        .await
        .unwrap();
    assert_eq!(snapshot.seq, seq);

    let read = f
        .gate
        .lease(lease(&f.scope, "read-1", "reconciliation"))
        .await
        .unwrap();
    assert_eq!(read.seq, seq);
    // A lease is an inspectable original: its saved reply comes back terminal.
    let original = read.reply.as_value()["request"].clone();
    let inspected = f
        .gate
        .call_inspection(inspect(&f.scope, "inspect-1", &original))
        .await
        .unwrap();
    assert_eq!(inspected.seq, seq);
    assert_eq!(inspected.reply.as_value()["outcome"]["kind"], "terminal");
    assert_eq!(
        &inspected.reply.as_value()["outcome"]["reply"],
        read.reply.as_value()
    );

    // Only the synthetic principal's read session was issued.
    let (held_seq, _) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    assert_eq!(held_seq, seq);
    assert!(f.gate.held(LeaseRole::Mutation).is_none());

    // A scope of another generation is refused by the registry.
    let mut foreign = f.scope.clone();
    foreign["ownerEpoch"] = json!("0".repeat(32));
    assert!(matches!(
        f.gate.attach(attach(&foreign, "attach-foreign")).await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));
}

#[tokio::test]
async fn a_mutation_lease_outside_a_workflow_is_forbidden_even_for_an_admin() {
    let f = initializing().await;
    assert!(matches!(
        f.gate.lease(lease(&f.scope, "write-1", "mutation")).await,
        Err(GateError::Forbidden)
    ));
    assert!(f.gate.held(LeaseRole::Mutation).is_none());
    // Nothing was leased, so the reconciliation lease is unaffected.
    f.gate
        .lease(lease(&f.scope, "read-1", "reconciliation"))
        .await
        .unwrap();
}

#[tokio::test]
async fn transitioning_refuses_every_entry_point() {
    let dir = TempDir::new();
    drop(AuthHost::start(&dir.0).await.unwrap());
    std::fs::write(
        dir.0.join(AUTH_PHASE_FILE),
        serde_json::to_vec(&json!({"version": 1, "phase": "transitioning"})).unwrap(),
    )
    .unwrap();
    let f = gate_in(dir).await;
    // Auth-disabled mode is still on, yet nothing is accepted (design §6).
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-1")).await,
        Err(GateError::Phase(AuthPhase::Transitioning))
    ));
    assert!(matches!(
        f.gate
            .lease(lease(&f.scope, "read-1", "reconciliation"))
            .await,
        Err(GateError::Phase(AuthPhase::Transitioning))
    ));
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
}

#[tokio::test]
async fn operation_needs_a_session_and_the_role_of_the_command() {
    let f = operational().await;
    f.auth.auth().logout().await;
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-1")).await,
        Err(GateError::Unauthorized)
    ));

    login(&f.auth, "viewer").await;
    f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    // A cancel of an operation needs Admin; one of a read needs read only.
    assert!(matches!(
        f.gate
            .cancel(cancel(&f.scope, "cancel-1", "operation"))
            .await,
        Err(GateError::Forbidden)
    ));
    assert!(matches!(
        f.gate
            .cancel(cancel(&f.scope, "cancel-2", "reconciliation"))
            .await,
        Err(GateError::Registry(LeaseError::InvalidInput))
    ));
    assert!(f.gate.held(LeaseRole::Mutation).is_none());

    f.auth.auth().logout().await;
    let admin = login(&f.auth, "admin").await;
    // Admin reaches the registry with the mutation session; with no
    // workflow the registry itself has nothing to cancel.
    assert!(matches!(
        f.gate
            .cancel(cancel(&f.scope, "cancel-3", "operation"))
            .await,
        Err(GateError::Registry(LeaseError::InvalidInput))
    ));
    let (held_seq, _) = f.gate.held(LeaseRole::Mutation).unwrap();
    assert_eq!(held_seq, admin.seq);
}

#[tokio::test]
async fn a_new_generation_revokes_the_old_sessions_and_the_principal_continues() {
    let f = operational().await;
    let first = f.auth.auth().current().await.unwrap().unwrap();
    let attached = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(attached.seq, first.seq);
    let (_, old) = f.gate.held(LeaseRole::Reconciliation).unwrap();

    f.auth.auth().logout().await;
    let second = login(&f.auth, "admin").await;
    assert_ne!(second.seq, first.seq);
    // The same principal re-fetches its own attach under the new generation.
    let again = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(again.seq, second.seq);
    assert_eq!(
        again.reply.reply.as_value(),
        attached.reply.reply.as_value()
    );
    let (held_seq, _) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    assert_eq!(held_seq, second.seq);
    // The first generation's grant is revoked in the registry.
    assert!(matches!(
        f.gate
            .with_root(|root| root.attach(&old, attach(&f.scope, "attach-1"))),
        Err(LeaseError::Unauthorized)
    ));

    // Another principal does not see that attach.
    f.auth.auth().logout().await;
    login(&f.auth, "viewer").await;
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-1")).await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));
}

#[tokio::test]
async fn a_reply_is_withheld_when_the_generation_changes_before_it_returns() {
    let f = operational().await;
    let auth = f.auth.clone();
    f.gate.after_next_call(async move {
        auth.auth().logout().await;
    });
    let withheld = lease(&f.scope, "read-1", "reconciliation");
    assert!(matches!(
        f.gate.lease(withheld.clone()).await,
        Err(GateError::Unauthorized)
    ));
    // The withheld command's sessions are revoked at once.
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());

    // A user switch while the reply is on its way: the other user never
    // receives it, and is refused the same ID.
    login(&f.auth, "admin").await;
    let auth = f.auth.clone();
    f.gate.after_next_call(async move {
        auth.auth().logout().await;
        login(&auth, "viewer").await;
    });
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-1")).await,
        Err(GateError::Unauthorized)
    ));
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-1")).await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));
    assert!(matches!(
        f.gate
            .call_inspection(inspect(&f.scope, "inspect-viewer", withheld.as_value()))
            .await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));

    // The registry kept both for their principal, which recovers them after
    // logging in again: the lease through a call inspection (design §4).
    f.auth.auth().logout().await;
    let admin = login(&f.auth, "admin").await;
    let recovered = f
        .gate
        .call_inspection(inspect(&f.scope, "inspect-1", withheld.as_value()))
        .await
        .unwrap();
    assert_eq!(recovered.seq, admin.seq);
    assert_eq!(recovered.reply.as_value()["outcome"]["kind"], "terminal");
    let reissued = f.gate.lease(withheld).await.unwrap();
    assert_eq!(
        &recovered.reply.as_value()["outcome"]["reply"],
        reissued.reply.as_value()
    );
    let attached = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(attached.seq, admin.seq);
    assert_eq!(outcome_kind(&attached, |r| r.reply.as_value()), "attached");
}

#[tokio::test]
async fn an_auth_db_read_failure_keeps_the_sessions_and_fails_only_that_command() {
    let f = operational().await;
    let current = f.auth.auth().current().await.unwrap().unwrap();
    f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    let raw = f.dir.raw().await;
    sqlx::query("ALTER TABLE users RENAME TO users_hidden")
        .execute(&raw)
        .await
        .unwrap();
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-2")).await,
        Err(GateError::AuthUnavailable(_))
    ));
    assert!(matches!(
        f.gate.refresh().await,
        Err(GateError::AuthUnavailable(_))
    ));
    let (held_seq, held) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    assert_eq!(held_seq, current.seq);
    assert!(f
        .gate
        .with_root(|root| root.attach(&held, attach(&f.scope, "attach-1")))
        .is_ok());

    sqlx::query("ALTER TABLE users_hidden RENAME TO users")
        .execute(&raw)
        .await
        .unwrap();
    let attached = f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap();
    assert_eq!(attached.seq, current.seq);
}

#[tokio::test]
async fn refresh_revokes_after_an_auth_change_without_waiting_for_a_command() {
    let f = operational().await;
    // Banto keeps the last administrator, so demote a second one.
    f.auth
        .auth()
        .users()
        .create_user("operator", PASSWORD, "運転員", Role::Admin)
        .await
        .unwrap();
    f.auth.auth().logout().await;
    let admin = login(&f.auth, "operator").await;
    f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    f.gate
        .cancel(cancel(&f.scope, "cancel-1", "operation"))
        .await
        .unwrap_err();
    let (_, read) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    let (_, mutation) = f.gate.held(LeaseRole::Mutation).unwrap();

    let id = admin.session.identity().id;
    f.auth
        .auth()
        .users()
        .update_user(id, "運転員", Role::Viewer)
        .await
        .unwrap();
    assert_eq!(f.gate.refresh().await.unwrap(), None);
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    for old in [read, mutation] {
        assert!(matches!(
            f.gate
                .with_root(|root| root.attach(&old, attach(&f.scope, "attach-1"))),
            Err(LeaseError::Unauthorized)
        ));
    }

    // Logged in again as a Viewer, the principal keeps reading its own
    // attach and can no longer use the mutation role.
    let viewer = login(&f.auth, "operator").await;
    let again = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(again.seq, viewer.seq);
    assert!(matches!(
        f.gate
            .cancel(cancel(&f.scope, "cancel-2", "operation"))
            .await,
        Err(GateError::Forbidden)
    ));
}

#[tokio::test]
async fn a_stale_refresh_never_revokes_the_sessions_of_a_newer_generation() {
    let f = operational().await;
    f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    f.auth.auth().logout().await;

    // The refresh reads "no session"; before it decides, the user logs in
    // again and a command issues sessions for the new generation.
    let (gate, auth, scope) = (f.gate.clone(), f.auth.clone(), f.scope.clone());
    f.gate.after_next_call(async move {
        login(&auth, "admin").await;
        gate.attach(attach(&scope, "attach-2")).await.unwrap();
    });
    assert_eq!(f.gate.refresh().await.unwrap(), None);

    let current = f.auth.auth().current().await.unwrap().unwrap();
    let (held_seq, held) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    assert_eq!(held_seq, current.seq);
    assert!(f
        .gate
        .with_root(|root| root.attach(&held, attach(&f.scope, "attach-2")))
        .is_ok());
    // An up-to-date refresh keeps it too.
    assert_eq!(f.gate.refresh().await.unwrap(), Some(current.clone()));
    let (held_seq, _) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    assert_eq!(held_seq, current.seq);
}

mod auth_change;
mod workflow;
