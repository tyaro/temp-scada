//! One fresh SDK resolution for a recording start (product-owner design §3,
//! §5): a new connection generation of its own, read once and shut down.
//! The recording itself takes another client; nothing is shared with the
//! read host of the screens.
use super::setup::SetupFailure;
use banto_tagclient::{BindingRequest, GenerationSnapshot, RestClient, TagClientConnectionState};
use std::sync::Arc;
use std::time::Duration;

/// How long the first live generation may take.
pub(super) const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

/// Starts a generation for `requests` (binding key = series ID) and returns
/// its first snapshot in which every request resolved and has a value.
pub(super) async fn resolve(
    client: RestClient,
    requests: Vec<BindingRequest>,
    timeout: Duration,
) -> Result<Arc<GenerationSnapshot>, SetupFailure> {
    let handle = client
        .start(requests)
        .map_err(|_| SetupFailure::ResolutionMismatch)?;
    let mut receiver = handle.state_watch();
    let wait = async {
        // The handle starts `Stopped` until its worker runs.
        let mut started = false;
        loop {
            let state = receiver.borrow_and_update().clone();
            match state.connection_state() {
                TagClientConnectionState::Live => {
                    if let Some(snapshot) = state.snapshot() {
                        if !snapshot.resolution.unresolved.is_empty() {
                            return Err(SetupFailure::TagsUnresolved);
                        }
                        return Ok(snapshot.clone());
                    }
                }
                TagClientConnectionState::Unbound => return Err(SetupFailure::TagsUnresolved),
                TagClientConnectionState::Unauthorized => {
                    return Err(SetupFailure::HubUnauthorized)
                }
                TagClientConnectionState::Stopped => {
                    if started || state.last_error().is_some() {
                        return Err(SetupFailure::HubUnavailable);
                    }
                }
                _ => started = true,
            }
            if receiver.changed().await.is_err() {
                return Err(SetupFailure::HubUnavailable);
            }
        }
    };
    let result = match tokio::time::timeout(timeout, wait).await {
        Ok(result) => result,
        Err(_) => Err(SetupFailure::HubUnavailable),
    };
    // The snapshot is plain data; the generation is not kept.
    let _ = handle.shutdown().await;
    result
}
