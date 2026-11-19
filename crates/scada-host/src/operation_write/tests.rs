//! The pure steps of the operation write: the request's shape (§4-1), the
//! resolution against the applied Project (§4-3, §3) and the catalog's type
//! and range table (§4.1, §4.2).
use banto_tagclient::{CatalogSnapshot, RequestedValue};
use serde_json::{json, Value};

use super::*;

pub(super) const PROJECT_ID: &str = "0199d300-0000-7000-8000-000000000000";
pub(super) const DIGEST: &str = "digest-1";
pub(super) const SCREEN: &str = "0199d301-0000-7000-8000-000000000001";
pub(super) const PLACEMENT: &str = "0199d301-0000-7000-8000-000000000047";
pub(super) const PUMP: &str = "0199d301-0000-7000-8000-000000000022";
pub(super) const OTHER_PUMP: &str = "0199d301-0000-7000-8000-000000000023";
pub(super) const COMMAND_TAG: &str = "WWT.P101.Command";
pub(super) const SPEED_TAG: &str = "WWT.P101.SpeedSp";
pub(super) const MODE_TAG: &str = "WWT.P101.Mode";

/// The demo Project with write slots on the pump type: `command` (bool
/// buttons), `speedSp` (number input 0–60 and a stop button at −1), `mode`
/// (state buttons) and `spare` (bound nowhere). The first pump binds all but
/// `spare`.
pub(super) fn project() -> scada_model::Project {
    let mut doc: Value =
        serde_json::from_str(include_str!("../../../../examples/demo-water.project.json")).unwrap();
    doc["manifest"]["projectId"] = json!(PROJECT_ID);
    let pump_type = doc["equipment"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == PUMP)
        .unwrap()["typeId"]
        .clone();
    let kind = doc["equipmentTypes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|kind| kind["id"] == pump_type)
        .unwrap();
    let slots = kind["slots"].as_array_mut().unwrap();
    slots.push(
        json!({"name": "command", "type": "bool", "direction": "read",
        "write": {"label": "運転指令", "buttons": [
            {"label": "運転", "value": true}, {"label": "停止", "value": false}]}}),
    );
    slots.push(
        json!({"name": "speedSp", "type": "number", "direction": "read",
        "write": {"label": "回転数 設定", "input": {"min": 0, "max": 60},
            "buttons": [{"label": "停止", "value": -1}]}}),
    );
    slots.push(json!({"name": "mode", "type": "state", "direction": "read",
        "stateDisplay": {"source": "value", "rows": [],
            "otherwise": {"text": "不明", "color": "#808080"}},
        "write": {"label": "運転モード", "buttons": [
            {"label": "手動", "value": 1}, {"label": "自動", "value": 2}]}}));
    slots.push(json!({"name": "spare", "type": "bool", "direction": "read",
        "write": {"label": "予備", "buttons": [{"label": "入", "value": true}]}}));
    let pump = doc["equipment"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["id"] == PUMP)
        .unwrap();
    let bindings = pump["bindings"].as_array_mut().unwrap();
    bindings.push(json!({"slotName": "command", "externalName": COMMAND_TAG}));
    bindings.push(json!({"slotName": "speedSp", "externalName": SPEED_TAG}));
    bindings.push(json!({"slotName": "mode", "externalName": MODE_TAG}));
    bindings.push(json!({"slotName": "spare", "externalName": null}));
    scada_model::Project::from_json(&doc.to_string()).unwrap()
}

pub(super) fn button(slot: &str, index: u64, expected: Value) -> OperationWriteRequest {
    OperationWriteRequest {
        project_id: PROJECT_ID.into(),
        project_digest: DIGEST.into(),
        screen_id: SCREEN.into(),
        object_id: PLACEMENT.into(),
        equipment_id: PUMP.into(),
        slot_name: slot.into(),
        button_index: Some(index),
        input: None,
        expected_value: expected,
    }
}

pub(super) fn input(text: &str, expected: Value) -> OperationWriteRequest {
    OperationWriteRequest {
        button_index: None,
        input: Some(text.into()),
        ..button("speedSp", 0, expected)
    }
}

fn resolve_with(
    project: &scada_model::Project,
    request: &OperationWriteRequest,
) -> (Result<Resolved, &'static str>, Known) {
    let applied = AppliedProject {
        id: PROJECT_ID,
        digest: DIGEST,
        project,
    };
    let mut known = Known::default();
    let result = resolve(&applied, request, &mut known);
    (result, known)
}

#[test]
fn the_request_deserializes_from_the_webview_shape() {
    let request: OperationWriteRequest = serde_json::from_value(json!({
        "projectId": "p", "projectDigest": "d", "screenId": "s", "objectId": "o",
        "equipmentId": "e", "slotName": "speedSp", "input": "12.5", "expectedValue": 12.5
    }))
    .unwrap();
    assert_eq!(request.input.as_deref(), Some("12.5"));
    assert_eq!(request.button_index, None);
    assert!(check_shape(&request).is_ok());
    // An external name is never part of the request.
    assert!(serde_json::from_value::<OperationWriteRequest>(json!({
        "projectId": "p", "projectDigest": "d", "screenId": "s", "objectId": "o",
        "equipmentId": "e", "slotName": "x", "buttonIndex": 0, "expectedValue": true,
        "tag": "PLC.Tag"
    }))
    .is_err());
}

#[test]
fn ids_are_1_to_128_characters_and_one_choice_is_given() {
    let ok = button("command", 0, json!(true));
    assert!(check_shape(&ok).is_ok());
    let long = "あ".repeat(MAX_ID_CHARS);
    assert!(check_shape(&OperationWriteRequest {
        screen_id: long.clone(),
        ..ok.clone()
    })
    .is_ok());
    for broken in [
        OperationWriteRequest {
            project_id: String::new(),
            ..ok.clone()
        },
        OperationWriteRequest {
            object_id: format!("{long}x"),
            ..ok.clone()
        },
        OperationWriteRequest {
            input: Some("1".into()),
            ..ok.clone()
        },
        OperationWriteRequest {
            button_index: None,
            ..ok.clone()
        },
        OperationWriteRequest {
            button_index: None,
            input: Some("1".repeat(MAX_INPUT_CHARS + 1)),
            ..ok.clone()
        },
    ] {
        assert!(check_shape(&broken).is_err(), "{broken:?}");
    }
}

#[test]
fn buttons_resolve_to_their_fixed_values() {
    let project = project();
    let (resolved, _) = resolve_with(&project, &button("command", 1, json!(false)));
    let resolved = resolved.unwrap();
    assert_eq!(resolved.tag, COMMAND_TAG);
    assert_eq!(resolved.value, WriteValue::Bool(false));
    assert_eq!(resolved.slot_type, SlotType::Bool);
    assert_eq!(resolved.equipment_code, "P-101");
    let (resolved, _) = resolve_with(&project, &button("mode", 1, json!(2)));
    assert_eq!(resolved.unwrap().value, WriteValue::Number(2.0));
    // A button value is not bound by the input's range.
    let (resolved, _) = resolve_with(&project, &button("speedSp", 0, json!(-1)));
    assert_eq!(resolved.unwrap().value, WriteValue::Number(-1.0));
}

#[test]
fn inputs_resolve_within_the_range() {
    let project = project();
    let (resolved, _) = resolve_with(&project, &input("12.5", json!(12.5)));
    assert_eq!(resolved.unwrap().value, WriteValue::Number(12.5));
    let (resolved, _) = resolve_with(&project, &input("60", json!(60)));
    assert!(resolved.is_ok());
    let (resolved, known) = resolve_with(&project, &input("60.1", json!(60.1)));
    assert_eq!(resolved, Err(reason::OUT_OF_RANGE));
    assert_eq!(known.value, Some(WriteValue::Number(60.1)));
    let (resolved, _) = resolve_with(&project, &input("-0.5", json!(-0.5)));
    assert_eq!(resolved, Err(reason::OUT_OF_RANGE));
}

#[test]
fn an_input_keeps_its_fraction_from_before_the_rounding() {
    let project = project();
    let fractional = |text: &str, expected: Value| {
        resolve_with(&project, &input(text, expected))
            .0
            .unwrap()
            .fractional
    };
    // Rounds to 1.0 as an f64, but is not an integer as entered.
    assert!(fractional("1.00000000000000001", json!(1.0)));
    assert!(fractional("12.5", json!(12.5)));
    assert!(!fractional("12", json!(12)));
    assert!(!fractional("12.000", json!(12)));
    assert!(!fractional("-0.0", json!(0)));
}

#[test]
fn each_resolution_check_has_its_reason() {
    let project = project();
    let cases: Vec<(OperationWriteRequest, &str)> = vec![
        (
            OperationWriteRequest {
                project_id: "another".into(),
                ..button("command", 0, json!(true))
            },
            reason::PROJECT_CHANGED,
        ),
        (
            OperationWriteRequest {
                project_digest: "digest-2".into(),
                ..button("command", 0, json!(true))
            },
            reason::PROJECT_CHANGED,
        ),
        (
            OperationWriteRequest {
                equipment_id: "missing".into(),
                ..button("command", 0, json!(true))
            },
            reason::UNKNOWN_EQUIPMENT,
        ),
        // The placement shows another pump.
        (
            OperationWriteRequest {
                equipment_id: OTHER_PUMP.into(),
                ..button("command", 0, json!(true))
            },
            reason::INVALID_REQUEST,
        ),
        (
            OperationWriteRequest {
                screen_id: "missing".into(),
                ..button("command", 0, json!(true))
            },
            reason::INVALID_REQUEST,
        ),
        (
            OperationWriteRequest {
                object_id: "missing".into(),
                ..button("command", 0, json!(true))
            },
            reason::INVALID_REQUEST,
        ),
        (button("nothing", 0, json!(true)), reason::UNKNOWN_SLOT),
        (button("state", 0, json!(1)), reason::NO_WRITE_DEF),
        (button("command", 2, json!(true)), reason::INVALID_BUTTON),
        (
            button("command", u64::MAX, json!(true)),
            reason::INVALID_BUTTON,
        ),
        // An input on a slot whose write has buttons only.
        (
            OperationWriteRequest {
                slot_name: "mode".into(),
                ..input("1", json!(1))
            },
            reason::INVALID_VALUE,
        ),
        (input("1e1", json!(10)), reason::INVALID_VALUE),
        (button("spare", 0, json!(true)), reason::UNBOUND),
        // The confirmation showed another value.
        (button("command", 0, json!(false)), reason::PROJECT_CHANGED),
        (button("command", 0, json!(1)), reason::PROJECT_CHANGED),
        (input("12.5", json!(12.6)), reason::PROJECT_CHANGED),
        (input("1", json!("1")), reason::PROJECT_CHANGED),
    ];
    for (request, expected) in cases {
        let (result, _) = resolve_with(&project, &request);
        assert_eq!(result, Err(expected), "{request:?}");
    }
}

#[test]
fn a_refusal_keeps_what_was_resolved_before_it() {
    let project = project();
    let (_, known) = resolve_with(&project, &button("command", 0, json!(false)));
    assert_eq!(known.equipment_code.as_deref(), Some("P-101"));
    assert_eq!(known.tag.as_deref(), Some(COMMAND_TAG));
    assert_eq!(known.value, Some(WriteValue::Bool(true)));
    let (_, known) = resolve_with(&project, &button("spare", 0, json!(true)));
    assert_eq!(known.tag, None);
    assert_eq!(known.value, Some(WriteValue::Bool(true)));
}

#[test]
fn inputs_are_half_width_decimals_only() {
    assert_eq!(parse_input("-1.5", None), Ok(-1.5));
    assert_eq!(parse_input("60", None), Ok(60.0));
    assert_eq!(parse_input("007.10", None), Ok(7.1));
    for text in [
        "",
        "-",
        "1.",
        ".5",
        "１",
        "1,000",
        "1e3",
        "1E3",
        "NaN",
        "Infinity",
        "-Infinity",
        " 1",
        "1 ",
        "+1",
        "--1",
        "0x10",
        "1.2.3",
    ] {
        assert_eq!(
            parse_input(text, None),
            Err(reason::INVALID_VALUE),
            "{text:?}"
        );
    }
    // Too large for f64: a syntactically valid number out of every range.
    assert_eq!(
        parse_input(&"9".repeat(400), None),
        Err(reason::OUT_OF_RANGE)
    );
}

#[test]
fn inputs_never_round_past_the_format_decimals() {
    assert_eq!(parse_input("1.25", Some(2)), Ok(1.25));
    assert_eq!(parse_input("1.250", Some(2)), Err(reason::INVALID_VALUE));
    assert_eq!(parse_input("1", Some(0)), Ok(1.0));
    assert_eq!(parse_input("1.0", Some(0)), Err(reason::INVALID_VALUE));
}

#[test]
fn the_decimals_are_the_largest_format_of_the_symbol_texts_showing_the_slot() {
    let doc = json!({"symbols": [{"id": "sym", "objects": [
        {"id": "a", "shape": {"type": "text", "slotBinding": {"slotName": "speedSp"},
            "format": {"decimals": 1}}},
        {"id": "b", "shape": {"type": "table", "cells": [[
            {"slotBinding": {"slotName": "speedSp"}, "format": {"decimals": 2, "unit": "Hz"}},
            {"slotBinding": {"slotName": "other"}, "format": {"decimals": 5}},
            {"slotBinding": {"slotName": "float"}, "format": {"decimals": 2.0}}]]}},
        {"id": "c", "shape": {"type": "text", "slotBinding": {"slotName": "speedSp"},
            "format": {"unit": "Hz"}}}
    ]}, {"id": "plain", "objects": []}]});
    let placement = |symbol: &str| json!({"shape": {"type": "symbol", "symbolId": symbol}});
    assert_eq!(slot_decimals(&doc, &placement("sym"), "speedSp"), Some(2));
    assert_eq!(slot_decimals(&doc, &placement("sym"), "other"), Some(5));
    // The schema takes an integral JSON float as an integer.
    assert_eq!(slot_decimals(&doc, &placement("sym"), "float"), Some(2));
    assert_eq!(slot_decimals(&doc, &placement("sym"), "none"), None);
    assert_eq!(slot_decimals(&doc, &placement("plain"), "speedSp"), None);
    assert_eq!(slot_decimals(&doc, &placement("missing"), "speedSp"), None);
}

fn catalog(rows: Value) -> CatalogSnapshot {
    let tags: Vec<Value> = rows
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let mut tag = json!({
                "external_name": row["name"], "tag_key": row["name"], "ids": [1, 2, i + 1],
                "connection": "PLC01", "group": "G", "name": row["name"], "address": "D100",
                "data_type": row["type"], "unit": null, "decimals": 0, "period_ms": 100,
                "enabled": true, "writable": true, "tag_kind": "plc", "expression": null,
                "retain": false, "simulation": false, "configured_simulation": false,
                "effective_simulation": false, "value_source": "real"});
            for key in ["enabled", "writable"] {
                if let Some(flag) = row.get(key) {
                    tag[key] = flag.clone();
                }
            }
            tag
        })
        .collect();
    serde_json::from_value(
        json!({"revision": 5, "run_id": 1, "collection_mode": "configured", "tags": tags}),
    )
    .unwrap()
}

#[test]
fn the_catalog_row_must_be_current_enabled_and_writable() {
    let snapshot = catalog(json!([
        {"name": "A", "type": "bit"},
        {"name": "Off", "type": "bit", "enabled": false},
        {"name": "Ro", "type": "bit", "writable": false},
    ]));
    let check = |revision, tag| {
        check_catalog(
            &snapshot,
            revision,
            tag,
            SlotType::Bool,
            WriteValue::Bool(true),
            false,
        )
    };
    assert_eq!(check(Some(5), "A"), Ok(RequestedValue::Bool(true)));
    assert_eq!(check(Some(4), "A"), Err(reason::CATALOG_PENDING));
    assert_eq!(check(None, "A"), Err(reason::CATALOG_PENDING));
    assert_eq!(check(Some(5), "Missing"), Err(reason::UNRESOLVED));
    assert_eq!(check(Some(5), "Off"), Err(reason::TAG_DISABLED));
    assert_eq!(check(Some(5), "Ro"), Err(reason::NOT_WRITABLE));
}

#[test]
fn an_integer_tag_refuses_a_fraction_as_entered() {
    let snapshot = catalog(json!([
        {"name": "I", "type": "i16"},
        {"name": "U", "type": "u64"},
        {"name": "F", "type": "f64"},
    ]));
    let check = |tag, fractional| {
        check_catalog(
            &snapshot,
            Some(5),
            tag,
            SlotType::Number,
            WriteValue::Number(1.0),
            fractional,
        )
    };
    assert_eq!(check("I", true), Err(reason::TYPE_MISMATCH));
    assert_eq!(check("U", true), Err(reason::TYPE_MISMATCH));
    assert_eq!(check("I", false), Ok(RequestedValue::Num(1.0)));
    assert_eq!(check("F", true), Ok(RequestedValue::Num(1.0)));
}

#[test]
fn the_hub_types_take_the_slot_types_of_the_table() {
    use SlotType::*;
    let num = WriteValue::Number;
    let ok = |n: f64| Ok(RequestedValue::Num(n));
    assert_eq!(
        hub_value("bit", Bool, WriteValue::Bool(false)),
        Ok(RequestedValue::Bool(false))
    );
    for (data_type, slot, value, expected) in [
        ("bit", Number, num(1.0), Err(reason::TYPE_MISMATCH)),
        (
            "i16",
            Bool,
            WriteValue::Bool(true),
            Err(reason::TYPE_MISMATCH),
        ),
        ("i16", Number, num(-32768.0), ok(-32768.0)),
        ("i16", Number, num(32768.0), Err(reason::OUT_OF_RANGE)),
        ("i16", Number, num(1.5), Err(reason::TYPE_MISMATCH)),
        ("u16", State, num(65535.0), ok(65535.0)),
        ("u16", Number, num(-1.0), Err(reason::OUT_OF_RANGE)),
        ("u16", Number, num(-0.0), ok(0.0)),
        ("i32", State, num(2147483647.0), ok(2147483647.0)),
        ("i32", Number, num(-2147483649.0), Err(reason::OUT_OF_RANGE)),
        ("u32", Number, num(4294967295.0), ok(4294967295.0)),
        ("u32", Number, num(4294967296.0), Err(reason::OUT_OF_RANGE)),
        ("i64", Number, num(-MAX_SAFE_INTEGER), ok(-MAX_SAFE_INTEGER)),
        (
            "i64",
            Number,
            num(MAX_SAFE_INTEGER + 1.0),
            Err(reason::OUT_OF_RANGE),
        ),
        ("u64", Number, num(MAX_SAFE_INTEGER), ok(MAX_SAFE_INTEGER)),
        ("u64", Number, num(-1.0), Err(reason::OUT_OF_RANGE)),
        ("f32", Number, num(1.25), ok(1.25)),
        ("f32", Number, num(3.4e38), ok(3.4e38)),
        ("f32", Number, num(-3.5e38), Err(reason::OUT_OF_RANGE)),
        ("f64", Number, num(1e300), ok(1e300)),
        // A state slot is an integer word: never a float tag.
        ("f32", State, num(1.0), Err(reason::TYPE_MISMATCH)),
        ("f64", State, num(1.0), Err(reason::TYPE_MISMATCH)),
        ("string", Number, num(1.0), Err(reason::TYPE_MISMATCH)),
        (
            "bool",
            Bool,
            WriteValue::Bool(true),
            Err(reason::TYPE_MISMATCH),
        ),
        ("i8", Number, num(1.0), Err(reason::TYPE_MISMATCH)),
        ("", Number, num(1.0), Err(reason::TYPE_MISMATCH)),
    ] {
        assert_eq!(
            hub_value(data_type, slot, value),
            expected,
            "{data_type} {slot:?} {value:?}"
        );
    }
}

#[test]
fn the_operator_claim_follows_the_hub_rules() {
    assert!(valid_operator(NOT_LOGGED_IN));
    assert!(valid_operator(&"あ".repeat(MAX_OPERATOR_CHARS)));
    assert!(!valid_operator(&"あ".repeat(MAX_OPERATOR_CHARS + 1)));
    assert!(!valid_operator(""));
    assert!(!valid_operator("op\nerator"));
    assert!(!valid_operator("op\u{7f}"));
}
