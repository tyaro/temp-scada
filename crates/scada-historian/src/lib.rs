//! H1 pure JSON contracts only: no recorder, store, network, clock or UI.
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde_json::Value;

pub const HISTORY_CONTRACT_SCHEMA: &str = include_str!("../schema/history-contract.schema.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContractError {
    Schema,
    Semantic,
}

impl ContractError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Schema => "schema",
            Self::Semantic => "semantic",
        }
    }
}

/// Validate one structured document. Validation does not prove persistence,
/// source identity, commit progress, or that a claimed snapshot actually exists.
pub fn validate_history_contract(document: &Value) -> Result<(), ContractError> {
    static SCHEMA: OnceLock<jsonschema::Validator> = OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        let source: Value =
            serde_json::from_str(HISTORY_CONTRACT_SCHEMA).expect("bundled schema JSON");
        jsonschema::validator_for(&source).expect("bundled contract schema")
    });
    if !schema.is_valid(document) {
        return Err(ContractError::Schema);
    }
    let valid = match text(&document["kind"]) {
        "query" => query(document),
        "sampleBatch" => batch(document),
        "result" => result(document),
        _ => false,
    };
    valid.then_some(()).ok_or(ContractError::Semantic)
}

// All helpers below run only after the complete shared schema has validated.
fn text(value: &Value) -> &str {
    value.as_str().expect("schema string")
}
fn rows(value: &Value) -> &[Value] {
    value.as_array().expect("schema array")
}
// JSON Schema integer includes 1.0. Within the schema's safe-integer bounds the
// f64 conversion is exact, including negative UTC dates and large sequences.
fn integer(value: &Value) -> i64 {
    value.as_f64().expect("schema integer") as i64
}
fn allowed_source(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("real" | "computed" | "internal" | "db")
    )
}

fn query(value: &Value) -> bool {
    let series = rows(&value["seriesIds"]);
    let count = series.iter().map(text).collect::<HashSet<_>>().len();
    let width = i128::from(integer(&value["toMs"])) - i128::from(integer(&value["fromMs"]));
    count == series.len()
        && (1..=3_600_000).contains(&width)
        && count as i64 * integer(&value["maxPointsPerSeries"]) <= 8000
}

type Identities<'a> = HashMap<(&'a str, &'a str), &'a Value>;
fn identities<'a>(values: impl IntoIterator<Item = &'a Value>) -> Option<Identities<'a>> {
    let mut by_segment = HashMap::new();
    let mut by_series = HashMap::new();
    let mut by_incarnation = HashMap::new();
    for value in values {
        let series = text(&value["seriesId"]);
        let incarnation = (text(&value["hubInstanceId"]), text(&value["incarnationId"]));
        if by_segment
            .insert((series, text(&value["segmentId"])), value)
            .is_some()
            || by_series
                .insert(series, incarnation)
                .is_some_and(|old| old != incarnation)
            || by_incarnation
                .insert(incarnation, series)
                .is_some_and(|old| old != series)
        {
            return None;
        }
    }
    Some(by_segment)
}

fn sample(value: &Value, descriptor: &Value) -> bool {
    if !value["source"].is_null() && value["source"] != descriptor["source"] {
        return false;
    }
    if !value["value"].is_null() {
        return value["quality"] == "good"
            && allowed_source(&value["source"])
            && !value["sourceTimeMs"].is_null()
            && value["reason"].is_null()
            && match text(&descriptor["valueType"]) {
                "bool" => value["value"].is_boolean(),
                "number" => value["value"].as_f64().is_some_and(f64::is_finite),
                _ => false,
            };
    }
    match value["reason"].as_str() {
        Some("bad") => value["quality"] == "bad",
        Some("stale") => value["quality"] == "stale",
        Some("unknownQuality") => value["quality"] == "unknown",
        Some("simulationExcluded") => matches!(
            value["source"].as_str(),
            Some("simulation" | "derivedSimulation")
        ),
        Some("unknownSource") => value["source"] == "unknown",
        Some("sourceUnavailable" | "unresolved" | "identityPending") => {
            value["quality"].is_null()
                && value["source"].is_null()
                && value["sourceTimeMs"].is_null()
        }
        Some("missingValue" | "nonFinite" | "typeMismatch") => {
            value["quality"] == "good" && allowed_source(&value["source"])
        }
        _ => false,
    }
}

fn batch(value: &Value) -> bool {
    let Some(descriptors) = identities(rows(&value["series"])) else {
        return false;
    };
    if descriptors
        .keys()
        .map(|key| key.0)
        .collect::<HashSet<_>>()
        .len()
        > 8
    {
        return false;
    }
    let mut latest = HashMap::new();
    let mut max_sequence = 0;
    for row in rows(&value["samples"]) {
        let series = text(&row["seriesId"]);
        let Some(descriptor) = descriptors.get(&(series, text(&row["segmentId"]))) else {
            return false;
        };
        let sequence = integer(&row["recordId"]["sequence"]);
        if row["recordId"]["sessionId"] != value["sessionId"]
            || !sample(row, descriptor)
            || latest
                .insert(series, sequence)
                .is_some_and(|previous| previous >= sequence)
        {
            return false;
        }
        max_sequence = max_sequence.max(sequence);
    }
    value["committedThrough"].is_null() || integer(&value["committedThrough"]) <= max_sequence
}

fn interval(value: &Value, from: i64, to: i64) -> bool {
    from <= integer(&value["fromMs"])
        && integer(&value["fromMs"]) < integer(&value["toMs"])
        && integer(&value["toMs"]) <= to
}

fn series_result(value: &Value, request: &Value) -> bool {
    let raw = rows(&value["raw"]);
    let bins = rows(&value["bins"]);
    let coverage = rows(&value["coverage"]);
    if value["status"] != "ready" {
        return rows(&value["segments"]).is_empty()
            && raw.is_empty()
            && bins.is_empty()
            && coverage.is_empty()
            && value["watermark"].is_null();
    }
    let segments = rows(&value["segments"]);
    if segments.is_empty()
        || segments
            .iter()
            .any(|row| row["seriesId"] != value["seriesId"])
    {
        return false;
    }
    let Some(descriptors) = identities(segments) else {
        return false;
    };
    let from = integer(&request["fromMs"]);
    let to = integer(&request["toMs"]);
    let mut end = from;
    for range in coverage {
        if !interval(range, from, to) || integer(&range["fromMs"]) < end {
            return false;
        }
        end = integer(&range["toMs"]);
    }
    if raw.len().max(bins.len()) as i64 > integer(&request["maxPointsPerSeries"]) {
        return false;
    }
    if request["mode"] == "raw" {
        if !bins.is_empty() {
            return false;
        }
        let mut seen = HashSet::new();
        let mut previous = None;
        for row in raw {
            let key = (text(&row["seriesId"]), text(&row["segmentId"]));
            let Some(descriptor) = descriptors.get(&key) else {
                return false;
            };
            let time = integer(&row["sampleTimeMs"]);
            let session = text(&row["recordId"]["sessionId"]);
            let sequence = integer(&row["recordId"]["sequence"]);
            let order = (time, session, sequence);
            if row["seriesId"] != value["seriesId"]
                || !sample(row, descriptor)
                || time < from
                || time >= to
                || !seen.insert((session, sequence))
                || previous.is_some_and(|old| old >= order)
                || (!value["watermark"].is_null()
                    && row["recordId"]["sessionId"] == value["watermark"]["sessionId"]
                    && sequence > integer(&value["watermark"]["committedThrough"]))
            {
                return false;
            }
            previous = Some(order);
        }
        return true;
    }
    if !raw.is_empty() || bins.is_empty() {
        return false;
    }
    end = from;
    for bin in bins {
        if !interval(bin, from, to) || integer(&bin["fromMs"]) != end {
            return false;
        }
        end = integer(&bin["toMs"]);
        let state = text(&bin["state"]);
        let valid = integer(&bin["validCount"]);
        let invalid = integer(&bin["invalidCount"]);
        let empty = bin["min"].is_null() && bin["max"].is_null();
        if state == "mixedSegment" {
            if !empty || !bin["segmentId"].is_null() || !bin["source"].is_null() {
                return false;
            }
            continue;
        }
        let Some(segment) = bin["segmentId"].as_str() else {
            return false;
        };
        let Some(descriptor) = descriptors.get(&(text(&value["seriesId"]), segment)) else {
            return false;
        };
        if bin["source"] != descriptor["source"] {
            return false;
        }
        if state == "gap" {
            if valid != 0 || !empty {
                return false;
            }
            continue;
        }
        let Some(min) = bin["min"].as_f64() else {
            return false;
        };
        let Some(max) = bin["max"].as_f64() else {
            return false;
        };
        if valid == 0
            || !min.is_finite()
            || !max.is_finite()
            || min > max
            || (valid == 1 && min != max)
            || !allowed_source(&bin["source"])
            || (descriptor["valueType"] == "bool"
                && (!matches!(min, 0.0 | 1.0) || !matches!(max, 0.0 | 1.0)))
            || (state == "complete"
                && (invalid != 0
                    || coverage.iter().any(|range| {
                        integer(&range["fromMs"]) < end
                            && integer(&bin["fromMs"]) < integer(&range["toMs"])
                    })))
        {
            return false;
        }
    }
    end == to
}

fn result(value: &Value) -> bool {
    let request = &value["query"];
    if !query(request) {
        return false;
    }
    let results = rows(&value["series"]);
    let requested = rows(&request["seriesIds"]);
    if results.len() != requested.len() {
        return false;
    }
    if identities(results.iter().flat_map(|row| rows(&row["segments"]))).is_none() {
        return false;
    }
    let mut unavailable = 0;
    let mut points = 0;
    let mut grid: Option<&[Value]> = None;
    for (row, id) in results.iter().zip(requested) {
        if row["seriesId"] != *id || !series_result(row, request) {
            return false;
        }
        unavailable += usize::from(row["status"] == "queryUnavailable");
        points += rows(&row["raw"]).len() + rows(&row["bins"]).len();
        if request["mode"] == "minmax" && row["status"] == "ready" {
            let bins = rows(&row["bins"]);
            if grid.is_some_and(|old| {
                old.len() != bins.len()
                    || old.iter().zip(bins).any(|(a, b)| {
                        integer(&a["fromMs"]) != integer(&b["fromMs"])
                            || integer(&a["toMs"]) != integer(&b["toMs"])
                    })
            }) {
                return false;
            }
            grid = Some(bins);
        }
    }
    let status = if unavailable == results.len() {
        "unavailable"
    } else if unavailable > 0 {
        "partial"
    } else {
        "ready"
    };
    points <= 8000
        && value["status"] == status
        && (value["snapshotId"].is_null() == (status == "unavailable"))
}
