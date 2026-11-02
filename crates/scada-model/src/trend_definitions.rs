//! Independent display definitions. Does not resolve a Historian or alter recording.
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
    let history: Value = serde_json::from_str(HISTORY_SCHEMA).expect("bundled H1 JSON");
    let root: Value = serde_json::from_str(TREND_DEFINITION_SCHEMA).expect("bundled Trend JSON");
    jsonschema::options()
        .with_retriever(BundledOnly)
        .with_resource(
            history["$id"].as_str().expect("H1 schema ID"),
            jsonschema::Resource::from_contents(history.clone()).expect("H1 resource"),
        )
        .build(&root)
        .expect("bundled Trend schema and H1 resource")
});

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

struct Budget {
    bytes: usize,
    nodes: usize,
}
impl Budget {
    fn add(&mut self, count: usize) -> Result<(), TrendDefinitionError> {
        self.bytes = self.bytes.checked_add(count).ok_or(TrendDefinitionError)?;
        if self.bytes > MAX_TREND_JSON_BYTES {
            return Err(TrendDefinitionError);
        }
        Ok(())
    }
    // Compact JSON UTF-8 bytes, with the same escaping as JSON.stringify.
    fn string(&mut self, text: &str) -> Result<(), TrendDefinitionError> {
        self.add(text.len())?;
        self.add(2)?;
        for c in text.chars() {
            self.add(match c {
                '"' | '\\' | '\u{0008}' | '\u{0009}' | '\u{000a}' | '\u{000c}' | '\u{000d}' => 1,
                '\u{0000}'..='\u{001f}' => 5,
                _ => 0,
            })?;
        }
        Ok(())
    }
    fn visit(&mut self, value: &Value, depth: usize) -> Result<(), TrendDefinitionError> {
        self.nodes += 1;
        if self.nodes > 250_000 || depth > 32 {
            return Err(TrendDefinitionError);
        }
        match value {
            Value::Null => self.add(4),
            Value::Bool(b) => self.add(if *b { 4 } else { 5 }),
            Value::String(s) => self.string(s),
            Value::Number(n) => {
                let f = n.as_f64().ok_or(TrendDefinitionError)?;
                // All accepted number fields are small nonnegative integers.
                // Normalize 1.0/1e0/-0 for size, without rewriting caller data.
                let length =
                    if f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
                        (f as i64).to_string().len()
                    } else {
                        n.to_string().len()
                    };
                self.add(length)
            }
            Value::Array(rows) => {
                self.add(2 + rows.len().saturating_sub(1))?;
                for row in rows {
                    self.visit(row, depth + 1)?;
                }
                Ok(())
            }
            Value::Object(rows) => {
                self.add(2 + rows.len().saturating_sub(1))?;
                for (key, row) in rows {
                    self.string(key)?;
                    self.add(1)?;
                    self.visit(row, depth + 1)?;
                }
                Ok(())
            }
        }
    }
}
fn blank(text: &str) -> bool {
    text.chars().all(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{0085}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
/// Validate a structured JSON value with bounded traversal before schema/semantics.
/// Byte budget is compact JSON after integer numeric spelling normalization;
/// input wire whitespace/escapes and number spellings are not measured here.
pub fn validate_trend_definitions(document: &Value) -> Result<(), TrendDefinitionError> {
    Budget { bytes: 0, nodes: 0 }.visit(document, 0)?;
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
