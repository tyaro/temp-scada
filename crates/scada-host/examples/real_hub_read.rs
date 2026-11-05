//! Read-only, local Windows commissioning probe. Never pass an API key on argv.
use scada_host::{local_bootstrap, DEFAULT_HUB_ENDPOINT};

const TAGS: [&str; 4] = [
    "s7-bridge.s7-bridge-g.temperature",
    "s7-bridge.s7-bridge-g.pressure",
    "s7-bridge.s7-bridge-g.running",
    "s7-bridge.s7-bridge-g.updated_at",
];

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bootstrap = local_bootstrap()?;
    let result = bootstrap.connect(DEFAULT_HUB_ENDPOINT).await?;
    println!("hub_status={}", result.status.as_str());
    if !result.status.is_connected() {
        return Ok(());
    }
    let catalog = result.catalog.expect("connected catalog");
    println!(
        "catalog_revision={} tags={}",
        catalog.revision,
        catalog.tags.len()
    );
    for name in TAGS {
        println!(
            "tag_present={name}:{}",
            catalog.tags.iter().any(|tag| tag.external_name == name)
        );
    }
    let client = bootstrap.rest_client()?.expect("connected client");
    let values = client.fetch_values(&TAGS).await?;
    println!("response_time_ms={} revision={}", values.t, values.revision);
    for value in values.values {
        println!(
            "value={} v={:?} quality={} source={} source_time_ms={}",
            value.tag,
            value.v,
            value.q.as_str(),
            value.value_source.as_str(),
            value.t
        );
    }
    Ok(())
}
