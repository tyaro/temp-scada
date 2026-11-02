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
