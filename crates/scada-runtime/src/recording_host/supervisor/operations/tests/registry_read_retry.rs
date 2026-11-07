//! Native registry read retries over the saved original apply (adapter design §7 acceptance 5).
use super::registry_observation::{observe_terminal, outcome, read_observation};
use super::*;
use crate::recording_registry::{
    RecordingRegistryApplyTicket, RecordingRegistryReconciliationTicket,
};

/// Issues a fresh read lease and builds a reconcile admission bound to it.
pub(super) fn read_admission(
    root: &mut RecordingRegistryRoot,
    read: &RecordingRegistrySession,
    scope: &Value,
    apply: &RecordingAdmissionRequest,
    accepted: &RecordingAdmissionReply,
    suffix: &str,
    reconciliation_id: &str,
) -> RecordingAdmissionRequest {
    let admission_id = format!("read-admission:{suffix}");
    let lease = root
        .issue_lease(
            read,
            registry_lease(
                scope,
                &format!("read-lease:{suffix}"),
                &admission_id,
                "reconciliation",
                1000,
            ),
        )
        .unwrap();
    let handle = &accepted.as_value()["outcome"]["handle"];
    let mut value = registry_reconciliation_admission(
        scope,
        apply,
        &admission_id,
        &lease,
        handle["changeRef"].as_str().unwrap(),
        handle["operationRef"].as_str().unwrap(),
    )
    .as_value()
    .clone();
    value["action"]["reconciliation"]["reconciliationId"] = json!(reconciliation_id);
    RecordingAdmissionRequest::from_value(value).unwrap()
}

pub(super) fn registered(
    registration: ReconciliationRegistration,
) -> RecordingRegistryReconciliationTicket {
    match registration {
        ReconciliationRegistration::Registered(ticket) => ticket,
        ReconciliationRegistration::Existing(_) => panic!("new reconciliation"),
    }
}

/// Dispatches an apply under the given native fault and waits for its completion.
pub(super) async fn failed_apply(
    epoch: &str,
    fault: driver::TestFault,
) -> (
    RecordingRegistryRoot,
    RecordingRegistryWorkflowTicket,
    RecordingRegistryApplyTicket,
    RecordingAdmissionRequest,
    RecordingAdmissionReply,
    crate::recording_host::retention::tests::Directory,
) {
    let (mut root, mutation, workflow, pause, apply, dir) = ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, apply.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    *client.shared.fault.lock().unwrap() = Some(fault);
    let accepted = root.dispatch_apply(&mutation, &ticket).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root.apply_completion(&mutation, &ticket).unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    (root, workflow, ticket, apply, accepted, dir)
}

#[tokio::test]
async fn registry_read_retry_needs_a_new_lease_and_a_settled_predecessor() {
    let epoch = "epoch-read-retry";
    let scope = registry_scope(epoch);
    let (mut root, workflow, apply_ticket, apply, accepted, _dir) =
        failed_apply(epoch, driver::TestFault::LostResponse).await;
    let client = root.test_native_client();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let original_completion = root
        .apply_completion(&mutation, &apply_ticket)
        .unwrap()
        .unwrap();

    // The first read is held inside the native loan.
    let first_admission = read_admission(
        &mut root,
        &read,
        &scope,
        &apply,
        &accepted,
        "1",
        "read:first",
    );
    let first_request = first_admission.as_value()["action"]["reconciliation"].clone();
    let first = registered(
        root.register_reconciliation(&read, &workflow, &apply_ticket, first_admission.clone())
            .unwrap(),
    );
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.read_fault.lock().unwrap() =
        Some(reconciliation::driver::TestFault::Gate(gate.clone()));
    let first_reply = root.dispatch_reconciliation(&read, &first).unwrap();
    assert_eq!(first_reply.as_value()["outcome"]["kind"], "accepted");
    gate.entered.notified().await;

    // A retry never runs beside an unfinished read, and the refusal consumes nothing.
    let second_admission = read_admission(
        &mut root,
        &read,
        &scope,
        &apply,
        &accepted,
        "2",
        "read:second",
    );
    let bytes = root.test_used_bytes(LeaseRole::Reconciliation);
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, second_admission.clone()),
        Err(LeaseError::Busy)
    ));
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), bytes);
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    gate.release.notify_one();
    let first_ref = first_reply.as_value()["outcome"]["handle"]["readRef"].clone();
    let first_observation = read_observation(&scope, "observe:first", &first_ref, &first_request);
    let first_delivery = observe_terminal(&mut root, &read, first_observation.clone()).await;
    let result = &outcome(&first_delivery)["delivery"]["outcome"]["result"];
    assert_eq!(result["outcome"]["kind"], "receiptFound");
    assert_eq!(result["recoveryRequired"], true);

    // The same lease now admits the retry; its read gets a new ref and handle.
    let second = registered(
        root.register_reconciliation(&read, &workflow, &apply_ticket, second_admission.clone())
            .unwrap(),
    );
    assert_ne!(second.sequence(), first.sequence());
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, second_admission)
            .unwrap(),
        ReconciliationRegistration::Existing(ticket) if ticket.sequence() == second.sequence()
    ));
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, first_admission.clone())
            .unwrap(),
        ReconciliationRegistration::Existing(ticket) if ticket.sequence() == first.sequence()
    ));
    let mut changed = first_admission.as_value().clone();
    changed["action"]["reconciliation"]["reconciliationId"] = json!("read:changed");
    assert!(matches!(
        root.register_reconciliation(
            &read,
            &workflow,
            &apply_ticket,
            RecordingAdmissionRequest::from_value(changed).unwrap()
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    let second_reply = root.dispatch_reconciliation(&read, &second).unwrap();
    assert_eq!(second_reply.as_value()["outcome"]["kind"], "accepted");
    let second_ref = second_reply.as_value()["outcome"]["handle"]["readRef"].clone();
    assert_ne!(second_ref, first_ref);
    let second_request = second_reply.as_value()["outcome"]["handle"]["request"].clone();
    let second_delivery = observe_terminal(
        &mut root,
        &read,
        read_observation(&scope, "observe:second", &second_ref, &second_request),
    )
    .await;
    let result = &outcome(&second_delivery)["delivery"]["outcome"]["result"];
    assert_eq!(result["outcome"]["kind"], "receiptFound");
    assert_eq!(result["recoveryRequired"], true);
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 2);

    // A spent reconciliation ID is the native owner's refusal, and a rejected read is settled.
    let admission = read_admission(
        &mut root,
        &read,
        &scope,
        &apply,
        &accepted,
        "3",
        "read:first",
    );
    let reused = registered(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission)
            .unwrap(),
    );
    let rejected = root.dispatch_reconciliation(&read, &reused).unwrap();
    assert_eq!(
        rejected.as_value()["outcome"],
        json!({"kind":"rejected","error":"consumed"})
    );
    assert_eq!(root.reconciliation_delivery(&read, &reused).unwrap(), None);
    let admission = read_admission(
        &mut root,
        &read,
        &scope,
        &apply,
        &accepted,
        "4",
        "read:fourth",
    );
    let fourth = registered(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission)
            .unwrap(),
    );
    assert_eq!(
        root.dispatch_reconciliation(&read, &fourth)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "accepted"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .reconciliation_delivery(&read, &fourth)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 4);

    // Earlier replies, deliveries and the original apply stay as first saved; recovery stays.
    assert_eq!(
        root.reconciliation_reply(&read, &first).unwrap(),
        Some(first_reply)
    );
    assert_eq!(
        root.observe_result(&read, first_observation).unwrap(),
        first_delivery
    );
    assert_eq!(
        root.apply_reply(&mutation, &apply_ticket).unwrap(),
        Some(accepted)
    );
    assert_eq!(
        root.apply_completion(&mutation, &apply_ticket)
            .unwrap()
            .unwrap(),
        original_completion
    );
    assert!(client.state().recovery_required);
}

#[tokio::test]
async fn registry_read_retry_stops_after_read_uncertain() {
    let epoch = "epoch-read-uncertain";
    let scope = registry_scope(epoch);
    let (mut root, workflow, apply_ticket, apply, accepted, _dir) =
        failed_apply(epoch, driver::TestFault::Full).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let admission = read_admission(
        &mut root,
        &read,
        &scope,
        &apply,
        &accepted,
        "1",
        "read:first",
    );
    let first = registered(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission)
            .unwrap(),
    );
    *client.shared.read_fault.lock().unwrap() =
        Some(reconciliation::driver::TestFault::DriverPanic);
    let reply = root.dispatch_reconciliation(&read, &first).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "accepted");
    let delivery = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = root.reconciliation_delivery(&read, &first).unwrap() {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(delivery.as_value()["outcome"]["kind"], "readUncertain");

    // Lost read cleanup is not an absent receipt: no retry, and the lease stays unconsumed.
    let retry = read_admission(
        &mut root,
        &read,
        &scope,
        &apply,
        &accepted,
        "2",
        "read:second",
    );
    let bytes = root.test_used_bytes(LeaseRole::Reconciliation);
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, retry.clone()),
        Err(LeaseError::Busy)
    ));
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, retry),
        Err(LeaseError::Busy)
    ));
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), bytes);
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
    assert!(client.state().recovery_required);
}
