// The commands of the desktop host by mode (Runtime mode design §5). The one
// list: `build.rs` declares them all in the app's ACL manifest, and the tests
// check it against `generate_handler!` and the two capabilities
// (`capabilities/editor.json`, `capabilities/runtime.json`).
//
// Read with `include!` by `build.rs` and `src/main.rs`; keep it plain consts.

/// Commands only the Editor window may call (`require_editor` first).
pub const EDITOR_ONLY: &[&str] = &[
    "project_open",
    "project_save",
    "alarm_apply",
    "alarm_sound_import",
    "hub_connect",
    "hub_catalog",
    "hub_read_start",
    "history_context",
    "recording_context",
    "recording_initial_setup",
    "recording_reconfigure",
    "recording_owner_rebind",
    "recording_resume",
    "recording_stop",
    "recording_workflow_reserve",
    "recording_workflow_resumption",
    "recording_workflow_lease",
    "recording_lease",
    "recording_admission",
    "recording_admission_inspection",
    "recording_observation",
    "recording_cancel",
    "recording_call_inspection",
    "recording_attach",
    "recording_control",
    "auth_transition_to_operational",
    "auth_config_apply",
];

/// Commands both windows may call.
pub const BOTH: &[&str] = &[
    "app_mode",
    "app_close_reply",
    "hub_disconnect",
    "hub_read_stop",
    "hub_saved_endpoint",
    "alarm_snapshot",
    "alarm_ack",
    "alarm_buzzer_silence",
    "alarm_history",
    "alarm_sound_test",
    "alarm_settings_get",
    "alarm_settings_set",
    "alarm_sound_reset",
    "auth_status",
    "auth_phase",
    "auth_login",
    "auth_logout",
    "auth_resolve",
    "auth_change_password",
    "auth_setup",
    "users_list",
    "users_create",
    "users_update",
    "users_reset_password",
    "users_delete",
    "auth_config_get",
    "history_query",
    "history_cancel",
    "recording_status",
    "recording_slot",
];

/// Commands only the Runtime window may call (`require_runtime` first).
/// They take no Project from the webview: the host's startup Project only.
pub const RUNTIME_ONLY: &[&str] = &[
    "runtime_project",
    "runtime_hub_connect",
    "runtime_read_start",
    "runtime_history_context",
    "runtime_recording_context",
    "runtime_alarm_status",
    "operation_write",
    "operation_view",
    "operation_key_status",
    "operation_key_register",
    "operation_key_delete",
    "operation_write_resume",
];
