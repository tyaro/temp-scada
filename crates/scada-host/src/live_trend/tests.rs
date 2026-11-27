use super::*;
use scada_historian::recorder::{
    ClockError, ClockReading, Recorder, RecorderClock, RecorderConfig, RecorderState,
    SnapshotSource, SourceError,
};
use scada_historian::store::query::{CancellationToken, QueryControl};
use scada_historian::store::{
    IdentityDescriptor, Source, SourceEpoch, SqliteStore, StoreIdentity, ValueType,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const WALL: i64 = 1_700_000_000_000;

fn plan() -> PlanRef {
    PlanRef {
        plan_id: "plan-a".into(),
        revision: 1,
    }
}

fn member(n: usize, value_type: ValueType) -> IdentityDescriptor {
    IdentityDescriptor {
        series_id: format!("series-{n}"),
        hub_instance_id: "hub-a".into(),
        incarnation_id: format!("incarnation-{n}"),
        external_name: format!("Line1.Tag{n}"),
        segment_id: format!("segment-{n}"),
        value_type,
        unit: None,
        period_ms: 1000,
        source: Source::Real,
    }
}

fn spec(session: &str) -> SessionSpec {
    SessionSpec {
        session_id: session.into(),
        members: vec![member(0, ValueType::Number), member(1, ValueType::Bool)],
    }
}

fn observation(series: &str, value: Option<ObservationValue>, quality: Quality) -> TickObservation {
    TickObservation {
        series_id: series.into(),
        // Frozen and far off the recorder's clock: never the live time.
        source_time_ms: Some(100),
        quality: Some(quality),
        source: Some(Source::Real),
        value,
        reason: None,
        source_epoch: Some(SourceEpoch {
            hub_instance_id: "hub-a".into(),
            run_id: Some(1),
            catalog_revision: 1,
            sdk_generation: 1,
        }),
    }
}

fn tick(session: &str, sequence: u64, epoch: &str) -> Tick {
    Tick {
        session_id: session.into(),
        sequence,
        clock_epoch: epoch.into(),
        sample_time_ms: WALL + sequence as i64 * 1000,
        ingested_at_ms: WALL + sequence as i64 * 1000,
        observations: vec![
            observation(
                "series-0",
                Some(ObservationValue::Number(sequence as f64)),
                Quality::Good,
            ),
            observation(
                "series-1",
                Some(ObservationValue::Bool(true)),
                Quality::Good,
            ),
        ],
    }
}

fn series(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|s| (*s).to_owned()).collect()
}

/// Everything queued for `pump`'s subscription now.
fn drain(feed: &LiveFeed, pump: &LivePump) -> Vec<LiveEvent> {
    let mut events = Vec::new();
    while let Ok(Some(event)) = feed.next(pump.subscription_id()) {
        events.push(event);
    }
    events
}

fn batch_sequences(events: &[LiveEvent]) -> Vec<u64> {
    events
        .iter()
        .filter_map(|e| match e {
            LiveEvent::Batch { sequence, .. } => Some(*sequence),
            _ => None,
        })
        .collect()
}

fn breaks(events: &[LiveEvent]) -> Vec<(Vec<String>, LiveBreakReason)> {
    events
        .iter()
        .filter_map(|e| match e {
            LiveEvent::Break {
                series_ids, reason, ..
            } => Some((series_ids.clone(), *reason)),
            _ => None,
        })
        .collect()
}

#[test]
fn only_the_demanded_series_of_the_subscribed_plan_are_sent() {
    let feed = LiveFeed::new();
    feed.begin(&spec("s1"), &plan());
    let pump = feed.subscribe("applied:1", plan(), series(&["series-1"]));
    feed.committed(&tick("s1", 1, "e"));
    let events = drain(&feed, &pump);
    assert_eq!(
        events,
        [LiveEvent::Batch {
            subscription_id: pump.subscription_id().into(),
            context_id: "applied:1".into(),
            session_id: "s1".into(),
            sequence: 1,
            first_sequence: 1,
            items: vec![LiveItem {
                series_id: "series-1".into(),
                segment_id: "segment-1".into(),
                t_ms: WALL + 1000,
                // bool as 0/1
                value: Some(1.0),
            }],
        }]
    );
    let value = serde_json::to_value(&events[0]).unwrap();
    assert_eq!(value["kind"], "batch");
    assert_eq!(value["items"][0]["tMs"], WALL + 1000);
    assert!(value["items"][0].get("sourceTimeMs").is_none());

    // Another plan's session: nothing, though the series IDs match.
    let other = feed.subscribe(
        "applied:2",
        PlanRef {
            plan_id: "plan-a".into(),
            revision: 2,
        },
        series(&["series-0", "series-1"]),
    );
    feed.committed(&tick("s1", 2, "e"));
    assert_eq!(drain(&feed, &other), []);
    // The replaced subscription is gone.
    assert!(feed.next(pump.subscription_id()).is_err());
    // A tick of a session that is not the begun one: nothing.
    let third = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    feed.committed(&tick("s0", 3, "e"));
    assert_eq!(drain(&feed, &third), []);
}

#[test]
fn a_bad_or_missing_value_is_null_and_the_time_is_the_sample_time() {
    let feed = LiveFeed::new();
    feed.begin(&spec("s1"), &plan());
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0", "series-1"]));
    let mut bad = tick("s1", 1, "e");
    bad.observations[0].quality = Some(Quality::Bad);
    bad.observations[1].value = None;
    bad.observations[1].reason = Some(scada_historian::store::Reason::Unresolved);
    feed.committed(&bad);
    let LiveEvent::Batch { items, .. } = &drain(&feed, &pump)[0] else {
        panic!("a batch");
    };
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .all(|i| i.value.is_none() && i.t_ms == WALL + 1000));
}

#[test]
fn an_overflow_drops_the_oldest_and_sends_their_series_a_break_first() {
    let feed = LiveFeed::new();
    feed.begin(&spec("s1"), &plan());
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    let total = LIVE_QUEUE_LIMIT as u64 + 5;
    for n in 1..=total {
        feed.committed(&tick("s1", n, "e"));
    }
    let events = drain(&feed, &pump);
    assert_eq!(
        breaks(&events[..1]),
        [(vec!["series-0".to_owned()], LiveBreakReason::Overflow)]
    );
    assert_eq!(batch_sequences(&events), (6..=total).collect::<Vec<_>>());
    assert_eq!(events.len(), LIVE_QUEUE_LIMIT + 1);
    // firstSequence stays the session's first, not the first kept.
    assert!(matches!(
        events[1],
        LiveEvent::Batch {
            first_sequence: 1,
            ..
        }
    ));
}

#[test]
fn a_session_change_drops_the_old_items_and_breaks_every_series() {
    let feed = LiveFeed::new();
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0", "series-1"]));
    feed.begin(&spec("s1"), &plan());
    feed.committed(&tick("s1", 1, "e1"));
    feed.committed(&tick("s1", 2, "e1"));
    // Stopped before the pump ran: the old session's items are dropped.
    feed.end("s1");
    // A late tick of the ended session is never delivered.
    feed.committed(&tick("s1", 3, "e1"));
    let events = drain(&feed, &pump);
    assert_eq!(
        breaks(&events),
        [(
            vec!["series-0".to_owned(), "series-1".to_owned()],
            LiveBreakReason::Session
        )]
    );
    assert_eq!(batch_sequences(&events), Vec::<u64>::new());

    feed.begin(&spec("s2"), &plan());
    feed.committed(&tick("s2", 1, "e2"));
    let events = drain(&feed, &pump);
    assert!(matches!(
        &events[..],
        [LiveEvent::Batch { session_id, sequence: 1, first_sequence: 1, .. }] if session_id == "s2"
    ));

    // A session begun without the old one's end also breaks every series.
    feed.committed(&tick("s2", 2, "e2"));
    feed.begin(&spec("s3"), &plan());
    let events = drain(&feed, &pump);
    assert_eq!(batch_sequences(&events), Vec::<u64>::new());
    assert_eq!(breaks(&events).len(), 1);
    assert_eq!(breaks(&events)[0].1, LiveBreakReason::Session);
}

/// The owner's order on #401: subscribe revision A; consume its stop and
/// read A again; apply and record revision B. The old subscription learns
/// its context changed (and gets nothing of B), and a new one on B delivers.
#[test]
fn a_recording_of_another_revision_tells_the_old_subscription_its_context_changed() {
    let feed = LiveFeed::new();
    let a = plan();
    let b = PlanRef {
        plan_id: "plan-a".into(),
        revision: 2,
    };
    feed.begin(&spec("s1"), &a);
    let old = feed.subscribe("applied:1", a.clone(), series(&["series-0"]));
    feed.committed(&tick("s1", 1, "e"));
    assert_eq!(batch_sequences(&drain(&feed, &old)), [1]);
    feed.end("s1");
    assert_eq!(breaks(&drain(&feed, &old))[0].1, LiveBreakReason::Session);
    // Read A again: still a subscription of A while nothing records.
    let old = feed.subscribe("applied:1", a, series(&["series-0"]));
    assert_eq!(drain(&feed, &old), []);

    feed.begin(&spec("s2"), &b);
    feed.committed(&tick("s2", 1, "e"));
    feed.end("s2");
    assert_eq!(
        drain(&feed, &old),
        [LiveEvent::ContextChanged {
            subscription_id: old.subscription_id().into(),
            context_id: "applied:1".into(),
        }]
    );

    let new = feed.subscribe("applied:2", b.clone(), series(&["series-0"]));
    feed.begin(&spec("s3"), &b);
    feed.committed(&tick("s3", 1, "e"));
    let events = drain(&feed, &new);
    assert!(matches!(
        &events[..],
        [LiveEvent::Batch { context_id, session_id, .. }] if context_id == "applied:2" && session_id == "s3"
    ));
}

/// `ContextChanged` survives an overflow: nothing is queued after it.
#[test]
fn a_context_change_is_never_dropped_by_an_overflow() {
    let feed = LiveFeed::new();
    feed.begin(&spec("s1"), &plan());
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    for sequence in 1..=(LIVE_QUEUE_LIMIT as u64 + 5) {
        feed.committed(&tick("s1", sequence, "e"));
    }
    let other = PlanRef {
        plan_id: "plan-b".into(),
        revision: 1,
    };
    feed.begin(&spec("s2"), &other);
    for sequence in 1..=(LIVE_QUEUE_LIMIT as u64 + 5) {
        feed.committed(&tick("s2", sequence, "e"));
    }
    feed.end("s2");
    let events = drain(&feed, &pump);
    assert!(matches!(
        events.last(),
        Some(LiveEvent::ContextChanged { .. })
    ));
    assert_eq!(batch_sequences(&events), Vec::<u64>::new());
}

#[test]
fn a_clock_epoch_change_breaks_the_series_before_the_new_epoch() {
    let feed = LiveFeed::new();
    feed.begin(&spec("s1"), &plan());
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    feed.committed(&tick("s1", 1, "e1"));
    feed.committed(&tick("s1", 2, "e2"));
    let events = drain(&feed, &pump);
    assert_eq!(batch_sequences(&events), [1, 2]);
    assert!(matches!(events[0], LiveEvent::Batch { .. }));
    assert_eq!(
        breaks(&events),
        [(vec!["series-0".to_owned()], LiveBreakReason::ClockEpoch)]
    );
    assert!(matches!(events[1], LiveEvent::Break { .. }));
}

#[test]
fn a_slow_receiver_does_not_delay_the_tap() {
    let feed = LiveFeed::new();
    feed.begin(&spec("s1"), &plan());
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    let (entered, entered_rx) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = std::sync::Mutex::new(release_rx);
    // The pump on its own thread, as the desktop host's async runtime has.
    let task = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(pump.run(move |_| {
            let _ = entered.send(());
            // The receiver is stuck until the test releases it.
            let _ = release_rx.lock().unwrap().recv();
            true
        }));
    });
    feed.committed(&tick("s1", 1, "e"));
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // The emit of tick 1 is blocked: the ticks after it still return at once.
    let started = Instant::now();
    for n in 2..=1000 {
        feed.committed(&tick("s1", n, "e"));
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    let inner = feed.lock();
    let queued = inner.subscription.as_ref().unwrap();
    assert_eq!(queued.queue.len(), LIVE_QUEUE_LIMIT);
    assert!(queued.overflowed.contains("series-0"));
    drop(inner);
    drop(release);
    feed.unsubscribe("other");
    let id = feed.lock().subscription.as_ref().unwrap().id.clone();
    feed.unsubscribe(&id);
    task.join().unwrap();
}

#[tokio::test]
async fn a_pump_emits_in_order_and_ends_with_its_subscription() {
    let feed = LiveFeed::new();
    feed.begin(&spec("s1"), &plan());
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    let id = pump.subscription_id().to_owned();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(pump.run(move |event| sent.send(event).is_ok()));
    feed.committed(&tick("s1", 1, "e"));
    feed.committed(&tick("s1", 2, "e"));
    let mut sequences = Vec::new();
    while sequences.len() < 2 {
        if let LiveEvent::Batch { sequence, .. } = received.recv().await.unwrap() {
            sequences.push(sequence);
        }
    }
    assert_eq!(sequences, [1, 2]);
    assert!(feed.unsubscribe(&id));
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();

    // A failed emit ends the subscription.
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    let id = pump.subscription_id().to_owned();
    feed.committed(&tick("s1", 3, "e"));
    pump.run(|_| false).await;
    assert!(!feed.unsubscribe(&id));
}

// The Recorder with a temporary SQLite store: what it commits is delivered.

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Wall time = `WALL` + monotonic; waits return at the deadline.
struct Clock(u64);
impl RecorderClock for Clock {
    fn read(&mut self) -> Result<ClockReading, ClockError> {
        Ok(ClockReading {
            monotonic_ms: self.0,
            wall_time_ms: WALL + self.0 as i64,
            clock_epoch: "epoch-1".into(),
        })
    }
    fn wait_until(&mut self, deadline: u64, _: &CancellationToken) -> Result<(), ClockError> {
        self.0 = self.0.max(deadline);
        Ok(())
    }
}

/// The same value with the same frozen source time on every capture.
struct Frozen;
impl SnapshotSource for Frozen {
    fn capture(&mut self) -> Result<Vec<TickObservation>, SourceError> {
        Ok(vec![
            observation(
                "series-0",
                Some(ObservationValue::Number(42.5)),
                Quality::Good,
            ),
            observation(
                "series-1",
                Some(ObservationValue::Bool(false)),
                Quality::Good,
            ),
        ])
    }
}

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}

fn read(store: &SqliteStore) -> Value {
    store
        .reader()
        .unwrap()
        .query_raw(
            &json!({"version": 1, "kind": "query", "requestId": "live",
                "seriesIds": ["series-0"], "fromMs": WALL - 1000, "toMs": WALL + 10_000,
                "mode": "raw", "maxPointsPerSeries": 100}),
            &control(),
        )
        .unwrap()
}

#[test]
fn the_delivered_items_are_the_committed_records_and_confirm_the_history() {
    let dir = TempDir::new();
    let mut store = SqliteStore::create(
        dir.0.join("store"),
        StoreIdentity {
            store_id: "store-a".into(),
            deployment_id: "deployment-a".into(),
        },
    )
    .unwrap();
    let mut clock = Clock(0);
    let config = RecorderConfig {
        session: spec("recording-1"),
        plan: plan(),
        period_ms: 1000,
        slot_count: None,
        max_clock_skew_ms: 5,
    };
    let feed = LiveFeed::new();
    let pump = feed.subscribe("applied:1", plan(), series(&["series-0"]));
    let mut recorder = Recorder::start(&mut store, config.clone(), &mut clock).unwrap();
    feed.begin(&config.session, &config.plan);

    // Before the first commit: unknown coverage and no watermark.
    let before = read(&store);
    let series = &before["series"][0];
    assert_eq!(series["watermark"], Value::Null, "{before}");
    assert_eq!(series["raw"], json!([]));
    assert!(
        series["coverage"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["reason"] == "unknownCoverage"),
        "{before}"
    );
    assert_eq!(drain(&feed, &pump), []);

    let cancel = CancellationToken::default();
    for _ in 0..3 {
        let report =
            recorder.step_with_commit(&mut store, &mut Frozen, &mut clock, &cancel, &mut |tick| {
                feed.committed(tick)
            });
        assert_eq!(report.state, RecorderState::Running, "{report:?}");
    }
    let events = drain(&feed, &pump);
    assert_eq!(batch_sequences(&events), [1, 2, 3]);

    // The re-read after the delivery is confirmed through the last sequence.
    let after = read(&store);
    let series = &after["series"][0];
    let LiveEvent::Batch {
        session_id,
        sequence,
        first_sequence,
        ..
    } = &events[2]
    else {
        panic!("a batch");
    };
    assert_eq!(*first_sequence, 1);
    assert_eq!(
        series["watermark"],
        json!({"sessionId": session_id, "committedThrough": sequence})
    );
    let raw = series["raw"].as_array().unwrap();
    assert_eq!(raw.len(), 3);
    for (event, record) in events.iter().zip(raw) {
        let LiveEvent::Batch {
            session_id,
            sequence,
            items,
            ..
        } = event
        else {
            panic!("a batch");
        };
        assert_eq!(record["recordId"]["sessionId"], json!(session_id));
        assert_eq!(record["recordId"]["sequence"], json!(sequence));
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(record["seriesId"], json!(item.series_id));
        assert_eq!(record["segmentId"], json!(item.segment_id));
        assert_eq!(record["value"], json!(item.value.unwrap()));
        // The observation time, though the source time stayed at 100.
        assert_eq!(record["sampleTimeMs"], json!(item.t_ms));
        assert_eq!(record["sourceTimeMs"], 100);
    }
    // One item per period although the source time never moved.
    let times: Vec<i64> = events
        .iter()
        .filter_map(|e| match e {
            LiveEvent::Batch { items, .. } => Some(items[0].t_ms),
            _ => None,
        })
        .collect();
    assert_eq!(
        times.windows(2).map(|w| w[1] - w[0]).collect::<Vec<_>>(),
        [1000, 1000]
    );

    // A stop ends the session: a break mark, then nothing of it.
    let report = recorder.stop(&mut store, &mut clock);
    assert_eq!(report.state, RecorderState::Stopped);
    feed.end(&config.session.session_id);
    let events = drain(&feed, &pump);
    assert_eq!(breaks(&events).len(), 1);
    assert_eq!(batch_sequences(&events), Vec::<u64>::new());
}
