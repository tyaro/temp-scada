//! Inspect the same ReadHost projection the desktop sends to the UI.
use scada_host::{local_bootstrap, DEFAULT_HUB_ENDPOINT};
use scada_model::Project;
use scada_runtime::ReadHost;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let project = Project::from_json(include_str!("../../../examples/real-hub-s7.project.json"))?;
    let bootstrap = local_bootstrap()?;
    let connection = bootstrap.connect(DEFAULT_HUB_ENDPOINT).await?;
    println!("hub_status={}", connection.status.as_str());
    if !connection.status.is_connected() {
        return Ok(());
    }
    let client = bootstrap.rest_client()?.expect("connected client");
    let mut host = ReadHost::new(&project).map_err(|_| "invalid_read_plan")?;
    host.replace(&project, Some(client))
        .await
        .map_err(|_| "read_start_failed")?;
    let mut frames = host.state_watch();
    for _ in 0..8 {
        match tokio::time::timeout(std::time::Duration::from_secs(2), frames.changed()).await {
            Ok(Ok(())) => {
                let frame = frames.borrow_and_update().clone();
                println!(
                    "connection={} metadata_ready={} generation={:?}",
                    frame.text.connection, frame.text.metadata_ready, frame.sdk_generation
                );
                for (name, reading) in &frame.text.readings {
                    println!("text={name} {reading:?}");
                }
                for slot in &frame.slots.slots {
                    println!("slot={:?}", slot);
                }
            }
            _ => break,
        }
    }
    let _ = host.stop().await;
    Ok(())
}
