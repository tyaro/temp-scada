//! The live delivery of the always-on trend (historian-live-trend §3.2, L2):
//! the snapshot the Recorder observed and committed, per tick, to the one
//! subscribed screen. Tauri-independent: the desktop host spawns a
//! [`LivePump`] with an `emit` callback, so the behavior is tested with plain
//! `cargo test`.
//!
//! The Recorder calls the feed as its [`CommitTap`] inside the tick, so the
//! feed only takes a short lock and queues: a slow receiver never delays a
//! tick. The queue is bounded; on overflow the oldest events are dropped and
//! their series get a break mark ahead of the rest, never a silent gap.
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use scada_historian::store::{
    evidence::PlanRef, ObservationValue, Quality, SessionSpec, Tick, TickObservation,
};
use scada_runtime::recording_host::CommitTap;
use serde::Serialize;
use tokio::sync::watch;

/// The Tauri event the live pumps emit.
pub const LIVE_TREND_EVENT: &str = "scada:live-trend";
/// Events (tick batches and break marks) queued for a subscription at most.
pub const LIVE_QUEUE_LIMIT: usize = 64;
/// Series one subscription may ask for at most (a recording group's bound).
pub const LIVE_SERIES_LIMIT: usize = 64;

/// One series' value of one committed tick: the stored record's value
/// (`null` unless good quality with a value; bool as 0/1) at its
/// `sampleTimeMs`. No `sourceTimeMs`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveItem {
    pub series_id: String,
    pub segment_id: String,
    pub t_ms: i64,
    pub value: Option<f64>,
}

/// Why a series' line breaks: the client calls `liveBreak` for each series.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveBreakReason {
    /// The queue overflowed and dropped some of this series' items.
    Overflow,
    /// The recorder clock's epoch changed (its time may have gone back).
    ClockEpoch,
    /// The recording session ended or another one began; the old session's
    /// queued items were dropped.
    Session,
}

/// One event of a subscription, emitted as [`LIVE_TREND_EVENT`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LiveEvent {
    /// One committed tick. `sessionId` and `sequence` are the stored record's
    /// (`recordId`), comparable with an H1 `watermark`; `firstSequence` is
    /// the first sequence of that session.
    #[serde(rename_all = "camelCase")]
    Batch {
        subscription_id: String,
        context_id: String,
        session_id: String,
        sequence: u64,
        first_sequence: u64,
        items: Vec<LiveItem>,
    },
    #[serde(rename_all = "camelCase")]
    Break {
        subscription_id: String,
        context_id: String,
        series_ids: Vec<String>,
        reason: LiveBreakReason,
    },
    /// A recording of another plan or revision began: this subscription's
    /// context is no longer the applied one and nothing more comes for it.
    /// The client reads the HistoryContext again and subscribes anew.
    #[serde(rename_all = "camelCase")]
    ContextChanged {
        subscription_id: String,
        context_id: String,
    },
}

/// The live feed of one recording store: at most one subscription (one
/// controller per screen); a new one replaces the earlier one.
pub struct LiveFeed {
    inner: Mutex<Inner>,
    wake: watch::Sender<u64>,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    session: Option<Session>,
    subscription: Option<Subscription>,
}

struct Session {
    id: String,
    plan: PlanRef,
    first_sequence: Option<u64>,
    segments: HashMap<String, String>,
}

struct Subscription {
    id: String,
    context_id: String,
    plan: PlanRef,
    series: BTreeSet<String>,
    queue: VecDeque<LiveEvent>,
    /// Series whose queued events overflowed: one break mark goes out before
    /// the queue's (newer) rest.
    overflowed: BTreeSet<String>,
    last_epoch: Option<String>,
    /// `ContextChanged` was queued: sent once.
    stale: bool,
}

impl Subscription {
    fn push(&mut self, event: LiveEvent) {
        while self.queue.len() >= LIVE_QUEUE_LIMIT {
            match self.queue.pop_front() {
                Some(LiveEvent::Batch { items, .. }) => self
                    .overflowed
                    .extend(items.into_iter().map(|item| item.series_id)),
                Some(LiveEvent::Break { series_ids, .. }) => self.overflowed.extend(series_ids),
                // The last event a subscription gets (nothing is queued
                // after it), so an overflow never drops it.
                Some(LiveEvent::ContextChanged { .. }) => {}
                None => break,
            }
        }
        self.queue.push_back(event);
    }

    fn break_all(&mut self, reason: LiveBreakReason) {
        let event = LiveEvent::Break {
            subscription_id: self.id.clone(),
            context_id: self.context_id.clone(),
            series_ids: self.series.iter().cloned().collect(),
            reason,
        };
        self.push(event);
    }

    /// The old session's items go: a session break covers them.
    fn end_session(&mut self) {
        if self.stale {
            return;
        }
        self.queue.clear();
        self.overflowed.clear();
        self.last_epoch = None;
        self.break_all(LiveBreakReason::Session);
    }

    fn next(&mut self) -> Option<LiveEvent> {
        if !self.overflowed.is_empty() {
            return Some(LiveEvent::Break {
                subscription_id: self.id.clone(),
                context_id: self.context_id.clone(),
                series_ids: std::mem::take(&mut self.overflowed).into_iter().collect(),
                reason: LiveBreakReason::Overflow,
            });
        }
        self.queue.pop_front()
    }
}

impl Default for LiveFeed {
    fn default() -> Self {
        Self {
            inner: Mutex::default(),
            wake: watch::Sender::new(0),
        }
    }
}

impl LiveFeed {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn notify(&self) {
        self.wake.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Subscribes `series` of the context `context_id` (whose applied plan is
    /// `plan`), replacing any earlier subscription, whose pump then ends.
    /// Only ticks of a session recording `plan` are delivered.
    pub fn subscribe(
        self: &Arc<Self>,
        context_id: &str,
        plan: PlanRef,
        series: BTreeSet<String>,
    ) -> LivePump {
        let mut inner = self.lock();
        inner.next_id += 1;
        let id = format!("live:{}", inner.next_id);
        inner.subscription = Some(Subscription {
            id: id.clone(),
            context_id: context_id.to_owned(),
            plan,
            series,
            queue: VecDeque::new(),
            overflowed: BTreeSet::new(),
            last_epoch: None,
            stale: false,
        });
        drop(inner);
        let wake = self.wake.subscribe();
        self.notify();
        LivePump {
            feed: self.clone(),
            id,
            wake,
        }
    }

    /// Ends the subscription `id` (its pump returns). Another one is kept.
    pub fn unsubscribe(&self, id: &str) -> bool {
        let mut inner = self.lock();
        let ended = inner.subscription.as_ref().is_some_and(|s| s.id == id);
        if ended {
            inner.subscription = None;
        }
        drop(inner);
        self.notify();
        ended
    }

    /// The next event of subscription `id`; `Err` once it is not current.
    fn next(&self, id: &str) -> Result<Option<LiveEvent>, ()> {
        let mut inner = self.lock();
        match inner.subscription.as_mut() {
            Some(subscription) if subscription.id == id => Ok(subscription.next()),
            _ => Err(()),
        }
    }
}

impl CommitTap for LiveFeed {
    fn begin(&self, session: &SessionSpec, plan: &PlanRef) {
        let mut inner = self.lock();
        let replaced = inner.session.is_some();
        inner.session = Some(Session {
            id: session.session_id.clone(),
            plan: plan.clone(),
            first_sequence: None,
            segments: session
                .members
                .iter()
                .map(|m| (m.series_id.clone(), m.segment_id.clone()))
                .collect(),
        });
        if let Some(subscription) = inner.subscription.as_mut() {
            if replaced {
                subscription.end_session();
            }
            if subscription.plan != *plan && !subscription.stale {
                subscription.stale = true;
                let event = LiveEvent::ContextChanged {
                    subscription_id: subscription.id.clone(),
                    context_id: subscription.context_id.clone(),
                };
                subscription.push(event);
            }
        }
        drop(inner);
        self.notify();
    }

    fn committed(&self, tick: &Tick) {
        let mut inner = self.lock();
        let Inner {
            session,
            subscription,
            ..
        } = &mut *inner;
        let Some(session) = session.as_mut().filter(|s| s.id == tick.session_id) else {
            return;
        };
        let first_sequence = *session.first_sequence.get_or_insert(tick.sequence);
        let Some(subscription) = subscription.as_mut().filter(|s| s.plan == session.plan) else {
            return;
        };
        if subscription
            .last_epoch
            .as_ref()
            .is_some_and(|epoch| *epoch != tick.clock_epoch)
        {
            subscription.break_all(LiveBreakReason::ClockEpoch);
        }
        subscription.last_epoch = Some(tick.clock_epoch.clone());
        let items: Vec<LiveItem> = tick
            .observations
            .iter()
            .filter(|o| subscription.series.contains(&o.series_id))
            .filter_map(|o| {
                Some(LiveItem {
                    series_id: o.series_id.clone(),
                    segment_id: session.segments.get(&o.series_id)?.clone(),
                    t_ms: tick.sample_time_ms,
                    value: live_value(o),
                })
            })
            .collect();
        if !items.is_empty() {
            let event = LiveEvent::Batch {
                subscription_id: subscription.id.clone(),
                context_id: subscription.context_id.clone(),
                session_id: tick.session_id.clone(),
                sequence: tick.sequence,
                first_sequence,
                items,
            };
            subscription.push(event);
        }
        drop(inner);
        self.notify();
    }

    fn end(&self, session_id: &str) {
        let mut inner = self.lock();
        if inner.session.as_ref().is_some_and(|s| s.id == session_id) {
            inner.session = None;
            if let Some(subscription) = inner.subscription.as_mut() {
                subscription.end_session();
            }
        }
        drop(inner);
        self.notify();
    }
}

/// The record's value as the trend draws it: missing unless good quality
/// with a value and no reason; bool as 0/1.
fn live_value(observation: &TickObservation) -> Option<f64> {
    if observation.quality != Some(Quality::Good) || observation.reason.is_some() {
        return None;
    }
    match observation.value.as_ref()? {
        ObservationValue::Number(n) => Some(*n),
        ObservationValue::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
    }
}

/// Emits one subscription's events in order until it is replaced or ended,
/// or `emit` fails.
pub struct LivePump {
    feed: Arc<LiveFeed>,
    id: String,
    wake: watch::Receiver<u64>,
}

impl LivePump {
    pub fn subscription_id(&self) -> &str {
        &self.id
    }

    pub async fn run(mut self, mut emit: impl FnMut(LiveEvent) -> bool + Send) {
        loop {
            self.wake.mark_unchanged();
            loop {
                match self.feed.next(&self.id) {
                    Err(()) => return,
                    Ok(None) => break,
                    Ok(Some(event)) => {
                        if !emit(event) {
                            self.feed.unsubscribe(&self.id);
                            return;
                        }
                    }
                }
            }
            if self.wake.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests;
