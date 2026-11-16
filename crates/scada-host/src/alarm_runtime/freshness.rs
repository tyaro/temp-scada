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
}

pub(super) struct Freshness {
    pub(super) config: FreshnessConfig,
    pub(super) clients: HubClients,
    reader: Option<Arc<RestClient>>,
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
            reader: None,
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
        if new_generation || !self.connected {
            self.epoch += 1;
        }
        self.connected = true;
        if self.live && !live {
            self.ticket = None;
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
        self.reread_lost = false;
        self.failures = 0;
        if self.streak.take().is_some() {
            self.report.send_replace(None);
        }
    }

    /// The subscription is replaced (apply or resubscription).
    pub(super) fn replaced(&mut self) {
        self.epoch += 1;
        self.ticket = None;
        self.reader = None;
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
        let reader = match &self.reader {
            Some(reader) => reader.clone(),
            None => match self.clients.make() {
                Some(client) => {
                    let reader = Arc::new(client);
                    self.reader = Some(reader.clone());
                    reader
                }
                None => return self.failure(now, wall),
            },
        };
        let (tx, rx) = oneshot::channel();
        let names: Vec<String> = tags.iter().cloned().collect();
        let timeout = self.config.reread_timeout;
        tokio::spawn(async move {
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
        });
        false
    }

    /// A reread failed or timed out. Returns `true` when ReceiveLost begins.
    pub(super) fn failure(&mut self, now: Instant, wall: i64) -> bool {
        self.reader = None;
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
        self.resubscribe_failures = 0;
        self.next_resubscribe = None;
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
        assert_eq!(report.borrow().map(|r| r.failures), Some(1));
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
