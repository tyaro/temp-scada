//! A presentation-only delivery stream. Local Host session tokens stay in Rust.
use serde::Serialize;

use crate::{ReadHostFrame, ReadSession, ReadSlotView, RuntimeView};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDisplayUpdate {
    pub sequence: u64,
    pub sdk_generation: Option<u64>,
    pub text: RuntimeView,
    pub slots: ReadSlotView,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadDisplayError {
    SessionChanged,
    SequenceExhausted,
    UnsafeInteger,
}

/// A transport adapter pairs one stream with one frontend delivery callback.
/// On SessionChanged, begin a new delivery; never serialize the local token.
pub struct ReadDisplayStream {
    session: ReadSession,
    sequence: u64,
}

impl ReadDisplayStream {
    pub fn new(frame: &ReadHostFrame) -> Self {
        Self {
            session: frame.session().clone(),
            sequence: 0,
        }
    }

    pub fn next(&mut self, frame: &ReadHostFrame) -> Result<ReadDisplayUpdate, ReadDisplayError> {
        if &self.session != frame.session() {
            return Err(ReadDisplayError::SessionChanged);
        }
        if frame
            .sdk_generation
            .is_some_and(|value| value > MAX_SAFE_INTEGER)
            || frame.text.project_revision > MAX_SAFE_INTEGER
            || frame.slots.project_revision > MAX_SAFE_INTEGER
            || frame
                .text
                .provenance
                .values()
                .chain(
                    frame
                        .slots
                        .slots
                        .iter()
                        .filter_map(|slot| slot.provenance.as_ref()),
                )
                .any(|p| {
                    p.catalog_revision > MAX_SAFE_INTEGER
                        || p.run_id.is_some_and(|value| value > MAX_SAFE_INTEGER)
                        || !(-(MAX_SAFE_INTEGER as i64)..=MAX_SAFE_INTEGER as i64)
                            .contains(&p.source_timestamp_ms)
                })
        {
            return Err(ReadDisplayError::UnsafeInteger);
        }
        if self.sequence == MAX_SAFE_INTEGER {
            return Err(ReadDisplayError::SequenceExhausted);
        }
        self.sequence += 1;
        Ok(ReadDisplayUpdate {
            sequence: self.sequence,
            sdk_generation: frame.sdk_generation,
            text: frame.text.clone(),
            slots: frame.slots.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BindingPlan, NumericReading, ReadHost, ReadSlotPlan, ReadSlotReading};
    use banto_tagclient::{CollectionMode, ValueQuality, ValueSource};
    use scada_model::Project;
    use serde_json::{json, Value};

    fn validator() -> jsonschema::Validator {
        let slots =
            serde_json::from_str(include_str!("../schema/read-slot-view.schema.json")).unwrap();
        let text =
            serde_json::from_str(include_str!("../schema/runtime-view.schema.json")).unwrap();
        let root: Value =
            serde_json::from_str(include_str!("../schema/read-display-update.schema.json"))
                .unwrap();
        jsonschema::options()
            .with_resource(
                "urn:banto:read-slot-view",
                jsonschema::Resource::from_contents(slots).unwrap(),
            )
            .with_resource(
                "urn:banto:runtime-view",
                jsonschema::Resource::from_contents(text).unwrap(),
            )
            .build(&root)
            .unwrap()
    }

    // JSON uses one number type in the browser, unlike serde_json's internal
    // integer/float variants. Validate the original before normalizing equality.
    fn normalize(value: &mut Value) {
        match value {
            Value::Number(number) => *value = json!(number.as_f64().unwrap()),
            Value::Array(values) => values.iter_mut().for_each(normalize),
            Value::Object(values) => values.values_mut().for_each(normalize),
            _ => {}
        }
    }

    #[test]
    fn shared_display_fixtures_are_rust_projection_and_schema_valid() {
        let project = Project::from_json(include_str!(
            "../../../examples/read-presentation.project.json"
        ))
        .unwrap();
        let host = ReadHost::new(&project).unwrap();
        let text_plan = BindingPlan::new(&project);
        let slot_plan = ReadSlotPlan::from_project(&project).unwrap();
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../../examples/read-display-cases.json"))
                .unwrap();
        for fixture in fixtures {
            let input = &fixture["input"];
            let mut frame = (*host.state()).clone();
            let connection = input["connection"].as_str().unwrap();
            if connection == "live" {
                let mut catalog = crate::tests::catalog();
                catalog.revision = 7;
                catalog.run_id = Some(17);
                catalog.collection_mode = CollectionMode::parse(input["mode"].as_str().unwrap());
                catalog.tags[0].external_name = "Demo.Number".into();
                let mut boolean = catalog.tags[0].clone();
                boolean.external_name = "Demo.Bool".into();
                boolean.tag_key = "bool-key".into();
                boolean.data_type = "bit".into();
                boolean.ids = banto_tagclient::StableTagId::new(1, 2, 4);
                catalog.tags.push(boolean);
                let mut values = crate::tests::snapshot();
                values.revision = 7;
                values.run_id = Some(17);
                values.collection_mode = catalog.collection_mode.clone();
                values.values[0].tag = "Demo.Number".into();
                values.values[0].v = input["value"].as_f64();
                values.values[0].q = ValueQuality::parse(input["quality"].as_str().unwrap());
                values.values[0].t = 1000;
                values.values[0].value_source =
                    ValueSource::parse(input["source"].as_str().unwrap());
                let mut boolean = values.values[0].clone();
                boolean.tag = "Demo.Bool".into();
                boolean.v = Some(0.0);
                values.values.push(boolean);
                frame.text.connection = "live".into();
                frame.slots.connection = "live".into();
                crate::project_snapshot(&text_plan, &values, &catalog, &mut frame.text);
                crate::slots::project_slot_snapshot(
                    &slot_plan,
                    Some(&values),
                    Some(&catalog),
                    &mut frame.slots,
                );
                frame.sdk_generation = Some(1);
            } else if connection == "unbound" {
                frame.sdk_generation = Some(1);
                frame.text.connection = "unbound".into();
                frame.slots.connection = "unbound".into();
                frame.text.metadata_ready = true;
                frame.slots.metadata_ready = true;
                frame
                    .text
                    .readings
                    .values_mut()
                    .for_each(|r| *r = NumericReading::Unresolved);
                frame.slots.slots.iter_mut().for_each(|slot| {
                    if slot.external_name.is_some() {
                        slot.reading = ReadSlotReading::Unresolved;
                    }
                });
            }
            let update = ReadDisplayStream::new(&frame).next(&frame).unwrap();
            let mut wire = serde_json::to_value(update).unwrap();
            assert!(validator().is_valid(&wire), "{}: {wire}", fixture["name"]);
            let mut expected = fixture["update"].clone();
            normalize(&mut wire);
            normalize(&mut expected);
            assert_eq!(wire, expected, "{}", fixture["name"]);
        }
    }

    #[tokio::test]
    async fn a_stream_never_serializes_local_session_identity_or_accepts_a_replacement_session() {
        let project = Project::from_json(include_str!(
            "../../../examples/read-presentation.project.json"
        ))
        .unwrap();
        let mut host = ReadHost::new(&project).unwrap();
        let frame = host.state();
        let mut stream = ReadDisplayStream::new(&frame);
        assert_eq!(stream.next(&frame).unwrap().sequence, 1);
        assert_eq!(stream.next(&frame).unwrap().sequence, 2);
        let wire = serde_json::to_value(stream.next(&frame).unwrap()).unwrap();
        assert!(validator().is_valid(&wire));
        assert_eq!(wire.as_object().unwrap().len(), 4);
        host.stop().await.unwrap();
        assert_eq!(
            stream.next(&host.state()),
            Err(ReadDisplayError::SessionChanged)
        );
    }

    #[test]
    fn unsafe_integer_and_exhausted_sequence_fail_without_rounding_or_consuming_a_number() {
        let project = Project::from_json(include_str!(
            "../../../examples/read-presentation.project.json"
        ))
        .unwrap();
        let host = ReadHost::new(&project).unwrap();
        let mut frame = (*host.state()).clone();
        let mut stream = ReadDisplayStream::new(&frame);
        frame.sdk_generation = Some(MAX_SAFE_INTEGER + 1);
        assert_eq!(stream.next(&frame), Err(ReadDisplayError::UnsafeInteger));
        frame.sdk_generation = None;
        assert_eq!(stream.next(&frame).unwrap().sequence, 1);
        stream.sequence = MAX_SAFE_INTEGER;
        assert_eq!(
            stream.next(&frame),
            Err(ReadDisplayError::SequenceExhausted)
        );
    }
}
