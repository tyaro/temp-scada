use super::*;
use crate::store::{
    evidence::PlanRef, query::QueryControl, test_support::*, Quality, Reason, SessionState, Source,
    TickObservation,
};
use std::{cell::RefCell, rc::Rc, time::Duration};
mod failures;

#[derive(Default)]
struct Time {
    mono: u64,
    wall: i64,
    wake_jitter: u64,
    read_cost: u64,
    deadlines: Vec<u64>,
}
struct FakeClock(Rc<RefCell<Time>>);
impl FakeClock {
    fn new() -> Self {
        Self(Rc::new(RefCell::new(Time {
            wall: 10_000,
            ..Time::default()
        })))
    }
    fn advance(&self, ms: u64) {
        let mut t = self.0.borrow_mut();
        t.mono += ms;
        t.wall += ms as i64;
    }
}
impl RecorderClock for FakeClock {
    fn read(&mut self) -> Result<ClockReading, ClockError> {
        let cost = self.0.borrow().read_cost;
        self.advance(cost);
        let t = self.0.borrow();
        Ok(ClockReading {
            monotonic_ms: t.mono,
            wall_time_ms: t.wall,
            clock_epoch: "epoch".into(),
        })
    }
    fn wait_until(&mut self, deadline: u64, cancel: &CancellationToken) -> Result<(), ClockError> {
        if cancel.is_cancelled() {
            return Err(ClockError::Cancelled);
        }
        let mut t = self.0.borrow_mut();
        t.deadlines.push(deadline);
        let new = t.mono.max(deadline) + t.wake_jitter;
        let delta = new - t.mono;
        t.mono = new;
        t.wall += delta as i64;
        Ok(())
    }
}
struct Latest {
    time: Rc<RefCell<Time>>,
    capture_cost: u64,
    observations: Vec<TickObservation>,
    cancel: Option<CancellationToken>,
}
impl Latest {
    fn new(clock: &FakeClock) -> Self {
        Self {
            time: clock.0.clone(),
            capture_cost: 0,
            observations: tick("recording", 1, 1000).observations,
            cancel: None,
        }
    }
}
impl SnapshotSource for Latest {
    fn capture(&mut self) -> Result<Vec<TickObservation>, SourceError> {
        let mut t = self.time.borrow_mut();
        t.mono += self.capture_cost;
        t.wall += self.capture_cost as i64;
        if let Some(c) = &self.cancel {
            c.cancel();
        }
        Ok(self.observations.clone())
    }
}
fn config(n: Option<u64>) -> RecorderConfig {
    RecorderConfig {
        session: spec("recording"),
        plan: PlanRef {
            plan_id: "plan".into(),
            revision: 1,
        },
        period_ms: 1000,
        slot_count: n,
        max_clock_skew_ms: 5,
    }
}
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}

#[test]
fn one_hour_keeps_3600_commits_with_wake_capture_and_processing_cost_instead_of_accumulating_drift()
{
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    clock.0.borrow_mut().read_cost = 7;
    clock.0.borrow_mut().wake_jitter = 3;
    let mut source = Latest::new(&clock);
    source.capture_cost = 11;
    let mut recorder = Recorder::start(&mut store, config(Some(3600)), &mut clock).unwrap();
    for slot in 0..3600 {
        let report = recorder.step(
            &mut store,
            &mut source,
            &mut clock,
            &CancellationToken::default(),
        );
        assert_eq!(report.state, RecorderState::Running, "{report:?}");
        let observed = report.observation.unwrap();
        assert_eq!(observed.slot, slot);
        assert_eq!(observed.scheduled_monotonic_ms, 7 + slot * 1000);
        assert!(observed.lateness_ms < 1000);
        assert_eq!(
            observed.observed.wall_time_ms as u64,
            10_000 + observed.observed.monotonic_ms
        );
        assert!(report.tick_receipt.is_some());
        assert!(report.gap_receipt.is_none());
    }
    assert_eq!(
        recorder.counters(),
        RecorderCounters {
            planned_slots: Some(3600),
            captured_snapshots: 3600,
            committed_ticks: 3600,
            resolved_slots: 3600,
            missed_slots: 0,
            committed_gaps: 0
        }
    );
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert!(matches!(
        report.terminal.unwrap(),
        TerminalReport {
            cause: StopCause::Completed,
            cleanup: CleanupOutcome::Closed(_)
        }
    ));
    assert_eq!(count(&store, "observations"), 7200);
    let per_series: (i64,i64)=connection(&store).query_row("SELECT min(points),max(points) FROM (SELECT count(*) AS points FROM observations GROUP BY series_id)",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(per_series, (3600, 3600));
    let (first, last): (i64, i64) = connection(&store)
        .query_row(
            "SELECT min(sample_time_ms),max(sample_time_ms) FROM observations",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(first >= 10_007 && last < 3_610_007);
    assert_eq!(clock.0.borrow().deadlines[3599], 3_599_007);
    // Same 28 ms per-cycle work with a relative 1000 ms wait drifts past the
    // half-open hour; the anchored recorder above retains every planned slot.
    let relative_count = (3_600_000u64 - 1) / (1000 + 28) + 1;
    assert!(relative_count < 3600);
    assert!(
        recorder
            .step(
                &mut store,
                &mut source,
                &mut clock,
                &CancellationToken::default()
            )
            .already_stopped
    );
}

#[test]
fn slot_overruns_sample_once_keep_real_observation_time_and_persist_a_nonoverlapping_gap() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    let mut recorder = Recorder::start(&mut store, config(Some(10)), &mut clock).unwrap();
    let first = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(first.observation.unwrap().slot, 0);
    clock.advance(3500);
    let next = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(
        next.observation.unwrap(),
        ObservedSlot {
            slot: 3,
            scheduled_monotonic_ms: 3000,
            observed: ClockReading {
                monotonic_ms: 3500,
                wall_time_ms: 13_500,
                clock_epoch: "epoch".into()
            },
            lateness_ms: 500
        }
    );
    assert_eq!(next.counters.missed_slots, 2);
    assert_eq!(next.counters.committed_ticks, 2);
    assert!(next.gap_receipt.is_some());
    let (from, to): (i64, i64) = connection(&store)
        .query_row("SELECT from_ms,to_ms FROM recording_gaps", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((from, to), (10_001, 13_500));
    let q = serde_json::json!({"version":1,"kind":"query","requestId":"recorded","seriesIds":["number"],"fromMs":10000,"toMs":14000,"mode":"raw","maxPointsPerSeries":4});
    let result = store.reader().unwrap().query_raw(&q, &control()).unwrap();
    assert_eq!(result["series"][0]["raw"].as_array().unwrap().len(), 2);
    assert!(result["series"][0]["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["reason"] == "samplingMissed"));
    let mut q = q;
    q["mode"] = "minmax".into();
    q["maxPointsPerSeries"] = 2.into();
    assert!(store.reader().unwrap().query_minmax(&q, &control()).is_ok());
    let next = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(next.observation.unwrap().slot, 4);
    assert_eq!(next.counters.committed_ticks, 3);
    assert_eq!(next.tick_receipt.unwrap().committed_through, 3);
}

#[test]
fn capture_boundary_and_finite_horizon_never_backdate_or_pad_records() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    source.capture_cost = 1000;
    let mut recorder = Recorder::start(&mut store, config(Some(3)), &mut clock).unwrap();
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(report.observation.unwrap().slot, 1);
    assert_eq!(report.counters.missed_slots, 1);
    assert_eq!(report.tick_receipt.unwrap().committed_through, 1);
    let done = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert!(matches!(done.terminal.unwrap().cause, StopCause::Completed));
    assert!(done.tick_receipt.is_none());
    assert!(done.observation.is_none());
    assert_eq!(done.counters.captured_snapshots, 2);
    assert_eq!(done.counters.committed_ticks, 1);
    assert_eq!(done.counters.missed_slots, 2);
    assert_eq!(done.counters.resolved_slots, 3);
    assert_eq!(count(&store, "observations"), 2);
}

#[test]
fn repeated_source_time_and_null_observations_are_distinct_valid_periodic_samples() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    let mut recorder = Recorder::start(&mut store, config(Some(4)), &mut clock).unwrap();
    for (quality, source_kind, reason) in [
        (Quality::Bad, Source::Real, Reason::Bad),
        (Quality::Stale, Source::Real, Reason::Stale),
    ] {
        for o in &mut source.observations {
            o.quality = Some(quality);
            o.source = Some(source_kind);
            o.value = None;
            o.reason = Some(reason);
        }
        assert!(recorder
            .step(
                &mut store,
                &mut source,
                &mut clock,
                &CancellationToken::default()
            )
            .tick_receipt
            .is_some());
    }
    source.observations = tick("recording", 1, 1000).observations;
    for _ in 0..2 {
        assert!(recorder
            .step(
                &mut store,
                &mut source,
                &mut clock,
                &CancellationToken::default()
            )
            .tick_receipt
            .is_some());
    }
    assert_eq!(recorder.counters().committed_ticks, 4);
    recorder.stop(&mut store, &mut clock);
    let mut sim = config(Some(1));
    sim.session.session_id = "sim".into();
    sim.plan.plan_id = "sim-plan".into();
    for member in &mut sim.session.members {
        member.source = Source::Simulation;
        member.segment_id = "sim-segment".into();
    }
    for obs in &mut source.observations {
        obs.source = Some(Source::Simulation);
        obs.value = None;
        obs.reason = Some(Reason::SimulationExcluded);
    }
    let mut recorder = Recorder::start(&mut store, sim, &mut clock).unwrap();
    assert!(recorder
        .step(
            &mut store,
            &mut source,
            &mut clock,
            &CancellationToken::default()
        )
        .tick_receipt
        .is_some());
    recorder.stop(&mut store, &mut clock);
    let mut unknown = config(Some(1));
    unknown.session.session_id = "unknown".into();
    unknown.plan.plan_id = "unknown-plan".into();
    for member in &mut unknown.session.members {
        member.source = Source::Unknown;
        member.segment_id = "unknown-segment".into();
    }
    for obs in &mut source.observations {
        obs.source = Some(Source::Unknown);
        obs.quality = Some(Quality::Unknown);
        obs.reason = Some(Reason::UnknownSource);
    }
    let mut recorder = Recorder::start(&mut store, unknown, &mut clock).unwrap();
    assert!(recorder
        .step(
            &mut store,
            &mut source,
            &mut clock,
            &CancellationToken::default()
        )
        .tick_receipt
        .is_some());
    assert_eq!(count(&store, "observations"), 12);
    let times: i64 = connection(&store)
        .query_row(
            "SELECT count(DISTINCT source_time_ms) FROM observations",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(times, 1);
}

#[test]
fn early_wake_reuses_the_same_deadline_without_sampling_an_unreached_slot() {
    struct Early {
        clock: FakeClock,
        early: bool,
        waits: Vec<u64>,
    }
    impl RecorderClock for Early {
        fn read(&mut self) -> Result<ClockReading, ClockError> {
            self.clock.read()
        }
        fn wait_until(
            &mut self,
            deadline: u64,
            cancel: &CancellationToken,
        ) -> Result<(), ClockError> {
            self.waits.push(deadline);
            if self.early {
                self.early = false;
                Ok(())
            } else {
                self.clock.wait_until(deadline, cancel)
            }
        }
    }
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    let mut recorder = Recorder::start(&mut store, config(Some(2)), &mut clock).unwrap();
    recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    let mut early = Early {
        clock,
        early: true,
        waits: Vec::new(),
    };
    let next = recorder.step(
        &mut store,
        &mut source,
        &mut early,
        &CancellationToken::default(),
    );
    assert_eq!(early.waits, vec![1000, 1000]);
    assert_eq!(next.observation.unwrap().slot, 1);
    assert_eq!(next.counters.captured_snapshots, 2);
    assert_eq!(next.counters.committed_ticks, 2);
}
