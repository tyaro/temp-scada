use serde_json::Value;
fn n(value: &Value) -> f64 {
    value.as_f64().expect("schema safe integer")
}
fn number_equal(a: &Value, b: &Value) -> bool {
    a.as_f64() == b.as_f64()
}
pub(super) fn apply_consistent(apply: &Value) -> bool {
    let enabled = apply["desired"]["enabled"].as_bool().expect("schema bool");
    [
        "expectedMappingRevision",
        "expectedRetentionAppliedRevision",
    ]
    .iter()
    .all(|key| enabled != apply[key].is_null())
}
fn receipt_consistent(receipt: &Value, apply: &Value) -> bool {
    let expected = &apply["expectedAppliedRevision"];
    let next = if expected.is_null() {
        1.0
    } else {
        let expected = n(expected);
        if expected == 9_007_199_254_740_991.0 {
            return false;
        }
        expected + 1.0
    };
    n(&receipt["appliedRevision"]) == next
        && number_equal(&receipt["plan"]["revision"], &receipt["appliedRevision"])
        && receipt["requestId"] == apply["requestId"]
        && receipt["desiredPlanId"] == apply["desired"]["planId"]
        && number_equal(&receipt["desiredRevision"], &apply["desired"]["revision"])
        && receipt["enabled"] == apply["desired"]["enabled"]
        && number_equal(
            &receipt["mappingRevision"],
            &apply["expectedMappingRevision"],
        )
        && number_equal(
            &receipt["retentionAppliedRevision"],
            &apply["expectedRetentionAppliedRevision"],
        )
}
pub(super) fn operation_consistent(result: &Value) -> bool {
    let request = &result["request"];
    let outcome = &result["outcome"];
    let unknown = result["quiescence"] == "unknown";
    let recovery = result["recoveryRequired"].as_bool().expect("schema bool");
    if unknown && !recovery {
        return false;
    }
    if outcome["kind"] == "failed" {
        if unknown && outcome["effect"] != "unconfirmed" {
            return false;
        }
        if outcome["effect"] == "notDispatched" && unknown {
            return false;
        }
        if request["stage"] == "pauseJoin" && outcome["effect"] == "notCommitted" {
            return false;
        }
        return !(request["stage"] == "apply" && outcome["effect"] != "notDispatched" && !recovery);
    }
    if outcome["kind"] != "applied" && (unknown || recovery) {
        return false;
    }
    match outcome["kind"].as_str().expect("schema outcome") {
        "candidate" => {
            request["stage"] == "preflight"
                && request["change"]["apply"]["expectedAppliedRevision"].as_f64()
                    != Some(9_007_199_254_740_991.0)
                && (outcome["activeSessionId"].is_null()
                    || outcome["activeSessionId"] == request["change"]["context"]["sessionId"])
        }
        "paused" => {
            request["stage"] == "pauseJoin"
                && outcome["sessionId"] == request["change"]["context"]["sessionId"]
        }
        "replay" => {
            request["stage"] == "preflight"
                && n(&outcome["receipt"]["commitVersion"]) <= n(&outcome["snapshotCommit"])
                && receipt_consistent(&outcome["receipt"], &request["change"]["apply"])
        }
        "applied" => {
            request["stage"] == "apply"
                && receipt_consistent(&outcome["receipt"], &request["change"]["apply"])
        }
        _ => unreachable!("schema outcome"),
    }
}
pub(super) fn reconciliation_consistent(result: &Value) -> bool {
    !(result["quiescence"] == "unknown" && result["recoveryRequired"] == false)
        && (result["outcome"]["kind"] != "receiptFound"
            || receipt_consistent(
                &result["outcome"]["receipt"],
                &result["request"]["operation"]["change"]["apply"],
            ))
}
