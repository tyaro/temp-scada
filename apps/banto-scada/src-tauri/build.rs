include!("command_list.rs");

fn main() {
    println!("cargo:rerun-if-changed=command_list.rs");
    // Every command of `generate_handler!` is declared in the app's ACL
    // manifest, so each window may call only the `allow-<command>` of its
    // capability (Runtime mode design §4): `editor.json` for the `editor`
    // window, `runtime.json` for the `runtime` window.
    let commands: Vec<&'static str> = EDITOR_ONLY
        .iter()
        .chain(BOTH)
        .chain(RUNTIME_ONLY)
        .copied()
        .collect();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands.leak()));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
