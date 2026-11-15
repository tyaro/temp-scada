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
