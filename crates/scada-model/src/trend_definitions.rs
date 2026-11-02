//! Independent display definitions. Does not resolve a Historian or alter recording.
use crate::json_contract::{blank, JsonBudget};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const TREND_DEFINITION_SCHEMA: &str = include_str!("../schema/trend-definition.schema.json");
pub const MAX_TREND_JSON_BYTES: usize = 1024 * 1024;
const HISTORY_SCHEMA: &str =
    include_str!("../../scada-historian/schema/history-contract.schema.json");

struct BundledOnly;
impl jsonschema::Retrieve for BundledOnly {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("Unregistered Trend schema resource".into())
    }
}
static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let root: Value = serde_json::from_str(TREND_DEFINITION_SCHEMA).expect("bundled Trend JSON");
    schema_options()
        .build(&root)
        .expect("bundled Trend schema and H1 resource")
});

/// Shared local resources for Project and the independent contract. Never fetch.
pub(crate) fn schema_options() -> jsonschema::ValidationOptions {
    let history: Value = serde_json::from_str(HISTORY_SCHEMA).expect("bundled H1 JSON");
    let trend: Value = serde_json::from_str(TREND_DEFINITION_SCHEMA).expect("bundled Trend JSON");
    jsonschema::options()
        .with_retriever(BundledOnly)
        .with_resource(
            history["$id"].as_str().expect("H1 schema ID"),
            jsonschema::Resource::from_contents(history.clone()).expect("H1 resource"),
        )
        .with_resource(
            "https://temp-scada.invalid/schema/trend-definition-v1.json",
            jsonschema::Resource::from_contents(trend).expect("Trend resource"),
        )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrendDefinitionError;
impl std::fmt::Display for TrendDefinitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Trend definitions: invalid")
    }
}
impl std::error::Error for TrendDefinitionError {}

/// Owns a validated document. Serialization is not a wire parser or a binding proof.
#[derive(Clone, Debug, PartialEq)]
pub struct TrendDefinitions(Value);
impl TrendDefinitions {
    pub fn from_value(value: Value) -> Result<Self, TrendDefinitionError> {
        validate_trend_definitions(&value)?;
        Ok(Self(value))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
}

/// Validate a structured JSON value with bounded traversal before schema/semantics.
/// Byte budget is compact JSON after integer numeric spelling normalization;
/// input wire whitespace/escapes and number spellings are not measured here.
pub fn validate_trend_definitions(document: &Value) -> Result<(), TrendDefinitionError> {
    JsonBudget::new(MAX_TREND_JSON_BYTES, 250_000)
        .visit(document, 0)
        .map_err(|_| TrendDefinitionError)?;
    if !VALIDATOR.is_valid(document) {
        return Err(TrendDefinitionError);
    }
    let mut ids = HashSet::new();
    for row in document["definitions"]
        .as_array()
        .expect("schema definitions")
    {
        let pens = row["pens"].as_array().expect("schema pens");
        if !ids.insert(row["id"].as_str().expect("schema ID"))
            || blank(row["name"].as_str().expect("schema name"))
            || pens.len() as f64 * row["maxPointsPerSeries"].as_f64().expect("schema points")
                > 8000.0
        {
            return Err(TrendDefinitionError);
        }
        let mut pen_ids = HashSet::new();
        let mut series = HashSet::new();
        for pen in pens {
            if !pen_ids.insert(pen["id"].as_str().expect("schema pen ID"))
                || !series.insert(pen["seriesId"].as_str().expect("schema series ID"))
                || pen
                    .get("label")
                    .is_some_and(|label| blank(label.as_str().expect("schema label")))
            {
                return Err(TrendDefinitionError);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
