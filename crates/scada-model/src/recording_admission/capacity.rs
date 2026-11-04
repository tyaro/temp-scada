//! Budget closure only: never recursively invokes the public validator.
use super::*;
use serde_json::json;
static LONGEST_ERROR: LazyLock<String> = LazyLock::new(|| {
    let schema: Value = serde_json::from_str(RECORDING_OPERATIONS_SCHEMA).expect("bundled JSON");
    schema["$defs"]["error"]["enum"]
        .as_array()
        .expect("error enum")
        .iter()
        .map(|s| s.as_str().expect("error string"))
        .max_by_key(|s| s.len())
        .expect("finite errors")
        .to_owned()
});
pub(super) fn check(request: &Value) -> Result<(), RecordingAdmissionError> {
    check_with(request, budget)
}
pub(super) fn check_with(
    request: &Value,
    mut check: impl FnMut(&Value) -> Result<(), RecordingAdmissionError>,
) -> Result<(), RecordingAdmissionError> {
    let id = "r".repeat(64);
    let inspection = json!({"version":1,"kind":"recordingAdmissionInspectionRequest","inspectionId":id,"original":request});
    check(&inspection)?;
    let action = &request["action"];
    let success = match action["kind"].as_str().expect("validated request") {
        "preflight" => {
            json!({"kind":"accepted","handle":{"kind":"operation","changeRef":id,"operationRef":id,"request":{"version":1,"kind":"recordingOperationRequest","operationId":id,"stage":"preflight","change":action["change"]}}})
        }
        "pauseJoin" | "apply" => {
            json!({"kind":"accepted","handle":{"kind":"operation","changeRef":id,"operationRef":id,"request":action["operation"]}})
        }
        "reconcile" => {
            json!({"kind":"accepted","handle":{"kind":"reconciliation","readRef":id,"request":action["reconciliation"]}})
        }
        "discard" => json!({"kind":"completedDiscard"}),
        _ => return Err(RecordingAdmissionError),
    };
    if action["kind"] == "preflight" {
        validate_recording_operations(&success["handle"]["request"])
            .map_err(|_| RecordingAdmissionError)?;
    }
    for outcome in [
        success,
        json!({"kind":"rejected","error":&*LONGEST_ERROR}),
        json!({"kind":"unknown","error":&*LONGEST_ERROR}),
    ] {
        let reply = json!({"version":1,"kind":"recordingAdmissionReply","request":request,"outcome":outcome});
        check(&reply)?;
        check(
            &json!({"version":1,"kind":"recordingAdmissionInspectionReply","request":inspection,"outcome":{"kind":"found","reply":reply}}),
        )?;
    }
    for outcome in [
        json!({"kind":"notFound"}),
        json!({"kind":"unavailable","error":&*LONGEST_ERROR}),
    ] {
        check(
            &json!({"version":1,"kind":"recordingAdmissionInspectionReply","request":inspection,"outcome":outcome}),
        )?;
    }
    Ok(())
}
