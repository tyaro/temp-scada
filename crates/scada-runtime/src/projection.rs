//! Textと機器slotで共用するSDK snapshotの検査。接続・Qualityの生成はSDKに委ねる。
use std::collections::HashMap;

use crate::{
    Provenance, Quality, ReadSlotInvalidReason as Reason, ReadSlotReading, ReadSlotType,
    ReadSlotValue,
};
use banto_tagclient::{
    resolve_bindings, BindingRequest, CatalogSnapshot, CatalogTag, CollectionMode,
    GenerationSnapshot, ValueEntry, ValueQuality, ValueSource, ValuesSnapshot,
};

pub(crate) struct SnapshotIndex<'a> {
    catalog: &'a CatalogSnapshot,
    tags: HashMap<&'a str, &'a CatalogTag>,
    values: HashMap<&'a str, &'a ValueEntry>,
}

impl<'a> SnapshotIndex<'a> {
    /// Public SDK state owns the catalog/resolution/values relationship.
    /// A projection may use a subset of a combined Text + slot subscription,
    /// but must never diagnose an unrequested name as a missing Hub tag.
    pub(crate) fn from_generation(
        requests: &[BindingRequest],
        generation: &'a GenerationSnapshot,
    ) -> Result<Self, Reason> {
        let requested: HashMap<_, _> =
            generation
                .resolution
                .resolved
                .iter()
                .map(|binding| (binding.binding_key.as_str(), binding.external_name.as_str()))
                .chain(
                    generation.resolution.unresolved.iter().map(|binding| {
                        (binding.binding_key.as_str(), binding.external_name.as_str())
                    }),
                )
                .collect();
        if requests.iter().any(|request| {
            requested.get(request.binding_key.as_str()).copied()
                != Some(request.external_name.as_str())
        }) {
            return Err(Reason::InvalidCatalog);
        }
        Self::new(requests, generation.values.as_deref(), &generation.catalog)
    }

    pub(crate) fn new(
        requests: &[BindingRequest],
        snapshot: Option<&'a ValuesSnapshot>,
        catalog: &'a CatalogSnapshot,
    ) -> Result<Self, Reason> {
        if matches!(catalog.collection_mode, CollectionMode::Unknown(_))
            || snapshot.is_some_and(|snapshot| {
                snapshot.revision != catalog.revision
                    || snapshot.run_id != catalog.run_id
                    || snapshot.collection_mode != catalog.collection_mode
            })
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
        for value in snapshot.into_iter().flat_map(|snapshot| &snapshot.values) {
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
        let Some(value) = self.values.get(name) else {
            return invalid(Reason::MissingValue);
        };
        // The catalog label is informational. Only the value entry owns its
        // source, including simulation and derived_simulation (#682 R7).
        if matches!(value.value_source, ValueSource::Unknown(_)) {
            return invalid(Reason::UnknownSource);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn unrequested_names_and_keys_are_not_diagnosed_as_missing_hub_tags() {
        let catalog = crate::tests::catalog();
        let request = BindingRequest {
            binding_key: catalog.tags[0].external_name.clone(),
            external_name: catalog.tags[0].external_name.clone(),
        };
        let generation = GenerationSnapshot {
            generation: 1,
            resolution: Arc::new(
                resolve_bindings(std::slice::from_ref(&request), &catalog.tags).unwrap(),
            ),
            catalog: Arc::new(catalog),
            values: Some(Arc::new(crate::tests::snapshot())),
        };
        assert!(
            SnapshotIndex::from_generation(std::slice::from_ref(&request), &generation).is_ok()
        );
        for request in [
            BindingRequest {
                binding_key: "unrequested".into(),
                external_name: "missing".into(),
            },
            BindingRequest {
                binding_key: request.binding_key.clone(),
                external_name: "wrong-name".into(),
            },
            BindingRequest {
                binding_key: "wrong-key".into(),
                external_name: request.external_name,
            },
        ] {
            assert!(matches!(
                SnapshotIndex::from_generation(&[request], &generation),
                Err(Reason::InvalidCatalog)
            ));
        }
    }
}
