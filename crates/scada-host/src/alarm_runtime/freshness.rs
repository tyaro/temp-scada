//! Freshness of the dedicated subscription (design §4.5, 3-C3b).
//!
//! The Hub subscription is on-change only and has no heartbeat, so the
//! runtime rereads the current values over REST. This module owns the
//! bookkeeping: when to reread, which subscription values arrived while a
//! reread was in flight, the failure streak, and resubscription failures.
//! The run loop owns the SDK handle and the Engine inputs.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use banto_tagclient::{RestClient, ValuesSnapshot};
use scada_alarm::{EngineUnavailable, Sample};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

/// Makes a Hub client for the applied endpoint on each call. The stream
/// consumes one client; rereads and resubscription need more. The caller
/// returns `None` when the saved Hub record or credential no longer matches
/// the applied endpoint, so the Engine never reads a different Hub.
#[derive(Clone)]
pub struct HubClients(Arc<dyn Fn() -> Option<RestClient> + Send + Sync>);

impl HubClients {
    pub fn new(make: impl Fn() -> Option<RestClient> + Send + Sync + 'static) -> Self {
        Self(Arc::new(make))
    }

    pub(crate) fn make(&self) -> Option<RestClient> {
        (self.0)()
    }
}

/// Terminal settings for the freshness check. Defaults per design §4.5
/// (3-C3b); the settings screen comes with the terminal settings slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FreshnessConfig {
    pub reread_interval: Duration,
    pub reread_timeout: Duration,
    /// Failures continuing this long since the first one mean ReceiveLost.
    pub failure_limit: Duration,
    /// Consecutive resubscription failures that mean ReceiveLost.
    pub resubscribe_failures: u32,
}

impl Default for FreshnessConfig {
    fn default() -> Self {
        Self {
            reread_interval: Duration::from_secs(10),
            reread_timeout: Duration::from_secs(5),
            failure_limit: Duration::from_secs(30),
            resubscribe_failures: 3,
        }
    }
}

/// The current reread failure streak, shown as a warning in `alarm_snapshot`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RereadFailure {
    pub since_wall_ms: i64,
    pub failures: u32,
}

pub(super) type RereadResult = Result<ValuesSnapshot, ()>;

/// One reread in flight, with what the subscription had delivered at send.
pub(super) struct Ticket {
    pub(super) epoch: u64,
    pub(super) arrivals: BTreeMap<String, u64>,
    pub(super) rx: oneshot::Receiver<RereadResult>,
    /// Dropping the ticket (invalidation) ends the request, so a new one
    /// never runs beside it.
    _task: AbortOnDrop,
}

struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) struct Freshness {
    pub(super) config: FreshnessConfig,
    pub(super) clients: HubClients,
    /// The subscription is Live or Unbound (not the Engine's Disconnected).
    connected: bool,
    /// The subscription is Live, so it carries values worth comparing.
    live: bool,
    /// Bumped on each new connection generation or replaced subscription.
    pub(super) epoch: u64,
    arrivals: BTreeMap<String, u64>,
    pub(super) next_reread: Instant,
    pub(super) ticket: Option<Ticket>,
    streak: Option<(Instant, i64)>,
    failures: u32,
    reread_lost: bool,
    resubscribe_failures: u32,
    pub(super) resubscribing: bool,
    /// The current subscription is a resubscription that missed its
    /// deadline; reaching Live/Unbound later still counts as success.
    late: bool,
    pub(super) next_resubscribe: Option<Instant>,
    report: watch::Sender<Option<RereadFailure>>,
}

impl Freshness {
    pub(super) fn new(
        config: FreshnessConfig,
        clients: HubClients,
        report: watch::Sender<Option<RereadFailure>>,
    ) -> Self {
        Self {
            config,
            clients,
            connected: false,
            live: false,
            epoch: 0,
            arrivals: BTreeMap::new(),
            next_reread: Instant::now() + config.reread_interval,
            ticket: None,
            streak: None,
            failures: 0,
            reread_lost: false,
            resubscribe_failures: 0,
            resubscribing: false,
            late: false,
            next_resubscribe: None,
            report,
        }
    }

    /// The Engine-wide reason this module wants now (design §4.5 priority).
    pub(super) fn desired(&self) -> Option<EngineUnavailable> {
        if self.resubscribe_failures >= self.config.resubscribe_failures {
            Some(EngineUnavailable::ReceiveLost)
        } else if !self.connected {
            Some(EngineUnavailable::Disconnected)
        } else if self.reread_lost {
            Some(EngineUnavailable::ReceiveLost)
        } else {
            None
        }
    }

    /// A Live or Unbound snapshot was accepted.
    pub(super) fn connected(&mut self, live: bool, new_generation: bool) {
        if self.late {
            self.resubscribe_succeeded();
        }
        if new_generation || !self.connected {
            self.epoch += 1;
        }
        if new_generation {
            // The watch may skip the non-Live state between generations: a
            // new one starts over as after Disconnected, and a reread sent to
            // the old one no longer counts.
            self.ticket = None;
            self.clear_streak();
        }
        self.connected = true;
        if self.live && !live {
            // Unbound sends no rereads, so nothing could end the streak:
            // it starts over, as for Disconnected.
            self.ticket = None;
            self.clear_streak();
        }
        self.live = live;
    }

    /// The subscription is not Live/Unbound: Disconnected is the reason, so
    /// the reread streak starts over.
    pub(super) fn disconnected(&mut self) {
        if self.connected {
            self.epoch += 1;
        }
        self.connected = false;
        self.live = false;
        self.ticket = None;
        self.clear_streak();
    }

    fn clear_streak(&mut self) {
        self.reread_lost = false;
        self.failures = 0;
        if self.streak.take().is_some() {
            self.report.send_replace(None);
        }
    }

    /// The subscription is replaced (apply or resubscription).
    pub(super) fn replaced(&mut self) {
        self.late = false;
        self.epoch += 1;
        self.ticket = None;
        // No rereads until the new subscription is Live.
        self.live = false;
    }

    /// An apply refreshed the Hub record or credential; the next reread
    /// uses it.
    pub(super) fn set_clients(&mut self, clients: HubClients) {
        self.clients = clients;
    }

    /// Saved terminal settings replace the config (terminal settings §4).
    /// The next reread is due one new interval from now. The failure streak
    /// and resubscription count are kept and judged against the new limits:
    /// a streak already past the new failure limit means ReceiveLost now.
    /// A longer limit does not end ReceiveLost; only a success does.
    pub(super) fn reconfigure(&mut self, config: FreshnessConfig, now: Instant) {
        self.config = config;
        self.next_reread = now + config.reread_interval;
        if let Some((since, _)) = self.streak {
            if now.duration_since(since) >= config.failure_limit {
                self.reread_lost = true;
            }
        }
    }

    /// A subscription value was accepted for `tag`.
    pub(super) fn arrived(&mut self, tag: &str) {
        *self.arrivals.entry(tag.to_owned()).or_default() += 1;
    }

    pub(super) fn arrival_count(&self, tag: &str) -> u64 {
        self.arrivals.get(tag).copied().unwrap_or(0)
    }

    /// Send a reread when one is due. Returns `true` when making a client
    /// failed and the availability may have changed.
    pub(super) fn start_reread(
        &mut self,
        tags: &BTreeSet<String>,
        now: Instant,
        wall: i64,
    ) -> bool {
        self.next_reread = now + self.config.reread_interval;
        if !self.live || self.ticket.is_some() || tags.is_empty() {
            return false;
        }
        // Made for each reread, so a changed saved Hub record or credential
        // is checked every time instead of a cached client reading the old
        // Hub.
        let Some(reader) = self.clients.make() else {
            return self.failure(now, wall);
        };
        let (tx, rx) = oneshot::channel();
        let names: Vec<String> = tags.iter().cloned().collect();
        let timeout = self.config.reread_timeout;
        let task = tokio::spawn(async move {
            let refs: Vec<&str> = names.iter().map(String::as_str).collect();
            let result = match tokio::time::timeout(timeout, reader.fetch_values(&refs)).await {
                Ok(Ok(values)) => Ok(values),
                _ => Err(()),
            };
            let _ = tx.send(result);
        });
        self.ticket = Some(Ticket {
            epoch: self.epoch,
            arrivals: self.arrivals.clone(),
            rx,
            _task: AbortOnDrop(task.abort_handle()),
        });
        false
    }

    /// A reread failed or timed out. Returns `true` when ReceiveLost begins.
    pub(super) fn failure(&mut self, now: Instant, wall: i64) -> bool {
        self.failures = self.failures.saturating_add(1);
        let (since, since_wall) = *self.streak.get_or_insert((now, wall));
        self.report.send_replace(Some(RereadFailure {
            since_wall_ms: since_wall,
            failures: self.failures,
        }));
        if !self.reread_lost && now.duration_since(since) >= self.config.failure_limit {
            self.reread_lost = true;
            return true;
        }
        false
    }

    /// A reread succeeded. Returns `true` when it ends ReceiveLost.
    pub(super) fn success(&mut self) -> bool {
        self.failures = 0;
        if self.streak.take().is_some() {
            self.report.send_replace(None);
        }
        std::mem::take(&mut self.reread_lost)
    }

    pub(super) fn resubscribe_started(&mut self) {
        self.resubscribing = true;
        self.next_resubscribe = None;
    }

    /// A fresh subscription reached Live/Unbound.
    pub(super) fn resubscribe_succeeded(&mut self) {
        self.resubscribing = false;
        self.late = false;
        self.resubscribe_failures = 0;
        self.next_resubscribe = None;
    }

    /// The resubscription did not reach Live/Unbound within its deadline.
    /// It stays in place; if it connects later, that ends the failures.
    pub(super) fn resubscribe_timed_out(&mut self, now: Instant) {
        self.resubscribe_failed(now);
        self.late = true;
    }

    /// The current subscription is a resubscription that has not reached
    /// Live/Unbound yet (within its deadline or late).
    pub(super) fn resubscription_pending(&self) -> bool {
        self.resubscribing || self.late
    }

    /// A pending resubscription stopped. It counts as one failure (a late
    /// one was counted at its deadline) and the next one is scheduled.
    pub(super) fn resubscription_stopped(&mut self, now: Instant) {
        if self.late {
            self.late = false;
        } else {
            self.resubscribe_failed(now);
        }
        self.disconnected();
    }

    pub(super) fn resubscribe_failed(&mut self, now: Instant) {
        self.resubscribing = false;
        self.resubscribe_failures = self.resubscribe_failures.saturating_add(1);
        self.next_resubscribe = Some(now + self.config.reread_interval);
    }
}

/// Whether a reread differs from the accepted subscription value. The
/// source timestamp is not compared (design §4.5, 3-C3b).
pub(super) fn differs(accepted: &Sample, read: &Sample) -> bool {
    accepted.resolved
        && read.resolved
        && accepted.value.is_some()
        && read.value.is_some()
        && (accepted.quality != read.quality || accepted.value != read.value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn freshness() -> (Freshness, watch::Receiver<Option<RereadFailure>>) {
        let (tx, rx) = watch::channel(None);
        let config = FreshnessConfig {
            reread_interval: Duration::from_millis(100),
            reread_timeout: Duration::from_millis(50),
            failure_limit: Duration::from_millis(300),
            resubscribe_failures: 3,
        };
        (Freshness::new(config, HubClients::new(|| None), tx), rx)
    }

    #[tokio::test]
    async fn reason_priority_puts_resubscription_loss_over_disconnect_over_reread_loss() {
        let (mut f, _) = freshness();
        assert_eq!(f.desired(), Some(EngineUnavailable::Disconnected));
        f.connected(true, false);
        assert_eq!(f.desired(), None);
        let start = Instant::now();
        assert!(!f.failure(start, 1));
        assert!(f.failure(start + Duration::from_millis(300), 2));
        assert_eq!(f.desired(), Some(EngineUnavailable::ReceiveLost));
        // Disconnected outranks a reread loss and restarts the streak.
        f.disconnected();
        assert_eq!(f.desired(), Some(EngineUnavailable::Disconnected));
        f.connected(true, false);
        assert_eq!(f.desired(), None);
        for _ in 0..3 {
            f.resubscribe_failed(start);
        }
        f.disconnected();
        assert_eq!(f.desired(), Some(EngineUnavailable::ReceiveLost));
        f.resubscribe_succeeded();
        f.connected(true, false);
        assert_eq!(f.desired(), None);
    }

    #[tokio::test]
    async fn a_resubscription_that_connects_after_its_deadline_ends_the_failures() {
        let (mut f, _) = freshness();
        let start = Instant::now();
        f.resubscribe_failed(start);
        f.resubscribe_failed(start);
        f.replaced();
        f.resubscribe_started();
        f.resubscribe_timed_out(start);
        f.disconnected();
        assert_eq!(f.desired(), Some(EngineUnavailable::ReceiveLost));
        assert!(f.next_resubscribe.is_some());
        // The same subscription reaches Live late: no retry, no ReceiveLost.
        f.connected(true, false);
        assert_eq!(f.desired(), None);
        assert!(f.next_resubscribe.is_none());
    }

    #[tokio::test]
    async fn the_failure_streak_is_reported_and_one_success_clears_it() {
        let (mut f, report) = freshness();
        f.connected(true, false);
        let start = Instant::now();
        f.failure(start, 10);
        f.failure(start + Duration::from_millis(100), 20);
        assert_eq!(
            *report.borrow(),
            Some(RereadFailure {
                since_wall_ms: 10,
                failures: 2
            })
        );
        assert!(!f.success());
        assert_eq!(*report.borrow(), None);
        // A new streak counts from its own first failure.
        assert!(!f.failure(start + Duration::from_millis(350), 30));
        assert_eq!(f.desired(), None);
    }

    #[tokio::test]
    async fn a_client_that_cannot_be_made_counts_as_a_failure() {
        let (mut f, report) = freshness();
        f.connected(true, false);
        let tags = BTreeSet::from(["A".to_owned()]);
        assert!(!f.start_reread(&tags, Instant::now(), 5));
        assert!(f.ticket.is_none());
        assert_eq!(report.borrow().map(|r| r.failures), Some(1));
        // Unbound sends nothing: there are no values to compare.
        f.connected(false, false);
        f.start_reread(&tags, Instant::now(), 6);
        assert_eq!(*report.borrow(), None);
    }

    #[tokio::test]
    async fn each_reread_makes_its_reader_from_the_current_clients() {
        let (mut f, _) = freshness();
        f.connected(true, false);
        let made = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = made.clone();
        let endpoint = || {
            banto_tagclient::RestClient::new(
                banto_tagclient::Endpoint::new("http://127.0.0.1:9").unwrap(),
                banto_tagclient::SecretApiKey::new("reader-test-only-key".into()).unwrap(),
            )
            .ok()
        };
        f.set_clients(HubClients::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            endpoint()
        }));
        let tags = BTreeSet::from(["A".to_owned()]);
        f.start_reread(&tags, Instant::now(), 1);
        f.ticket = None;
        f.start_reread(&tags, Instant::now(), 2);
        assert_eq!(made.load(std::sync::atomic::Ordering::SeqCst), 2);
        f.ticket = None;
        let again = made.clone();
        f.set_clients(HubClients::new(move || {
            again.fetch_add(10, std::sync::atomic::Ordering::SeqCst);
            endpoint()
        }));
        f.start_reread(&tags, Instant::now(), 3);
        assert_eq!(made.load(std::sync::atomic::Ordering::SeqCst), 12);
    }

    #[tokio::test]
    async fn a_replaced_subscription_sends_no_reread_until_live() {
        let (mut f, report) = freshness();
        f.connected(true, false);
        f.replaced();
        let tags = BTreeSet::from(["A".to_owned()]);
        // The factory makes nothing: a reread would count a failure.
        f.start_reread(&tags, Instant::now(), 1);
        assert_eq!(*report.borrow(), None);
        f.connected(true, true);
        f.start_reread(&tags, Instant::now(), 2);
        assert_eq!(report.borrow().map(|r| r.failures), Some(1));
    }

    #[tokio::test]
    async fn an_invalidated_reread_is_aborted() {
        let (mut f, _) = freshness();
        f.connected(true, false);
        f.set_clients(HubClients::new(|| {
            banto_tagclient::RestClient::new(
                banto_tagclient::Endpoint::new("http://10.255.255.1:9").unwrap(),
                banto_tagclient::SecretApiKey::new("reader-test-only-key".into()).unwrap(),
            )
            .ok()
        }));
        let tags = BTreeSet::from(["A".to_owned()]);
        f.start_reread(&tags, Instant::now(), 1);
        let mut ticket = f.ticket.take().unwrap();
        let handle = ticket._task.0.clone();
        drop(std::mem::replace(&mut ticket.rx, oneshot::channel().1));
        drop(ticket);
        for _ in 0..100 {
            if handle.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(handle.is_finished());
    }

    #[tokio::test]
    async fn a_new_generation_starts_the_streak_over() {
        let (mut f, report) = freshness();
        f.connected(true, false);
        let start = Instant::now();
        f.failure(start, 1);
        assert!(f.failure(start + Duration::from_millis(300), 2));
        f.connected(true, true);
        assert_eq!(f.desired(), None);
        assert_eq!(*report.borrow(), None);
        assert!(!f.failure(start + Duration::from_millis(400), 3));
    }

    #[tokio::test]
    async fn leaving_live_for_unbound_starts_the_streak_over() {
        let (mut f, report) = freshness();
        f.connected(true, false);
        let start = Instant::now();
        f.failure(start, 1);
        assert!(f.failure(start + Duration::from_millis(300), 2));
        assert_eq!(f.desired(), Some(EngineUnavailable::ReceiveLost));
        f.connected(false, false);
        assert_eq!(f.desired(), None);
        assert_eq!(*report.borrow(), None);
        // Back to Live: evaluable at once, a new streak from its own start.
        f.connected(true, false);
        assert_eq!(f.desired(), None);
        assert!(!f.failure(start + Duration::from_millis(400), 3));
    }

    #[tokio::test]
    async fn a_stopped_resubscription_counts_once_and_schedules_the_next() {
        let (mut f, _) = freshness();
        f.connected(true, false);
        let start = Instant::now();
        f.replaced();
        f.resubscribe_started();
        assert!(f.resubscription_pending());
        f.resubscription_stopped(start);
        assert!(!f.resubscription_pending());
        assert!(f.next_resubscribe.is_some());
        assert_eq!(f.desired(), Some(EngineUnavailable::Disconnected));
        // A late one was counted at its deadline; stopping adds nothing.
        f.replaced();
        f.resubscribe_started();
        f.resubscribe_timed_out(start);
        assert!(f.resubscription_pending());
        f.resubscription_stopped(start);
        assert_eq!(f.desired(), Some(EngineUnavailable::Disconnected));
        f.replaced();
        f.resubscribe_started();
        f.resubscription_stopped(start);
        assert_eq!(f.desired(), Some(EngineUnavailable::ReceiveLost));
    }

    #[test]
    fn differs_ignores_the_source_timestamp_and_missing_values() {
        let sample = |value: Option<bool>, t| Sample {
            resolved: true,
            quality: scada_alarm::Quality::Good,
            value: value.map(scada_alarm::TagValue::Bool),
            source_timestamp_ms: Some(t),
        };
        assert!(!differs(&sample(Some(true), 1), &sample(Some(true), 2)));
        assert!(differs(&sample(Some(true), 1), &sample(Some(false), 1)));
        assert!(!differs(&sample(None, 1), &sample(Some(false), 1)));
    }
}
