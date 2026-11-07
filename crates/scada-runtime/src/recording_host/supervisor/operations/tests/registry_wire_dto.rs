//! Native registry wire DTOs as a shared fixture for the TS validators (adapter design §7
//! acceptance 6). The scenario runs one workflow on the real owner with a temporary SQLite
//! store and records every DTO the registry returns. The committed JSON must match exactly;
//! regenerate it with `SCADA_BLESS_WIRE_FIXTURES=1 cargo test -p scada-runtime registry_wire_dto`.
use super::registry_observation::{
    handle_request, observe_terminal, operation_observation, outcome, read_observation,
};
use super::*;
use scada_model::recording_wire::{
    RecordingWireAttachRequest, RecordingWireCancelRequest, RecordingWireControlRequest,
};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/recording-registry-native-wire-cases.json"
);

/// The largest grant, so a slow CI machine never turns the gated pause into notDispatched.
const BUDGET_MS: u64 = 10_000;
/// The store generates its recording plan ID per database; the fixture pins one value.
const PLAN_ID: &str = "recording:00000000-0000-4000-8000-000000000000";

fn is_store_plan_id(text: &str) -> bool {
    text.strip_prefix("recording:").is_some_and(|rest| {
        rest.len() == 36
            && rest.chars().enumerate().all(|(i, ch)| {
                matches!(i, 8 | 13 | 18 | 23) == (ch == '-')
                    && (ch == '-' || ch.is_ascii_hexdigit())
            })
    })
}

fn pin_plan_ids(value: &mut Value, seen: &mut Option<String>) {
    match value {
        Value::String(text) if is_store_plan_id(text) => {
            assert_eq!(
                seen.get_or_insert_with(|| text.clone()),
                text,
                "one store plan ID"
            );
            *text = PLAN_ID.to_owned();
        }
        Value::Array(items) => items.iter_mut().for_each(|v| pin_plan_ids(v, seen)),
        Value::Object(map) => map.values_mut().for_each(|v| pin_plan_ids(v, seen)),
        _ => {}
    }
}

#[derive(Default)]
struct Capture(Vec<Value>);

impl Capture {
    /// `request` names the request the reply must echo (TS checks the pairing).
    fn push(&mut self, name: &str, value: &Value, request: Option<&Value>) {
        assert!(
            self.0.iter().all(|c| c["name"] != name),
            "duplicate case {name}"
        );
        let mut case = json!({"name":name, "value":value});
        if let Some(request) = request {
            case["request"] = request.clone();
        }
        self.0.push(case);
    }
}

fn cancel(scope: &Value, id: &str, kind: &str, reference: &Value) -> RecordingWireCancelRequest {
    RecordingWireCancelRequest::from_value(json!({
        "version":1, "kind":"recordingWireCancelRequest", "scope":scope,
        "cancelId":id, "target":{"kind":kind, "ref":reference}
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

fn control(scope: &Value, id: &str, reference: &str, action: &str) -> RecordingWireControlRequest {
    RecordingWireControlRequest::from_value(json!({
        "version":1, "kind":"recordingWireControlRequest", "scope":scope,
        "controlId":id, "subscriptionRef":reference, "action":action
    }))
    .unwrap()
}

async fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = probe() {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn registry_wire_dto_fixture_matches_the_native_scenario() {
    let epoch = "epoch-wire-dto";
    let scope = registry_scope(epoch);
    let mut c = Capture::default();
    let (mut root, mutation, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, BUDGET_MS).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);

    // Preflight: original reply, inspection and terminal observation.
    let preflight_reply = root
        .preflight_reply(&mutation, &preflight)
        .unwrap()
        .unwrap();
    let preflight_request = preflight_reply.as_value()["request"].clone();
    c.push(
        "preflight.admissionReply.accepted",
        preflight_reply.as_value(),
        Some(&preflight_request),
    );
    let inspection = registry_inspection(
        &RecordingAdmissionRequest::from_value(preflight_request.clone()).unwrap(),
        "inspect:preflight",
    );
    let inspected = root
        .inspect_preflight_admission(&read, &workflow, inspection.clone())
        .unwrap();
    c.push(
        "preflight.admissionInspectionReply.accepted",
        inspected.as_value(),
        Some(inspection.as_value()),
    );
    let preflight_operation = handle_request(&preflight_reply);
    let first = operation_observation(&scope, "observe:preflight", &preflight_operation);
    let candidate = root.observe_result(&read, first.clone()).unwrap();
    assert_eq!(
        outcome(&candidate)["result"]["outcome"]["kind"],
        "candidate"
    );
    c.push(
        "preflight.observationReply.candidate",
        candidate.as_value(),
        Some(first.as_value()),
    );

    // Subscription fixed at the Candidate snapshot.
    let attach_request = attach(&scope, "attach:wire");
    let attached = root.attach(&read, attach_request.clone()).unwrap();
    let reference = attached.as_value()["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned();
    c.push(
        "subscription.attachReply.attached",
        attached.as_value(),
        Some(attach_request.as_value()),
    );

    // Pause/join gated: pending observation, notSupported cancel, pending state frame.
    let pause = match root
        .register_pause_join(&mutation, &workflow, &preflight, pause_admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let pause_reply = root.dispatch_pause_join(&mutation, &pause).unwrap();
    c.push(
        "pause.admissionReply.accepted",
        pause_reply.as_value(),
        Some(&pause_reply.as_value()["request"]),
    );
    gate.entered.notified().await;
    let pause_operation = handle_request(&pause_reply);
    let pause_observation = operation_observation(&scope, "observe:pause", &pause_operation);
    let pending = root
        .observe_result(&read, pause_observation.clone())
        .unwrap();
    assert_eq!(outcome(&pending)["kind"], "pending");
    c.push(
        "pause.observationReply.pending",
        pending.as_value(),
        Some(pause_observation.as_value()),
    );
    let not_supported_request = cancel(
        &scope,
        "cancel:pause",
        "operation",
        &pause_operation["operationId"],
    );
    let not_supported = root
        .request_cancel(&mutation, not_supported_request.clone())
        .unwrap();
    c.push(
        "pause.cancelReply.notSupported",
        not_supported.as_value(),
        Some(not_supported_request.as_value()),
    );
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    assert!(frame.as_value()["snapshot"]["operation"].is_null());
    c.push(
        "subscription.stateFrame.pausePending",
        frame.as_value(),
        None,
    );
    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    let paused = observe_terminal(&mut root, &read, pause_observation.clone()).await;
    assert_eq!(
        outcome(&paused)["result"]["outcome"]["kind"],
        "paused",
        "{paused:?}"
    );
    c.push(
        "pause.observationReply.paused",
        paused.as_value(),
        Some(pause_observation.as_value()),
    );
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    c.push("subscription.stateFrame.paused", frame.as_value(), None);
    let control_request = control(&scope, "control:snapshot", &reference, "snapshot");
    let latest = root.control(&read, control_request.clone()).unwrap();
    c.push(
        "subscription.controlReply.snapshot",
        latest.as_value(),
        Some(control_request.as_value()),
    );

    // Apply whose response is lost after commit: accepted reply, failed completion.
    let change_ref = pause_reply.as_value()["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap()
        .to_owned();
    let apply_lease_request = registry_lease(
        &scope,
        "apply-lease",
        "apply-admission",
        "mutation",
        BUDGET_MS,
    );
    let apply_lease = root
        .issue_apply_lease(
            &mutation,
            &workflow,
            &pause,
            "apply:wire",
            apply_lease_request.clone(),
        )
        .unwrap();
    c.push(
        "apply.leaseReply.granted",
        apply_lease.as_value(),
        Some(apply_lease_request.as_value()),
    );
    let apply_admission = registry_apply_admission(
        &scope,
        &change("pause-ready"),
        "apply-admission",
        &apply_lease,
        &change_ref,
        "apply:wire",
    );
    let apply_operation = apply_admission.as_value()["action"]["operation"].clone();
    let early = operation_observation(&scope, "observe:apply-early", &apply_operation);
    let unavailable = root.observe_result(&read, early.clone()).unwrap();
    c.push(
        "apply.observationReply.unavailable",
        unavailable.as_value(),
        Some(early.as_value()),
    );
    let unknown_cancel = cancel(
        &scope,
        "cancel:apply-early",
        "operation",
        &json!("apply:wire"),
    );
    let rejected = root
        .request_cancel(&mutation, unknown_cancel.clone())
        .unwrap();
    c.push(
        "apply.cancelReply.ownerUnavailable",
        rejected.as_value(),
        Some(unknown_cancel.as_value()),
    );
    let apply = match root
        .register_apply(&mutation, &workflow, &pause, apply_admission.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::LostResponse);
    let before = sqlite_applied_revision(&dir.0);
    let apply_reply = root.dispatch_apply(&mutation, &apply).unwrap();
    c.push(
        "apply.admissionReply.accepted",
        apply_reply.as_value(),
        Some(apply_admission.as_value()),
    );
    until(|| root.apply_completion(&mutation, &apply).unwrap()).await;
    *client.shared.fault.lock().unwrap() = None;
    let apply_observation = operation_observation(&scope, "observe:apply", &apply_operation);
    let failed = root
        .observe_result(&read, apply_observation.clone())
        .unwrap();
    assert_eq!(outcome(&failed)["result"]["outcome"]["kind"], "failed");
    c.push(
        "apply.observationReply.failed",
        failed.as_value(),
        Some(apply_observation.as_value()),
    );
    let completed_request = cancel(&scope, "cancel:apply", "operation", &json!("apply:wire"));
    let completed = root
        .request_cancel(&mutation, completed_request.clone())
        .unwrap();
    c.push(
        "apply.cancelReply.alreadyCompleted",
        completed.as_value(),
        Some(completed_request.as_value()),
    );
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    c.push(
        "subscription.stateFrame.applyFailed",
        frame.as_value(),
        None,
    );

    // Reconciliation of the original apply: lease, accepted reply, delivery, observation.
    let read_lease_request = registry_lease(
        &scope,
        "read-lease",
        "read-admission",
        "reconciliation",
        BUDGET_MS,
    );
    let read_lease = root.issue_lease(&read, read_lease_request.clone()).unwrap();
    c.push(
        "read.leaseReply.granted",
        read_lease.as_value(),
        Some(read_lease_request.as_value()),
    );
    let read_admission = registry_reconciliation_admission(
        &scope,
        &apply_admission,
        "read-admission",
        &read_lease,
        apply_reply.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
        apply_reply.as_value()["outcome"]["handle"]["operationRef"]
            .as_str()
            .unwrap(),
    );
    let read_ticket = match root
        .register_reconciliation(&read, &workflow, &apply, read_admission.clone())
        .unwrap()
    {
        ReconciliationRegistration::Registered(ticket) => ticket,
        _ => panic!("new reconciliation"),
    };
    let read_reply = root.dispatch_reconciliation(&read, &read_ticket).unwrap();
    c.push(
        "read.admissionReply.accepted",
        read_reply.as_value(),
        Some(read_admission.as_value()),
    );
    let delivery = until(|| root.reconciliation_delivery(&read, &read_ticket).unwrap()).await;
    assert_eq!(
        delivery.as_value()["outcome"]["result"]["outcome"]["kind"],
        "receiptFound"
    );
    c.push(
        "read.reconciliationDelivery.receiptFound",
        delivery.as_value(),
        None,
    );
    let read_ref = read_reply.as_value()["outcome"]["handle"]["readRef"].clone();
    let read_observation_request = read_observation(
        &scope,
        "observe:read",
        &read_ref,
        &read_admission.as_value()["action"]["reconciliation"],
    );
    let read_result = root
        .observe_result(&read, read_observation_request.clone())
        .unwrap();
    assert_eq!(outcome(&read_result)["kind"], "reconciliation");
    c.push(
        "read.observationReply.delivery",
        read_result.as_value(),
        Some(read_observation_request.as_value()),
    );
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    c.push("subscription.stateFrame.read", frame.as_value(), None);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before + 1);

    // Handoff closes the root: closed state frame and ownerClosed control frame.
    let handoff = root.try_handoff().unwrap();
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    assert_eq!(frame.as_value()["snapshot"]["closed"], true);
    c.push("subscription.stateFrame.closed", frame.as_value(), None);
    let closed = root.take_control_frame(&read, &reference).unwrap().unwrap();
    c.push(
        "subscription.controlFrame.ownerClosed",
        closed.as_value(),
        None,
    );
    let detach_request = control(&scope, "control:detach", &reference, "detach");
    let detached = root.control(&read, detach_request.clone()).unwrap();
    c.push(
        "subscription.controlReply.detached",
        detached.as_value(),
        Some(detach_request.as_value()),
    );
    // Close keeps read-only lookups (adapter acceptance 6): the same AdmissionInspection ID
    // returns its original reply, and new inspection and observation IDs first sent after
    // close see the same immutable evidence. Nothing here reaches native again.
    assert_eq!(
        root.inspect_preflight_admission(&read, &workflow, inspection)
            .unwrap(),
        inspected
    );
    let late = registry_inspection(
        &RecordingAdmissionRequest::from_value(preflight_request.clone()).unwrap(),
        "inspect:after-close",
    );
    assert_eq!(
        root.inspect_preflight_admission(&read, &workflow, late)
            .unwrap()
            .as_value()["outcome"],
        inspected.as_value()["outcome"]
    );
    let late = operation_observation(&scope, "observe:after-close", &preflight_operation);
    assert_eq!(
        root.observe_result(&read, late).unwrap().as_value()["outcome"],
        candidate.as_value()["outcome"]
    );
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
    drop(handoff);

    let mut generated = json!({
        "version": 1,
        "description": "Native registry wire DTOs from one real-owner workflow (mock Hub, temporary SQLite). Generated by registry_wire_dto.rs; do not edit by hand.",
        "cases": c.0,
    });
    pin_plan_ids(&mut generated, &mut None);
    let text = format!("{}\n", serde_json::to_string_pretty(&generated).unwrap());
    if let Some(out) = std::env::var_os("SCADA_DUMP_WIRE_FIXTURES") {
        fs::write(out, &text).unwrap();
    }
    if std::env::var_os("SCADA_BLESS_WIRE_FIXTURES").is_some() {
        fs::write(FIXTURE, &text).unwrap();
    }
    let committed = fs::read_to_string(FIXTURE).expect("fixture exists; bless it first");
    assert_eq!(
        serde_json::from_str::<Value>(&committed).unwrap(),
        generated,
        "native wire DTOs changed; rerun with SCADA_BLESS_WIRE_FIXTURES=1 and review the diff"
    );
}
