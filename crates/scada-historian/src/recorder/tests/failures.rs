use super::*;

#[test]
fn cancellation_during_capture_keeps_observation_count_without_committing_or_faking_close_time() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    let cancel = CancellationToken::default();
    source.cancel = Some(cancel.clone());
    let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
    let report = recorder.step(&mut store, &mut source, &mut clock, &cancel);
    assert_eq!(report.counters.captured_snapshots, 1);
    assert_eq!(report.counters.committed_ticks, 0);
    assert!(matches!(
        report.terminal.unwrap(),
        TerminalReport {
            cause: StopCause::Cancelled,
            cleanup: CleanupOutcome::Interrupted(_)
        }
    ));
    assert_eq!(count(&store, "observations"), 0);
    assert_eq!(
        store.session_status("recording").unwrap().unwrap().state,
        SessionState::Interrupted
    );
    let before = counter(&store);
    assert!(recorder.stop(&mut store, &mut clock).already_stopped);
    assert_eq!(counter(&store), before);
}

#[test]
fn configuration_and_start_never_reuse_a_session_or_overflow_the_horizon() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    for kind in 0..5 {
        let mut c = config(Some(2));
        match kind {
            0 => c.period_ms = 999,
            1 => c.slot_count = Some(0),
            2 => c.slot_count = Some(MAX_SAFE + 1),
            3 => c.max_clock_skew_ms = MAX_SAFE + 1,
            _ => c.session.members.clear(),
        };
        assert!(Recorder::start(&mut store, c, &mut clock).is_err());
        assert_eq!(counter(&store), 0);
    }
    let _recorder = Recorder::start(&mut store, config(Some(2)), &mut clock).unwrap();
    let before = counter(&store);
    assert!(matches!(
        Recorder::start(&mut store, config(Some(2)), &mut clock),
        Err(RecorderStartError::InvalidConfig)
    ));
    assert_eq!(counter(&store), before);
    let second = TempStore::new();
    let mut store = second.create();
    clock.0.borrow_mut().mono = u64::MAX;
    assert!(matches!(
        Recorder::start(&mut store, config(Some(1)), &mut clock),
        Err(RecorderStartError::InvalidConfig)
    ));
    assert_eq!(counter(&store), 0);
}

#[test]
fn wall_jumps_regressions_and_mono_regression_stop_without_inventing_gaps_or_end_time() {
    for kind in 0..4 {
        let directory = TempStore::new();
        let mut store = directory.create();
        let mut clock = FakeClock::new();
        let mut source = Latest::new(&clock);
        let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
        assert!(recorder
            .step(
                &mut store,
                &mut source,
                &mut clock,
                &CancellationToken::default()
            )
            .tick_receipt
            .is_some());
        {
            let mut t = clock.0.borrow_mut();
            match kind {
                0 => t.wall += 1000,
                1 => t.wall -= 1,
                2 => {}
                _ => t.wall = i64::MAX,
            };
        }
        if kind == 2 {
            recorder.step(
                &mut store,
                &mut source,
                &mut clock,
                &CancellationToken::default(),
            );
            clock.0.borrow_mut().mono = 999;
        }
        let report = recorder.stop(&mut store, &mut clock);
        let expected = match kind {
            0 => ClockError::SkewExceeded,
            1 => ClockError::WallRegressed,
            2 => ClockError::MonotonicRegressed,
            _ => ClockError::InvalidReading,
        };
        assert!(
            matches!(report.terminal.unwrap(),TerminalReport{cause:StopCause::Clock(e),cleanup:CleanupOutcome::Interrupted(_)} if e==expected)
        );
        assert_eq!(
            report.counters.committed_ticks,
            if kind == 2 { 2 } else { 1 }
        );
        assert_eq!(report.counters.committed_gaps, 0);
        assert!(store
            .session_evidence("recording")
            .unwrap()
            .unwrap()
            .end_ms
            .is_none());
    }
}

#[test]
fn epoch_changes_and_clock_read_errors_stop_before_capture() {
    struct BrokenClock {
        reading: Option<ClockReading>,
    }
    impl RecorderClock for BrokenClock {
        fn read(&mut self) -> Result<ClockReading, ClockError> {
            self.reading.clone().ok_or(ClockError::ReadingFailed)
        }
        fn wait_until(&mut self, _: u64, _: &CancellationToken) -> Result<(), ClockError> {
            Ok(())
        }
    }
    for epoch in [false, true] {
        let directory = TempStore::new();
        let mut store = directory.create();
        let mut clock = FakeClock::new();
        let mut source = Latest::new(&clock);
        let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
        let mut broken = BrokenClock {
            reading: epoch.then(|| ClockReading {
                monotonic_ms: 0,
                wall_time_ms: 10000,
                clock_epoch: "new-epoch".into(),
            }),
        };
        let report = recorder.step(
            &mut store,
            &mut source,
            &mut broken,
            &CancellationToken::default(),
        );
        assert!(matches!(
            report.terminal.unwrap().cause,
            StopCause::Clock(_)
        ));
        assert_eq!(report.counters.captured_snapshots, 0);
        assert_eq!(count(&store, "observations"), 0);
    }
}

#[test]
fn source_and_invalid_snapshot_failures_are_terminal_and_do_not_substitute_old_values() {
    struct Failed;
    impl SnapshotSource for Failed {
        fn capture(&mut self) -> Result<Vec<TickObservation>, SourceError> {
            Err(SourceError("unavailable"))
        }
    }
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
    let report = recorder.step(
        &mut store,
        &mut Failed,
        &mut clock,
        &CancellationToken::default(),
    );
    assert!(matches!(
        report.terminal.unwrap().cause,
        StopCause::Source(_)
    ));
    assert_eq!(report.counters.captured_snapshots, 0);
    let mut c = config(None);
    c.session.session_id = "second".into();
    let mut recorder = Recorder::start(&mut store, c, &mut clock).unwrap();
    let mut source = Latest::new(&clock);
    source.observations.pop();
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert!(matches!(
        report.terminal.unwrap().cause,
        StopCause::InvalidObservation(_)
    ));
    assert_eq!(report.counters.captured_snapshots, 1);
    assert_eq!(report.counters.committed_ticks, 0);
    assert_eq!(count(&store, "observations"), 0);
}

#[test]
fn gap_commit_survives_a_later_real_full_without_claiming_a_tick_and_reopen_interrupts() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
    recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    clock.advance(3500);
    connection(&store).execute_batch("CREATE TABLE recorder_pressure(value BLOB); CREATE TEMP TRIGGER recorder_full AFTER INSERT ON observations BEGIN INSERT INTO recorder_pressure VALUES(zeroblob(1048576)); END;").unwrap();
    let max: i64 = connection(&store)
        .query_row("PRAGMA max_page_count", [], |r| r.get(0))
        .unwrap();
    let pages: i64 = connection(&store)
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    connection(&store)
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert!(report.gap_receipt.is_some());
    assert!(report.tick_receipt.is_none());
    assert!(
        matches!(report.terminal.unwrap(),TerminalReport{cause:StopCause::Store(StoreError::Sqlite(ref e)),cleanup:CleanupOutcome::Failed(StoreError::NeedsReopen)} if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    );
    assert_eq!(report.counters.committed_ticks, 1);
    assert_eq!(report.counters.committed_gaps, 1);
    assert_eq!(count(&store, "observations"), 2);
    connection(&store)
        .pragma_update(None, "max_page_count", max)
        .unwrap();
    drop(store);
    let store = directory.open();
    assert_eq!(
        store.session_status("recording").unwrap().unwrap().state,
        SessionState::Interrupted
    );
    assert!(store
        .session_evidence("recording")
        .unwrap()
        .unwrap()
        .end_ms
        .is_none());
}

#[test]
fn cancellation_after_commit_retains_receipt_and_never_undoes_the_tick() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    let cancel = CancellationToken::default();
    let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
    let flag = cancel.clone();
    connection_mut(&mut store)
        .authorizer(Some(move |c: AuthContext<'_>| {
            if matches!(
                c.action,
                AuthAction::Insert {
                    table_name: "observations"
                }
            ) {
                flag.cancel();
            }
            Authorization::Allow
        }))
        .unwrap();
    let report = recorder.step(&mut store, &mut source, &mut clock, &cancel);
    assert!(report.tick_receipt.is_some());
    assert_eq!(report.counters.committed_ticks, 1);
    assert_eq!(count(&store, "observations"), 2);
    assert!(matches!(
        report.terminal.unwrap().cause,
        StopCause::Cancelled
    ));
}

#[test]
fn system_clock_waits_for_an_absolute_deadline_and_observes_cancellation() {
    let mut clock = SystemRecorderClock::new("system-test".into()).unwrap();
    let first = clock.read().unwrap();
    let target = first.monotonic_ms + 5;
    clock
        .wait_until(target, &CancellationToken::default())
        .unwrap();
    assert!(clock.read().unwrap().monotonic_ms >= target);
    let cancel = CancellationToken::default();
    let flag = cancel.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(5));
        flag.cancel();
    });
    assert_eq!(
        clock.wait_until(target + 1000, &cancel),
        Err(ClockError::Cancelled)
    );
    thread.join().unwrap();
}

#[test]
fn first_capture_past_the_horizon_is_counted_but_never_padded_into_the_last_slot() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    source.capture_cost = 3000;
    let mut recorder = Recorder::start(&mut store, config(Some(3)), &mut clock).unwrap();
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(report.counters.captured_snapshots, 1);
    assert_eq!(report.counters.committed_ticks, 0);
    assert_eq!(report.counters.missed_slots, 3);
    assert!(report.gap_receipt.is_some());
    assert!(report.tick_receipt.is_none());
    assert!(report.observation.is_none());
    assert!(matches!(
        report.terminal.unwrap(),
        TerminalReport {
            cause: StopCause::Completed,
            cleanup: CleanupOutcome::Closed(_)
        }
    ));
    assert_eq!(count(&store, "observations"), 0);
}

#[test]
fn cancellation_after_gap_commit_reports_the_gap_and_does_not_append_the_sample() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    let mut source = Latest::new(&clock);
    let cancel = CancellationToken::default();
    let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
    recorder.step(&mut store, &mut source, &mut clock, &cancel);
    clock.advance(3500);
    let flag = cancel.clone();
    connection_mut(&mut store)
        .authorizer(Some(move |c: AuthContext<'_>| {
            if matches!(
                c.action,
                AuthAction::Insert {
                    table_name: "recording_gaps"
                }
            ) {
                flag.cancel();
            }
            Authorization::Allow
        }))
        .unwrap();
    let report = recorder.step(&mut store, &mut source, &mut clock, &cancel);
    assert!(report.gap_receipt.is_some());
    assert!(report.tick_receipt.is_none());
    assert_eq!(report.counters.committed_ticks, 1);
    assert_eq!(report.counters.committed_gaps, 1);
    assert!(matches!(
        report.terminal.unwrap().cause,
        StopCause::Cancelled
    ));
    assert_eq!(count(&store, "observations"), 2);
}

#[test]
fn unbounded_run_stops_on_deadline_overflow_after_preserving_the_last_commit() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut clock = FakeClock::new();
    clock.0.borrow_mut().mono = u64::MAX;
    let mut source = Latest::new(&clock);
    let mut recorder = Recorder::start(&mut store, config(None), &mut clock).unwrap();
    assert!(recorder
        .step(
            &mut store,
            &mut source,
            &mut clock,
            &CancellationToken::default()
        )
        .tick_receipt
        .is_some());
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert!(matches!(
        report.terminal.unwrap().cause,
        StopCause::ArithmeticOverflow
    ));
    assert_eq!(report.counters.committed_ticks, 1);
    assert_eq!(report.counters.captured_snapshots, 1);
}
