//! Textと機器slotで共用するSDK snapshotの検査。接続・Qualityの生成はSDKに委ねる。
use std::collections::HashMap;

use crate::{
    Provenance, Quality, ReadSlotInvalidReason as Reason, ReadSlotReading, ReadSlotType,
    ReadSlotValue,
};
use banto_tagclient::{
    resolve_bindings, BindingRequest, CatalogSnapshot, CatalogTag, CollectionMode, ValueEntry,
    ValueQuality, ValueSource, ValuesSnapshot,
};

pub(crate) struct SnapshotIndex<'a> {
    catalog: &'a CatalogSnapshot,
    tags: HashMap<&'a str, &'a CatalogTag>,
    values: HashMap<&'a str, &'a ValueEntry>,
}

impl<'a> SnapshotIndex<'a> {
    pub(crate) fn new(
        requests: &[BindingRequest],
        snapshot: &'a ValuesSnapshot,
        catalog: &'a CatalogSnapshot,
    ) -> Result<Self, Reason> {
        if snapshot.revision != catalog.revision
            || snapshot.run_id != catalog.run_id
            || snapshot.collection_mode != catalog.collection_mode
            || matches!(catalog.collection_mode, CollectionMode::Unknown(_))
        {
            return Err(Reason::MetadataMismatch);
        }
        if resolve_bindings(requests, &catalog.tags).is_err() {
            return Err(Reason::InvalidCatalog);
        }
        let tags = catalog
            .tags
            .iter()
            .map(|tag| (tag.external_name.as_str(), tag))
            .collect();
        let mut values = HashMap::new();
        for value in &snapshot.values {
            if values.insert(value.tag.as_str(), value).is_some() {
                return Err(Reason::DuplicateValues);
            }
        }
        Ok(Self {
            catalog,
            tags,
            values,
        })
    }

    pub(crate) fn read(
        &self,
        name: &str,
        expected: ReadSlotType,
    ) -> (ReadSlotReading, Option<Provenance>) {
        let invalid = |reason| (ReadSlotReading::Invalid { reason }, None);
        let Some(tag) = self.tags.get(name) else {
            return (ReadSlotReading::Unresolved, None);
        };
        if !tag.enabled {
            return invalid(Reason::Disabled);
        }
        let compatible = match expected {
            ReadSlotType::Bool => tag.data_type == "bit",
            ReadSlotType::Number => matches!(
                tag.data_type.as_str(),
                "i16" | "u16" | "i32" | "u32" | "f32" | "i64" | "u64" | "f64"
            ),
        };
        if !compatible {
            return invalid(Reason::TypeMismatch);
        }
        if matches!(tag.value_source, ValueSource::Unknown(_)) {
            return invalid(Reason::UnknownSource);
        }
        let Some(value) = self.values.get(name) else {
            return invalid(Reason::MissingValue);
        };
        if value.value_source != tag.value_source {
            return invalid(Reason::SourceMismatch);
        }
        let (quality, projected) = match value.q {
            ValueQuality::Good => {
                let Some(number) = value.v.filter(|value| value.is_finite()) else {
                    return invalid(Reason::InvalidValue);
                };
                let projected = match expected {
                    ReadSlotType::Bool => match number {
                        0.0 => ReadSlotValue::Bool(false),
                        1.0 => ReadSlotValue::Bool(true),
                        _ => return invalid(Reason::InvalidValue),
                    },
                    ReadSlotType::Number => ReadSlotValue::Number(number),
                };
                (Quality::Good, Some(projected))
            }
            ValueQuality::Bad => (Quality::Bad, None),
            ValueQuality::Stale => (Quality::Stale, None),
            ValueQuality::Unknown(_) => return invalid(Reason::UnknownQuality),
        };
        (
            ReadSlotReading::Resolved {
                quality,
                value: projected,
            },
            Some(Provenance {
                catalog_revision: self.catalog.revision,
                run_id: self.catalog.run_id,
                collection_mode: self.catalog.collection_mode.as_str().into(),
                value_source: value.value_source.as_str().into(),
                source_timestamp_ms: value.t,
            }),
        )
    }
}
