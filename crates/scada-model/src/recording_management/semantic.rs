use serde_json::Value;
fn n(value: &Value) -> f64 {
    value.as_f64().expect("schema integer")
}
/// Only called after schema validation. DB/Host disagreement is allowed.
pub(super) fn database_consistent(db: &Value) -> bool {
    if db["state"] == "unavailable" {
        return true;
    }
    let applied = &db["applied"];
    let activation = &db["latestActivation"];
    let fence = &db["retentionFence"];
    let snapshot = n(&db["snapshotCommit"]);
    if !db["activeSessionId"].is_null() && !db["activeRetentionJobId"].is_null() {
        return false;
    }
    if (if fence["cutoffMs"].is_null() {
        n(&fence["commitVersion"]) != 0.0
    } else {
        n(&fence["commitVersion"]) < 1.0
    }) || n(&fence["commitVersion"]) > snapshot
    {
        return false;
    }
    if snapshot == 0.0
        && [
            "currentMappingRevision",
            "currentRetentionAppliedRevision",
            "applied",
            "latestActivation",
            "activeSessionId",
            "activeRetentionJobId",
        ]
        .iter()
        .any(|key| !db[key].is_null())
    {
        return false;
    }
    if !applied.is_null() {
        if n(&applied["commitVersion"]) > snapshot {
            return false;
        }
        for (bound, current) in [
            ("mappingRevision", "currentMappingRevision"),
            (
                "retentionAppliedRevision",
                "currentRetentionAppliedRevision",
            ),
        ] {
            if applied["desired"]["enabled"]
                .as_bool()
                .expect("schema bool")
                != !applied[bound].is_null()
                || (!applied[bound].is_null()
                    && (db[current].is_null() || n(&applied[bound]) > n(&db[current])))
            {
                return false;
            }
        }
    }
    if !activation.is_null() {
        if applied.is_null()
            || n(&activation["appliedRevision"]) > n(&applied["appliedRevision"])
            || n(&activation["commitVersion"]) > snapshot
        {
            return false;
        }
        let end = &activation["endCommitVersion"];
        if (activation["state"] == "active") != end.is_null() {
            return false;
        }
        if !end.is_null() && (n(end) <= n(&activation["commitVersion"]) || n(end) > snapshot) {
            return false;
        }
        if n(&activation["appliedRevision"]) == n(&applied["appliedRevision"]) {
            if applied["desired"]["enabled"] != true
                || n(&activation["commitVersion"]) <= n(&applied["commitVersion"])
            {
                return false;
            }
        } else if end.is_null() || n(end) >= n(&applied["commitVersion"]) {
            return false;
        }
        if activation["state"] == "active"
            && (n(&activation["appliedRevision"]) != n(&applied["appliedRevision"])
                || activation["sessionId"] != db["activeSessionId"])
        {
            return false;
        }
    }
    if !applied.is_null()
        && !db["activeSessionId"].is_null()
        && (activation["state"] != "active" || activation["sessionId"] != db["activeSessionId"])
    {
        return false;
    }
    true
}
