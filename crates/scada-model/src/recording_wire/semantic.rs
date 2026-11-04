//! Only called after bounded schema validation. Nested roots keep independent checks.
use super::*;
fn op(v: &Value) -> Result<(), RecordingWireError> {
    crate::recording_operations::validate_recording_operations(v).map_err(|_| RecordingWireError)
}
fn admission(v: &Value) -> Result<(), RecordingWireError> {
    crate::recording_admission::validate_recording_admission(v).map_err(|_| RecordingWireError)
}
fn scope(v: &Value) -> Result<(), RecordingWireError> {
    op(&v["context"])
}
fn admission_scope(s: &Value, v: &Value) -> Result<(), RecordingWireError> {
    let q = match v["kind"].as_str() {
        Some("recordingAdmissionReply") => &v["request"],
        Some("recordingAdmissionInspectionReply") => &v["request"]["original"],
        Some("recordingAdmissionInspectionRequest") => &v["original"],
        _ => v,
    };
    require(q["ownerRef"] == s["ownerRef"] && same_json(&q["context"], &s["context"]))
}
fn delivery_scope(s: &Value, d: &Value) -> Result<(), RecordingWireError> {
    require(
        d["ownerRef"] == s["ownerRef"]
            && same_json(
                &d["request"]["operation"]["change"]["context"],
                &s["context"],
            ),
    )
}
fn snapshot(v: &Value) -> Result<(), RecordingWireError> {
    measure(v, WIRE_SNAPSHOT_LIMIT)?;
    scope(&v["scope"])?;
    if !v["admission"].is_null() {
        admission(&v["admission"])?;
        admission_scope(&v["scope"], &v["admission"])?;
    }
    if !v["operation"].is_null() {
        op(&v["operation"]["result"])?;
        require(same_json(
            &v["scope"]["context"],
            &v["operation"]["result"]["request"]["change"]["context"],
        ))?;
    }
    if !v["reconciliation"].is_null() {
        admission(&v["reconciliation"])?;
        delivery_scope(&v["scope"], &v["reconciliation"])?;
    }
    let h = &v["admission"]["outcome"]["handle"];
    if v["admission"]["outcome"]["kind"] == "accepted" {
        if h["kind"] == "operation"
            && !v["operation"].is_null()
            && h["operationRef"] == v["operation"]["operationRef"]
        {
            require(same_json(
                &h["request"],
                &v["operation"]["result"]["request"],
            ))?;
        }
        if h["kind"] == "reconciliation"
            && !v["reconciliation"].is_null()
            && h["readRef"] == v["reconciliation"]["readRef"]
        {
            require(same_json(&h["request"], &v["reconciliation"]["request"]))?;
        }
    }
    Ok(())
}
pub(super) fn document(v: &Value) -> Result<(), RecordingWireError> {
    match v["kind"].as_str().expect("schema kind") {
        "recordingWireLeaseRequest"
        | "recordingWireCancelRequest"
        | "recordingWireAttachRequest"
        | "recordingWireControlRequest"
        | "recordingWireControlFrame" => scope(&v["scope"]),
        "recordingWireLeaseReply" => {
            validate_recording_wire(&v["request"])?;
            if v["outcome"]["kind"] == "issued" {
                require(
                    v["outcome"]["grantedBudgetMs"].as_f64()
                        <= v["request"]["requestedBudgetMs"].as_f64(),
                )?;
            }
            Ok(())
        }
        "recordingWireCancelReply" => validate_recording_wire(&v["request"]),
        "recordingWireObservationRequest" => {
            scope(&v["scope"])?;
            let t = &v["target"];
            op(&t["request"])?;
            let c = if t["kind"] == "operation" {
                &t["request"]["change"]["context"]
            } else {
                &t["request"]["operation"]["change"]["context"]
            };
            require(same_json(c, &v["scope"]["context"]))
        }
        "recordingWireObservationReply" => {
            validate_recording_wire(&v["request"])?;
            let t = &v["request"]["target"];
            let o = &v["outcome"];
            match o["kind"].as_str() {
                Some("operation") => {
                    op(&o["result"])?;
                    require(
                        t["kind"] == "operation"
                            && same_json(&t["request"], &o["result"]["request"]),
                    )
                }
                Some("reconciliation") => {
                    admission(&o["delivery"])?;
                    delivery_scope(&v["request"]["scope"], &o["delivery"])?;
                    require(
                        t["kind"] == "reconciliation"
                            && t["readRef"] == o["delivery"]["readRef"]
                            && same_json(&t["request"], &o["delivery"]["request"]),
                    )
                }
                _ => Ok(()),
            }
        }
        "recordingWireAttachReply" => {
            validate_recording_wire(&v["request"])?;
            if v["outcome"]["kind"] == "attached" {
                let s = &v["outcome"]["snapshot"];
                snapshot(s)?;
                require(same_json(&s["scope"], &v["request"]["scope"]))?;
                require(
                    v["request"]["afterRevision"].is_null()
                        || s["revision"].as_f64() >= v["request"]["afterRevision"].as_f64(),
                )?;
            }
            Ok(())
        }
        "recordingWireStateFrame" => snapshot(&v["snapshot"]),
        "recordingWireControlReply" => {
            validate_recording_wire(&v["request"])?;
            match v["outcome"]["kind"].as_str() {
                Some("detached") => require(v["request"]["action"] == "detach"),
                Some("snapshot") => {
                    require(v["request"]["action"] == "snapshot")?;
                    snapshot(&v["outcome"]["snapshot"])?;
                    require(same_json(
                        &v["outcome"]["snapshot"]["scope"],
                        &v["request"]["scope"],
                    ))
                }
                _ => Ok(()),
            }
        }
        "recordingWireCallInspectionRequest" => {
            scope(&v["scope"])?;
            let o = &v["original"];
            if o["kind"]
                .as_str()
                .expect("schema original")
                .starts_with("recordingWire")
            {
                validate_recording_wire(o)?;
                require(same_json(&o["scope"], &v["scope"]))
            } else {
                admission(o)?;
                admission_scope(&v["scope"], o)
            }
        }
        "recordingWireCallInspectionReply" => {
            validate_recording_wire(&v["request"])?;
            if v["outcome"]["kind"] != "terminal" {
                return Ok(());
            }
            let r = &v["outcome"]["reply"];
            if r["kind"]
                .as_str()
                .expect("schema reply")
                .starts_with("recordingWire")
            {
                validate_recording_wire(r)?;
            } else {
                admission(r)?;
            }
            require(
                r["kind"]
                    == v["request"]["original"]["kind"]
                        .as_str()
                        .unwrap()
                        .replace("Request", "Reply")
                    && same_json(&r["request"], &v["request"]["original"]),
            )
        }
        _ => unreachable!("schema kind"),
    }
}
