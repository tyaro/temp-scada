use super::{RecordingInspectionRequest, RecordingInspectionResponse};
use crate::recording_plan::DesiredRecordingPlan;
use serde_json::Value;

/// Full echoed request equality, independent of object key order or 1/1.0 spelling.
pub fn same_recording_inspection_request(
    a: &RecordingInspectionRequest,
    b: &RecordingInspectionRequest,
) -> bool {
    let (a, b) = (a.as_value(), b.as_value());
    a["requestId"] == b["requestId"]
        && [
            "contextId",
            "projectId",
            "deploymentId",
            "storeId",
            "historianNamespace",
        ]
        .iter()
        .all(|key| a["context"][key] == b["context"][key])
        && a["context"]["projectRevision"].as_f64() == b["context"]["projectRevision"].as_f64()
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesiredAppliedComparison {
    Unavailable,
    Absent,
    LocalAbsent,
    NotApplied,
    DifferentPlan,
    SameRevisionConflict,
    Matches,
    LocalNewer { same_content: bool },
    LocalOlder { same_content: bool },
}
impl DesiredAppliedComparison {
    /// Exact shared JSON shape, without adding a serialization dependency.
    pub fn to_value(self) -> Value {
        use DesiredAppliedComparison::*;
        let kind = match self {
            Unavailable => "unavailable",
            Absent => "absent",
            LocalAbsent => "localAbsent",
            NotApplied => "notApplied",
            DifferentPlan => "differentPlan",
            SameRevisionConflict => "sameRevisionConflict",
            Matches => "matches",
            LocalNewer { .. } => "localNewer",
            LocalOlder { .. } => "localOlder",
        };
        match self {
            LocalNewer { same_content } | LocalOlder { same_content } => {
                serde_json::json!({"kind":kind,"sameContent":same_content})
            }
            _ => serde_json::json!({"kind":kind}),
        }
    }
}
// Validated IDs are ASCII: Rust string order equals JS code unit order.
fn members(value: &Value) -> Vec<(&str, &str, &str)> {
    let mut rows: Vec<_> = value["group"]["members"]
        .as_array()
        .expect("schema members")
        .iter()
        .map(|m| {
            (
                m["memberId"].as_str().expect("schema ID"),
                m["externalName"].as_str().expect("schema name"),
                m["valueType"].as_str().expect("schema type"),
            )
        })
        .collect();
    rows.sort_by_key(|row| row.0);
    rows
}
fn same_content(a: &Value, b: &Value) -> bool {
    // version/kind are constants in validated H5a. Compare integer values, not spellings.
    a["planId"] == b["planId"]
        && a["enabled"] == b["enabled"]
        && ["groupId", "hubRef"]
            .iter()
            .all(|key| a["group"][key] == b["group"][key])
        && a["group"]["periodMs"].as_f64() == b["group"]["periodMs"].as_f64()
        && members(a) == members(b)
}
/// Only owned validated inputs. No reordering caller data or implicit apply.
pub fn compare_desired_applied(
    local: Option<&DesiredRecordingPlan>,
    response: &RecordingInspectionResponse,
) -> DesiredAppliedComparison {
    use DesiredAppliedComparison::*;
    let db = &response.as_value()["database"];
    if db["state"] == "unavailable" {
        return Unavailable;
    }
    let applied = &db["applied"];
    let Some(local) = local else {
        return if applied.is_null() {
            Absent
        } else {
            LocalAbsent
        };
    };
    if applied.is_null() {
        return NotApplied;
    }
    let (local, applied) = (local.as_value(), &applied["desired"]);
    if local["planId"] != applied["planId"] {
        return DifferentPlan;
    }
    let same_content = same_content(local, applied);
    let (a, b) = (
        local["revision"].as_f64().expect("schema revision"),
        applied["revision"].as_f64().expect("schema revision"),
    );
    if a == b {
        if same_content {
            Matches
        } else {
            SameRevisionConflict
        }
    } else if a > b {
        LocalNewer { same_content }
    } else {
        LocalOlder { same_content }
    }
}
