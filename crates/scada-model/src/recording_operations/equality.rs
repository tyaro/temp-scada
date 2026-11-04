use super::{
    RecordingChangeRequest, RecordingOperationRequest, RecordingOperationsContext,
    RecordingReconciliationRequest,
};
use serde_json::Value;
// Only schema-validated owned JSON. Numeric spellings and object order are ignored;
// member display order is part of the immutable echoed operation request.
pub(crate) fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same_json(a, b)))
        }
        _ => a == b,
    }
}
/// Full context equality, not authority or native run identity validation.
pub fn same_recording_operations_context(
    a: &RecordingOperationsContext,
    b: &RecordingOperationsContext,
) -> bool {
    same_json(a.as_value(), b.as_value())
}
pub fn same_recording_change_request(
    a: &RecordingChangeRequest,
    b: &RecordingChangeRequest,
) -> bool {
    same_json(a.as_value(), b.as_value())
}
pub fn same_recording_operation_request(
    a: &RecordingOperationRequest,
    b: &RecordingOperationRequest,
) -> bool {
    same_json(a.as_value(), b.as_value())
}
pub fn same_recording_reconciliation_request(
    a: &RecordingReconciliationRequest,
    b: &RecordingReconciliationRequest,
) -> bool {
    same_json(a.as_value(), b.as_value())
}
