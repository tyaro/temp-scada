use super::*;
use serde_json::json;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "scada-project-file-{name}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn format_follows_the_extension_case_insensitively() {
    assert_eq!(
        ProjectFormat::of(Path::new("a/B.JSON")),
        Some(ProjectFormat::Json)
    );
    assert_eq!(
        ProjectFormat::of(Path::new("x.BantoScada")),
        Some(ProjectFormat::Package)
    );
    assert_eq!(ProjectFormat::of(Path::new("x.zip")), None);
    assert_eq!(ProjectFormat::of(Path::new("json")), None);
}

#[test]
fn a_read_file_is_overwritten_by_its_id_only_in_its_own_format() {
    let dir = temp_dir("read");
    let path = dir.join("plant.json");
    std::fs::write(&path, b"{}").unwrap();
    let files = ProjectFiles::default();
    let opened = files.read(&path).unwrap();
    assert_eq!(opened.file_name, "plant.json");
    assert_eq!(opened.bytes, b"{}");
    assert_eq!(
        files.target(Some(opened.file_id), ProjectFormat::Json),
        Some(path.clone())
    );
    // An image added to a JSON Project makes it a package: ask again.
    assert_eq!(
        files.target(Some(opened.file_id), ProjectFormat::Package),
        None
    );
    // A new Project or a sample has no file; an unknown id is not a file.
    assert_eq!(files.target(None, ProjectFormat::Json), None);
    assert_eq!(
        files.target(Some(opened.file_id + 1), ProjectFormat::Json),
        None
    );
    // The same path keeps its id.
    assert_eq!(files.read(&path).unwrap().file_id, opened.file_id);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn reading_refuses_other_extensions_and_missing_files() {
    let dir = temp_dir("refuse");
    let other = dir.join("plant.txt");
    std::fs::write(&other, b"{}").unwrap();
    let files = ProjectFiles::default();
    assert_eq!(files.read(&other).unwrap_err(), FileError::UnknownFormat);
    let missing = files.read(&dir.join("none.json")).unwrap_err();
    assert_eq!(missing.reason(), "not_found");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn writing_replaces_the_file_and_remembers_it() {
    let dir = temp_dir("write");
    let path = dir.join("plant.json");
    std::fs::write(&path, b"old").unwrap();
    let files = ProjectFiles::default();
    let saved = files
        .write(&path, ProjectFormat::Json, b"{\"new\":1}")
        .unwrap();
    assert_eq!(saved.file_name, "plant.json");
    assert_eq!(std::fs::read(&path).unwrap(), b"{\"new\":1}");
    assert!(!dir.join("plant.json.tmp").exists());
    assert_eq!(
        files.target(Some(saved.file_id), ProjectFormat::Json),
        Some(path.clone())
    );
    assert_eq!(files.path(saved.file_id), Some(path.clone()));
    // Saving the same path again keeps the id.
    let again = files.write(&path, ProjectFormat::Json, b"{}").unwrap();
    assert_eq!(again.file_id, saved.file_id);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn writing_refuses_bytes_of_the_other_format_and_keeps_the_file() {
    let dir = temp_dir("mismatch");
    let json_path = dir.join("plant.json");
    let package_path = dir.join("plant.bantoscada");
    std::fs::write(&json_path, b"old").unwrap();
    let files = ProjectFiles::default();
    assert_eq!(
        files
            .write(&json_path, ProjectFormat::Json, b"PK\x03\x04")
            .unwrap_err(),
        FileError::FormatMismatch
    );
    assert_eq!(
        files
            .write(&package_path, ProjectFormat::Package, b"{}")
            .unwrap_err(),
        FileError::FormatMismatch
    );
    assert_eq!(
        files
            .write(&json_path, ProjectFormat::Package, b"PK")
            .unwrap_err(),
        FileError::UnknownFormat
    );
    assert_eq!(std::fs::read(&json_path).unwrap(), b"old");
    assert!(!package_path.exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_write_reports_the_io_reason() {
    let dir = temp_dir("io");
    let files = ProjectFiles::default();
    let error = files
        .write(
            &dir.join("missing-dir").join("plant.json"),
            ProjectFormat::Json,
            b"{}",
        )
        .unwrap_err();
    assert_eq!(error.reason(), "not_found");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_dialog_name_gets_the_format_extension() {
    assert_eq!(
        with_extension(PathBuf::from("d/plant"), ProjectFormat::Json),
        PathBuf::from("d/plant.json")
    );
    assert_eq!(
        with_extension(PathBuf::from("d/plant.JSON"), ProjectFormat::Json),
        PathBuf::from("d/plant.JSON")
    );
    assert_eq!(
        with_extension(PathBuf::from("d/plant.json"), ProjectFormat::Package),
        PathBuf::from("d/plant.json.bantoscada")
    );
    assert_eq!(
        suggested_file_name(" 第1工程 <A/B>. ", ProjectFormat::Package),
        "第1工程 _A_B_.bantoscada"
    );
    assert_eq!(
        suggested_file_name("  ", ProjectFormat::Json),
        "project.json"
    );
}

#[test]
fn a_frame_round_trips_and_a_cut_frame_is_refused() {
    let framed = frame(
        &json!({"fileId": 3, "format": "package", "name": "A", "saveAs": false}),
        b"PKbody",
    );
    let (header, body) = unframe::<SaveRequest>(&framed).unwrap();
    assert_eq!(
        header,
        SaveRequest {
            file_id: Some(3),
            format: ProjectFormat::Package,
            name: "A".into(),
            save_as: false,
        }
    );
    assert_eq!(body, b"PKbody");
    assert!(unframe::<SaveRequest>(&framed[..6]).is_none());
    assert!(unframe::<SaveRequest>(&[]).is_none());
    assert!(unframe::<SaveRequest>(&frame(&json!({"fileId": null}), b"")).is_none());
    assert!(unframe::<SaveRequest>(&u32::MAX.to_le_bytes()).is_none());
}
