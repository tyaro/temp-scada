//! Steps 1 and 3 of the operation write (operation stage-3 design §4): the
//! request's shape, and its resolution against the applied Project (§3).
//! Pure: nothing here reads the clock, the auth state or the Hub.
use scada_model::Project;
use serde::Deserialize;
use serde_json::{json, Value};

use super::reason;

/// Upper bound of every id of a request, in characters (§4 "要求").
pub const MAX_ID_CHARS: usize = 128;
/// Upper bound of the typed input text. The design leaves it open; a text
/// longer than any number a slot can take is a malformed request, not a
/// value to record.
pub const MAX_INPUT_CHARS: usize = 128;

/// The `operation_write` request (§4 "要求"). The external name is never
/// sent: the host resolves it from the applied Project.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationWriteRequest {
    pub project_id: String,
    /// The applied Project's `projectDigest` the confirmation was built from.
    pub project_digest: String,
    pub screen_id: String,
    pub object_id: String,
    pub equipment_id: String,
    pub slot_name: String,
    /// A button of the slot's `write.buttons`; exactly one of this and
    /// `input` is given.
    #[serde(default)]
    pub button_index: Option<u64>,
    /// The typed text of the slot's `write.input`, as typed (§3).
    #[serde(default)]
    pub input: Option<String>,
    /// The value the confirmation showed.
    pub expected_value: Value,
}

/// Step 1: whether the request is well formed. A malformed request is
/// refused with `invalid_request` and never recorded (§4); the detail is for
/// the log only.
pub fn check_shape(request: &OperationWriteRequest) -> Result<(), &'static str> {
    for (name, id) in [
        ("projectId", &request.project_id),
        ("projectDigest", &request.project_digest),
        ("screenId", &request.screen_id),
        ("objectId", &request.object_id),
        ("equipmentId", &request.equipment_id),
        ("slotName", &request.slot_name),
    ] {
        let chars = id.chars().count();
        if chars == 0 || chars > MAX_ID_CHARS {
            return Err(name);
        }
    }
    match (&request.button_index, &request.input) {
        (Some(_), None) => Ok(()),
        (None, Some(input)) if input.chars().count() <= MAX_INPUT_CHARS => Ok(()),
        (None, Some(_)) => Err("input"),
        _ => Err("buttonIndex/input"),
    }
}

/// The Project applied on this terminal (§4-3): the one the host read from
/// the saved file, with its id and `projectDigest`.
#[derive(Clone, Copy, Debug)]
pub struct AppliedProject<'a> {
    pub id: &'a str,
    pub digest: &'a str,
    pub project: &'a Project,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotType {
    Bool,
    Number,
    State,
}

/// A value the Project resolves to: a button's fixed value or a parsed input.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WriteValue {
    Bool(bool),
    Number(f64),
}

impl WriteValue {
    pub fn to_json(self) -> Value {
        match self {
            Self::Bool(value) => json!(value),
            Self::Number(value) => json!(value),
        }
    }
}

/// A request resolved against the applied Project.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub equipment_code: String,
    pub slot_type: SlotType,
    /// The slot's external name.
    pub tag: String,
    pub value: WriteValue,
    /// Whether the value has a non-zero fraction as entered, before the
    /// rounding to `f64` (an input like `1.00000000000000001` reads as 1.0):
    /// an integer tag refuses it (§4.2 `type_mismatch`).
    pub fractional: bool,
}

/// What resolution learned before it stopped, for the record of a refusal.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Known {
    pub equipment_code: Option<String>,
    pub tag: Option<String>,
    pub value: Option<WriteValue>,
}

/// Step 3: resolve the request against the applied Project (§4-3, §3).
/// Returns the §4 refusal code of the first check that fails; `known`
/// keeps what was resolved up to it.
pub fn resolve(
    applied: &AppliedProject<'_>,
    request: &OperationWriteRequest,
    known: &mut Known,
) -> Result<Resolved, &'static str> {
    if request.project_id != applied.id || request.project_digest != applied.digest {
        return Err(reason::PROJECT_CHANGED);
    }
    let doc = applied.project.as_value();
    let equipment = items(&doc["equipment"])
        .find(|item| item["id"] == request.equipment_id.as_str())
        .ok_or(reason::UNKNOWN_EQUIPMENT)?;
    known.equipment_code = equipment["code"].as_str().map(str::to_owned);
    // The pressed placement must be on that screen and show this equipment.
    let placement = items(&doc["screens"])
        .find(|screen| screen["id"] == request.screen_id.as_str())
        .and_then(|screen| {
            items(&screen["objects"]).find(|object| object["id"] == request.object_id.as_str())
        })
        .filter(|object| object["shape"]["equipmentId"] == request.equipment_id.as_str())
        .ok_or(reason::INVALID_REQUEST)?;
    let slot = items(&doc["equipmentTypes"])
        .find(|kind| kind["id"] == equipment["typeId"])
        .and_then(|kind| {
            items(&kind["slots"]).find(|slot| slot["name"] == request.slot_name.as_str())
        })
        .ok_or(reason::UNKNOWN_SLOT)?;
    let slot_type = match slot["type"].as_str() {
        Some("bool") => SlotType::Bool,
        Some("number") => SlotType::Number,
        Some("state") => SlotType::State,
        _ => return Err(reason::UNKNOWN_SLOT),
    };
    let write = slot
        .get("write")
        .filter(|write| write.is_object())
        .ok_or(reason::NO_WRITE_DEF)?;
    let mut fractional = false;
    let value = match (request.button_index, request.input.as_deref()) {
        (Some(index), _) => {
            let button = usize::try_from(index)
                .ok()
                .and_then(|index| write["buttons"].as_array()?.get(index))
                .ok_or(reason::INVALID_BUTTON)?;
            button_value(slot_type, &button["value"]).ok_or(reason::INVALID_BUTTON)?
        }
        (None, Some(text)) => {
            let input = write
                .get("input")
                .filter(|input| slot_type == SlotType::Number && input.is_object())
                .ok_or(reason::INVALID_VALUE)?;
            let decimals = slot_decimals(doc, placement, &request.slot_name);
            let value = parse_input(text, decimals)?;
            fractional = has_fraction(text);
            let (Some(min), Some(max)) = (input["min"].as_f64(), input["max"].as_f64()) else {
                return Err(reason::INVALID_VALUE);
            };
            if value < min || value > max {
                known.value = Some(WriteValue::Number(value));
                return Err(reason::OUT_OF_RANGE);
            }
            WriteValue::Number(value)
        }
        (None, None) => return Err(reason::INVALID_REQUEST),
    };
    if let WriteValue::Number(number) = value {
        fractional |= number.fract() != 0.0;
    }
    known.value = Some(value);
    let tag = items(&equipment["bindings"])
        .find(|binding| binding["slotName"] == request.slot_name.as_str())
        .and_then(|binding| binding["externalName"].as_str())
        .ok_or(reason::UNBOUND)?;
    known.tag = Some(tag.to_owned());
    if !matches_expected(value, &request.expected_value) {
        return Err(reason::PROJECT_CHANGED);
    }
    Ok(Resolved {
        equipment_code: known.equipment_code.clone().unwrap_or_default(),
        slot_type,
        tag: tag.to_owned(),
        value,
        fractional,
    })
}

fn items(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

/// A button's value by the slot type (§3). The Project was checked when it
/// was applied, so a mismatch here means a value this host cannot send.
fn button_value(slot_type: SlotType, value: &Value) -> Option<WriteValue> {
    match slot_type {
        SlotType::Bool => value.as_bool().map(WriteValue::Bool),
        SlotType::Number => value
            .as_f64()
            .filter(|n| n.is_finite())
            .map(WriteValue::Number),
        SlotType::State => value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && (0.0..=f64::from(i32::MAX)).contains(n))
            .map(WriteValue::Number),
    }
}

/// The decimals of the slot's numeric format (§3, numeric format 1-B). A
/// slot has no format of its own: it is the `format.decimals` of the Texts
/// that show the slot (`slotBinding`) in the placement's shared Symbol. When
/// several show it, the largest is the limit (the operator can see that
/// many digits); none means the input digits are not limited.
pub fn slot_decimals(doc: &Value, placement: &Value, slot_name: &str) -> Option<u32> {
    let symbol_id = placement["shape"]["symbolId"].as_str()?;
    let symbol = items(&doc["symbols"]).find(|symbol| symbol["id"] == symbol_id)?;
    let mut decimals = None;
    collect_decimals(&symbol["objects"], slot_name, &mut decimals);
    decimals
}

fn collect_decimals(value: &Value, slot_name: &str, decimals: &mut Option<u32>) {
    match value {
        Value::Object(map) => {
            if map
                .get("slotBinding")
                .is_some_and(|binding| binding["slotName"] == slot_name)
            {
                if let Some(found) = map
                    .get("format")
                    .and_then(|format| format["decimals"].as_f64())
                    // `2.0` is a valid integer in the schema too.
                    .filter(|d| d.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(d))
                    .map(|d| d as u32)
                {
                    *decimals = Some(decimals.map_or(found, |d| d.max(found)));
                }
            }
            for child in map.values() {
                collect_decimals(child, slot_name, decimals);
            }
        }
        Value::Array(list) => {
            for child in list {
                collect_decimals(child, slot_name, decimals);
            }
        }
        _ => {}
    }
}

/// Read a typed input (§3): half-width decimal only — an optional `-`, the
/// integer digits, and an optional `.` with fraction digits. Full-width
/// digits, separators, exponents, `NaN` and `Infinity` are `invalid_value`,
/// and so are more fraction digits than `decimals` (never rounded). A
/// number too large for `f64` is `out_of_range`.
pub fn parse_input(text: &str, decimals: Option<u32>) -> Result<f64, &'static str> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (integer, fraction) = match unsigned.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (unsigned, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !digits(integer) || fraction.is_some_and(|fraction| !digits(fraction)) {
        return Err(reason::INVALID_VALUE);
    }
    let places = fraction.map_or(0, str::len);
    if decimals.is_some_and(|limit| places > limit as usize) {
        return Err(reason::INVALID_VALUE);
    }
    let value: f64 = text.parse().map_err(|_| reason::INVALID_VALUE)?;
    if !value.is_finite() {
        return Err(reason::OUT_OF_RANGE);
    }
    Ok(value)
}

/// Whether a typed input (already checked by [`parse_input`]) has a
/// non-zero fraction digit.
fn has_fraction(text: &str) -> bool {
    text.split_once('.')
        .is_some_and(|(_, fraction)| fraction.bytes().any(|b| b != b'0'))
}

/// Whether the resolved value is the one the confirmation showed.
fn matches_expected(value: WriteValue, expected: &Value) -> bool {
    match value {
        WriteValue::Bool(value) => expected.as_bool() == Some(value),
        WriteValue::Number(value) => expected.is_number() && expected.as_f64() == Some(value),
    }
}
