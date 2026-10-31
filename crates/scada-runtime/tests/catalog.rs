//! Catalog reads use only an ephemeral loopback HTTP server and a test key.
use banto_tagclient::{
    CatalogSnapshot, CollectionMode, Endpoint, ErrorKind, RestClient, SecretApiKey,
};
use scada_model::Project;
use scada_runtime::{catalog_view, CatalogError, CatalogHost};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

fn project() -> Project {
    Project::from_json(include_str!("../../../examples/minimal.project.json")).unwrap()
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../examples/catalog-view.json")).unwrap()
}
fn client(listener: &TcpListener) -> RestClient {
    RestClient::with_request_timeout(
        Endpoint::new(format!("http://{}", listener.local_addr().unwrap())).unwrap(),
        SecretApiKey::new("catalog-test-only".into()).unwrap(),
        Duration::from_secs(3),
    )
    .unwrap()
}
async fn request(listener: &TcpListener) -> TcpStream {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        headers.push(stream.read_u8().await.unwrap());
        assert!(headers.len() < 16384);
    }
    let headers = String::from_utf8(headers).unwrap();
    assert!(headers.starts_with("GET /api/v1/tags "));
    assert!(headers
        .to_lowercase()
        .contains("authorization: bearer catalog-test-only"));
    stream
}
async fn reply(mut stream: TcpStream, status: &str, body: Value) {
    let body = body.to_string();
    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

#[test]
fn shared_catalog_fixture_is_minimal_and_schema_valid() {
    let f = fixture();
    let catalog: CatalogSnapshot = serde_json::from_value(f["input"].clone()).unwrap();
    let wire = serde_json::to_value(catalog_view(&project(), &catalog).unwrap()).unwrap();
    assert_eq!(wire, f["view"]);
    let schema: Value =
        serde_json::from_str(include_str!("../schema/catalog-view.schema.json")).unwrap();
    assert!(jsonschema::validator_for(&schema).unwrap().is_valid(&wire));
    for row in wire["tags"].as_array().unwrap() {
        assert_eq!(row.as_object().unwrap().len(), 7);
        for private in [
            "address",
            "expression",
            "writable",
            "tagKey",
            "ids",
            "valueSource",
        ] {
            assert!(row.get(private).is_none());
        }
    }
}

#[test]
fn malformed_metadata_and_duplicate_names_fail_but_unknown_types_stay_visible() {
    let mut catalog: CatalogSnapshot = serde_json::from_value(fixture()["input"].clone()).unwrap();
    assert_eq!(
        catalog_view(&project(), &catalog).unwrap().tags[3].data_type,
        "future"
    );
    catalog.tags.push(catalog.tags[0].clone());
    assert_eq!(
        catalog_view(&project(), &catalog),
        Err(CatalogError::InvalidCatalog)
    );
    catalog.tags.pop();
    catalog.revision = 9_007_199_254_740_992;
    assert_eq!(
        catalog_view(&project(), &catalog),
        Err(CatalogError::UnsafeInteger)
    );
    catalog.revision = 7;
    catalog.collection_mode = CollectionMode::Unknown("future".into());
    assert_eq!(
        catalog_view(&project(), &catalog),
        Err(CatalogError::InvalidCatalog)
    );
    catalog.collection_mode = CollectionMode::Configured;
    catalog.tags[0].connection = " ".into();
    assert_eq!(
        catalog_view(&project(), &catalog),
        Err(CatalogError::InvalidCatalog)
    );
}

#[tokio::test]
async fn a_project_without_value_bindings_reads_catalog_once_and_rejects_reverse_completion() {
    let project = project();
    assert!(project.text_bindings().is_empty());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut host = CatalogHost::new(&project);
    assert!(host.request().is_none());
    host.replace(&project, Some(client(&listener)));
    let old = tokio::spawn(host.request().unwrap().fetch());
    let old_stream = request(&listener).await;
    let current = tokio::spawn(host.request().unwrap().fetch());
    reply(
        request(&listener).await,
        "200 OK",
        fixture()["input"].clone(),
    )
    .await;
    assert_eq!(
        serde_json::to_value(host.accept(current.await.unwrap()).unwrap().unwrap()).unwrap(),
        fixture()["view"]
    );
    reply(old_stream, "401 Unauthorized", json!({})).await;
    assert_eq!(host.accept(old.await.unwrap()), Ok(None));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn same_project_replacement_and_stop_retire_successes_and_current_errors_are_preserved() {
    let project = project();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut host = CatalogHost::new(&project);
    host.replace(&project, Some(client(&listener)));
    for stop in [false, true] {
        let pending = tokio::spawn(host.request().unwrap().fetch());
        let stream = request(&listener).await;
        if stop {
            host.stop();
        } else {
            host.replace(&project, Some(client(&listener)));
        }
        reply(stream, "200 OK", fixture()["input"].clone()).await;
        assert_eq!(host.accept(pending.await.unwrap()), Ok(None));
    }
    assert!(host.request().is_none());
    host.replace(&project, Some(client(&listener)));
    let pending = tokio::spawn(host.request().unwrap().fetch());
    reply(request(&listener).await, "401 Unauthorized", json!({})).await;
    assert_eq!(
        host.accept(pending.await.unwrap()),
        Err(CatalogError::Fetch(ErrorKind::Unauthorized))
    );
}
