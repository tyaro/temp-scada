use super::Project;
use crate::recording_plan::tests::{cases, input};
use serde_json::{json, Value};

fn sample() -> Value {
    serde_json::from_str(include_str!("../../../examples/recording.project.json")).unwrap()
}
fn check(value: &Value, expected: bool, name: &Value) {
    let result = Project::from_json(&value.to_string());
    assert_eq!(
        result.is_ok(),
        expected,
        "{name}: {:?}",
        result.as_ref().err()
    );
    if let Ok(project) = result {
        let round = Project::from_json(&project.to_json()).unwrap();
        assert_eq!(project, round);
        let saved: Value = serde_json::from_str(&round.to_json()).unwrap();
        assert_eq!(saved["recordingPlan"], value["recordingPlan"]);
        assert_eq!(saved["manifest"]["schemaVersion"], "0.37.0");
        assert_eq!(saved["manifest"]["minRuntimeVersion"], "0.37.0");
    }
}
#[test]
fn all_shared_h5a_cases_apply_inside_project() {
    for case in cases().as_array().unwrap() {
        let expected = case["accepted"].as_bool().unwrap();
        if let Ok(plan) = input(case) {
            let mut value = sample();
            value["recordingPlan"] = plan;
            check(&value, expected, &case["name"]);
        } else {
            assert!(!expected, "{}", case["name"]);
        }
    }
}
#[test]
fn shared_project_recording_cases_preserve_optional_settings_and_names() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../examples/project-recording-cases.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let mut value = if case["legacy"] == true {
            serde_json::from_str(include_str!("../../../examples/legacy.project.json")).unwrap()
        } else {
            sample()
        };
        for op in case["ops"].as_array().into_iter().flatten() {
            let (parent, key) = op["path"].as_str().unwrap().rsplit_once('/').unwrap();
            let target = value.pointer_mut(parent).unwrap();
            if target.is_array() {
                target[key.parse::<usize>().unwrap()] = op["value"].clone();
            } else {
                target[key] = op["value"].clone();
            }
        }
        if case["omit"] == true {
            value.as_object_mut().unwrap().remove("recordingPlan");
        }
        if case["largeCanvas"] == true {
            let template = value["screens"][0]["objects"][2].clone();
            for i in 0..100 {
                let mut object = template.clone();
                object["id"] = json!(format!("0199f000-0000-7000-8000-{:012}", 1000 + i));
                object["order"] = json!(1000 + i);
                object["shape"]["text"] = json!("x".repeat(1000));
                value["screens"][0]["objects"]
                    .as_array_mut()
                    .unwrap()
                    .push(object);
            }
            assert!(value.to_string().len() > 65536);
        }
        check(&value, case["accepted"].as_bool().unwrap(), &case["name"]);
    }
}
#[test]
fn c5_6_acceptance_project_carries_an_enabled_plan() {
    let value: Value = serde_json::from_str(include_str!(
        "../../../examples/real-hub-recording.project.json"
    ))
    .unwrap();
    assert_eq!(value["recordingPlan"]["enabled"], true);
    check(&value, true, &json!("real-hub-recording"));
}

#[test]
fn o4d_write_acceptance_project_is_valid_and_has_two_writable_slots() {
    let value: Value = serde_json::from_str(include_str!(
        "../../../examples/real-hub-write.project.json"
    ))
    .unwrap();
    let slots = value["equipmentTypes"][0]["slots"].as_array().unwrap();
    assert!(slots.iter().all(|slot| slot.get("write").is_some()));
    assert_eq!(slots.len(), 2);
    // The history window's button (O4c, #335): §3.6 6-3 of the procedure.
    let objects = value["screens"][0]["objects"].as_array().unwrap();
    assert!(objects
        .iter()
        .any(|object| object["shape"]["target"]["kind"] == "operationList"));
    check(&value, true, &json!("real-hub-write"));
}
