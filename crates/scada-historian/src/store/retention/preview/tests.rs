use super::*;
use crate::store::{
    retention::{
        clock_guard::CutoffRule,
        jobs::{JobRequest, JobStepRequest},
        TrimRequest,
    },
    test_support::*,
    Reason,
};
use std::time::Duration;
mod failures;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn policy(retain_for_ms: u64) -> RetentionClockPolicy {
    RetentionClockPolicy {
        policy_id: "policy".into(),
        revision: 1,
        cutoff_rule: CutoffRule::Elapsed { retain_for_ms },
        tolerance_ms: 10,
        max_observation_gap_ms: 1000,
        max_cutoff_advance_ms: 500,
        initial_cutoff_ceiling_ms: Some(2000),
    }
}
fn request() -> RetentionPreviewRequest {
    RetentionPreviewRequest {
        reference_wall_ms: 3000,
        proposed_policy: policy(1000),
        comparison_policy: Some(policy(2000)),
    }
}
fn expected(ticks: u64, observations: u64, first: i64, last: i64) -> TargetCounts {
    TargetCounts {
        ticks,
        observations,
        series: 2,
        earliest_sample_ms: Some(first),
        latest_sample_ms: Some(last),
    }
}
fn fixture() -> (TempStore, SqliteStore) {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for (index, time) in [999, 1000, 1000, 1999, 2000, 2500].into_iter().enumerate() {
        let mut t = tick("a", index as u64 + 1, time);
        if index == 2 {
            for obs in &mut t.observations {
                obs.value = None;
                obs.reason = Some(Reason::MissingValue);
            }
        }
        store.append_tick(t).unwrap();
    }
    store.close_session("a").unwrap();
    let mut single = spec("b");
    single.members.retain(|m| m.series_id == "number");
    store.begin_session(single).unwrap();
    let mut t = tick("b", 1, 1000);
    t.observations.retain(|o| o.series_id == "number");
    store.append_tick(t).unwrap();
    store.close_session("b").unwrap();
    (directory, store)
}

#[test]
fn empty_preview_does_not_invent_a_comparison_or_applied_policy() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let r = RetentionPreviewRequest {
        comparison_policy: None,
        ..request()
    };
    let result = store.preview_retention_change(&r, &control()).unwrap();
    assert_eq!(result.proposed.targets, TargetCounts::default());
    assert!(result.comparison.is_none() && result.difference.is_none());
    assert_eq!(result.proposed.cutoff_ms, 2000);
    assert_eq!(result.proposed.policy, r.proposed_policy);
    assert_eq!(result.reference_wall_ms, 3000);
    assert_eq!(result.recovery.snapshot_commit, 0);
    assert_eq!(counter(&store), 0);
    assert!(store.connection.is_autocommit());
}

#[test]
fn shortening_counts_whole_ticks_null_members_and_duplicate_times_at_exclusive_boundaries() {
    let (_directory, mut store) = fixture();
    let before = store.recovery_state(&control()).unwrap();
    let result = store
        .preview_retention_change(&request(), &control())
        .unwrap();
    assert_eq!(result.recovery, before);
    assert_eq!(result.proposed.targets, expected(5, 9, 999, 1999));
    assert_eq!(result.comparison.unwrap().targets, expected(1, 2, 999, 999));
    let diff = result.difference.unwrap();
    assert_eq!(diff.change, DurationChange::Shorter);
    assert_eq!(
        diff.newly_targeted,
        RangeImpact {
            range: Some(PreviewRange {
                from_ms: 1000,
                to_ms: 2000
            }),
            targets: expected(4, 7, 1000, 1999)
        }
    );
    assert_eq!(diff.no_longer_targeted, RangeImpact::empty());
    assert_eq!(count(&store, "observations"), 13);
    assert_eq!(store.recovery_state(&control()).unwrap(), before);
}

#[test]
fn extending_reports_the_reverse_range_and_same_duration_compares_full_policy_values() {
    let (_directory, mut store) = fixture();
    let mut r = request();
    r.proposed_policy = policy(2000);
    r.comparison_policy = Some(policy(1000));
    let result = store.preview_retention_change(&r, &control()).unwrap();
    let diff = result.difference.unwrap();
    assert_eq!(diff.change, DurationChange::Longer);
    assert_eq!(diff.newly_targeted, RangeImpact::empty());
    assert_eq!(diff.no_longer_targeted.targets, expected(4, 7, 1000, 1999));
    assert_eq!(
        diff.no_longer_targeted.range,
        Some(PreviewRange {
            from_ms: 1000,
            to_ms: 2000
        })
    );
    r.comparison_policy = Some(r.proposed_policy.clone());
    r.proposed_policy.policy_id = "alternative".into();
    r.proposed_policy.revision = 2;
    r.proposed_policy.tolerance_ms = 11;
    let same = store.preview_retention_change(&r, &control()).unwrap();
    assert_eq!(
        same.proposed.targets,
        same.comparison.as_ref().unwrap().targets
    );
    assert_eq!(same.proposed.policy, r.proposed_policy);
    assert_eq!(
        same.difference.unwrap(),
        PolicyDifference {
            change: DurationChange::SameDuration,
            newly_targeted: RangeImpact::empty(),
            no_longer_targeted: RangeImpact::empty()
        }
    );
}

#[test]
fn active_recording_remains_active_and_later_appends_require_a_fresh_preview() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("active")).unwrap();
    store.append_tick(tick("active", 1, 1000)).unwrap();
    let before = counter(&store);
    let old = store
        .preview_retention_change(&request(), &control())
        .unwrap();
    assert_eq!(old.recovery.active_session_id, Some("active".into()));
    assert_eq!(old.proposed.targets, expected(1, 2, 1000, 1000));
    assert_eq!(counter(&store), before);
    store.append_tick(tick("active", 2, 1500)).unwrap();
    let fresh = store
        .preview_retention_change(&request(), &control())
        .unwrap();
    assert_eq!(old.proposed.targets.ticks, 1);
    assert_eq!(fresh.proposed.targets.ticks, 2);
    assert!(fresh.recovery.snapshot_commit > old.recovery.snapshot_commit);
}

#[test]
fn fence_and_partial_job_progress_are_visible_but_deleted_raw_is_never_recounted() {
    let (_directory, mut store) = fixture();
    store
        .trim(
            TrimRequest {
                request_id: "trim".into(),
                cutoff_ms: 1000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let after_trim = store
        .preview_retention_change(&request(), &control())
        .unwrap();
    assert_eq!(after_trim.recovery.retention_fence.cutoff_ms, Some(1000));
    assert_eq!(
        after_trim.comparison.unwrap().targets,
        TargetCounts::default()
    );
    assert_eq!(after_trim.proposed.targets, expected(4, 7, 1000, 1999));
    let earlier = RetentionPreviewRequest {
        proposed_policy: policy(2500),
        ..request()
    };
    let earlier = store
        .preview_retention_change(&earlier, &control())
        .unwrap();
    assert_eq!(earlier.proposed.cutoff_ms, 500); // Not clamped to the 1000 fence.
    assert_eq!(earlier.proposed.targets, TargetCounts::default());
    assert_eq!(earlier.recovery.retention_fence.cutoff_ms, Some(1000));
    store
        .begin_retention_job(
            JobRequest {
                job_id: "job".into(),
                cutoff_ms: 2000,
                expected_cutoff_ms: Some(1000),
            },
            &control(),
        )
        .unwrap();
    store
        .step_retention_job(
            JobStepRequest {
                job_id: "job".into(),
                step: 1,
                max_ticks: 1,
            },
            &control(),
        )
        .unwrap();
    let before = counter(&store);
    let partial = store
        .preview_retention_change(&request(), &control())
        .unwrap();
    assert_eq!(partial.recovery.retention_fence.cutoff_ms, Some(1000));
    assert_eq!(
        partial.recovery.active_job.unwrap().status.next_step,
        Some(2)
    );
    assert_eq!(partial.proposed.targets, expected(3, 5, 1000, 1999));
    assert_eq!(
        partial
            .difference
            .unwrap()
            .newly_targeted
            .targets
            .observations,
        5
    );
    assert_eq!(counter(&store), before);
}

#[test]
fn negative_times_empty_difference_ranges_and_safe_endpoints_remain_exact() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for (n, time) in [-501, -500, -499].into_iter().enumerate() {
        store.append_tick(tick("a", n as u64 + 1, time)).unwrap();
    }
    store.close_session("a").unwrap();
    let r = RetentionPreviewRequest {
        reference_wall_ms: 0,
        proposed_policy: policy(500),
        comparison_policy: Some(policy(501)),
    };
    let result = store.preview_retention_change(&r, &control()).unwrap();
    assert_eq!(result.proposed.targets, expected(1, 2, -501, -501));
    assert_eq!(result.comparison.unwrap().targets, TargetCounts::default());
    assert_eq!(
        result.difference.unwrap().newly_targeted.range,
        Some(PreviewRange {
            from_ms: -501,
            to_ms: -500
        })
    );
    let r = RetentionPreviewRequest {
        reference_wall_ms: -(MAX_SAFE as i64) + 1,
        proposed_policy: policy(1),
        comparison_policy: None,
    };
    assert_eq!(
        store
            .preview_retention_change(&r, &control())
            .unwrap()
            .proposed
            .targets,
        TargetCounts::default()
    );
    let r = RetentionPreviewRequest {
        reference_wall_ms: 3000,
        proposed_policy: policy(1),
        comparison_policy: Some(policy(2)),
    };
    let empty = store
        .preview_retention_change(&r, &control())
        .unwrap()
        .difference
        .unwrap()
        .newly_targeted;
    assert!(empty.range.is_some()); // A meaningful range can contain zero rows.
    assert_eq!(empty.targets, TargetCounts::default());
}
