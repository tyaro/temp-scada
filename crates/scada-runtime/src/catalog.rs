//! Explicit catalog reads, independent of a Project's value subscriptions.
use std::sync::Arc;

use banto_tagclient::{resolve_bindings, CatalogSnapshot, CollectionMode, ErrorKind, RestClient};
use scada_model::Project;
use serde::Serialize;

use crate::ReadSession;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub project_id: String,
    pub project_revision: u64,
    pub catalog_revision: u64,
    pub run_id: Option<u64>,
    pub collection_mode: String,
    pub tags: Vec<CatalogRow>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRow {
    pub external_name: String,
    pub connection: String,
    pub group: String,
    pub name: String,
    pub data_type: String,
    pub unit: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogError {
    Fetch(ErrorKind),
    InvalidCatalog,
    UnsafeInteger,
}

/// No address, expression, credential, current value or write capability escapes.
pub fn catalog_view(
    project: &Project,
    catalog: &CatalogSnapshot,
) -> Result<CatalogView, CatalogError> {
    project_catalog(project.id(), project.revision(), catalog)
}

fn project_catalog(
    project_id: &str,
    project_revision: u64,
    catalog: &CatalogSnapshot,
) -> Result<CatalogView, CatalogError> {
    if project_revision > MAX_SAFE_INTEGER
        || catalog.revision > MAX_SAFE_INTEGER
        || catalog.run_id.is_some_and(|id| id > MAX_SAFE_INTEGER)
    {
        return Err(CatalogError::UnsafeInteger);
    }
    let text = |value: &str, limit: usize| {
        !value
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .is_empty()
            && value.chars().count() <= limit
    };
    if catalog.tags.len() > 64_000
        || matches!(catalog.collection_mode, CollectionMode::Unknown(_))
        || resolve_bindings(&[], &catalog.tags).is_err()
        || catalog.tags.iter().any(|tag| {
            !text(&tag.external_name, 512)
                || tag.external_name.chars().any(char::is_control)
                || !text(&tag.connection, 512)
                || !text(&tag.group, 512)
                || !text(&tag.name, 512)
                || !text(&tag.data_type, 64)
                || tag
                    .unit
                    .as_ref()
                    .is_some_and(|unit| unit.chars().count() > 512)
        })
    {
        return Err(CatalogError::InvalidCatalog);
    }
    Ok(CatalogView {
        project_id: project_id.into(),
        project_revision,
        catalog_revision: catalog.revision,
        run_id: catalog.run_id,
        collection_mode: catalog.collection_mode.as_str().into(),
        tags: catalog
            .tags
            .iter()
            .map(|tag| CatalogRow {
                external_name: tag.external_name.clone(),
                connection: tag.connection.clone(),
                group: tag.group.clone(),
                name: tag.name.clone(),
                data_type: tag.data_type.clone(),
                unit: tag.unit.clone(),
                enabled: tag.enabled,
            })
            .collect(),
    })
}

/// Owns SDK REST access only. No polling, worker, socket or value subscription.
pub struct CatalogHost {
    project_id: String,
    project_revision: u64,
    client: Option<Arc<RestClient>>,
    current: ReadSession,
}

impl CatalogHost {
    pub fn new(project: &Project) -> Self {
        Self {
            project_id: project.id().into(),
            project_revision: project.revision(),
            client: None,
            current: ReadSession::new(),
        }
    }

    /// Caller retires frontend delivery and drops old request futures first.
    pub fn replace(&mut self, project: &Project, client: Option<RestClient>) {
        self.stop();
        self.project_id = project.id().into();
        self.project_revision = project.revision();
        self.client = client.map(Arc::new);
    }

    pub fn stop(&mut self) {
        self.current = ReadSession::new();
        self.client = None;
    }

    /// Every explicit request retires previous replies, even for identical IDs.
    /// A retained request does no I/O until fetch is polled.
    pub fn request(&mut self) -> Option<CatalogRequest> {
        self.current = ReadSession::new();
        Some(CatalogRequest {
            session: self.current.clone(),
            project_id: self.project_id.clone(),
            project_revision: self.project_revision,
            client: self.client.as_ref()?.clone(),
        })
    }

    /// None means obsolete, including obsolete failures. No stale DTO is exposed.
    pub fn accept(&self, reply: CatalogReply) -> Result<Option<CatalogView>, CatalogError> {
        if reply.session != self.current {
            return Ok(None);
        }
        reply.result.map(Some)
    }
}

pub struct CatalogRequest {
    session: ReadSession,
    project_id: String,
    project_revision: u64,
    client: Arc<RestClient>,
}

pub struct CatalogReply {
    session: ReadSession,
    result: Result<CatalogView, CatalogError>,
}

impl CatalogRequest {
    pub async fn fetch(self) -> CatalogReply {
        let result = match self.client.fetch_catalog().await {
            Ok(catalog) => project_catalog(&self.project_id, self.project_revision, &catalog),
            Err(error) => Err(CatalogError::Fetch(error.kind())),
        };
        CatalogReply {
            session: self.session,
            result,
        }
    }
}
