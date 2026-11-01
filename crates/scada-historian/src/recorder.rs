//! One fixed recording group driven by absolute monotonic deadlines.
mod clock;
mod types;
use crate::store::{
    self,
    evidence::{ClockStamp, GapEvidence, GapReason, TimedStart},
    query::CancellationToken,
    SqliteStore, StoreError, Tick, MAX_SAFE,
};
pub use clock::SystemRecorderClock;
pub use types::*;

pub struct Recorder {
    config: RecorderConfig,
    anchor: ClockReading,
    last_read: ClockReading,
    last_sample_ms: Option<i64>,
    next_slot: u64,
    counters: RecorderCounters,
    stopped: bool,
}

impl Recorder {
    pub fn start(
        store: &mut SqliteStore,
        config: RecorderConfig,
        clock: &mut impl RecorderClock,
    ) -> Result<Self, RecorderStartError> {
        let config = config.validated()?;
        if store
            .session_status(&config.session.session_id)
            .map_err(RecorderStartError::Store)?
            .is_some()
        {
            return Err(RecorderStartError::InvalidConfig);
        }
        let anchor = clock.read().map_err(RecorderStartError::Clock)?;
        valid_reading(&anchor).map_err(RecorderStartError::Clock)?;
        if config.slot_count.is_some_and(|n| {
            n.checked_mul(config.period_ms)
                .and_then(|d| anchor.monotonic_ms.checked_add(d))
                .is_none()
        }) {
            return Err(RecorderStartError::InvalidConfig);
        }
        store
            .begin_timed_session(
                config.session.clone(),
                TimedStart {
                    clock_epoch: anchor.clock_epoch.clone(),
                    at_ms: anchor.wall_time_ms,
                    plan: config.plan.clone(),
                },
            )
            .map_err(RecorderStartError::Store)?;
        Ok(Self {
            counters: RecorderCounters {
                planned_slots: config.slot_count,
                ..RecorderCounters::default()
            },
            config,
            last_read: anchor.clone(),
            anchor,
            last_sample_ms: None,
            next_slot: 0,
            stopped: false,
        })
    }

    pub fn counters(&self) -> RecorderCounters {
        self.counters
    }

    pub fn step(
        &mut self,
        store: &mut SqliteStore,
        source: &mut impl SnapshotSource,
        clock: &mut impl RecorderClock,
        cancel: &CancellationToken,
    ) -> RecorderReport {
        let mut report = self.report();
        if self.stopped {
            report.already_stopped = true;
            return report;
        }
        if cancel.is_cancelled() {
            return self.stop_with_cause(store, clock, StopCause::Cancelled, report);
        }
        let Some(deadline) = self.deadline(self.next_slot) else {
            return self.finish(store, StopCause::ArithmeticOverflow, None, report);
        };
        let now = loop {
            if let Err(error) = clock.wait_until(deadline, cancel) {
                return if error == ClockError::Cancelled {
                    self.stop_with_cause(store, clock, StopCause::Cancelled, report)
                } else {
                    self.finish(store, StopCause::Clock(error), None, report)
                };
            }
            let now = match self.read(clock) {
                Ok(now) => now,
                Err(e) => return self.finish(store, StopCause::Clock(e), None, report),
            };
            if cancel.is_cancelled() {
                return self.finish(store, StopCause::Cancelled, Some(now), report);
            }
            if now.monotonic_ms >= deadline {
                break now;
            }
        };
        if self.at_horizon(&now) {
            return self.complete(store, now, report);
        }
        let observations = match source.capture() {
            Ok(value) => value,
            Err(e) => return self.finish(store, StopCause::Source(e), None, report),
        };
        let Some(captured) = self
            .counters
            .captured_snapshots
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
        else {
            return self.finish(store, StopCause::ArithmeticOverflow, None, report);
        };
        self.counters.captured_snapshots = captured;
        let observed = match self.read(clock) {
            Ok(now) => now,
            Err(e) => return self.finish(store, StopCause::Clock(e), None, report),
        };
        if cancel.is_cancelled() {
            return self.finish(store, StopCause::Cancelled, Some(observed), report);
        }
        if self.at_horizon(&observed) {
            return self.complete(store, observed, report);
        }
        let slot = (observed.monotonic_ms - self.anchor.monotonic_ms) / self.config.period_ms;
        let Some(next) = slot.checked_add(1).filter(|n| *n <= MAX_SAFE) else {
            return self.finish(store, StopCause::ArithmeticOverflow, None, report);
        };
        let Some(sequence) = self
            .counters
            .committed_ticks
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
        else {
            return self.finish(store, StopCause::ArithmeticOverflow, None, report);
        };
        let missed = slot - self.next_slot;
        self.next_slot = next;
        self.counters.resolved_slots = next;
        self.counters.missed_slots += missed;
        let scheduled = self
            .deadline(slot)
            .expect("slot derived from an in-range clock reading");
        report.observation = Some(ObservedSlot {
            slot,
            scheduled_monotonic_ms: scheduled,
            lateness_ms: observed.monotonic_ms - scheduled,
            observed: observed.clone(),
        });
        let tick = Tick {
            session_id: self.config.session.session_id.clone(),
            sequence,
            clock_epoch: observed.clock_epoch.clone(),
            sample_time_ms: observed.wall_time_ms,
            ingested_at_ms: observed.wall_time_ms,
            observations,
        };
        let tick = match tick.validated(&self.config.session) {
            Ok((tick, _)) => tick,
            Err(_) => {
                return self.finish(
                    store,
                    StopCause::InvalidObservation("snapshot violates the recording group contract"),
                    Some(observed),
                    report,
                )
            }
        };
        if missed > 0 {
            if let Err(error) = self.record_gap(store, &observed, &mut report) {
                return self.finish(store, StopCause::Store(error), None, report);
            }
            if cancel.is_cancelled() {
                return self.finish(store, StopCause::Cancelled, Some(observed), report);
            }
        }
        match store.append_tick(tick) {
            Ok(receipt) => {
                self.counters.committed_ticks = sequence;
                self.last_sample_ms = Some(observed.wall_time_ms);
                report.tick_receipt = Some(receipt);
            }
            Err(error) => return self.finish(store, StopCause::Store(error), None, report),
        }
        if cancel.is_cancelled() {
            return self.stop_with_cause(store, clock, StopCause::Cancelled, report);
        }
        report.counters = self.counters;
        report
    }

    pub fn stop(
        &mut self,
        store: &mut SqliteStore,
        clock: &mut impl RecorderClock,
    ) -> RecorderReport {
        let mut report = self.report();
        if self.stopped {
            report.already_stopped = true;
            return report;
        }
        self.stop_with_cause(store, clock, StopCause::Requested, report)
    }

    fn deadline(&self, slot: u64) -> Option<u64> {
        slot.checked_mul(self.config.period_ms)
            .and_then(|d| self.anchor.monotonic_ms.checked_add(d))
    }
    fn at_horizon(&self, now: &ClockReading) -> bool {
        self.config
            .slot_count
            .is_some_and(|n| self.deadline(n).is_some_and(|d| now.monotonic_ms >= d))
    }
    fn read(&mut self, clock: &mut impl RecorderClock) -> Result<ClockReading, ClockError> {
        let now = clock.read()?;
        valid_reading(&now)?;
        if now.clock_epoch != self.anchor.clock_epoch {
            return Err(ClockError::EpochChanged);
        }
        let elapsed = now
            .monotonic_ms
            .checked_sub(self.last_read.monotonic_ms)
            .ok_or(ClockError::MonotonicRegressed)?;
        let wall = now.wall_time_ms as i128 - self.last_read.wall_time_ms as i128;
        if wall < 0 {
            return Err(ClockError::WallRegressed);
        }
        if wall.abs_diff(elapsed as i128) > self.config.max_clock_skew_ms as u128 {
            return Err(ClockError::SkewExceeded);
        }
        self.last_read = now.clone();
        Ok(now)
    }
    fn record_gap(
        &mut self,
        store: &mut SqliteStore,
        now: &ClockReading,
        report: &mut RecorderReport,
    ) -> Result<(), StoreError> {
        let from = self
            .last_sample_ms
            .map_or(self.anchor.wall_time_ms, |t| t + 1);
        if from < now.wall_time_ms {
            let receipt = store.record_gap(GapEvidence {
                session_id: self.config.session.session_id.clone(),
                gap_id: format!("missed-{}", self.next_slot),
                clock_epoch: now.clock_epoch.clone(),
                from_ms: from,
                to_ms: now.wall_time_ms,
                observed_at_ms: now.wall_time_ms,
                reason: GapReason::SamplingMissed,
            })?;
            self.counters.committed_gaps += 1;
            report.gap_receipt = Some(receipt);
        }
        Ok(())
    }
    fn complete(
        &mut self,
        store: &mut SqliteStore,
        now: ClockReading,
        mut report: RecorderReport,
    ) -> RecorderReport {
        let count = self
            .config
            .slot_count
            .expect("only finite recordings have a horizon");
        let missed = count - self.next_slot;
        self.next_slot = count;
        self.counters.resolved_slots = count;
        self.counters.missed_slots += missed;
        if missed > 0 {
            if let Err(error) = self.record_gap(store, &now, &mut report) {
                return self.finish(store, StopCause::Store(error), None, report);
            }
        }
        self.finish(store, StopCause::Completed, Some(now), report)
    }
    fn stop_with_cause(
        &mut self,
        store: &mut SqliteStore,
        clock: &mut impl RecorderClock,
        cause: StopCause,
        report: RecorderReport,
    ) -> RecorderReport {
        match self.read(clock) {
            Ok(now) => self.finish(store, cause, Some(now), report),
            Err(e) => self.finish(store, StopCause::Clock(e), None, report),
        }
    }
    fn finish(
        &mut self,
        store: &mut SqliteStore,
        cause: StopCause,
        now: Option<ClockReading>,
        mut report: RecorderReport,
    ) -> RecorderReport {
        self.stopped = true;
        let close = now.filter(|t| {
            t.wall_time_ms > self.anchor.wall_time_ms
                && self.last_sample_ms.is_none_or(|last| t.wall_time_ms > last)
        });
        let cleanup = if let Some(t) = close {
            match store.close_timed_session(
                &self.config.session.session_id,
                ClockStamp {
                    clock_epoch: t.clock_epoch,
                    at_ms: t.wall_time_ms,
                },
            ) {
                Ok(s) => CleanupOutcome::Closed(s),
                Err(e) => CleanupOutcome::Failed(e),
            }
        } else {
            match store.interrupt_session(&self.config.session.session_id) {
                Ok(s) => CleanupOutcome::Interrupted(s),
                Err(e) => CleanupOutcome::Failed(e),
            }
        };
        report.state = RecorderState::Stopped;
        report.counters = self.counters;
        report.terminal = Some(TerminalReport { cause, cleanup });
        report
    }
    fn report(&self) -> RecorderReport {
        RecorderReport {
            state: if self.stopped {
                RecorderState::Stopped
            } else {
                RecorderState::Running
            },
            already_stopped: false,
            counters: self.counters,
            observation: None,
            tick_receipt: None,
            gap_receipt: None,
            terminal: None,
        }
    }
}

fn valid_reading(now: &ClockReading) -> Result<(), ClockError> {
    if !store::id(&now.clock_epoch)
        || !(-(MAX_SAFE as i64)..=MAX_SAFE as i64).contains(&now.wall_time_ms)
    {
        return Err(ClockError::InvalidReading);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
