//! A dedicated SDK owner for a fixed historian group, independent of UI demand.
//! Capture copies one SDK state, without networking, async work, or a second cache.
mod plan;
mod projection;
pub use plan::*;

use banto_tagclient::{ErrorKind, RestClient, TagClientConnectionState, TagClientHandle};
use scada_historian::{
    recorder::{SnapshotSource, SourceError},
    store::{Reason, TickObservation},
};

/// A source never replaces its plan or endpoint in place. After a terminal
/// failure, explicitly close the recorder and create a new source/session.
pub struct SdkRecorderSource {
    plan: SdkRecorderPlan,
    handle: Option<TagClientHandle>,
    failure: Option<SourceError>,
    seen_progress: bool,
    accepted_generation: Option<u64>,
    shutdown_result: Option<Result<(), ErrorKind>>,
}

impl SdkRecorderSource {
    /// Call inside a running Tokio runtime. Only this group's names are requested.
    pub fn start(plan: SdkRecorderPlan, client: RestClient) -> Result<Self, ErrorKind> {
        let handle = client
            .start(plan.requests())
            .map_err(|error| error.kind())?;
        Ok(Self {
            plan,
            handle: Some(handle),
            failure: None,
            seen_progress: false,
            accepted_generation: None,
            shutdown_result: None,
        })
    }

    /// Invalidate synchronously on first poll, then join the SDK worker. Dropping
    /// this future still drops the SDK owner and cannot resurrect an old state.
    /// This does not close the recorder's separate SQLite session.
    pub async fn shutdown(&mut self) -> Result<(), ErrorKind> {
        self.failure
            .get_or_insert(SourceError("SDK source stopped"));
        if let Some(result) = self.shutdown_result {
            return result;
        }
        // Cancellation leaves joining unconfirmed. A retry cannot claim success.
        self.shutdown_result = Some(Err(ErrorKind::Transport));
        if let Some(handle) = self.handle.take() {
            let result = handle.shutdown().await.map_err(|error| error.kind());
            self.shutdown_result = Some(result);
            return result;
        }
        Err(ErrorKind::Transport)
    }

    pub fn terminal_error(&self) -> Option<SourceError> {
        self.failure
    }
}

impl SnapshotSource for SdkRecorderSource {
    fn capture(&mut self) -> Result<Vec<TickObservation>, SourceError> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let result = (|| {
            let handle = self
                .handle
                .as_ref()
                .ok_or(SourceError("SDK source stopped"))?;
            // The only read from the owner in this capture. Arc clones preserve
            // the catalog/resolution/values relationship across concurrent updates.
            let state = handle.state();
            if state.connection_state() != TagClientConnectionState::Stopped {
                self.seen_progress = true;
            }
            match state.connection_state() {
                TagClientConnectionState::Live | TagClientConnectionState::Unbound => {
                    let generation = state
                        .snapshot()
                        .ok_or(SourceError("SDK snapshot missing"))?;
                    if self
                        .accepted_generation
                        .is_some_and(|old| old > generation.generation)
                    {
                        return Err(SourceError("SDK generation regressed"));
                    }
                    if self.plan.generation.run_id.is_none()
                        && self
                            .accepted_generation
                            .is_some_and(|old| old != generation.generation)
                    {
                        return Err(SourceError("SDK generation without run identity changed"));
                    }
                    let observations = projection::capture(&self.plan, generation)?;
                    self.accepted_generation = Some(generation.generation);
                    Ok(observations)
                }
                // The SDK starts at Stopped before its worker is first polled.
                TagClientConnectionState::Stopped
                    if !self.seen_progress && state.last_error().is_none() =>
                {
                    Ok(self.plan.empty(Reason::SourceUnavailable))
                }
                TagClientConnectionState::Stopped | TagClientConnectionState::Unauthorized => {
                    Err(SourceError("SDK source terminated"))
                }
                _ => Ok(self.plan.empty(Reason::SourceUnavailable)),
            }
        })();
        if let Err(error) = result {
            self.failure = Some(error);
        }
        result
    }
}

#[cfg(test)]
mod tests;
