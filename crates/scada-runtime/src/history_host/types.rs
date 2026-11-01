use scada_historian::store::query::QueryError;
use serde_json::Value;
use std::{fmt, sync::Arc};

/// Process-local identity, separate from caller-provided H1 requestId. Reusing
/// that string does not allow a past request to cancel a new execution.
#[derive(Clone)]
pub struct HistoryRequest(pub(super) Arc<()>);
impl PartialEq for HistoryRequest {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for HistoryRequest {}
impl fmt::Debug for HistoryRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HistoryRequest(..)")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryPhase {
    Idle,
    InFlight,
    ReaderUnusable,
    Faulted,
    NoReader,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryHostState {
    pub phase: HistoryPhase,
    pub request: Option<HistoryRequest>,
}
#[derive(Debug)]
pub struct HistoryCompletion {
    pub request: HistoryRequest,
    pub result: Result<Value, QueryError>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryHostError {
    Busy,
    NoReader,
    NoRequest,
    NoRuntime,
    WrongRequest,
    ReaderUnusable,
    WorkerFailed,
    Request(QueryError),
}
