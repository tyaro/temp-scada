use super::*;
use std::io::Write;

fn example() -> Value {
    let mut project: Value = serde_json::from_str(include_str!(
        "../../../../examples/read-presentation.project.json"
    ))
    .unwrap();
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../examples/alarm-definition-cases.json"
    ))
    .unwrap();
    project["alarms"] = cases[0]["alarms"].clone();
    project
}

#[test]
fn saved_json_expands_enabled_conditions_and_keeps_disabled_ids() {
    let bytes = serde_json::to_vec(&example()).unwrap();
    let saved = SavedAlarmProject::from_bytes(Path::new("saved.json"), &bytes).unwrap();
    let threshold = "0199f6a1-0000-7000-8000-000000000001";
    let disabled = "0199f6a1-0000-7000-8000-000000000002";
    assert_eq!(saved.definitions.len(), 4);
    assert!(saved.definitions.contains_key(&format!("{threshold}:hh")));
    assert_eq!(saved.disabled, BTreeSet::from([disabled.into()]));
    assert_eq!(
        saved.displays[&format!("{threshold}:hh")].message,
        "温度 異常高"
    );
    assert_eq!(
        saved.displays[&format!("{threshold}:h")].message,
        "T-101 温度 H"
    );
    let applied = saved.applied("http://127.0.0.1:8722".into(), "未ログイン".into(), 1);
    assert_eq!(applied.condition_hashes.len(), 4);
    assert_eq!(applied.file_hash, format!("{:x}", Sha256::digest(bytes)));
    assert_eq!(
        SavedAlarmProject::from_applied(&applied)
            .unwrap()
            .definitions,
        saved.definitions
    );
    let mut tampered = applied;
    tampered.condition_hashes.clear();
    assert!(SavedAlarmProject::from_applied(&tampered).is_err());
}

#[test]
fn present_alarm_timing_fields_reject_wrong_types() {
    for (field, invalid) in [
        ("onDelayMs", json!("5000")),
        ("onDelayMs", json!(-1)),
        ("offDelayMs", json!(1.5)),
        ("deadband", json!("0.5")),
    ] {
        let mut project = example();
        if field == "deadband" {
            project["alarms"]["definitions"][0]["source"][field] = invalid;
        } else {
            project["alarms"]["definitions"][0][field] = invalid;
        }
        assert!(matches!(
            parse_alarm_document(&project["alarms"]),
            Err(AlarmProjectError::InvalidFile)
        ));
        assert!(SavedAlarmProject::from_bytes(
            Path::new("saved.json"),
            &serde_json::to_vec(&project).unwrap()
        )
        .is_err());
    }
}

#[test]
fn duplicate_alarm_ids_and_expanded_condition_ids_are_rejected() {
    let mut project = example();
    let id = project["alarms"]["definitions"][0]["id"].clone();
    project["alarms"]["definitions"][1]["id"] = id;
    assert!(matches!(
        parse_alarm_document(&project["alarms"]),
        Err(AlarmProjectError::InvalidFile)
    ));
    assert!(SavedAlarmProject::from_bytes(
        Path::new("saved.json"),
        &serde_json::to_vec(&project).unwrap()
    )
    .is_err());

    // The model schema requires UUIDs, but the expansion boundary must also
    // reject a condition id colliding across enabled and disabled definitions.
    project["alarms"]["definitions"][0]["id"] = json!("alpha");
    project["alarms"]["definitions"][1]["id"] = json!("alpha:hh");
    assert!(matches!(
        parse_alarm_document(&project["alarms"]),
        Err(AlarmProjectError::InvalidFile)
    ));
}

#[test]
fn package_uses_checked_project_and_manifest_bytes() {
    let mut project = example();
    let manifest = project.as_object_mut().unwrap().remove("manifest").unwrap();
    let manifest_bytes = serde_json::to_vec(&json!({
        "profile": "banto-scada.image-project", "version": 1, "project": manifest
    }))
    .unwrap();
    let project_bytes = serde_json::to_vec(&project).unwrap();
    let checksums = json!({
        "manifest.json": format!("{:x}", Sha256::digest(&manifest_bytes)),
        "project.json": format!("{:x}", Sha256::digest(&project_bytes)),
    });
    let archive = |checksums: &Value| {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [
            ("manifest.json", manifest_bytes.clone()),
            ("project.json", project_bytes.clone()),
            ("checksums.json", serde_json::to_vec(checksums).unwrap()),
        ] {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    };
    let bytes = archive(&checksums);
    let saved = SavedAlarmProject::from_bytes(Path::new("saved.bantoscada"), &bytes).unwrap();
    assert_eq!(saved.definitions.len(), 4);
    assert_eq!(saved.file_hash, format!("{:x}", Sha256::digest(&bytes)));
    let mut wrong_checksums = checksums.clone();
    wrong_checksums["project.json"] = json!("0".repeat(64));
    assert!(SavedAlarmProject::from_bytes(
        Path::new("saved.bantoscada"),
        &archive(&wrong_checksums)
    )
    .is_err());
}

#[test]
fn typescript_writer_package_with_image_and_alarms_is_readable() {
    // Generated by writeProjectPackage from symbol-image.project.json plus
    // alarm-definition-cases.json[0]. Keep this fixture aligned in the TS test.
    let bytes = include_bytes!("../../../../examples/alarm-writer.bantoscada");
    let saved = SavedAlarmProject::from_bytes(Path::new("alarm-writer.bantoscada"), bytes).unwrap();
    assert_eq!(saved.definitions.len(), 4);
    assert!(saved
        .definitions
        .contains_key("0199f6a1-0000-7000-8000-000000000001:hh"));
}

#[test]
fn saved_identity_reads_package_manifest_without_validating_other_entries() {
    let source = include_bytes!("../../../../examples/alarm-writer.bantoscada");
    let mut archive = zip::ZipArchive::new(Cursor::new(source.as_slice())).unwrap();
    let mut manifest = Vec::new();
    archive
        .by_name("manifest.json")
        .unwrap()
        .read_to_end(&mut manifest)
        .unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("manifest.json", manifest),
        ("project.json", b"invalid".to_vec()),
        ("checksums.json", b"{}".to_vec()),
    ] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    let broken = writer.finish().unwrap().into_inner();
    let path = std::env::temp_dir().join(format!(
        "alarm-identity-{}.bantoscada",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&path, broken).unwrap();
    let id = SavedAlarmProject::read_project_id(&path).unwrap();
    assert_eq!(
        id,
        SavedAlarmProject::from_bytes(&path, source)
            .unwrap()
            .project_id
    );
    assert!(SavedAlarmProject::read(&path).is_err());
    std::fs::remove_file(path).unwrap();
}

fn saved(project: &Value) -> SavedAlarmProject {
    SavedAlarmProject::from_bytes(
        Path::new("saved.json"),
        &serde_json::to_vec(project).unwrap(),
    )
    .unwrap()
}

fn applied_of(project: &Value) -> AppliedDefinitions {
    saved(project).applied("http://127.0.0.1:8722".into(), "未ログイン".into(), 1)
}

#[test]
fn comparison_with_the_applied_record_names_the_four_cases() {
    let project = example();
    let applied = applied_of(&project);
    assert_eq!(
        compare_with_applied(&saved(&project), None).unwrap(),
        AlarmDefinitionMatch::NotApplied
    );
    assert_eq!(
        compare_with_applied(&saved(&project), Some(&applied)).unwrap(),
        AlarmDefinitionMatch::Same
    );
    let mut other = applied.clone();
    other.project_id = "0199f200-0000-7000-8000-00000000ffff".into();
    assert_eq!(
        compare_with_applied(&saved(&project), Some(&other)).unwrap(),
        AlarmDefinitionMatch::OtherProject
    );
}

#[test]
fn a_severity_only_change_differs() {
    let project = example();
    let applied = applied_of(&project);
    let mut edited = project.clone();
    let limits = &mut edited["alarms"]["definitions"][0]["source"]["limits"];
    assert_eq!(limits["h"]["severity"], "medium");
    limits["h"]["severity"] = json!("high");
    let edited = saved(&edited);
    // The evaluation is unchanged: only the display tells them apart.
    assert_eq!(
        edited
            .applied(String::new(), String::new(), 0)
            .condition_hashes,
        applied.condition_hashes
    );
    assert_eq!(
        compare_with_applied(&edited, Some(&applied)).unwrap(),
        AlarmDefinitionMatch::Differs
    );
}

#[test]
fn a_disabled_or_evaluation_change_differs() {
    let project = example();
    let applied = applied_of(&project);
    let mut limit = project.clone();
    limit["alarms"]["definitions"][0]["source"]["limits"]["hh"]["value"] = json!(96);
    assert_eq!(
        compare_with_applied(&saved(&limit), Some(&applied)).unwrap(),
        AlarmDefinitionMatch::Differs
    );
    let mut disabled = project.clone();
    disabled["alarms"]["definitions"][0]["enabled"] = json!(false);
    assert_eq!(
        compare_with_applied(&saved(&disabled), Some(&applied)).unwrap(),
        AlarmDefinitionMatch::Differs
    );
}

#[test]
fn identical_alarms_with_other_project_edits_are_the_same() {
    let project = example();
    let applied = applied_of(&project);
    let mut edited = project.clone();
    edited["manifest"]["name"] = json!("名前だけ変えた Project");
    edited["manifest"]["projectRevision"] = json!(2);
    let edited = saved(&edited);
    assert_ne!(edited.file_hash, applied.file_hash);
    assert_eq!(
        compare_with_applied(&edited, Some(&applied)).unwrap(),
        AlarmDefinitionMatch::Same
    );
}
