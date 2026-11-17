//! The `alarm` field of the terminal settings (terminal settings design §2):
//! history retention and the reread values, with their ranges and relations,
//! and the stored buzzer sound (§5, checked in `alarm_sound`).
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::alarm_sound::SoundSetting;
use crate::alarm_db::RetentionLimit;
use crate::alarm_runtime::FreshnessConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RetentionKind {
    #[default]
    Days,
    Count,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionSettings {
    pub kind: RetentionKind,
    /// Kept while `kind` is `count`, so switching back needs no re-entry.
    pub days: u32,
    pub count: u32,
}

impl Default for RetentionSettings {
    fn default() -> Self {
        Self {
            kind: RetentionKind::Days,
            days: 365,
            count: 1_000_000,
        }
    }
}

impl RetentionSettings {
    /// The limit the Engine deletes by: only the selected kind applies.
    pub fn limit(&self) -> RetentionLimit {
        match self.kind {
            RetentionKind::Days => RetentionLimit::Days(self.days),
            RetentionKind::Count => RetentionLimit::Count(self.count),
        }
    }
}

const DAYS: (u32, u32) = (1, 3650);
const COUNT: (u32, u32) = (10_000, 10_000_000);
const INTERVAL_SEC: (u32, u32) = (2, 300);
const FAILURE_LIMIT_MAX_SEC: u32 = 3600;
const RECONNECT_FAILURES: (u32, u32) = (1, 10);

fn within(value: u32, (min, max): (u32, u32)) -> bool {
    (min..=max).contains(&value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RereadSettings {
    pub interval_sec: u32,
    pub timeout_sec: u32,
    pub failure_limit_sec: u32,
    pub reconnect_failures: u32,
}

impl Default for RereadSettings {
    fn default() -> Self {
        let config = FreshnessConfig::default();
        Self {
            interval_sec: config.reread_interval.as_secs() as u32,
            timeout_sec: config.reread_timeout.as_secs() as u32,
            failure_limit_sec: config.failure_limit.as_secs() as u32,
            reconnect_failures: config.resubscribe_failures,
        }
    }
}

impl RereadSettings {
    /// The four values relate to each other (timeout ≤ interval, failure
    /// limit ≥ twice the interval), so they are valid only together.
    pub fn is_valid(&self) -> bool {
        within(self.interval_sec, INTERVAL_SEC)
            && within(self.timeout_sec, (1, self.interval_sec))
            && within(
                self.failure_limit_sec,
                (self.interval_sec * 2, FAILURE_LIMIT_MAX_SEC),
            )
            && within(self.reconnect_failures, RECONNECT_FAILURES)
    }

    pub fn freshness(&self) -> FreshnessConfig {
        FreshnessConfig {
            reread_interval: Duration::from_secs(self.interval_sec.into()),
            reread_timeout: Duration::from_secs(self.timeout_sec.into()),
            failure_limit: Duration::from_secs(self.failure_limit_sec.into()),
            resubscribe_failures: self.reconnect_failures,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlarmSettings {
    pub retention: RetentionSettings,
    pub reread: RereadSettings,
}

impl AlarmSettings {
    /// `alarm_settings_set` saves only values within every range and relation.
    pub fn is_valid(&self) -> bool {
        within(self.retention.days, DAYS)
            && within(self.retention.count, COUNT)
            && self.reread.is_valid()
    }
}

/// A group of values reset to its defaults on load, shown by `alarm_settings_get`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AlarmSettingsWarning {
    RetentionKind,
    RetentionDays,
    RetentionCount,
    Reread,
    Sound,
}

/// The `alarm` field as written: the values `alarm_settings_set` saves and
/// the sound, which only `alarm_sound_import`/`reset` change.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SavedAlarm {
    #[serde(flatten)]
    pub settings: AlarmSettings,
    pub sound: SoundSetting,
}

/// The `alarm` field as stored. An out-of-range value (a hand edit) is not
/// corruption: it is reset per group on load. Numbers are read wide so a
/// negative or huge integer is a range error; a wrong JSON type stays
/// `Corrupt`.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(super) struct StoredAlarm {
    retention: StoredRetention,
    reread: StoredReread,
    sound: StoredSound,
}

/// Read loosely like the numbers: an unknown kind or a value no import could
/// have written resets the sound to the default with a warning.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSound {
    kind: String,
    name: Option<String>,
    size: Option<i64>,
    hash: Option<String>,
}

impl Default for StoredSound {
    fn default() -> Self {
        Self {
            kind: "default".into(),
            name: None,
            size: None,
            hash: None,
        }
    }
}

impl StoredSound {
    fn setting(self) -> Option<SoundSetting> {
        let setting = match (self.kind.as_str(), self.name, self.size, self.hash) {
            ("default", None, None, None) => SoundSetting::Default,
            ("custom", Some(name), Some(size), Some(hash)) => SoundSetting::Custom {
                name,
                size: u64::try_from(size).ok()?,
                hash,
            },
            _ => return None,
        };
        setting.is_valid().then_some(setting)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct StoredRetention {
    kind: String,
    days: i64,
    count: i64,
}

impl Default for StoredRetention {
    fn default() -> Self {
        let defaults = RetentionSettings::default();
        Self {
            kind: "days".into(),
            days: defaults.days.into(),
            count: defaults.count.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct StoredReread {
    interval_sec: i64,
    timeout_sec: i64,
    failure_limit_sec: i64,
    reconnect_failures: i64,
}

impl Default for StoredReread {
    fn default() -> Self {
        let defaults = RereadSettings::default();
        Self {
            interval_sec: defaults.interval_sec.into(),
            timeout_sec: defaults.timeout_sec.into(),
            failure_limit_sec: defaults.failure_limit_sec.into(),
            reconnect_failures: defaults.reconnect_failures.into(),
        }
    }
}

fn ranged(value: i64, range: (u32, u32)) -> Option<u32> {
    u32::try_from(value)
        .ok()
        .filter(|value| within(*value, range))
}

impl StoredAlarm {
    /// Reset each related group to its defaults: the retention kind, days and
    /// count independently, the four reread values together, the sound alone.
    pub(super) fn normalize(self) -> (SavedAlarm, Vec<AlarmSettingsWarning>) {
        let defaults = AlarmSettings::default();
        let mut warnings = Vec::new();
        let kind = match self.retention.kind.as_str() {
            "days" => RetentionKind::Days,
            "count" => RetentionKind::Count,
            _ => {
                warnings.push(AlarmSettingsWarning::RetentionKind);
                defaults.retention.kind
            }
        };
        let days = ranged(self.retention.days, DAYS).unwrap_or_else(|| {
            warnings.push(AlarmSettingsWarning::RetentionDays);
            defaults.retention.days
        });
        let count = ranged(self.retention.count, COUNT).unwrap_or_else(|| {
            warnings.push(AlarmSettingsWarning::RetentionCount);
            defaults.retention.count
        });
        let wide = |value: i64| u32::try_from(value).ok();
        let reread = match (
            wide(self.reread.interval_sec),
            wide(self.reread.timeout_sec),
            wide(self.reread.failure_limit_sec),
            wide(self.reread.reconnect_failures),
        ) {
            (
                Some(interval_sec),
                Some(timeout_sec),
                Some(failure_limit_sec),
                Some(reconnect_failures),
            ) => Some(RereadSettings {
                interval_sec,
                timeout_sec,
                failure_limit_sec,
                reconnect_failures,
            }),
            _ => None,
        }
        .filter(RereadSettings::is_valid)
        .unwrap_or_else(|| {
            warnings.push(AlarmSettingsWarning::Reread);
            defaults.reread
        });
        let sound = self.sound.setting().unwrap_or_else(|| {
            warnings.push(AlarmSettingsWarning::Sound);
            SoundSetting::Default
        });
        (
            SavedAlarm {
                settings: AlarmSettings {
                    retention: RetentionSettings { kind, days, count },
                    reread,
                },
                sound,
            },
            warnings,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(json: serde_json::Value) -> (AlarmSettings, Vec<AlarmSettingsWarning>) {
        let (saved, warnings) = serde_json::from_value::<StoredAlarm>(json)
            .unwrap()
            .normalize();
        (saved.settings, warnings)
    }

    fn load_sound(sound: serde_json::Value) -> (SoundSetting, Vec<AlarmSettingsWarning>) {
        let (saved, warnings) =
            serde_json::from_value::<StoredAlarm>(serde_json::json!({ "sound": sound }))
                .unwrap()
                .normalize();
        (saved.sound, warnings)
    }

    #[test]
    fn a_sound_no_import_could_write_resets_to_the_default() {
        let hash = "a".repeat(64);
        let custom =
            serde_json::json!({"kind": "custom", "name": "a.wav", "size": 10, "hash": hash});
        assert_eq!(
            load_sound(custom),
            (
                SoundSetting::Custom {
                    name: "a.wav".into(),
                    size: 10,
                    hash: hash.clone(),
                },
                vec![]
            )
        );
        for sound in [
            serde_json::json!({"kind": "chime"}),
            serde_json::json!({"kind": "custom", "name": "a.wav", "size": 10}),
            serde_json::json!({"kind": "custom", "name": "a.wav", "size": -1, "hash": hash}),
            serde_json::json!({"kind": "custom", "name": "a.wav", "size": 2_000_000, "hash": hash}),
            serde_json::json!({"kind": "custom", "name": "", "size": 10, "hash": hash}),
            serde_json::json!({"kind": "custom", "name": "a.wav", "size": 10, "hash": "XYZ"}),
            serde_json::json!({"kind": "default", "name": "a.wav"}),
        ] {
            assert_eq!(
                load_sound(sound.clone()),
                (SoundSetting::Default, vec![AlarmSettingsWarning::Sound]),
                "{sound}"
            );
        }
    }

    fn reread(interval: i64, timeout: i64, limit: i64, failures: i64) -> serde_json::Value {
        serde_json::json!({
            "reread": {
                "intervalSec": interval,
                "timeoutSec": timeout,
                "failureLimitSec": limit,
                "reconnectFailures": failures,
            }
        })
    }

    #[test]
    fn defaults_are_the_design_values_and_valid() {
        let defaults = AlarmSettings::default();
        assert_eq!(defaults.retention.kind, RetentionKind::Days);
        assert_eq!(
            (defaults.retention.days, defaults.retention.count),
            (365, 1_000_000)
        );
        assert_eq!(
            defaults.reread,
            RereadSettings {
                interval_sec: 10,
                timeout_sec: 5,
                failure_limit_sec: 30,
                reconnect_failures: 3,
            }
        );
        assert!(defaults.is_valid());
        assert_eq!(defaults.reread.freshness(), FreshnessConfig::default());
    }

    #[test]
    fn ranges_and_relations_are_checked_together() {
        let ok = |interval, timeout, limit, failures| {
            RereadSettings {
                interval_sec: interval,
                timeout_sec: timeout,
                failure_limit_sec: limit,
                reconnect_failures: failures,
            }
            .is_valid()
        };
        assert!(ok(2, 1, 4, 1));
        assert!(ok(300, 300, 600, 10));
        assert!(ok(10, 10, 3600, 3));
        assert!(!ok(1, 1, 30, 3), "interval below 2");
        assert!(!ok(301, 5, 3600, 3), "interval above 300");
        assert!(!ok(10, 0, 30, 3), "timeout below 1");
        assert!(!ok(10, 11, 30, 3), "timeout above the interval");
        assert!(!ok(10, 5, 19, 3), "failure limit below twice the interval");
        assert!(!ok(10, 5, 3601, 3), "failure limit above 3600");
        assert!(!ok(10, 5, 30, 0), "reconnect failures below 1");
        assert!(!ok(10, 5, 30, 11), "reconnect failures above 10");
        let mut settings = AlarmSettings::default();
        settings.retention.days = 0;
        assert!(!settings.is_valid());
        settings.retention.days = 3650;
        settings.retention.count = 9_999;
        assert!(!settings.is_valid());
        settings.retention.count = 10_000_000;
        assert!(settings.is_valid());
    }

    #[test]
    fn any_reread_value_out_of_range_or_relation_resets_all_four() {
        // The three cases of design §8.
        for (json, case) in [
            (reread(2, 0, 30, 3), "interval 2, timeout 0"),
            (reread(300, 5, 1, 3), "interval 300, failure limit 1"),
            (reread(1, 1, 30, 3), "interval itself out of range"),
            (reread(10, 5, 30, -1), "negative value"),
            (reread(10, 5, 30, 1 << 40), "beyond u32"),
        ] {
            let (settings, warnings) = load(json);
            assert_eq!(settings.reread, RereadSettings::default(), "{case}");
            assert_eq!(warnings, vec![AlarmSettingsWarning::Reread], "{case}");
            assert_eq!(settings.retention, RetentionSettings::default(), "{case}");
        }
        let (settings, warnings) = load(reread(20, 20, 40, 10));
        assert!(warnings.is_empty());
        assert_eq!(settings.reread.interval_sec, 20);
    }

    #[test]
    fn retention_values_reset_independently() {
        let (settings, warnings) =
            load(serde_json::json!({"retention": {"kind": "weeks", "days": 30, "count": 5}}));
        assert_eq!(
            settings.retention,
            RetentionSettings {
                kind: RetentionKind::Days,
                days: 30,
                count: 1_000_000,
            }
        );
        assert_eq!(
            warnings,
            vec![
                AlarmSettingsWarning::RetentionKind,
                AlarmSettingsWarning::RetentionCount
            ]
        );
        let (settings, warnings) =
            load(serde_json::json!({"retention": {"kind": "count", "days": 0, "count": 20000}}));
        assert_eq!(
            settings.retention,
            RetentionSettings {
                kind: RetentionKind::Count,
                days: 365,
                count: 20_000,
            }
        );
        assert_eq!(warnings, vec![AlarmSettingsWarning::RetentionDays]);
    }

    #[test]
    fn a_wrong_type_or_unknown_field_is_not_a_range_error() {
        for json in [
            serde_json::json!({"reread": {"intervalSec": "10"}}),
            serde_json::json!({"reread": {"intervalSec": 10.5}}),
            serde_json::json!({"retention": {"kind": 1}}),
            serde_json::json!({"sound": "default"}),
            serde_json::json!(null),
        ] {
            assert!(serde_json::from_value::<StoredAlarm>(json).is_err());
        }
    }

    #[test]
    fn the_wire_names_follow_the_design() {
        let json = serde_json::to_value(SavedAlarm::default()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "sound": {"kind": "default"},
                "retention": {"kind": "days", "days": 365, "count": 1_000_000},
                "reread": {
                    "intervalSec": 10,
                    "timeoutSec": 5,
                    "failureLimitSec": 30,
                    "reconnectFailures": 3,
                },
            })
        );
        let (settings, warnings) = load(json);
        assert!(warnings.is_empty());
        assert_eq!(settings, AlarmSettings::default());
        // The command argument of `alarm_settings_set` has no sound.
        assert!(serde_json::to_value(AlarmSettings::default())
            .unwrap()
            .get("sound")
            .is_none());
    }
}
