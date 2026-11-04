use super::super::{driver as mutation, tests as fixtures};
use super::*;
use crate::recording_host::retention::tests::control;
use crate::recording_host::RecordingPhase;
use scada_historian::store::SqliteStore;
use std::time::Duration;

async fn failed(
    c: &RecordingOperationsClient,
    fault: mutation::TestFault,
) -> (AcceptedRecordingChange, RecordingOperationHandle) {
    let change = fixtures::paused(c, "original").await;
    *c.shared.fault.lock().unwrap() = Some(fault);
    let op = c
        .apply(&change.change, "original:apply", control())
        .unwrap();
    assert_eq!(
        op.wait().await.unwrap().as_value()["outcome"]["effect"],
        "unconfirmed"
    );
    (change, op)
}
mod gates;
mod lifecycle;
mod outcomes;
