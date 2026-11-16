//! The REST reread and resubscription against a loopback Hub (3-C3b).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::tests::outage_fixture;
use super::*;
use crate::recording_runtime::setup_tests::Hub;

const ID: &str = "alarm:bit";

fn fast() -> FreshnessConfig {
    FreshnessConfig {
        reread_interval: Duration::from_millis(100),
        reread_timeout: Duration::from_secs(1),
        failure_limit: Duration::from_millis(300),
        resubscribe_failures: 3,
    }
}

async fn wait_engine(runtime: &AlarmRuntime, what: &str, check: impl Fn(&Engine) -> bool) {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if check(&runtime.snapshot().await.unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(result.is_ok(), "timed out waiting for {what}");
}

fn active(engine: &Engine) -> bool {
    let state = &engine.condition(ID).unwrap().state;
    engine.unavailable().is_none() && state.unavailable.is_none() && state.active
}

#[tokio::test]
async fn a_differing_reread_is_used_and_the_subscription_is_replaced() {
    let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
    let (dir, _terminal, _db, _applied, _definitions, _session, evaluator) =
        outage_fixture("alarm-reread-stall").await;
    let runtime = AlarmRuntime::start_with_config(evaluator, hub.clients(), fast())
        .await
        .unwrap();
    let mut changes = runtime.changes();
    wait_engine(&runtime, "the subscribed value", active).await;
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 1);
    // The subscription keeps 1; the Hub's current value is 0.
    hub.rest_values
        .lock()
        .unwrap()
        .insert("PLANT.FLAG".into(), 0.0);
    let returned = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let change = changes.recv().await.unwrap();
            if change
                .conditions
                .get(ID)
                .and_then(Option::as_ref)
                .is_some_and(|state| !state.active)
            {
                return;
            }
        }
    })
    .await;
    assert!(returned.is_ok(), "the read value was not evaluated");
    let resubscribed = tokio::time::timeout(Duration::from_secs(10), async {
        while hub.subscriptions.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(resubscribed.is_ok(), "the subscription was not replaced");
    hub.rest_values.lock().unwrap().clear();
    // The replaced subscription keeps the Engine evaluable (no Engine event).
    wait_engine(&runtime, "the new subscription's value", active).await;
    assert!(runtime.reread_failure().borrow().is_none());
    runtime.stop().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn reread_failures_beyond_the_limit_mean_receive_lost_until_one_succeeds() {
    let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
    let (dir, _terminal, _db, _applied, _definitions, _session, evaluator) =
        outage_fixture("alarm-reread-failure").await;
    let runtime = AlarmRuntime::start_with_config(evaluator, hub.clients(), fast())
        .await
        .unwrap();
    let mut report = runtime.reread_failure();
    wait_engine(&runtime, "the subscribed value", active).await;
    hub.rest_fail.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(10), report.wait_for(Option::is_some))
        .await
        .expect("a reread failure warning")
        .unwrap();
    wait_engine(&runtime, "ReceiveLost", |engine| {
        engine.unavailable() == Some(EngineUnavailable::ReceiveLost)
    })
    .await;
    hub.rest_fail.store(false, Ordering::SeqCst);
    // One success ends it; the condition is evaluated again from the
    // subscription's current value, not the value it held.
    wait_engine(&runtime, "recovery", active).await;
    assert!(runtime.reread_failure().borrow().is_none());
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 1);
    runtime.stop().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn resubscription_failures_mean_receive_lost_until_one_succeeds() {
    let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
    let (dir, _terminal, _db, _applied, _definitions, _session, evaluator) =
        outage_fixture("alarm-resubscribe-failure").await;
    let made = Arc::new(AtomicUsize::new(0));
    let allow = Arc::new(AtomicBool::new(false));
    let inner = hub.clients();
    let clients = {
        let made = made.clone();
        let allow = allow.clone();
        // The stream and the first reader are made; then the saved Hub
        // record no longer matches, until `allow`.
        HubClients::new(move || {
            let count = made.fetch_add(1, Ordering::SeqCst);
            if count < 2 || allow.load(Ordering::SeqCst) {
                inner.make()
            } else {
                None
            }
        })
    };
    let runtime = AlarmRuntime::start_with_config(evaluator, clients, fast())
        .await
        .unwrap();
    wait_engine(&runtime, "the subscribed value", active).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while made.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the first reread");
    hub.rest_values
        .lock()
        .unwrap()
        .insert("PLANT.FLAG".into(), 0.0);
    wait_engine(&runtime, "ReceiveLost", |engine| {
        engine.unavailable() == Some(EngineUnavailable::ReceiveLost)
    })
    .await;
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 1);
    hub.rest_values.lock().unwrap().clear();
    allow.store(true, Ordering::SeqCst);
    wait_engine(&runtime, "recovery", active).await;
    assert!(hub.subscriptions.load(Ordering::SeqCst) >= 2);
    runtime.stop().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_reread_from_another_catalog_generation_is_only_liveness() {
    let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
    let (dir, _terminal, _db, _applied, _definitions, _session, evaluator) =
        outage_fixture("alarm-reread-generation").await;
    let runtime = AlarmRuntime::start_with_config(evaluator, hub.clients(), fast())
        .await
        .unwrap();
    wait_engine(&runtime, "the subscribed value", active).await;
    // The Hub's catalog changed before the subscription rebinds: its rows
    // must not be converted with the old catalog's data types.
    hub.rest_revision.store(4, Ordering::SeqCst);
    hub.rest_values
        .lock()
        .unwrap()
        .insert("PLANT.FLAG".into(), 0.0);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(active(&runtime.snapshot().await.unwrap()));
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 1);
    assert!(runtime.reread_failure().borrow().is_none());
    runtime.stop().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
