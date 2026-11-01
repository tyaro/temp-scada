//! Bounded request/response ownership around one synchronous HistoryReader.
//! No request queue, latest-result watch, transport or recorder control.
mod types;
pub use types::*;

use scada_historian::store::query::{
    validate_query_request, CancellationToken, HistoryQueryMode, HistoryReader, QueryControl,
    QueryError,
};
use serde_json::Value;
use std::sync::Arc;
use tokio::task::JoinHandle;

pub struct HistoryHost {
    reader: Option<HistoryReader>,
    running: Option<Running>,
    completion: Option<Arc<HistoryCompletion>>,
    reader_unusable: bool,
    faulted: bool,
}
struct Running {
    request: HistoryRequest,
    cancel: CancellationToken,
    task: JoinHandle<QueryResult>,
}
struct QueryResult {
    reader: HistoryReader,
    completion: HistoryCompletion,
}

impl HistoryHost {
    /// Issue a bounded reader lease from the store before moving the writer to
    /// a recording host. Idle hosts keep that lease until taken or dropped.
    pub fn new(reader: HistoryReader) -> Self {
        Self {
            reader: Some(reader),
            running: None,
            completion: None,
            reader_unusable: false,
            faulted: false,
        }
    }

    pub fn state(&self) -> HistoryHostState {
        HistoryHostState {
            phase: if self.faulted {
                HistoryPhase::Faulted
            } else if self.running.is_some() {
                HistoryPhase::InFlight
            } else if self.reader.is_none() {
                HistoryPhase::NoReader
            } else if self.reader_unusable {
                HistoryPhase::ReaderUnusable
            } else {
                HistoryPhase::Idle
            },
            request: self
                .running
                .as_ref()
                .map(|r| r.request.clone())
                .or_else(|| self.completion.as_ref().map(|c| c.request.clone())),
        }
    }

    /// Acceptance only. QueryControl is moved unchanged: time in the blocking
    /// pool counts against its original deadline. Finished but unjoined work
    /// still occupies the single request slot.
    pub fn start_query(
        &mut self,
        query: Value,
        control: QueryControl,
    ) -> Result<HistoryRequest, HistoryHostError> {
        if self.running.is_some() {
            return Err(HistoryHostError::Busy);
        }
        if self.faulted {
            return Err(HistoryHostError::WorkerFailed);
        }
        if self.reader.is_none() {
            return Err(HistoryHostError::NoReader);
        }
        if self.reader_unusable {
            return Err(HistoryHostError::ReaderUnusable);
        }
        let mode = validate_query_request(&query).map_err(HistoryHostError::Request)?;
        tokio::runtime::Handle::try_current().map_err(|_| HistoryHostError::NoRuntime)?;
        let request = HistoryRequest(Arc::new(()));
        let worker_request = request.clone();
        let mut reader = self.reader.take().expect("idle reader checked above");
        let cancel = control.cancellation.clone();
        self.completion = None;
        let task = tokio::task::spawn_blocking(move || {
            let result = match mode {
                HistoryQueryMode::Raw => reader.query_raw(&query, &control),
                HistoryQueryMode::MinMax => reader.query_minmax(&query, &control),
            };
            QueryResult {
                reader,
                completion: HistoryCompletion {
                    request: worker_request,
                    result,
                },
            }
        });
        self.running = Some(Running {
            request: request.clone(),
            cancel,
            task,
        });
        Ok(request)
    }

    /// A late cancel after completion is a no-op; it never rewrites a result
    /// which the reader already returned. Another request's token is rejected.
    pub fn cancel_query(&mut self, expected: &HistoryRequest) -> Result<(), HistoryHostError> {
        if let Some(running) = &self.running {
            if &running.request != expected {
                return Err(HistoryHostError::WrongRequest);
            }
            running.cancel.cancel();
            return Ok(());
        }
        self.check_completed(expected).map(|_| ())
    }

    /// Borrowed-handle await is cancellation safe. The request remains Busy
    /// until joined. Ok confirms worker joining; inspect completion.result for
    /// the query outcome. ReaderUnusable is sticky until explicitly dropped.
    pub async fn join_query(
        &mut self,
        expected: &HistoryRequest,
    ) -> Result<Arc<HistoryCompletion>, HistoryHostError> {
        let Some(running) = self.running.as_mut() else {
            return self.check_completed(expected);
        };
        if &running.request != expected {
            return Err(HistoryHostError::WrongRequest);
        }
        let result = (&mut running.task).await;
        self.running.take();
        match result {
            Ok(result) => {
                self.reader = Some(result.reader);
                self.reader_unusable = result.completion.result == Err(QueryError::ReaderUnusable);
                let completion = Arc::new(result.completion);
                self.completion = Some(completion.clone());
                Ok(completion)
            }
            Err(_) => {
                self.faulted = true;
                Err(HistoryHostError::WorkerFailed)
            }
        }
    }

    /// Transfers the lease without reopening the DB. An unusable reader may be
    /// taken for explicit disposal, but doing so does not repair it.
    pub fn take_reader(&mut self) -> Result<HistoryReader, HistoryHostError> {
        if self.running.is_some() {
            return Err(HistoryHostError::Busy);
        }
        if self.faulted {
            return Err(HistoryHostError::WorkerFailed);
        }
        let reader = self.reader.take().ok_or(HistoryHostError::NoReader)?;
        self.completion = None;
        Ok(reader)
    }

    fn check_completed(
        &self,
        expected: &HistoryRequest,
    ) -> Result<Arc<HistoryCompletion>, HistoryHostError> {
        if self.faulted {
            return Err(HistoryHostError::WorkerFailed);
        }
        let completion = self
            .completion
            .as_ref()
            .ok_or(HistoryHostError::NoRequest)?;
        if &completion.request != expected {
            return Err(HistoryHostError::WrongRequest);
        }
        Ok(completion.clone())
    }
}
impl Drop for HistoryHost {
    fn drop(&mut self) {
        if let Some(running) = &self.running {
            running.cancel.cancel();
        }
        // Dropping a blocking JoinHandle detaches it. The worker retains the
        // reader lease through query cleanup; no abort or immediate release.
    }
}

#[cfg(test)]
mod tests;
