//! The confirmation before the window closes (product-owner design §6.1,
//! the confirmation dialog). On `CloseRequested` the host reads
//! [`close_check`](recording_control::close_check):
//!
//! - nothing unsettled: the window closes, and the exit (§6) follows;
//! - a Candidate: the close is held and the webview is asked
//!   ([`CLOSE_EVENT`], `{"id", "kind": "candidate"}`). It answers with
//!   `app_close_reply`: `shown` at once, then `discard` (the exit discards
//!   the Candidate) or `cancel` (nothing happens). A webview that does not
//!   answer `shown` within [`SHOWN_LIMIT`] is taken as unresponsive and the
//!   exit proceeds without the confirmation;
//! - accepted work still running: the close is held, the webview is told
//!   (`{"id", "kind": "waiting"}`) and the exit starts at once. It waits for
//!   the work within its own limit.
//!
//! Once the exit has started, further close requests are held: the exit
//! ends the process itself.
use crate::auth::AuthState;
use scada_host::recording_control;
use scada_host::recording_gate::CloseCheck;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, State, Window};

/// The event that asks the webview, or tells it the exit waits.
pub const CLOSE_EVENT: &str = "scada:close";

/// How long the webview has to show a confirmation before the exit
/// proceeds without it.
pub const SHOWN_LIMIT: Duration = Duration::from_secs(3);

/// The confirmation state of the app.
#[derive(Default)]
pub struct CloseGuard(Mutex<Guard>);

#[derive(Default)]
struct Guard {
    next: u64,
    /// The confirmation asked and not answered yet, and whether the webview
    /// has shown it.
    prompt: Option<(u64, bool)>,
    exiting: bool,
}

/// What the webview is sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClosePrompt {
    pub id: u64,
    pub kind: CloseCheck,
}

/// What one close request does.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Let the window close.
    Close,
    /// Hold the close: the exit has started.
    Hold,
    /// Hold the close and ask the webview this confirmation.
    Ask(ClosePrompt),
    /// Hold the close, tell the webview and start the exit.
    Wait(ClosePrompt),
}

/// The webview's answer to a confirmation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reply {
    Shown,
    Discard,
    Cancel,
}

impl Reply {
    fn parse(reply: &str) -> Option<Self> {
        match reply {
            "shown" => Some(Self::Shown),
            "discard" => Some(Self::Discard),
            "cancel" => Some(Self::Cancel),
            _ => None,
        }
    }
}

impl CloseGuard {
    fn guard(&self) -> std::sync::MutexGuard<'_, Guard> {
        self.0.lock().expect("close guard mutex poisoned")
    }

    /// One close request, by what the host found unsettled. A request
    /// while a confirmation is open asks it again under a new ID: the
    /// webview must show it again, or it is taken as unresponsive.
    pub fn request(&self, check: CloseCheck) -> Decision {
        let mut guard = self.guard();
        if guard.exiting {
            return Decision::Hold;
        }
        guard.next += 1;
        let prompt = ClosePrompt {
            id: guard.next,
            kind: check,
        };
        match check {
            CloseCheck::Close => {
                guard.prompt = None;
                Decision::Close
            }
            CloseCheck::Candidate => {
                guard.prompt = Some((prompt.id, false));
                Decision::Ask(prompt)
            }
            CloseCheck::Waiting => {
                guard.prompt = None;
                guard.exiting = true;
                Decision::Wait(prompt)
            }
        }
    }

    /// The webview's `reply` to confirmation `id`. Answers whether the exit
    /// starts now. A reply to any other confirmation is refused.
    pub fn reply(&self, id: u64, reply: Reply) -> Result<bool, &'static str> {
        let mut guard = self.guard();
        match guard.prompt {
            Some((current, _)) if current == id && !guard.exiting => {}
            _ => return Err("stale_prompt"),
        }
        match reply {
            Reply::Shown => {
                guard.prompt = Some((id, true));
                Ok(false)
            }
            Reply::Discard => {
                guard.prompt = None;
                guard.exiting = true;
                Ok(true)
            }
            Reply::Cancel => {
                guard.prompt = None;
                Ok(false)
            }
        }
    }

    /// Past [`SHOWN_LIMIT`]: whether confirmation `id` is still open and
    /// was never shown. If so the exit starts now.
    pub fn unanswered(&self, id: u64) -> bool {
        let mut guard = self.guard();
        if guard.exiting || guard.prompt != Some((id, false)) {
            return false;
        }
        guard.prompt = None;
        guard.exiting = true;
        true
    }

    /// The exit has started by any route (the last window closed, the OS,
    /// a reply): close requests are held from now on.
    pub fn begin_exit(&self) {
        let mut guard = self.guard();
        guard.prompt = None;
        guard.exiting = true;
    }
}

/// `CloseRequested` of `window`. Called by the window hook of `commands`.
pub fn requested<R: Runtime>(window: &Window<R>, api: &tauri::CloseRequestApi) {
    let auth = window.state::<AuthState>();
    let check = recording_control::close_check(auth.get().ok());
    let guard = window.state::<CloseGuard>();
    let app = window.app_handle().clone();
    let target = EventTarget::webview(window.label());
    match guard.request(check) {
        Decision::Close => {}
        Decision::Hold => api.prevent_close(),
        Decision::Ask(prompt) => {
            api.prevent_close();
            let id = prompt.id;
            if app.emit_to(target, CLOSE_EVENT, prompt).is_err() {
                if guard.unanswered(id) {
                    app.exit(0);
                }
                return;
            }
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SHOWN_LIMIT).await;
                if app.state::<CloseGuard>().unanswered(id) {
                    app.exit(0);
                }
            });
        }
        Decision::Wait(prompt) => {
            api.prevent_close();
            let _ = app.emit_to(target, CLOSE_EVENT, prompt);
            app.exit(0);
        }
    }
}

/// The webview's answer to confirmation `id`: `shown`, `discard` or
/// `cancel`. `discard` starts the exit, which discards the Candidate.
#[tauri::command]
pub fn app_close_reply<R: Runtime>(
    app: AppHandle<R>,
    guard: State<'_, CloseGuard>,
    id: u64,
    reply: String,
) -> Result<(), String> {
    let reply = Reply::parse(&reply).ok_or("invalid_reply")?;
    if guard.reply(id, reply)? {
        app.exit(0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(decision: Decision) -> u64 {
        match decision {
            Decision::Ask(prompt) => {
                assert_eq!(prompt.kind, CloseCheck::Candidate);
                prompt.id
            }
            other => panic!("not asked: {other:?}"),
        }
    }

    #[test]
    fn a_settled_host_closes_at_once() {
        let guard = CloseGuard::default();
        assert_eq!(guard.request(CloseCheck::Close), Decision::Close);
        assert_eq!(guard.request(CloseCheck::Close), Decision::Close);
    }

    #[test]
    fn a_candidate_is_asked_and_a_cancel_leaves_the_window_open() {
        let guard = CloseGuard::default();
        let id = asked(guard.request(CloseCheck::Candidate));
        assert_eq!(guard.reply(id, Reply::Shown), Ok(false));
        assert!(!guard.unanswered(id));
        assert_eq!(guard.reply(id, Reply::Cancel), Ok(false));
        // Answered once only.
        assert_eq!(guard.reply(id, Reply::Discard), Err("stale_prompt"));
        // The next close asks again.
        let next = asked(guard.request(CloseCheck::Candidate));
        assert_ne!(next, id);
    }

    #[test]
    fn a_discard_starts_the_exit_and_holds_later_closes() {
        let guard = CloseGuard::default();
        let id = asked(guard.request(CloseCheck::Candidate));
        guard.reply(id, Reply::Shown).unwrap();
        assert_eq!(guard.reply(id, Reply::Discard), Ok(true));
        assert_eq!(guard.request(CloseCheck::Candidate), Decision::Hold);
        assert_eq!(guard.request(CloseCheck::Close), Decision::Hold);
    }

    #[test]
    fn an_unshown_confirmation_lets_the_exit_proceed() {
        let guard = CloseGuard::default();
        let id = asked(guard.request(CloseCheck::Candidate));
        assert!(guard.unanswered(id));
        // Too late to answer.
        assert_eq!(guard.reply(id, Reply::Cancel), Err("stale_prompt"));
        assert_eq!(guard.request(CloseCheck::Candidate), Decision::Hold);
    }

    #[test]
    fn a_second_close_asks_again_and_must_be_shown_again() {
        let guard = CloseGuard::default();
        let first = asked(guard.request(CloseCheck::Candidate));
        guard.reply(first, Reply::Shown).unwrap();
        let second = asked(guard.request(CloseCheck::Candidate));
        // The first one is replaced and its timer does nothing.
        assert_eq!(guard.reply(first, Reply::Discard), Err("stale_prompt"));
        assert!(!guard.unanswered(first));
        assert!(guard.unanswered(second));
    }

    #[test]
    fn waiting_work_starts_the_exit_without_a_question() {
        let guard = CloseGuard::default();
        let id = asked(guard.request(CloseCheck::Candidate));
        match guard.request(CloseCheck::Waiting) {
            Decision::Wait(prompt) => assert_eq!(prompt.kind, CloseCheck::Waiting),
            other => panic!("not waiting: {other:?}"),
        }
        assert_eq!(guard.reply(id, Reply::Discard), Err("stale_prompt"));
        assert_eq!(guard.request(CloseCheck::Close), Decision::Hold);
    }

    #[test]
    fn an_exit_from_elsewhere_holds_closes_and_ends_the_confirmation() {
        let guard = CloseGuard::default();
        let id = asked(guard.request(CloseCheck::Candidate));
        guard.begin_exit();
        assert_eq!(guard.reply(id, Reply::Discard), Err("stale_prompt"));
        assert_eq!(guard.request(CloseCheck::Close), Decision::Hold);
    }

    #[test]
    fn the_prompt_is_camel_case_json() {
        let prompt = ClosePrompt {
            id: 7,
            kind: CloseCheck::Candidate,
        };
        assert_eq!(
            serde_json::to_value(prompt).unwrap(),
            serde_json::json!({"id": 7, "kind": "candidate"})
        );
    }
}
