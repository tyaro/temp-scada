use super::*;
fn nested(value: &Value) -> Result<(), RecordingAdmissionError> {
    validate_recording_operations(value).map_err(|_| RecordingAdmissionError)
}
fn request(value: &Value) -> Result<(), RecordingAdmissionError> {
    nested(&value["context"])?;
    let action = &value["action"];
    let change = match action["kind"].as_str().expect("schema action") {
        "preflight" | "discard" => {
            nested(&action["change"])?;
            &action["change"]
        }
        "pauseJoin" | "apply" => {
            nested(&action["operation"])?;
            require(action["kind"] == action["operation"]["stage"])?;
            &action["operation"]["change"]
        }
        "reconcile" => {
            nested(&action["reconciliation"])?;
            &action["reconciliation"]["operation"]["change"]
        }
        _ => unreachable!("schema action"),
    };
    require(same_json(&value["context"], &change["context"]))?;
    capacity::check(value)
}
fn reply(value: &Value) -> Result<(), RecordingAdmissionError> {
    request(&value["request"])?;
    let action = &value["request"]["action"];
    let outcome = &value["outcome"];
    if outcome["kind"] == "completedDiscard" {
        return require(action["kind"] == "discard");
    }
    if outcome["kind"] != "accepted" {
        return Ok(());
    }
    let handle = &outcome["handle"];
    nested(&handle["request"])?;
    match action["kind"].as_str().expect("schema action") {
        "preflight" => require(
            handle["kind"] == "operation"
                && handle["request"]["stage"] == "preflight"
                && same_json(&action["change"], &handle["request"]["change"]),
        ),
        "pauseJoin" | "apply" => require(
            handle["kind"] == "operation"
                && action["changeRef"] == handle["changeRef"]
                && same_json(&action["operation"], &handle["request"]),
        ),
        "reconcile" => require(
            handle["kind"] == "reconciliation"
                && same_json(&action["reconciliation"], &handle["request"]),
        ),
        _ => Err(RecordingAdmissionError),
    }
}
pub(super) fn document(value: &Value) -> Result<(), RecordingAdmissionError> {
    match value["kind"].as_str().expect("schema root") {
        "recordingAdmissionRequest" => request(value),
        "recordingAdmissionReply" => reply(value),
        "recordingAdmissionInspectionRequest" => request(&value["original"]),
        "recordingAdmissionInspectionReply" => {
            request(&value["request"]["original"])?;
            if value["outcome"]["kind"] == "found" {
                reply(&value["outcome"]["reply"])?;
                require(same_json(
                    &value["request"]["original"],
                    &value["outcome"]["reply"]["request"],
                ))?;
            }
            Ok(())
        }
        "recordingReconciliationDelivery" => {
            nested(&value["request"])?;
            if value["outcome"]["kind"] == "result" {
                nested(&value["outcome"]["result"])?;
                require(same_json(
                    &value["request"],
                    &value["outcome"]["result"]["request"],
                ))?;
            }
            Ok(())
        }
        _ => unreachable!("schema root"),
    }
}
