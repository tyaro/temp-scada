//! Converts the host's saved Project file into durable alarm definitions.
//! The webview supplies only a fileId; these bytes are read again by the host.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader, Cursor, Read};
use std::path::Path;

use scada_alarm::{AckMode, ConditionSpec, LimitKind, Source};
use scada_model::Project;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::alarm_db::{AppliedDefinitions, ConditionDisplay, Definition};
use crate::project_file::{ProjectFormat, FILE_LIMIT};

const JSON_LIMIT: u64 = 1024 * 1024;
const TOTAL_LIMIT: u64 = 67 * 1024 * 1024;

#[derive(Deserialize)]
struct ProjectIdentity {
    manifest: ManifestIdentity,
}

#[derive(Deserialize)]
struct ManifestIdentity {
    #[serde(rename = "projectId")]
    project_id: String,
}

#[derive(Debug)]
pub enum AlarmProjectError {
    Io(std::io::Error),
    InvalidFile,
    InvalidProject(String),
}

impl From<std::io::Error> for AlarmProjectError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// The validated definitions and identity derived from one saved file.
pub struct SavedAlarmProject {
    pub project_id: String,
    pub project_revision: u64,
    pub file_hash: String,
    pub definitions: BTreeMap<String, Definition>,
    pub disabled: BTreeSet<String>,
    pub displays: BTreeMap<String, ConditionDisplay>,
    pub document: Value,
}

impl SavedAlarmProject {
    /// Read only the saved identity before a Saved-mode apply decides whether
    /// this file belongs to the monitored Project. A package's assets and
    /// checksums are read only when the Project is actually applied.
    pub fn read_project_id(path: &Path) -> Result<String, AlarmProjectError> {
        if std::fs::metadata(path)?.len() > FILE_LIMIT {
            return Err(AlarmProjectError::InvalidFile);
        }
        match ProjectFormat::of(path) {
            Some(ProjectFormat::Json) => {
                let file = std::fs::File::open(path)?;
                let identity: ProjectIdentity = serde_json::from_reader(BufReader::new(file))
                    .map_err(|_| AlarmProjectError::InvalidFile)?;
                Ok(identity.manifest.project_id)
            }
            Some(ProjectFormat::Package) => {
                let file = std::fs::File::open(path)?;
                let mut zip =
                    zip::ZipArchive::new(file).map_err(|_| AlarmProjectError::InvalidFile)?;
                let mut entry = zip
                    .by_name("manifest.json")
                    .map_err(|_| AlarmProjectError::InvalidFile)?;
                let mut bytes = Vec::new();
                entry
                    .by_ref()
                    .take(JSON_LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| AlarmProjectError::InvalidFile)?;
                if bytes.len() as u64 > JSON_LIMIT {
                    return Err(AlarmProjectError::InvalidFile);
                }
                let envelope: Value =
                    serde_json::from_slice(&bytes).map_err(|_| AlarmProjectError::InvalidFile)?;
                if envelope["profile"] != "banto-scada.image-project" || envelope["version"] != 1 {
                    return Err(AlarmProjectError::InvalidFile);
                }
                envelope["project"]["projectId"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or(AlarmProjectError::InvalidFile)
            }
            None => Err(AlarmProjectError::InvalidFile),
        }
    }

    pub fn read(path: &Path) -> Result<Self, AlarmProjectError> {
        if std::fs::metadata(path)?.len() > FILE_LIMIT {
            return Err(AlarmProjectError::InvalidFile);
        }
        let bytes = std::fs::read(path)?;
        Self::from_bytes(path, &bytes)
    }

    pub fn from_bytes(path: &Path, bytes: &[u8]) -> Result<Self, AlarmProjectError> {
        if bytes.len() as u64 > FILE_LIMIT {
            return Err(AlarmProjectError::InvalidFile);
        }
        let file_hash = format!("{:x}", Sha256::digest(bytes));
        let document = match ProjectFormat::of(path) {
            Some(ProjectFormat::Json) => {
                serde_json::from_slice(bytes).map_err(|_| AlarmProjectError::InvalidFile)?
            }
            Some(ProjectFormat::Package) => package_document(bytes)?,
            None => return Err(AlarmProjectError::InvalidFile),
        };
        let project =
            Project::from_json(&document.to_string()).map_err(AlarmProjectError::InvalidProject)?;
        let alarm_document = document
            .get("alarms")
            .cloned()
            .unwrap_or_else(|| json!({"definitions": []}));
        let (definitions, disabled, displays) = parse_alarm_document(&alarm_document)?;
        Ok(Self {
            project_id: project.id().into(),
            project_revision: project.revision(),
            file_hash,
            definitions,
            disabled,
            displays,
            document: alarm_document,
        })
    }

    pub fn from_applied(applied: &AppliedDefinitions) -> Result<Self, AlarmProjectError> {
        let (definitions, disabled, displays) = parse_alarm_document(&applied.definitions)?;
        let candidate = Self {
            project_id: applied.project_id.clone(),
            project_revision: applied.project_revision,
            file_hash: applied.file_hash.clone(),
            definitions,
            disabled,
            displays,
            document: applied.definitions.clone(),
        };
        if candidate.applied(
            applied.endpoint.clone(),
            applied.applied_by.clone(),
            applied.applied_at_ms,
        ) != *applied
        {
            return Err(AlarmProjectError::InvalidFile);
        }
        Ok(candidate)
    }

    pub fn applied(&self, endpoint: String, applied_by: String, at_ms: i64) -> AppliedDefinitions {
        AppliedDefinitions {
            project_id: self.project_id.clone(),
            project_revision: self.project_revision,
            file_hash: self.file_hash.clone(),
            endpoint,
            applied_by,
            applied_at_ms: at_ms,
            definitions: self.document.clone(),
            condition_hashes: self
                .definitions
                .iter()
                .map(|(id, definition)| (id.clone(), definition.evaluation_hash()))
                .collect(),
            disabled_condition_ids: self.disabled.clone(),
            displays: self.displays.clone(),
        }
    }
}

type ExpandedAlarms = (
    BTreeMap<String, Definition>,
    BTreeSet<String>,
    BTreeMap<String, ConditionDisplay>,
);

fn parse_alarm_document(alarm_document: &Value) -> Result<ExpandedAlarms, AlarmProjectError> {
    let mut definitions = BTreeMap::new();
    let mut disabled = BTreeSet::new();
    let mut displays = BTreeMap::new();
    let mut source_ids = BTreeSet::new();
    for item in alarm_document["definitions"]
        .as_array()
        .ok_or(AlarmProjectError::InvalidFile)?
    {
        let id = required_string(item, "id")?;
        if !source_ids.insert(id.clone()) {
            return Err(AlarmProjectError::InvalidFile);
        }
        let name = required_string(item, "name")?;
        let tag = required_string(&item["source"], "tag")?;
        let ack_mode = match item.get("ackMode") {
            Some(mode) => serde_json::from_value::<AckMode>(mode.clone())
                .map_err(|_| AlarmProjectError::InvalidFile)?,
            None => AckMode::Manual,
        };
        let on_delay_ms = match item.get("onDelayMs") {
            None => 0,
            Some(value) => value.as_u64().ok_or(AlarmProjectError::InvalidFile)?,
        };
        let off_delay_ms = match item.get("offDelayMs") {
            None => 0,
            Some(value) => value.as_u64().ok_or(AlarmProjectError::InvalidFile)?,
        };
        let mut add = |condition_id: String,
                       source: Source,
                       severity: String,
                       message: String,
                       limit_label: Option<String>|
         -> Result<(), AlarmProjectError> {
            if definitions.contains_key(&condition_id) || disabled.contains(&condition_id) {
                return Err(AlarmProjectError::InvalidFile);
            }
            if item["enabled"] == false {
                disabled.insert(condition_id);
            } else {
                let definition = Definition {
                    spec: ConditionSpec {
                        source,
                        on_delay_ms,
                        off_delay_ms,
                        ack_mode,
                    },
                };
                displays.insert(
                    condition_id.clone(),
                    ConditionDisplay {
                        name: name.clone(),
                        message,
                        severity,
                        limit_label,
                    },
                );
                definitions.insert(condition_id, definition);
            }
            Ok(())
        };
        match item["source"]["kind"].as_str() {
            Some("bit") => add(
                id,
                Source::Bit {
                    tag,
                    active_when: item["source"]["activeWhen"]
                        .as_bool()
                        .ok_or(AlarmProjectError::InvalidFile)?,
                },
                required_string(item, "severity")?,
                item["message"].as_str().unwrap_or(&name).to_owned(),
                None,
            )?,
            Some("threshold") => {
                let deadband = match item["source"].get("deadband") {
                    None => 0.0,
                    Some(value) => value.as_f64().ok_or(AlarmProjectError::InvalidFile)?,
                };
                for (key, limit, label) in [
                    ("hh", LimitKind::Hh, "HH"),
                    ("h", LimitKind::H, "H"),
                    ("l", LimitKind::L, "L"),
                    ("ll", LimitKind::Ll, "LL"),
                ] {
                    let row = &item["source"]["limits"][key];
                    if row.is_null() {
                        continue;
                    }
                    add(
                        format!("{id}:{key}"),
                        Source::Threshold {
                            tag: tag.clone(),
                            limit,
                            value: row["value"]
                                .as_f64()
                                .ok_or(AlarmProjectError::InvalidFile)?,
                            deadband,
                        },
                        required_string(row, "severity")?,
                        row["message"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("{name} {label}")),
                        Some(label.into()),
                    )?;
                }
            }
            _ => return Err(AlarmProjectError::InvalidFile),
        }
    }
    Ok((definitions, disabled, displays))
}

fn required_string(value: &Value, key: &str) -> Result<String, AlarmProjectError> {
    value[key]
        .as_str()
        .map(str::to_owned)
        .ok_or(AlarmProjectError::InvalidFile)
}

fn package_document(bytes: &[u8]) -> Result<Value, AlarmProjectError> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| AlarmProjectError::InvalidFile)?;
    if !(3..=131).contains(&zip.len()) {
        return Err(AlarmProjectError::InvalidFile);
    }
    let mut files = BTreeMap::new();
    let mut total = 0_u64;
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|_| AlarmProjectError::InvalidFile)?;
        let name = file.name().to_owned();
        let known = matches!(
            name.as_str(),
            "manifest.json" | "project.json" | "checksums.json"
        );
        if !known && !valid_asset_path(&name) {
            return Err(AlarmProjectError::InvalidFile);
        }
        let limit = if known { JSON_LIMIT } else { TOTAL_LIMIT };
        let mut data = Vec::new();
        file.by_ref()
            .take(limit + 1)
            .read_to_end(&mut data)
            .map_err(|_| AlarmProjectError::InvalidFile)?;
        total = total
            .checked_add(data.len() as u64)
            .ok_or(AlarmProjectError::InvalidFile)?;
        if data.len() as u64 > limit || total > TOTAL_LIMIT || files.insert(name, data).is_some() {
            return Err(AlarmProjectError::InvalidFile);
        }
    }
    let checksums: BTreeMap<String, String> = serde_json::from_slice(
        files
            .get("checksums.json")
            .ok_or(AlarmProjectError::InvalidFile)?,
    )
    .map_err(|_| AlarmProjectError::InvalidFile)?;
    if checksums.len() + 1 != files.len() {
        return Err(AlarmProjectError::InvalidFile);
    }
    for (name, data) in &files {
        if name == "checksums.json" {
            continue;
        }
        if checksums.get(name) != Some(&format!("{:x}", Sha256::digest(data))) {
            return Err(AlarmProjectError::InvalidFile);
        }
    }
    let manifest: Value = serde_json::from_slice(
        files
            .get("manifest.json")
            .ok_or(AlarmProjectError::InvalidFile)?,
    )
    .map_err(|_| AlarmProjectError::InvalidFile)?;
    if manifest["profile"] != "banto-scada.image-project" || manifest["version"] != 1 {
        return Err(AlarmProjectError::InvalidFile);
    }
    let mut project: Value = serde_json::from_slice(
        files
            .get("project.json")
            .ok_or(AlarmProjectError::InvalidFile)?,
    )
    .map_err(|_| AlarmProjectError::InvalidFile)?;
    project
        .as_object_mut()
        .ok_or(AlarmProjectError::InvalidFile)?
        .insert("manifest".into(), manifest["project"].clone());
    Ok(project)
}

fn valid_asset_path(name: &str) -> bool {
    let Some((hash, extension)) = name
        .strip_prefix("assets/")
        .and_then(|tail| tail.rsplit_once('.'))
    else {
        return false;
    };
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        && matches!(extension, "png" | "jpg")
}

#[cfg(test)]
#[path = "alarm_project/tests.rs"]
mod tests;
