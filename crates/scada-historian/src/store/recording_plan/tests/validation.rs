use super::*;

fn desired_for(m: &RecordingMapping) -> serde_json::Value {
    let mut d = desired(true);
    d["group"]["members"] = json!(m.members.iter().map(|m| json!({"memberId":m.member_id,"externalName":m.identity.external_name,"valueType":m.identity.value_type})).collect::<Vec<_>>());
    d
}
#[test]
fn eight_existing_members_can_be_applied_again_and_read_with_the_fixed_budget() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut r = register("eight", None);
    r.mapping.members = (0..8)
        .map(|n| {
            let mut m = mapping().members[0].clone();
            m.member_id = format!("m:{n}");
            m.identity.series_id = format!("s:{n}");
            m.identity.incarnation_id = format!("inc:{n}");
            m.identity.external_name = format!("Plant.Value{n}");
            m
        })
        .collect();
    store
        .begin_session(SessionSpec {
            session_id: "prior".into(),
            members: r
                .mapping
                .members
                .iter()
                .map(|m| m.identity.clone())
                .collect(),
        })
        .unwrap();
    store.close_session("prior").unwrap();
    store.register_recording_mapping(&r, &control()).unwrap();
    retention(&mut store);
    let mut a = apply("first", None, true);
    a.desired = desired_for(&r.mapping);
    store.apply_recording_plan(&a, &control()).unwrap();
    a.request_id = "second".into();
    a.expected_applied_revision = Some(1);
    store.apply_recording_plan(&a, &control()).unwrap();
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .unwrap()
            .receipt
            .applied_revision,
        2
    );
    assert_eq!(
        store
            .recording_plan_receipt("first", &control())
            .unwrap()
            .unwrap()
            .applied_revision,
        1
    );
}
#[test]
fn reservations_reject_rebinding_but_allow_new_segments_and_old_proposal_replay() {
    let (_directory, mut store) = enabled_store();
    let mut proposal = register("old-proposal", Some(1));
    proposal.mapping.members[0].identity.unit = Some("F".into());
    let old = store
        .register_recording_mapping(&proposal, &control())
        .unwrap();
    let mut current = register("current", Some(2));
    store
        .register_recording_mapping(&current, &control())
        .unwrap();
    let mut a = apply("apply", None, true);
    a.expected_mapping_revision = Some(3);
    store.apply_recording_plan(&a, &control()).unwrap();
    assert_eq!(
        store
            .register_recording_mapping(&proposal, &control())
            .unwrap(),
        old
    );
    let before = counter(&store);
    for kind in 0..3 {
        let mut bad = register("conflict", Some(3));
        let identity = &mut bad.mapping.members[0].identity;
        match kind {
            0 => identity.incarnation_id = "new-life".into(),
            1 => identity.series_id = "another-series".into(),
            _ => identity.unit = Some("F".into()),
        }
        assert!(
            matches!(
                store.register_recording_mapping(&bad, &control()),
                Err(StoreError::Conflict)
            ),
            "{kind}"
        );
        assert_eq!(counter(&store), before);
    }
    current.request_id = "new-segment".into();
    current.expected_mapping_revision = Some(3);
    current.mapping.members[0].identity.segment_id = "segment-b".into();
    current.mapping.members[0].identity.unit = Some("F".into());
    store
        .register_recording_mapping(&current, &control())
        .unwrap();
    a.request_id = "new-apply".into();
    a.expected_applied_revision = Some(1);
    a.expected_mapping_revision = Some(4);
    store.apply_recording_plan(&a, &control()).unwrap();
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .unwrap()
            .receipt
            .applied_revision,
        2
    );
}
#[test]
fn exact_resolution_immutable_definitions_and_canonical_numbers_are_enforced() {
    let (_directory, mut store) = enabled_store();
    let a = apply("apply", None, true);
    for kind in 0..6 {
        let mut bad = a.clone();
        match kind {
            0 => bad.desired["group"]["hubRef"] = json!("other"),
            1 => bad.desired["group"]["members"]
                .as_array_mut()
                .unwrap()
                .pop()
                .map(|_| ())
                .unwrap(),
            2 => bad.desired["group"]["members"][0]["memberId"] = json!("missing"),
            3 => bad.desired["group"]["members"][0]["externalName"] = json!(" Plant.Value"),
            4 => bad.desired["group"]["members"][0]["valueType"] = json!("bool"),
            _ => bad.desired["group"]["periodMs"] = json!(500),
        }
        assert!(
            matches!(
                store.apply_recording_plan(&bad, &control()),
                Err(StoreError::Conflict)
            ),
            "{kind}"
        );
    }
    let receipt = store.apply_recording_plan(&a, &control()).unwrap();
    let mut reorder = a.clone();
    reorder.desired["group"]["members"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reorder.desired["revision"] = json!(1.0);
    reorder.desired["group"]["periodMs"] = json!(1000.0);
    assert_eq!(
        store.apply_recording_plan(&reorder, &control()).unwrap(),
        receipt
    );
    let mut changed = apply("changed", Some(1), false);
    assert!(matches!(
        store.apply_recording_plan(&changed, &control()),
        Err(StoreError::Conflict)
    ));
    changed.desired["revision"] = json!(2);
    store.apply_recording_plan(&changed, &control()).unwrap();
}
#[test]
fn active_retention_job_blocks_new_writes_but_not_old_receipts() {
    let (_directory, mut store) = enabled_store();
    let a = apply("apply", None, true);
    let receipt = store.apply_recording_plan(&a, &control()).unwrap();
    store
        .begin_retention_job(
            crate::store::retention::jobs::JobRequest {
                job_id: "job".into(),
                cutoff_ms: 1000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    assert_eq!(store.apply_recording_plan(&a, &control()).unwrap(), receipt);
    assert!(store
        .register_recording_mapping(&register("map", None), &control())
        .is_ok());
    assert!(matches!(
        store.register_recording_mapping(&register("new", Some(1)), &control()),
        Err(StoreError::Busy)
    ));
    let mut next = apply("new", Some(1), false);
    next.desired["revision"] = json!(2);
    assert!(matches!(
        store.apply_recording_plan(&next, &control()),
        Err(StoreError::Busy)
    ));
}
#[test]
fn bounded_ledger_capacity_keeps_existing_receipts_available() {
    let directory = TempStore::new();
    let mut store = directory.create();
    // Seed valid historical mapping receipts in one fixture transaction.
    let tx = store.connection.transaction().unwrap();
    for n in 1..=MAX_LEDGER_ENTRIES {
        let r = register(&format!("map:{n}"), (n > 1).then_some(n - 1));
        let receipt = MappingReceipt {
            request_id: r.request_id.clone(),
            mapping_revision: n,
            commit_version: n,
            mapping_hash: canonical::hash(&canonical::encode(&r.mapping).unwrap()),
        };
        tx.execute(
            "INSERT INTO recording_mapping_revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                n as i64,
                r.request_id,
                r.expected_mapping_revision.map(|v| v as i64),
                canonical::encode(&r).unwrap(),
                receipt.mapping_hash,
                n as i64,
                canonical::encode(&receipt).unwrap()
            ],
        )
        .unwrap();
    }
    tx.execute(
        "UPDATE recording_mapping_state SET mapping_revision=?1,revision_count=?1",
        [MAX_LEDGER_ENTRIES as i64],
    )
    .unwrap();
    tx.execute(
        "UPDATE store_meta SET last_commit=?1",
        [MAX_LEDGER_ENTRIES as i64],
    )
    .unwrap();
    tx.commit().unwrap();
    let before = counter(&store);
    assert!(matches!(
        store.register_recording_mapping(
            &register("overflow", Some(MAX_LEDGER_ENTRIES)),
            &control()
        ),
        Err(StoreError::RecordingPlanCapacity)
    ));
    assert_eq!(counter(&store), before);
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .mapping
            .unwrap()
            .receipt
            .mapping_revision,
        MAX_LEDGER_ENTRIES
    );
    assert_eq!(
        store
            .register_recording_mapping(&register("map:1", None), &control())
            .unwrap()
            .mapping_revision,
        1
    );
}

#[test]
fn eight_distinct_first_use_applications_fit_one_default_apply_budget() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut all = mapping();
    all.members = (0..8)
        .map(|n| {
            let mut m = mapping().members[0].clone();
            m.member_id = format!("m:{n}");
            m.identity.series_id = format!("s:{n}");
            m.identity.incarnation_id = format!("inc:{n}");
            m.identity.external_name = format!("Plant.Value{n}");
            m
        })
        .collect();
    store
        .begin_session(SessionSpec {
            session_id: "permanent".into(),
            members: all.members.iter().map(|m| m.identity.clone()).collect(),
        })
        .unwrap();
    store.close_session("permanent").unwrap();
    retention(&mut store);
    for n in 1..=8 {
        let mut r = register(&format!("map:{n}"), (n > 1).then_some(n - 1));
        r.mapping = all.clone();
        r.mapping.members = vec![all.members[n as usize - 1].clone()];
        store.register_recording_mapping(&r, &control()).unwrap();
        let mut a = apply(&format!("apply:{n}"), (n > 1).then_some(n - 1), true);
        a.expected_mapping_revision = Some(n);
        a.desired = desired_for(&r.mapping);
        a.desired["revision"] = json!(n);
        store.apply_recording_plan(&a, &control()).unwrap();
    }
    let mut r = register("combined", Some(8));
    r.mapping = all;
    store.register_recording_mapping(&r, &control()).unwrap();
    let mut a = apply("combined", Some(8), true);
    a.expected_mapping_revision = Some(9);
    a.desired = desired_for(&r.mapping);
    a.desired["revision"] = json!(9);
    let combined = store.apply_recording_plan(&a, &control()).unwrap();
    assert_eq!(combined.applied_revision, 9);
    a.request_id = "repeat-combined".into();
    a.expected_applied_revision = Some(9);
    let before = counter(&store);
    let mut low = control();
    low.limits.max_decoded_rows = 32;
    assert!(matches!(
        store.apply_recording_plan(&a, &low),
        Err(StoreError::Control(_))
    ));
    assert_eq!(counter(&store), before);
    let repeated = store.apply_recording_plan(&a, &control()).unwrap();
    assert_eq!(repeated.applied_revision, 10);
    assert_eq!(repeated.resolved_config_hash, combined.resolved_config_hash);
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .unwrap()
            .receipt,
        repeated
    );
    assert_eq!(
        store.apply_recording_plan(&a, &control()).unwrap(),
        repeated
    );
    // Evidence is scoped to this transaction, never reused across operations.
    let before = counter(&store);
    store
        .connection
        .execute(
            "UPDATE recording_mapping_revisions SET request_json='{}' WHERE mapping_revision=1",
            [],
        )
        .unwrap();
    a.request_id = "after-corruption".into();
    a.expected_applied_revision = Some(10);
    assert!(matches!(
        store.apply_recording_plan(&a, &control()),
        Err(StoreError::CorruptData)
    ));
    assert_eq!(counter(&store), before);
}

#[test]
fn disjoint_eight_member_switches_fit_default_budget_with_sixteen_first_use_origins() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut pool = mapping();
    pool.members = (0..16)
        .map(|n| {
            let mut m = mapping().members[0].clone();
            m.member_id = format!("m:{n}");
            m.identity.series_id = format!("s:{n}");
            m.identity.incarnation_id = format!("inc:{n}");
            m.identity.external_name = format!("Plant.Value{n}");
            m
        })
        .collect();
    for n in 0..2 {
        let id = format!("manual:{n}");
        store
            .begin_session(SessionSpec {
                session_id: id.clone(),
                members: pool.members[n * 8..(n + 1) * 8]
                    .iter()
                    .map(|m| m.identity.clone())
                    .collect(),
            })
            .unwrap();
        store.close_session(&id).unwrap();
    }
    retention(&mut store);
    for n in 1..=16 {
        let mut r = register(&format!("map:{n}"), (n > 1).then_some(n - 1));
        r.mapping = pool.clone();
        r.mapping.members = vec![pool.members[n as usize - 1].clone()];
        store.register_recording_mapping(&r, &control()).unwrap();
        let mut a = apply(&format!("apply:{n}"), (n > 1).then_some(n - 1), true);
        a.expected_mapping_revision = Some(n);
        a.desired = desired_for(&r.mapping);
        a.desired["revision"] = json!(n);
        store.apply_recording_plan(&a, &control()).unwrap();
    }
    let mut receipts = Vec::new();
    for (n, offset) in [(17, 0), (18, 8), (19, 0)] {
        let mut r = register(&format!("map:{n}"), Some(n - 1));
        r.mapping = pool.clone();
        r.mapping.members = pool.members[offset..offset + 8].to_vec();
        store.register_recording_mapping(&r, &control()).unwrap();
        let mut a = apply(&format!("apply:{n}"), Some(n - 1), true);
        a.expected_mapping_revision = Some(n);
        a.desired = desired_for(&r.mapping);
        a.desired["revision"] = json!(if offset == 0 { 17 } else { 18 });
        let before = counter(&store);
        let mut low = control();
        low.limits.max_decoded_rows = 32;
        assert!(matches!(
            store.apply_recording_plan(&a, &low),
            Err(StoreError::Control(_))
        ));
        assert_eq!(counter(&store), before);
        let receipt = store.apply_recording_plan(&a, &control()).unwrap();
        assert_eq!(receipt.applied_revision, n);
        assert_eq!(
            store
                .recording_plan_state(&control())
                .unwrap()
                .applied
                .unwrap()
                .receipt,
            receipt
        );
        assert_eq!(store.apply_recording_plan(&a, &control()).unwrap(), receipt);
        receipts.push(receipt);
    }
    assert_eq!(
        store
            .recording_plan_receipt("apply:17", &control())
            .unwrap(),
        Some(receipts[0].clone())
    );
    let before = counter(&store);
    for kind in 0..3 {
        let mut r = register("conflict", Some(19));
        r.mapping.members = vec![pool.members[0].clone()];
        match kind {
            0 => r.mapping.members[0].identity.series_id = "different-series".into(),
            1 => r.mapping.members[0].identity.incarnation_id = "different-life".into(),
            _ => r.mapping.members[0].identity.unit = Some("F".into()),
        }
        assert!(matches!(
            store.register_recording_mapping(&r, &control()),
            Err(StoreError::Conflict)
        ));
        assert_eq!(counter(&store), before);
    }
}

#[test]
fn thirty_two_series_and_segment_origins_with_distinct_retention_versions_fit_default_budget() {
    use crate::store::retention::application::{PolicyApplyRequest, PolicyPreparationRequest};
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut pool = mapping();
    pool.members = (0..16)
        .map(|n| {
            let mut m = mapping().members[0].clone();
            m.member_id = format!("m:{n}");
            m.identity.series_id = format!("s:{n}");
            m.identity.incarnation_id = format!("inc:{n}");
            m.identity.external_name = format!("Plant.Value{n}");
            m
        })
        .collect();
    for segment in ["segment-a", "segment-b"] {
        for half in 0..2 {
            let id = format!("manual:{segment}:{half}");
            let members = pool.members[half * 8..(half + 1) * 8]
                .iter()
                .map(|m| {
                    let mut d = m.identity.clone();
                    d.segment_id = segment.into();
                    d
                })
                .collect();
            store
                .begin_session(SessionSpec {
                    session_id: id.clone(),
                    members,
                })
                .unwrap();
            store.close_session(&id).unwrap();
        }
    }
    retention(&mut store);
    for n in 1..=32 {
        if n > 1 {
            let mut policy = store
                .recovery_state(&control())
                .unwrap()
                .applied_retention_policy
                .unwrap()
                .policy;
            policy.revision = n;
            let preview = store
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
                        request_id: format!("retention:{n}"),
                        expected_applied_revision: Some(n - 1),
                        expected_preview_snapshot_commit: preview.snapshot_commit,
                        reference_wall_ms: 3000,
                        proposed_policy: policy,
                    },
                    &control(),
                )
                .unwrap();
        }
        let mut r = register(&format!("map:{n}"), (n > 1).then_some(n - 1));
        r.mapping = pool.clone();
        r.mapping.members = vec![pool.members[(n as usize - 1) % 16].clone()];
        if n > 16 {
            r.mapping.members[0].identity.segment_id = "segment-b".into();
        }
        store.register_recording_mapping(&r, &control()).unwrap();
        let mut a = apply(&format!("apply:{n}"), (n > 1).then_some(n - 1), true);
        a.expected_mapping_revision = Some(n);
        a.expected_retention_applied_revision = Some(n);
        a.desired = desired_for(&r.mapping);
        a.desired["revision"] = json!(n);
        store.apply_recording_plan(&a, &control()).unwrap();
    }
    let mut last_apply = None;
    for (n, offset) in [(33, 0), (34, 8)] {
        let mut r = register(&format!("map:{n}"), Some(n - 1));
        r.mapping = pool.clone();
        r.mapping.members = pool.members[offset..offset + 8].to_vec();
        for m in &mut r.mapping.members {
            m.identity.segment_id = "segment-b".into();
        }
        store.register_recording_mapping(&r, &control()).unwrap();
        let mut a = apply(&format!("apply:{n}"), Some(n - 1), true);
        a.expected_mapping_revision = Some(n);
        a.expected_retention_applied_revision = Some(32);
        a.desired = desired_for(&r.mapping);
        a.desired["revision"] = json!(n);
        let receipt = store.apply_recording_plan(&a, &control()).unwrap();
        assert_eq!(receipt.applied_revision, n);
        assert_eq!(
            store
                .recording_plan_state(&control())
                .unwrap()
                .applied
                .unwrap()
                .receipt,
            receipt
        );
        assert_eq!(store.apply_recording_plan(&a, &control()).unwrap(), receipt);
        last_apply = Some(a);
    }
    // The recorder's preflight and activation also fit with these persisted origins.
    struct Clock;
    impl crate::recorder::RecorderClock for Clock {
        fn read(&mut self) -> Result<crate::recorder::ClockReading, crate::recorder::ClockError> {
            Ok(crate::recorder::ClockReading {
                monotonic_ms: 0,
                wall_time_ms: 10000,
                clock_epoch: "managed-worst".into(),
            })
        }
        fn wait_until(
            &mut self,
            _: u64,
            _: &crate::store::query::CancellationToken,
        ) -> Result<(), crate::recorder::ClockError> {
            unreachable!()
        }
    }
    let applied = store
        .recording_plan_state(&control())
        .unwrap()
        .applied
        .unwrap();
    let config = crate::recorder::RecorderConfig {
        session: SessionSpec {
            session_id: "managed-worst".into(),
            members: applied
                .resolution
                .unwrap()
                .members
                .into_iter()
                .map(|m| m.identity)
                .collect(),
        },
        plan: applied.receipt.plan,
        period_ms: 1000,
        slot_count: Some(1),
        max_clock_skew_ms: 5,
    };
    let binding = crate::recorder::ManagedRecorderStart {
        activation_id: "managed-worst".into(),
        expected_applied_revision: 34,
        expected_mapping_revision: 34,
        expected_retention_applied_revision: 32,
    };
    let (_recorder, receipt) = crate::recorder::Recorder::start_managed(
        &mut store,
        config,
        binding,
        &mut Clock,
        &control(),
    )
    .unwrap();
    assert_eq!(receipt.spec.members.len(), 8);
    store.interrupt_session("managed-worst").unwrap();
    // Joined reads must still validate historical desired/mapping/policy bodies.
    let before = counter(&store);
    store
        .connection
        .execute(
            "UPDATE retention_policy_applications SET receipt_json='{}' WHERE applied_revision=9",
            [],
        )
        .unwrap();
    let mut a = last_apply.unwrap();
    a.request_id = "corrupt-proof".into();
    a.expected_applied_revision = Some(34);
    assert!(matches!(
        store.apply_recording_plan(&a, &control()),
        Err(StoreError::CorruptData)
    ));
    assert_eq!(counter(&store), before);
}
