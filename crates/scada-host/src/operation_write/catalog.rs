//! Step 4 of the operation write (operation stage-3 design §4.1, §4.2): the
//! resolved tag against the catalog just fetched. Pure.
use banto_tagclient::{CatalogSnapshot, RequestedValue};

use super::reason;
use super::resolve::{SlotType, WriteValue};

/// The largest integer a JSON number carries exactly (2^53 − 1, §4.2).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Check the tag in the catalog (§4.1, §4.2) and give the value to send.
/// `subscribed_revision` is the catalog revision the terminal's subscription
/// resolved against; another revision (or none) is `catalog_pending`.
pub fn check_catalog(
    catalog: &CatalogSnapshot,
    subscribed_revision: Option<u64>,
    tag: &str,
    slot_type: SlotType,
    value: WriteValue,
) -> Result<RequestedValue, &'static str> {
    if subscribed_revision != Some(catalog.revision) {
        return Err(reason::CATALOG_PENDING);
    }
    let row = catalog
        .tags
        .iter()
        .find(|row| row.external_name == tag)
        .ok_or(reason::UNRESOLVED)?;
    if !row.enabled {
        return Err(reason::TAG_DISABLED);
    }
    if !row.writable {
        return Err(reason::NOT_WRITABLE);
    }
    hub_value(&row.data_type, slot_type, value)
}

/// The type table of §4.2 over the Hub's `data_type` vocabulary (`bit`,
/// `i16`, `u16`, `i32`, `u32`, `i64`, `u64`, `f32`, `f64`, `string`; O2a).
/// A word outside it is `type_mismatch` (fail-closed). An integer type takes
/// whole numbers only (a fraction is `type_mismatch`) within its range, and
/// 64-bit ones within ±(2^53 − 1); `f32` checks the range only and leaves
/// the rounding to the Hub.
pub fn hub_value(
    data_type: &str,
    slot_type: SlotType,
    value: WriteValue,
) -> Result<RequestedValue, &'static str> {
    match (slot_type, value) {
        (SlotType::Bool, WriteValue::Bool(value)) if data_type == "bit" => {
            Ok(RequestedValue::Bool(value))
        }
        (SlotType::Number | SlotType::State, WriteValue::Number(value)) => {
            if let Some((min, max)) = integer_range(data_type) {
                if value.fract() != 0.0 {
                    return Err(reason::TYPE_MISMATCH);
                }
                if value < min || value > max {
                    return Err(reason::OUT_OF_RANGE);
                }
                // `-0` is zero: never send a negative zero to an unsigned tag.
                return Ok(RequestedValue::Num(value + 0.0));
            }
            match (data_type, slot_type) {
                ("f32", SlotType::Number) if value.abs() > f64::from(f32::MAX) => {
                    Err(reason::OUT_OF_RANGE)
                }
                ("f32" | "f64", SlotType::Number) if value.is_finite() => {
                    Ok(RequestedValue::Num(value))
                }
                ("f64", SlotType::Number) => Err(reason::OUT_OF_RANGE),
                _ => Err(reason::TYPE_MISMATCH),
            }
        }
        _ => Err(reason::TYPE_MISMATCH),
    }
}

fn integer_range(data_type: &str) -> Option<(f64, f64)> {
    Some(match data_type {
        "i16" => (f64::from(i16::MIN), f64::from(i16::MAX)),
        "u16" => (0.0, f64::from(u16::MAX)),
        "i32" => (f64::from(i32::MIN), f64::from(i32::MAX)),
        "u32" => (0.0, f64::from(u32::MAX)),
        "i64" => (-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER),
        "u64" => (0.0, MAX_SAFE_INTEGER),
        _ => return None,
    })
}
