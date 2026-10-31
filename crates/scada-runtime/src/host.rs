//! One Project's read-only SDK owner. Reconnect and rebinding belong to the SDK.
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use banto_tagclient::{BindingRequest, ErrorKind, RestClient, TagClientHandle, TagClientState};
use scada_model::Project;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::{
    project_view, read_slot_view, BindingPlan, ReadSlotPlan, ReadSlotPlanError, ReadSlotView,
    RuntimeView,
};

/// Opaque local identity, independent of Project ID/revision and SDK generation.
/// Do not serialize this token or reuse it when reopening the same file.
#[derive(Clone)]
pub struct ReadSession(Arc<()>);

impl ReadSession {
    fn new() -> Self {
        Self(Arc::new(()))
    }
}

impl PartialEq for ReadSession {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ReadSession {}

impl fmt::Debug for ReadSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReadSession(..)")
    }
}

/// One atomic presentation update, not a wire transport or persisted Project.
/// Retained frames are historical snapshots; check their session before use.
#[derive(Clone, Debug, PartialEq)]
pub struct ReadHostFrame {
    session: ReadSession,
    pub sdk_generation: Option<u64>,
    pub text: RuntimeView,
    pub slots: ReadSlotView,
}

impl ReadHostFrame {
    pub fn session(&self) -> &ReadSession {
        &self.session
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadHostError {
    Plan(ReadSlotPlanError),
    Start(ErrorKind),
}

/// A previous terminal SDK error does not prevent an explicit replacement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadTransition {
    pub session: ReadSession,
    pub previous_error: Option<ErrorKind>,
}

struct ReadPlan {
    text: BindingPlan,
    slots: ReadSlotPlan,
    requests: Vec<BindingRequest>,
}

impl ReadPlan {
    fn new(project: &Project) -> Result<Self, ReadSlotPlanError> {
        let text = BindingPlan::new(project);
        let slots = ReadSlotPlan::from_project(project)?;
        let requests: BTreeMap<_, _> = text
            .requests()
            .into_iter()
            .chain(slots.requests())
            .map(|request| (request.external_name.clone(), request))
            .collect();
        Ok(Self {
            text,
            slots,
            requests: requests.into_values().collect(),
        })
    }

    fn pending(&self, session: ReadSession, error: Option<ErrorKind>) -> Arc<ReadHostFrame> {
        let error = error.map(|error| error.as_str().to_owned());
        Arc::new(ReadHostFrame {
            session,
            sdk_generation: None,
            text: RuntimeView::pending(&self.text, "stopped".into(), error.clone()),
            slots: ReadSlotView::pending(&self.slots, "stopped".into(), error),
        })
    }

    fn project(&self, session: ReadSession, state: &TagClientState) -> Arc<ReadHostFrame> {
        Arc::new(ReadHostFrame {
            session,
            sdk_generation: state.snapshot().map(|snapshot| snapshot.generation),
            text: project_view(&self.text, state),
            slots: read_slot_view(&self.slots, state),
        })
    }
}

/// Owns at most one SDK handle and one bounded-latest projection task.
/// Build outside Tokio if needed, then call replace/stop from a runtime.
/// No UI, authentication, persistent configuration, or PLC access is owned here.
pub struct ReadHost {
    plan: Arc<ReadPlan>,
    frames: watch::Sender<Arc<ReadHostFrame>>,
    running: Option<Running>,
}

impl ReadHost {
    pub fn new(project: &Project) -> Result<Self, ReadSlotPlanError> {
        let plan = Arc::new(ReadPlan::new(project)?);
        let (frames, _) = watch::channel(plan.pending(ReadSession::new(), None));
        Ok(Self {
            plan,
            frames,
            running: None,
        })
    }

    pub fn state(&self) -> Arc<ReadHostFrame> {
        self.frames.borrow().clone()
    }

    /// Borrow, clone, and release the watch guard before awaiting other work.
    pub fn state_watch(&self) -> watch::Receiver<Arc<ReadHostFrame>> {
        self.frames.subscribe()
    }

    pub fn is_current(&self, session: &ReadSession) -> bool {
        self.frames.borrow().session() == session
    }

    /// The first poll invalidates the old session before any await. Cancelling
    /// while stopping the old owner leaves this Host stopped with the new plan.
    /// None means disconnected; an empty request set never starts the SDK.
    pub async fn replace(
        &mut self,
        project: &Project,
        client: Option<RestClient>,
    ) -> Result<ReadTransition, ReadHostError> {
        let plan = Arc::new(ReadPlan::new(project).map_err(ReadHostError::Plan)?);
        self.plan = plan;
        let session = self.invalidate(None);
        let previous_error = match self.running.take() {
            Some(running) => running.shutdown().await,
            None => None,
        };
        if let Some(client) = client.filter(|_| !self.plan.requests.is_empty()) {
            let handle = client.start(self.plan.requests.clone()).map_err(|error| {
                self.frames
                    .send_replace(self.plan.pending(session.clone(), Some(error.kind())));
                ReadHostError::Start(error.kind())
            })?;
            let receiver = handle.state_watch();
            let frames = self.frames.clone();
            let plan = self.plan.clone();
            let pump_session = session.clone();
            let pump = tokio::spawn(pump(receiver, plan, pump_session, frames));
            self.running = Some(Running {
                handle: Some(handle),
                pump: Some(pump),
            });
        }
        Ok(ReadTransition {
            session,
            previous_error,
        })
    }

    /// Publishes a fresh stopped session first, then closes/joins the old owner.
    /// An SDK terminal error remains an error; the frame is still safely empty.
    pub async fn stop(&mut self) -> Result<ReadSession, ErrorKind> {
        let session = self.invalidate(None);
        if let Some(running) = self.running.take() {
            if let Some(error) = running.shutdown().await {
                self.frames
                    .send_replace(self.plan.pending(session, Some(error)));
                return Err(error);
            }
        }
        Ok(session)
    }

    fn invalidate(&self, error: Option<ErrorKind>) -> ReadSession {
        let session = ReadSession::new();
        self.frames
            .send_replace(self.plan.pending(session.clone(), error));
        session
    }
}

impl Drop for ReadHost {
    fn drop(&mut self) {
        self.invalidate(None);
        // Running::drop aborts its pump and the SDK owner's Drop stops it too.
        self.running.take();
    }
}

struct Running {
    handle: Option<TagClientHandle>,
    pump: Option<JoinHandle<()>>,
}

impl Running {
    async fn shutdown(mut self) -> Option<ErrorKind> {
        let mut failure = None;
        if let Some(pump) = self.pump.take() {
            pump.abort();
            if pump.await.is_err_and(|error| !error.is_cancelled()) {
                failure = Some(ErrorKind::Transport);
            }
        }
        if let Some(handle) = self.handle.take() {
            if let Err(error) = handle.shutdown().await {
                failure = Some(error.kind());
            }
        }
        failure
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(pump) = self.pump.take() {
            pump.abort();
        }
    }
}

/// reset and publish share the watch slot lock: a completed old projection can
/// never overwrite the new session, even if its task races with replacement.
fn publish_if_current(
    frames: &watch::Sender<Arc<ReadHostFrame>>,
    next: Arc<ReadHostFrame>,
) -> bool {
    frames.send_if_modified(|current| {
        if current.session != next.session {
            return false;
        }
        *current = next;
        true
    })
}

async fn pump(
    mut receiver: watch::Receiver<TagClientState>,
    plan: Arc<ReadPlan>,
    session: ReadSession,
    frames: watch::Sender<Arc<ReadHostFrame>>,
) {
    loop {
        let state = receiver.borrow_and_update().clone();
        if !publish_if_current(&frames, plan.project(session.clone(), &state)) {
            return;
        }
        if receiver.changed().await.is_err() {
            publish_if_current(&frames, plan.pending(session, Some(ErrorKind::Transport)));
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_completed_old_projection_cannot_replace_a_new_session() {
        let project =
            Project::from_json(include_str!("../../../examples/tag-binding.project.json")).unwrap();
        let host = ReadHost::new(&project).unwrap();
        let mut old = (*host.state()).clone();
        old.text.connection = "live".into();
        old.text.readings.insert(
            "old".into(),
            crate::NumericReading::Resolved {
                quality: crate::Quality::Good,
                numeric_value: Some(123.0),
            },
        );
        let fresh = host.invalidate(None);
        assert!(!publish_if_current(&host.frames, Arc::new(old)));
        assert!(host.is_current(&fresh));
        assert_eq!(host.state().text.connection, "stopped");
        assert!(!host.state().text.readings.contains_key("old"));
    }
}
