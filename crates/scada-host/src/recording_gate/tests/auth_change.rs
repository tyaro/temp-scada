//! Auth changes and subscriptions (§9 step 4-2-3): frame delivery bound to
//! the attaching generation, the move to operation and the demotion or
//! deletion of an Admin against the registry's quiescence, and the
//! revocation they make before returning.
use std::time::Duration;

use banto_admin_services::settings::AuthSettings;

use super::workflow::{discard, preflighted};
use super::*;
use crate::auth_phase::TransitionError;

fn subscription_ref(attached: &Bound<Attached>) -> String {
    attached.reply.reply.as_value()["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Whether the registry still serves `reference` to the held read session.
fn live(f: &Fixture, reference: &str) -> bool {
    let Some((_, session)) = f.gate.held(LeaseRole::Reconciliation) else {
        return false;
    };
    !matches!(
        f.gate
            .with_root(|root| root.take_control_frame(&session, reference)),
        Err(LeaseError::InvalidInput)
    )
}

/// Wait until only `owner`'s workflow keeps the registry unsettled, so
/// `holds` names no one else (the native preflight has completed).
async fn settled_but_for(f: &Fixture, other: &RecordingPrincipal) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while f.gate.lock().holds(other) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the native preflight completes");
}

/// `operational` with a second Admin `operator`, logged in.
async fn with_operator() -> (Fixture, CurrentSession) {
    let f = operational().await;
    f.auth
        .auth()
        .users()
        .create_user("operator", PASSWORD, "運転員", Role::Admin)
        .await
        .unwrap();
    f.gate.logout().await;
    let operator = login(&f.auth, "operator").await;
    (f, operator)
}

#[tokio::test]
async fn frames_are_delivered_to_the_attaching_generation_only() {
    let f = initializing().await;
    let seq = f.auth.auth().seq();
    let attached = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    let reference = subscription_ref(&attached);
    // Nothing new since the attach snapshot.
    let empty = f.gate.frames(1, &reference).await.unwrap();
    assert_eq!(empty.seq, seq);
    assert_eq!(empty.reply.state, None);

    preflighted(&f, "frames-change").await;
    let delivered = f.gate.frames(1, &reference).await.unwrap();
    assert_eq!(delivered.seq, seq);
    let state = delivered.reply.state.expect("a new revision");
    assert_eq!(
        state.as_value()["subscriptionRef"].as_str(),
        Some(reference.as_str())
    );
    // The latest-one slot was taken: a later delivery carries only a newer
    // revision (the native preflight may complete meanwhile), never this one.
    let revision = |frame: &RecordingWireStateFrame| {
        frame.as_value()["snapshot"]["revision"].as_u64().unwrap()
    };
    if let Some(next) = f.gate.frames(1, &reference).await.unwrap().reply.state {
        assert!(revision(&next) > revision(&state));
    }
    // A reference the gate never attached is unknown.
    assert!(matches!(
        f.gate.frames(1, "native-subscription:99").await,
        Err(GateError::Registry(LeaseError::InvalidInput))
    ));
}

#[tokio::test]
async fn a_new_generation_ends_the_old_subscription_at_its_next_delivery() {
    let (f, first) = with_operator().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());

    // Logged out and in again behind the gate's back (another window, or
    // an auth change outside a gate command): the next delivery finds it.
    f.auth.auth().logout().await;
    let second = login(&f.auth, "operator").await;
    assert_ne!(second.seq, first.seq);
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
    // The subscription is ended in the registry, its live slot freed, and
    // the same principal's replayed attach does not revive it.
    let again = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(again.seq, second.seq);
    assert_eq!(subscription_ref(&again), reference);
    assert!(!live(&f, &reference));
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
    // A new attach of the new generation is delivered.
    let fresh = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap());
    assert_eq!(f.gate.frames(1, &fresh).await.unwrap().seq, second.seq);
}

#[tokio::test]
async fn a_generation_change_racing_the_delivery_withholds_the_frame() {
    let f = initializing().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    preflighted(&f, "race-change").await;

    // The delivery validated the synthetic Admin; before it takes the frame
    // the auth-disabled role is lowered (a new generation).
    let auth = f.auth.clone();
    f.gate.after_next_call(async move {
        auth.auth()
            .settings()
            .set_auth_config(&AuthSettings {
                disabled: true,
                disabled_role: Role::Viewer,
                ..AuthSettings::default()
            })
            .await
            .unwrap();
        auth.auth().current().await.unwrap();
    });
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
    // The withheld delivery ended it at once, without waiting for another
    // delivery; the frame was never sent to the new generation.
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap();
    assert!(!live(&f, &reference));
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
}

#[tokio::test]
async fn an_auth_db_read_failure_holds_the_frame_for_the_next_delivery() {
    let f = operational().await;
    let current = f.auth.auth().current().await.unwrap().unwrap();
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    // An empty slot: the failure ends nothing.
    let raw = f.dir.raw().await;
    sqlx::query("ALTER TABLE users RENAME TO users_hidden")
        .execute(&raw)
        .await
        .unwrap();
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::AuthUnavailable(_))
    ));
    // Nothing was revoked or ended.
    assert!(live(&f, &reference));
    sqlx::query("ALTER TABLE users_hidden RENAME TO users")
        .execute(&raw)
        .await
        .unwrap();
    assert_eq!(f.gate.frames(1, &reference).await.unwrap().seq, current.seq);
}

#[tokio::test]
async fn a_held_frame_is_delivered_after_the_auth_db_recovers() {
    let f = initializing().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    preflighted(&f, "held-change").await;
    let raw = f.dir.raw().await;
    sqlx::query("ALTER TABLE settings RENAME TO settings_hidden")
        .execute(&raw)
        .await
        .unwrap();
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::AuthUnavailable(_))
    ));
    sqlx::query("ALTER TABLE settings_hidden RENAME TO settings")
        .execute(&raw)
        .await
        .unwrap();
    // The frame stayed in the latest-one slot and is delivered now.
    let delivered = f.gate.frames(1, &reference).await.unwrap();
    assert!(delivered.reply.state.is_some());
}

#[tokio::test]
async fn logout_revokes_and_ends_subscriptions_within_the_command() {
    let f = operational().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (_, old) = f.gate.held(LeaseRole::Reconciliation).unwrap();

    f.gate.logout().await;
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&old, &reference)),
        Err(LeaseError::Unauthorized)
    ));
    login(&f.auth, "admin").await;
    f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap();
    assert!(!live(&f, &reference));
}

#[tokio::test]
async fn a_no_op_logout_in_auth_disabled_mode_keeps_the_current_generation() {
    // A host restarted with the mode already on is at generation 0.
    let Fixture {
        gate, auth, dir, ..
    } = initializing().await;
    drop((gate, auth));
    let f = gate_in(dir).await;
    assert_eq!(f.auth.auth().seq(), 0);
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    assert_eq!(f.gate.logout().await, 0);
    assert!(f.gate.held(LeaseRole::Reconciliation).is_some());
    assert!(live(&f, &reference));
    assert_eq!(f.gate.frames(1, &reference).await.unwrap().seq, 0);
}

#[tokio::test]
async fn the_move_to_operation_waits_for_quiescence_and_revokes_the_synthetic_sessions() {
    let f = initializing().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let p = preflighted(&f, "transition-change").await;
    let (_, old) = f.gate.held(LeaseRole::Mutation).unwrap();

    // A Candidate of the synthetic principal: nothing is saved.
    assert!(matches!(
        f.gate
            .transition_to_operational("admin", PASSWORD, "管理者")
            .await,
        Err(TransitionError::Busy)
    ));
    assert_eq!(f.auth.phase().await, AuthPhase::Initializing);
    assert!(
        f.auth
            .auth()
            .settings()
            .auth_config()
            .await
            .unwrap()
            .disabled
    );
    assert!(f.gate.held(LeaseRole::Mutation).is_some());

    discard(&f, &p, "discard").await;
    let done = f
        .gate
        .transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    let admin = done.session.expect("the administrator is logged in");
    assert_eq!(f.auth.phase().await, AuthPhase::Operational);
    // The synthetic session's registry sessions and subscriptions ended
    // within the command.
    assert!(f.gate.held(LeaseRole::Mutation).is_none());
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&old, &reference)),
        Err(LeaseError::Unauthorized)
    ));
    // The administrator is another principal: the root's workflow stays the
    // synthetic principal's (design §8-1), and its subscription is ended.
    assert_eq!(f.auth.auth().seq(), admin.seq);
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-2")).await,
        Err(GateError::Registry(LeaseError::Forbidden))
    ));
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
}

#[tokio::test]
async fn an_admin_with_an_unsettled_workflow_is_neither_demoted_nor_deleted() {
    let (f, operator) = with_operator().await;
    let operator_id = operator.session.identity().id;
    let p = preflighted(&f, "demote-change").await;
    f.gate.logout().await;
    login(&f.auth, "admin").await;
    let viewer_id = f
        .auth
        .auth()
        .users()
        .list_users()
        .await
        .unwrap()
        .into_iter()
        .find(|user| user.username == "viewer")
        .unwrap()
        .id;
    settled_but_for(&f, &RecordingPrincipal::banto_user(viewer_id)).await;

    assert!(matches!(
        f.gate
            .update_user(operator_id, "運転員", Role::Viewer)
            .await,
        Err(AuthChangeError::Busy)
    ));
    assert!(matches!(
        f.gate.delete_user(operator_id).await,
        Err(AuthChangeError::Busy)
    ));
    // Neither changed the account.
    let operator_row = |users: Vec<UserSummary>| {
        users
            .into_iter()
            .find(|user| user.id == operator_id)
            .map(|user| user.role)
    };
    assert_eq!(
        operator_row(f.auth.auth().users().list_users().await.unwrap()),
        Some(Role::Admin)
    );
    // A display-name edit keeps the role and is allowed; so is a change of
    // another user, whom the workflow does not belong to.
    f.gate
        .update_user(operator_id, "運転員A", Role::Admin)
        .await
        .unwrap();
    f.gate
        .update_user(viewer_id, "閲覧者", Role::Editor)
        .await
        .unwrap();
    f.gate.delete_user(viewer_id).await.unwrap();

    // The owner discards; then the demotion goes through.
    f.gate.logout().await;
    login(&f.auth, "operator").await;
    discard(&f, &p, "discard").await;
    f.gate.logout().await;
    login(&f.auth, "admin").await;
    f.gate
        .update_user(operator_id, "運転員", Role::Viewer)
        .await
        .unwrap();
    assert_eq!(
        operator_row(f.auth.auth().users().list_users().await.unwrap()),
        Some(Role::Viewer)
    );
}

#[tokio::test]
async fn demoting_yourself_revokes_your_sessions_within_the_command() {
    let (f, operator) = with_operator().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (_, read) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    f.gate
        .update_user(operator.session.identity().id, "運転員", Role::Viewer)
        .await
        .unwrap();
    // The role change bumped the epoch: the session and its registry
    // sessions ended before the command returned.
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&read, &reference)),
        Err(LeaseError::Unauthorized)
    ));
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
}

#[tokio::test]
async fn a_password_reset_ends_the_sessions_but_not_the_owners_workflow() {
    let (f, operator) = with_operator().await;
    let operator_id = operator.session.identity().id;
    let p = preflighted(&f, "reset-change").await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (_, mutation) = f.gate.held(LeaseRole::Mutation).unwrap();

    // Not `Busy` under the unsettled workflow: the principal stays the same.
    f.gate
        .reset_password(operator_id, "reset-horse-3")
        .await
        .unwrap();
    // The reset ended the operator's own session, its registry sessions and
    // subscription within the command.
    assert!(f.gate.held(LeaseRole::Mutation).is_none());
    assert!(matches!(
        f.gate.with_root(|root| root.revoke_session(&mutation)),
        Ok(())
    ));
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
    assert!(f.auth.auth().current().await.unwrap().is_none());

    // With the new password the same principal reaches its workflow again.
    match f
        .auth
        .auth()
        .login("operator", "reset-horse-3")
        .await
        .unwrap()
    {
        LoginOutcome::LoggedIn(_) => {}
        other => panic!("login failed: {other:?}"),
    }
    discard(&f, &p, "discard").await;
}

#[tokio::test]
async fn a_refused_reset_revokes_nothing() {
    let f = operational().await;
    f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    let before = f.auth.auth().seq();
    // Banto refuses an unknown account.
    assert!(matches!(
        f.gate.reset_password(9999, "reset-horse-3").await,
        Err(AuthChangeError::Auth(_))
    ));
    assert_eq!(f.auth.auth().seq(), before);
    assert!(f.gate.held(LeaseRole::Reconciliation).is_some());
    // Below Admin, refused before anything is touched.
    f.gate.logout().await;
    login(&f.auth, "viewer").await;
    assert!(matches!(
        f.gate.reset_password(1, "reset-horse-3").await,
        Err(AuthChangeError::Forbidden)
    ));
}

#[tokio::test]
async fn while_the_mode_is_on_a_lowered_local_role_raises_itself() {
    let f = initializing().await;
    f.gate.set_auth_config(true, Role::Viewer).await.unwrap();
    // Neither the move (it needs the synthetic Admin) nor any other Admin
    // command is open to the lowered session; the settings stay open.
    assert!(matches!(
        f.gate.delete_user(1).await,
        Err(AuthChangeError::Forbidden)
    ));
    let saved = f.gate.set_auth_config(true, Role::Admin).await.unwrap();
    assert_eq!(saved.disabled_role, Role::Admin);
    assert_eq!(
        f.auth
            .auth()
            .current()
            .await
            .unwrap()
            .unwrap()
            .session
            .role(),
        Role::Admin
    );
}

#[tokio::test]
async fn only_an_admin_changes_users_and_settings() {
    let f = operational().await;
    f.gate.logout().await;
    assert!(matches!(
        f.gate.delete_user(1).await,
        Err(AuthChangeError::Unauthorized)
    ));
    login(&f.auth, "viewer").await;
    assert!(matches!(
        f.gate.update_user(1, "x", Role::Viewer).await,
        Err(AuthChangeError::Forbidden)
    ));
    assert!(matches!(
        f.gate.set_auth_config(false, Role::Admin).await,
        Err(AuthChangeError::Forbidden)
    ));
}

#[tokio::test]
async fn the_auth_disabled_role_is_not_lowered_under_an_unsettled_workflow() {
    let f = initializing().await;
    let saved = f.auth.auth().settings().auth_config().await.unwrap();
    // The mode is switched only by the move to operation.
    assert!(matches!(
        f.gate.set_auth_config(false, Role::Admin).await,
        Err(AuthChangeError::NotAllowed)
    ));

    let p = preflighted(&f, "disabled-role-change").await;
    assert!(matches!(
        f.gate.set_auth_config(true, Role::Viewer).await,
        Err(AuthChangeError::Busy)
    ));
    assert_eq!(f.auth.auth().settings().auth_config().await.unwrap(), saved);
    discard(&f, &p, "discard").await;
    let (_, mutation) = f.gate.held(LeaseRole::Mutation).unwrap();
    let before = f.auth.auth().seq();
    f.gate.set_auth_config(true, Role::Viewer).await.unwrap();
    // A new generation with the lowered role; the old sessions ended.
    assert_ne!(f.auth.auth().seq(), before);
    assert!(f.gate.held(LeaseRole::Mutation).is_none());
    assert!(matches!(
        f.gate.with_root(|root| root.revoke_session(&mutation)),
        Ok(())
    ));
    assert!(matches!(
        f.gate
            .cancel(cancel(&f.scope, "cancel-1", "operation"))
            .await,
        Err(GateError::Forbidden)
    ));
}

#[tokio::test]
async fn auth_changes_are_audited_by_the_acting_admin() {
    let (f, operator) = with_operator().await;
    let id = operator.session.identity().id;
    f.gate.logout().await;
    login(&f.auth, "admin").await;
    f.gate
        .update_user(id, "運転員", Role::Editor)
        .await
        .unwrap();
    f.gate.delete_user(id).await.unwrap();
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT action, resource, COALESCE(entity_id, ''), actor_username FROM audit_log \
         WHERE resource = 'users' ORDER BY id",
    )
    .fetch_all(&f.dir.raw().await)
    .await
    .unwrap();
    let id = id.to_string();
    assert_eq!(
        rows,
        vec![
            ("update".into(), "users".into(), id.clone(), "admin".into()),
            ("delete".into(), "users".into(), id, "admin".into()),
        ]
    );
}

#[tokio::test]
async fn a_stale_validation_never_uses_or_ends_a_newer_generation() {
    let f = operational().await;
    let stale = f.auth.auth().current().await.unwrap().unwrap();
    f.gate.logout().await;
    let newer = login(&f.auth, "admin").await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    // A call that validated the older generation reaches the state late.
    assert!(matches!(
        f.gate
            .lock()
            .installed
            .as_mut()
            .unwrap()
            .session_for(&stale, LeaseRole::Reconciliation),
        Err(LeaseError::Unauthorized)
    ));
    let (held_seq, _) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    assert_eq!(held_seq, newer.seq);
    assert!(live(&f, &reference));
    assert_eq!(f.gate.frames(1, &reference).await.unwrap().seq, newer.seq);
}

#[tokio::test]
async fn an_auth_change_whose_refresh_fails_still_revokes_the_held_sessions() {
    let (f, _) = with_operator().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (_, read) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    // The change was saved; the auth DB then fails before the refresh.
    let raw = f.dir.raw().await;
    sqlx::query("ALTER TABLE users RENAME TO users_hidden")
        .execute(&raw)
        .await
        .unwrap();
    f.gate.refresh_after_change().await;
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&read, &reference)),
        Err(LeaseError::Unauthorized)
    ));
    // Nothing was ended for good: once the DB is back and nothing changed,
    // the same generation is re-issued and its subscription delivers.
    sqlx::query("ALTER TABLE users_hidden RENAME TO users")
        .execute(&raw)
        .await
        .unwrap();
    let current = f.auth.auth().current().await.unwrap().unwrap();
    assert_eq!(f.gate.frames(1, &reference).await.unwrap().seq, current.seq);

    // Revoked once more, then a new generation logs in behind the gate's
    // back: its first command ends the old subscription although no
    // session of the old generation is held any longer.
    sqlx::query("ALTER TABLE users RENAME TO users_hidden")
        .execute(&raw)
        .await
        .unwrap();
    f.gate.refresh_after_change().await;
    sqlx::query("ALTER TABLE users_hidden RENAME TO users")
        .execute(&raw)
        .await
        .unwrap();
    f.auth.auth().logout().await;
    login(&f.auth, "operator").await;
    f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap();
    assert!(!live(&f, &reference));
}

#[tokio::test]
async fn logout_waits_for_a_command_that_already_validated_the_session() {
    let f = operational().await;
    let current = f.auth.auth().current().await.unwrap().unwrap();
    // The logout is started only once the command has validated the session
    // and run its registry call (the hook runs while it holds the lock).
    let started = Arc::new(Mutex::new(None));
    let (slot, gate, auth) = (started.clone(), f.gate.clone(), f.auth.clone());
    f.gate.after_next_call(async move {
        let mut logout = tokio::spawn(async move { gate.logout().await });
        // The logout cannot get past the lock this command holds.
        let raced = tokio::time::timeout(Duration::from_millis(200), &mut logout).await;
        assert!(raced.is_err(), "logout ran inside the command");
        assert_eq!(auth.auth().seq(), current.seq);
        *slot.lock().unwrap() = Some(logout);
    });
    let attached = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(attached.seq, current.seq);
    let logout = started.lock().unwrap().take().expect("the hook ran");
    assert_ne!(logout.await.unwrap(), current.seq);
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
}

#[tokio::test]
async fn the_move_to_operation_ends_the_synthetic_subscriptions_even_if_the_refresh_fails() {
    let f = initializing().await;
    // The synthetic session fills every live subscription slot.
    let mut references = Vec::new();
    for index in 0..4 {
        let attached = f
            .gate
            .attach(attach(&f.scope, &format!("attach-{index}")))
            .await
            .unwrap();
        references.push(subscription_ref(&attached));
    }
    assert!(matches!(
        f.gate.attach(attach(&f.scope, "attach-full")).await,
        Err(GateError::Registry(LeaseError::Capacity))
    ));
    // The auth DB fails after the transition, before its refresh.
    let raw = f.dir.raw().await;
    let hide = raw.clone();
    f.gate.after_next_call(async move {
        sqlx::query("ALTER TABLE settings RENAME TO settings_hidden")
            .execute(&hide)
            .await
            .unwrap();
    });
    let admin = f
        .gate
        .transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap()
        .session
        .expect("the administrator is logged in");
    sqlx::query("ALTER TABLE settings_hidden RENAME TO settings")
        .execute(&raw)
        .await
        .unwrap();
    // The synthetic generation's subscriptions ended within the command,
    // before any later command or delivery could settle them.
    assert!(f
        .gate
        .lock()
        .installed
        .as_ref()
        .unwrap()
        .subscriptions
        .values()
        .all(|b| b.ended));
    // So the administrator's attach finds free slots.
    let attached = f
        .gate
        .attach(attach(&f.scope, "attach-admin"))
        .await
        .unwrap();
    assert_eq!(attached.seq, admin.seq);
    for reference in &references {
        assert!(matches!(
            f.gate.frames(1, reference).await,
            Err(GateError::Unauthorized)
        ));
    }
}

#[tokio::test]
async fn a_user_switch_revokes_and_ends_the_previous_user_within_the_login() {
    let f = operational().await;
    f.auth
        .auth()
        .users()
        .create_user("operator", PASSWORD, "運転員", Role::Admin)
        .await
        .unwrap();
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (_, old) = f.gate.held(LeaseRole::Reconciliation).unwrap();

    // No logout in between: the login itself switches the user.
    let LoginOutcome::LoggedIn(operator) = f.gate.login("operator", PASSWORD).await.unwrap() else {
        panic!("login failed");
    };
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&old, &reference)),
        Err(LeaseError::Unauthorized)
    ));
    assert!(matches!(
        f.gate.frames(1, &reference).await,
        Err(GateError::Unauthorized)
    ));
    let attached = f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap();
    assert_eq!(attached.seq, operator.seq);
    assert!(!live(&f, &reference));

    // A refused login writes nothing and revokes nothing.
    assert_eq!(
        f.gate.login("operator", "wrong-password-0").await.unwrap(),
        LoginOutcome::InvalidCredentials
    );
    assert_eq!(
        f.gate.held(LeaseRole::Reconciliation).unwrap().0,
        operator.seq
    );
}

#[tokio::test]
async fn the_own_password_change_revokes_the_old_generation_within_the_command() {
    let f = operational().await;
    let before = f.auth.auth().current().await.unwrap().unwrap();
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (_, old) = f.gate.held(LeaseRole::Reconciliation).unwrap();

    // A wrong current password changes and revokes nothing.
    assert!(matches!(
        f.gate
            .change_own_password("wrong-password-0", "another-horse-2")
            .await,
        Err(BantoError::Validation { .. })
    ));
    assert_eq!(
        f.gate.held(LeaseRole::Reconciliation).unwrap().0,
        before.seq
    );

    let seq = f
        .gate
        .change_own_password(PASSWORD, "another-horse-2")
        .await
        .unwrap();
    assert_eq!(seq, before.seq + 1);
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&old, &reference)),
        Err(LeaseError::Unauthorized)
    ));
    // The same principal is served again under the new generation.
    let attached = f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap();
    assert_eq!(attached.seq, seq);
}

#[tokio::test]
async fn a_password_change_ends_the_old_subscriptions_even_if_the_refresh_fails() {
    let f = operational().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    // The auth DB fails after the change, before its refresh.
    let raw = f.dir.raw().await;
    let hide = raw.clone();
    f.gate.after_next_call(async move {
        sqlx::query("ALTER TABLE settings RENAME TO settings_hidden")
            .execute(&hide)
            .await
            .unwrap();
    });
    let seq = f
        .gate
        .change_own_password(PASSWORD, "another-horse-2")
        .await
        .unwrap();
    sqlx::query("ALTER TABLE settings_hidden RENAME TO settings")
        .execute(&raw)
        .await
        .unwrap();
    let attached = f.gate.attach(attach(&f.scope, "attach-2")).await.unwrap();
    assert_eq!(attached.seq, seq);
    assert!(!live(&f, &reference));
}

#[tokio::test]
async fn a_resolve_that_ends_the_session_ends_its_subscriptions_within_the_command() {
    let f = operational().await;
    let admin = f.auth.auth().current().await.unwrap().unwrap();
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (_, old) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    f.auth
        .auth()
        .users()
        .reset_password(admin.session.identity().id, "another-horse-2")
        .await
        .unwrap();

    let desktop = crate::desktop_auth::DesktopAuth::with_gate(f.gate.clone());
    let resolved = desktop.resolve().await.unwrap();
    assert_eq!(resolved.identity, None);
    assert_eq!(resolved.current, admin.seq + 1);
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&old, &reference)),
        Err(LeaseError::Unauthorized)
    ));
}

#[tokio::test]
async fn a_password_change_and_a_resolve_wait_for_a_command_that_already_validated() {
    let f = operational().await;
    let current = f.auth.auth().current().await.unwrap().unwrap();
    let started = Arc::new(Mutex::new(None));
    let (slot, gate, auth) = (started.clone(), f.gate.clone(), f.auth.clone());
    f.gate.after_next_call(async move {
        let change = {
            let gate = gate.clone();
            tokio::spawn(async move {
                gate.change_own_password(PASSWORD, "another-horse-2")
                    .await
                    .unwrap()
            })
        };
        let resolve = tokio::spawn(async move { gate.resolve().await.unwrap() });
        // Neither can get past the lock this command holds.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!change.is_finished(), "the change ran inside the command");
        assert!(!resolve.is_finished(), "the resolve ran inside the command");
        assert_eq!(auth.auth().seq(), current.seq);
        *slot.lock().unwrap() = Some((change, resolve));
    });
    let attached = f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap();
    assert_eq!(attached.seq, current.seq);
    let (change, resolve) = started.lock().unwrap().take().expect("the hook ran");
    assert_eq!(change.await.unwrap(), current.seq + 1);
    resolve.await.unwrap();
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
}

#[tokio::test]
async fn a_refused_password_change_still_ends_a_generation_its_check_moved_past() {
    let f = initializing().await;
    let reference = subscription_ref(&f.gate.attach(attach(&f.scope, "attach-1")).await.unwrap());
    let (seq, old) = f.gate.held(LeaseRole::Reconciliation).unwrap();
    // The auth-disabled role lowered outside the host: the change's own
    // check follows it (a new generation), then refuses the synthetic
    // session, which owns no password.
    f.auth
        .auth()
        .settings()
        .set_auth_config(&AuthSettings {
            disabled: true,
            disabled_role: Role::Viewer,
            autologin_enabled: false,
            autologin_username: None,
        })
        .await
        .unwrap();
    assert!(matches!(
        f.gate
            .change_own_password(PASSWORD, "another-horse-2")
            .await,
        Err(BantoError::Forbidden)
    ));
    assert!(f.auth.auth().seq() > seq);
    assert!(f.gate.held(LeaseRole::Reconciliation).is_none());
    assert!(matches!(
        f.gate
            .with_root(|root| root.take_state_frame(&old, &reference)),
        Err(LeaseError::Unauthorized)
    ));
}
