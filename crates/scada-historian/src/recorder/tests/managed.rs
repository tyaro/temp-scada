use super::*;
use crate::store::{
    recording_plan::*,
    retention::{
        application::{PolicyApplyRequest, PolicyPreparationRequest},
        clock_guard::RetentionClockPolicy,
        policy::CutoffRule,
    },
};
use serde_json::json;
fn setup(slots: Option<u64>) -> (TempStore, SqliteStore, RecorderConfig, ManagedRecorderStart) {
    let d = TempStore::new();
    let mut store = d.create();
    let mut c = config(slots);
    c.session.members[1].external_name = "Plant.Run".into();
    let members: Vec<_> = c
        .session
        .members
        .iter()
        .enumerate()
        .map(|(n, m)| RecordingMappingMember {
            member_id: format!("member:{n}"),
            identity: m.clone(),
        })
        .collect();
    store
        .register_recording_mapping(
            &RegisterMappingRequest {
                request_id: "map".into(),
                expected_mapping_revision: None,
                mapping: RecordingMapping {
                    hub_ref: "hub".into(),
                    hub_instance_id: "hub-a".into(),
                    members: members.clone(),
                },
            },
            &control(),
        )
        .unwrap();
    let policy = RetentionClockPolicy {
        policy_id: "retention".into(),
        revision: 1,
        cutoff_rule: CutoffRule::Elapsed {
            retain_for_ms: 1000,
        },
        tolerance_ms: 10,
        max_observation_gap_ms: 1000,
        max_cutoff_advance_ms: 500,
        initial_cutoff_ceiling_ms: Some(2000),
    };
    let p = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: policy.clone(),
                reference_wall_ms: 3000,
            },
            &control(),
        )
        .unwrap();
    store
        .apply_retention_policy(
            &PolicyApplyRequest {
                request_id: "retention".into(),
                expected_applied_revision: None,
                expected_preview_snapshot_commit: p.snapshot_commit,
                reference_wall_ms: 3000,
                proposed_policy: policy,
            },
            &control(),
        )
        .unwrap();
    let applied=store.apply_recording_plan(&ApplyRecordingPlanRequest{request_id:"apply".into(),expected_applied_revision:None,expected_mapping_revision:Some(1),expected_retention_applied_revision:Some(1),desired:json!({"version":1,"kind":"recordingPlan","planId":"desired","revision":1,"enabled":true,"group":{"groupId":"group","hubRef":"hub","periodMs":1000,"members":members.iter().map(|m|json!({"memberId":m.member_id,"externalName":m.identity.external_name,"valueType":m.identity.value_type})).collect::<Vec<_>>()}})},&control()).unwrap();
    c.plan = applied.plan;
    let binding = ManagedRecorderStart {
        activation_id: "activation".into(),
        expected_applied_revision: 1,
        expected_mapping_revision: 1,
        expected_retention_applied_revision: 1,
    };
    (d, store, c, binding)
}
struct NeverRead;
impl RecorderClock for NeverRead {
    fn read(&mut self) -> Result<ClockReading, ClockError> {
        panic!("clock must not be read");
    }
    fn wait_until(&mut self, _: u64, _: &CancellationToken) -> Result<(), ClockError> {
        panic!("clock must not wait");
    }
}
fn activation_request(r: &RecordingActivationReceipt) -> ActivateRecordingPlanRequest {
    ActivateRecordingPlanRequest {
        activation_id: r.activation_id.clone(),
        expected_applied_revision: r.applied_revision,
        expected_mapping_revision: r.mapping_revision,
        expected_retention_applied_revision: r.retention_applied_revision,
        session_id: r.spec.session_id.clone(),
        start: r.start.clone(),
    }
}
#[test]
fn managed_start_uses_one_anchor_and_same_bound_session_for_actual_first_sample() {
    let (_d, mut store, c, b) = setup(Some(2));
    let mut clock = FakeClock::new();
    clock.0.borrow_mut().read_cost = 7;
    let before = counter(&store);
    let (mut recorder, receipt) =
        Recorder::start_managed(&mut store, c.clone(), b, &mut clock, &control()).unwrap();
    assert_eq!(counter(&store), before + 1);
    assert_eq!(receipt.start.at_ms, 10007);
    assert_eq!(receipt.start.clock_epoch, "epoch");
    assert_eq!(receipt.plan, c.plan);
    assert_eq!(
        store
            .recording_activation("activation", &control())
            .unwrap()
            .unwrap()
            .receipt,
        receipt
    );
    let mut source = Latest::new(&clock);
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(
        report.tick_receipt.as_ref().unwrap().session_id,
        c.session.session_id
    );
    let observed = report.observation.unwrap();
    assert_eq!(observed.scheduled_monotonic_ms, 7);
    assert_eq!(observed.slot, 0);
    let result=store.reader().unwrap().query_raw(&json!({"version":1,"kind":"query","requestId":"read","seriesIds":["number"],"fromMs":10000,"toMs":12000,"mode":"raw","maxPointsPerSeries":10}),&control()).unwrap();
    assert_eq!(
        result["series"][0]["raw"][0]["sampleTimeMs"],
        observed.observed.wall_time_ms
    );
    assert_ne!(observed.observed.wall_time_ms, receipt.start.at_ms);
    while recorder
        .step(
            &mut store,
            &mut source,
            &mut clock,
            &CancellationToken::default(),
        )
        .state
        != RecorderState::Stopped
    {}
    assert_eq!(recorder.counters().committed_ticks, 2);
    assert_eq!(
        store
            .recording_activation("activation", &control())
            .unwrap()
            .unwrap()
            .session
            .state,
        SessionState::Closed
    );
}
#[test]
fn one_hour_managed_recording_keeps_3600_absolute_slots_with_processing_cost() {
    let (_d, mut store, c, b) = setup(Some(3600));
    let mut clock = FakeClock::new();
    clock.0.borrow_mut().read_cost = 7;
    clock.0.borrow_mut().wake_jitter = 3;
    let mut source = Latest::new(&clock);
    source.capture_cost = 11;
    let (mut recorder, receipt) =
        Recorder::start_managed(&mut store, c, b, &mut clock, &control()).unwrap();
    assert_eq!(receipt.start.at_ms, 10007);
    for slot in 0..3600 {
        let report = recorder.step(
            &mut store,
            &mut source,
            &mut clock,
            &CancellationToken::default(),
        );
        assert_eq!(report.state, RecorderState::Running);
        let o = report.observation.unwrap();
        assert_eq!(o.slot, slot);
        assert_eq!(o.scheduled_monotonic_ms, 7 + slot * 1000);
        assert!(o.lateness_ms < 1000);
        assert!(report.tick_receipt.is_some());
        assert!(report.gap_receipt.is_none());
        clock.advance(5);
    }
    let report = recorder.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(report.state, RecorderState::Stopped);
    assert_eq!(report.counters.committed_ticks, 3600);
    assert_eq!(report.counters.missed_slots, 0);
    assert_eq!(report.counters.captured_snapshots, 3600);
}
#[test]
fn existing_active_closed_and_interrupted_activation_is_never_a_new_recorder() {
    for state in 0..3 {
        let (_d, mut store, c, b) = setup(None);
        let mut clock = FakeClock::new();
        let (mut r, receipt) =
            Recorder::start_managed(&mut store, c.clone(), b.clone(), &mut clock, &control())
                .unwrap();
        match state {
            1 => {
                clock.advance(1);
                r.stop(&mut store, &mut clock);
            }
            2 => {
                store.interrupt_session(&c.session.session_id).unwrap();
            }
            _ => {}
        }
        let before = counter(&store);
        assert!(matches!(
            Recorder::start_managed(&mut store, c, b, &mut NeverRead, &control()),
            Err(RecorderStartError::AlreadyActivated)
        ));
        assert_eq!(counter(&store), before);
        assert_eq!(
            store
                .activate_recording_plan(&activation_request(&receipt), &control())
                .unwrap(),
            receipt
        );
    }
}
#[test]
fn every_descriptor_and_binding_difference_is_rejected_before_reading_clock() {
    let (_d, mut store, c, b) = setup(None);
    let before = counter(&store);
    for kind in 0..11 {
        let mut c = c.clone();
        let mut b = b.clone();
        match kind {
            0 => c.session.members[0].unit = Some("F".into()),
            1 => c.session.members[0].source = Source::Computed,
            2 => c.session.members[0].incarnation_id = "different-life".into(),
            3 => c.session.members[0].segment_id = "different-segment".into(),
            4 => {
                for m in &mut c.session.members {
                    m.period_ms = 500;
                }
                c.period_ms = 500;
            }
            5 => c.plan.revision = 2,
            6 => b.expected_applied_revision = 2,
            7 => b.expected_mapping_revision = 2,
            8 => b.expected_retention_applied_revision = 2,
            9 => c.session.members[0].external_name = "different name".into(),
            _ => c.session.members.pop().map(|_| ()).unwrap(),
        }
        assert!(matches!(
            Recorder::start_managed(&mut store, c, b, &mut NeverRead, &control()),
            Err(RecorderStartError::ManagedBindingMismatch)
        ));
        assert_eq!(counter(&store), before);
    }
}
#[test]
fn activation_latency_is_a_missed_slot_and_never_moves_the_anchor() {
    let (_d, mut store, c, b) = setup(None);
    let mut clock = FakeClock::new();
    let time = clock.0.clone();
    let (mut r, receipt) =
        Recorder::start_managed_with(&mut store, c, b, &mut clock, &control(), |s, q, c| {
            let a = s.activate_recording_plan(q, c)?;
            let mut t = time.borrow_mut();
            t.mono += 2500;
            t.wall += 2500;
            Ok(a)
        })
        .unwrap();
    assert_eq!(receipt.start.at_ms, 10000);
    let mut source = Latest::new(&clock);
    let report = r.step(
        &mut store,
        &mut source,
        &mut clock,
        &CancellationToken::default(),
    );
    assert_eq!(report.counters.captured_snapshots, 1);
    assert_eq!(report.counters.committed_ticks, 1);
    assert_eq!(report.counters.missed_slots, 2);
    assert_eq!(report.observation.unwrap().scheduled_monotonic_ms, 2000);
    assert!(report.gap_receipt.is_some());
}
#[test]
fn postcommit_cancellation_keeps_receipt_and_first_step_performs_cleanup_without_capture() {
    let (_d, mut store, c, b) = setup(None);
    let mut clock = FakeClock::new();
    let ctl = control();
    let token = ctl.cancellation.clone();
    let (mut r, receipt) =
        Recorder::start_managed_with(&mut store, c, b, &mut clock, &ctl, |s, q, c| {
            let a = s.activate_recording_plan(q, c)?;
            token.cancel();
            Ok(a)
        })
        .unwrap();
    assert_eq!(
        store
            .recording_activation("activation", &control())
            .unwrap()
            .unwrap()
            .receipt,
        receipt
    );
    let mut source = Latest::new(&clock);
    clock.advance(1);
    let report = r.step(&mut store, &mut source, &mut clock, &ctl.cancellation);
    assert_eq!(report.counters.captured_snapshots, 0);
    assert!(matches!(
        report.terminal.unwrap().cleanup,
        CleanupOutcome::Closed(_)
    ));
}
#[test]
fn response_loss_is_unconfirmed_and_recovery_cannot_reattach_the_session() {
    let (d, mut store, c, b) = setup(None);
    let mut clock = FakeClock::new();
    let before = counter(&store);
    assert!(matches!(
        Recorder::start_managed_with(
            &mut store,
            c.clone(),
            b.clone(),
            &mut clock,
            &control(),
            |s, q, c| {
                s.activate_recording_plan(q, c)?;
                Err(StoreError::Invalid("response lost"))
            }
        ),
        Err(RecorderStartError::ActivationUnconfirmed(_))
    ));
    assert_eq!(counter(&store), before + 1);
    let receipt = store
        .recording_activation("activation", &control())
        .unwrap()
        .unwrap()
        .receipt;
    assert!(matches!(
        Recorder::start_managed(&mut store, c.clone(), b.clone(), &mut NeverRead, &control()),
        Err(RecorderStartError::AlreadyActivated)
    ));
    drop(store);
    let mut store = d.open();
    assert_eq!(
        store
            .recording_activation("activation", &control())
            .unwrap()
            .unwrap()
            .session
            .state,
        SessionState::Interrupted
    );
    assert_eq!(
        store
            .activate_recording_plan(&activation_request(&receipt), &control())
            .unwrap(),
        receipt
    );
    assert!(matches!(
        Recorder::start_managed(&mut store, c, b, &mut NeverRead, &control()),
        Err(RecorderStartError::AlreadyActivated)
    ));
}
#[test]
fn invalid_limits_and_cancelled_preflight_do_not_reset_control_or_create_session() {
    let (_d, mut store, c, b) = setup(None);
    let before = counter(&store);
    for n in 0..4 {
        let mut ctl = control();
        match n {
            0 => ctl.cancellation.cancel(),
            1 => ctl.deadline = std::time::Instant::now(),
            2 => ctl.limits.max_decoded_rows = 1,
            _ => ctl.limits.max_output_bytes = 1,
        };
        assert!(matches!(
            Recorder::start_managed(&mut store, c.clone(), b.clone(), &mut NeverRead, &ctl),
            Err(RecorderStartError::Store(StoreError::Control(_)))
        ));
        assert_eq!(counter(&store), before);
    }
    let mut clock = FakeClock::new();
    let ctl = control();
    let deadline = ctl.deadline;
    let limits = ctl.limits;
    assert!(matches!(
        Recorder::start_managed_with(&mut store, c, b, &mut clock, &ctl, |_, _, original| {
            assert_eq!(original.deadline, deadline);
            assert_eq!(original.limits.max_vm_steps, limits.max_vm_steps);
            original.cancellation.cancel();
            Err(StoreError::Control(store::query::QueryError::Cancelled))
        }),
        Err(RecorderStartError::ActivationUnconfirmed(
            StoreError::Control(_)
        ))
    ));
    assert!(ctl.cancellation.is_cancelled());
    assert_eq!(counter(&store), before);
}
#[test]
fn invalid_binding_and_horizon_fail_before_activation() {
    let (_d, mut store, c, b) = setup(None);
    let before = counter(&store);
    for n in 0..4 {
        let mut b = b.clone();
        match n {
            0 => b.activation_id = "bad id".into(),
            1 => b.expected_applied_revision = 0,
            2 => b.expected_mapping_revision = MAX_SAFE + 1,
            _ => b.expected_retention_applied_revision = 0,
        };
        assert!(matches!(
            Recorder::start_managed(&mut store, c.clone(), b, &mut NeverRead, &control()),
            Err(RecorderStartError::InvalidConfig)
        ));
    }
    let mut c = c;
    c.slot_count = Some(1);
    let mut clock = FakeClock::new();
    clock.0.borrow_mut().mono = u64::MAX;
    assert!(matches!(
        Recorder::start_managed(&mut store, c, b, &mut clock, &control()),
        Err(RecorderStartError::InvalidConfig)
    ));
    assert_eq!(counter(&store), before);
}

#[test]
fn disabled_or_advanced_mapping_never_reaches_clock_or_activation() {
    for disabled in [false, true] {
        let (_d, mut store, mut c, mut b) = setup(None);
        if disabled {
            let current = store.recording_plan_state(&control()).unwrap();
            let mut desired = current.applied.unwrap().request.desired;
            desired["revision"] = json!(2);
            desired["enabled"] = json!(false);
            let applied = store
                .apply_recording_plan(
                    &ApplyRecordingPlanRequest {
                        request_id: "disabled".into(),
                        expected_applied_revision: Some(1),
                        desired,
                        expected_mapping_revision: None,
                        expected_retention_applied_revision: None,
                    },
                    &control(),
                )
                .unwrap();
            c.plan = applied.plan;
            b.expected_applied_revision = 2;
        } else {
            let mapping = store
                .recording_plan_state(&control())
                .unwrap()
                .mapping
                .unwrap()
                .mapping;
            store
                .register_recording_mapping(
                    &RegisterMappingRequest {
                        request_id: "new-map".into(),
                        expected_mapping_revision: Some(1),
                        mapping,
                    },
                    &control(),
                )
                .unwrap();
        }
        let before = counter(&store);
        assert!(matches!(
            Recorder::start_managed(&mut store, c, b, &mut NeverRead, &control()),
            Err(RecorderStartError::ManagedBindingMismatch)
        ));
        assert_eq!(counter(&store), before);
        assert!(store
            .recording_activation_state(&control())
            .unwrap()
            .latest
            .is_none());
    }
}
#[test]
fn current_retention_is_still_authoritative_inside_activation() {
    let (_d, mut store, c, b) = setup(None);
    let mut policy = store
        .recovery_state(&control())
        .unwrap()
        .applied_retention_policy
        .unwrap()
        .policy;
    policy.revision = 2;
    let p = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: policy.clone(),
                reference_wall_ms: 3000,
            },
            &control(),
        )
        .unwrap();
    store
        .apply_retention_policy(
            &PolicyApplyRequest {
                request_id: "retention2".into(),
                expected_applied_revision: Some(1),
                expected_preview_snapshot_commit: p.snapshot_commit,
                reference_wall_ms: 3000,
                proposed_policy: policy,
            },
            &control(),
        )
        .unwrap();
    let before = counter(&store);
    let mut clock = FakeClock::new();
    assert!(matches!(
        Recorder::start_managed(&mut store, c, b, &mut clock, &control()),
        Err(RecorderStartError::ActivationUnconfirmed(
            StoreError::Conflict
        ))
    ));
    assert_eq!(counter(&store), before);
    assert!(store
        .recording_activation_state(&control())
        .unwrap()
        .latest
        .is_none());
}
#[test]
fn failed_or_invalid_start_clock_never_writes_begin_evidence() {
    struct BadClock(u8);
    impl RecorderClock for BadClock {
        fn read(&mut self) -> Result<ClockReading, ClockError> {
            match self.0 {
                0 => Err(ClockError::ReadingFailed),
                1 => Ok(ClockReading {
                    monotonic_ms: 0,
                    wall_time_ms: i64::MAX,
                    clock_epoch: "epoch".into(),
                }),
                _ => Ok(ClockReading {
                    monotonic_ms: 0,
                    wall_time_ms: 10000,
                    clock_epoch: "bad epoch".into(),
                }),
            }
        }
        fn wait_until(&mut self, _: u64, _: &CancellationToken) -> Result<(), ClockError> {
            unreachable!()
        }
    }
    let (_d, mut store, c, b) = setup(None);
    let before = counter(&store);
    for n in 0..3 {
        assert!(matches!(
            Recorder::start_managed(
                &mut store,
                c.clone(),
                b.clone(),
                &mut BadClock(n),
                &control()
            ),
            Err(RecorderStartError::Clock(_))
        ));
        assert_eq!(counter(&store), before);
    }
}
