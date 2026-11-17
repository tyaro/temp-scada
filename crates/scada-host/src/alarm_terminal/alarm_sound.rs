//! The buzzer sound of the terminal settings (terminal settings design §5):
//! the WAV check, the stored `sound` value and how the sound to play is
//! decided from the imported file.
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::durable;

/// The imported sound under the terminal data dir (`local_data_dir()`).
pub const SOUND_FILE: &str = "alarm-sound.wav";
/// The largest WAV accepted (1 MB).
pub const MAX_SOUND_BYTES: usize = 1024 * 1024;
/// The longest WAV accepted: it is played in a loop, so it stays short.
pub const MAX_SOUND_MS: u64 = 5_000;
const MAX_NAME_CHARS: usize = 255;

/// The `sound` of the terminal settings. `custom` names the imported file
/// (the original name is for display only) by its size and SHA-256.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SoundSetting {
    #[default]
    Default,
    Custom {
        name: String,
        size: u64,
        hash: String,
    },
}

impl SoundSetting {
    pub fn kind(&self) -> SoundKind {
        match self {
            Self::Default => SoundKind::Default,
            Self::Custom { .. } => SoundKind::Custom,
        }
    }

    /// A stored value is used only if it could have been saved by an import.
    pub(super) fn is_valid(&self) -> bool {
        match self {
            Self::Default => true,
            Self::Custom { name, size, hash } => {
                !name.is_empty()
                    && name.chars().count() <= MAX_NAME_CHARS
                    && (1..=MAX_SOUND_BYTES as u64).contains(size)
                    && hash.len() == 64
                    && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundKind {
    Default,
    Custom,
}

/// Why the imported sound is not played and the bundled beep is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundFallback {
    /// The file is missing or cannot be read.
    FileUnreadable,
    /// The file is not the one the settings name (size or SHA-256).
    HashMismatch,
    /// The file no longer passes the WAV check.
    InvalidWav,
}

/// The sound the buzzer plays: the setting's kind, and the WAV bytes or
/// `None` for the bundled beep (with the reason when it is a fallback).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSound {
    pub kind: SoundKind,
    pub fallback: Option<SoundFallback>,
    pub wav: Option<Arc<[u8]>>,
}

impl ResolvedSound {
    pub fn default_beep() -> Self {
        Self {
            kind: SoundKind::Default,
            fallback: None,
            wav: None,
        }
    }
}

/// Why a WAV is refused (design §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WavRejection {
    TooLarge,
    NotWav,
    /// A chunk reaches beyond the RIFF chunk or the file.
    OutOfBounds,
    NoFormat,
    Extensible,
    Compressed,
    UnsupportedBits,
    UnsupportedChannels,
    /// The format chunk is inconsistent (block align, byte rate, rate 0).
    Malformed,
    NoData,
    TooLong,
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Accept only a WAV that `PlaySoundW` plays as is: RIFF/WAVE, PCM (1),
/// 8 or 16 bit, 1 or 2 channels, every chunk within the file, a data
/// chunk, at most 1 MB and 5 seconds.
pub fn check_wav(bytes: &[u8]) -> Result<(), WavRejection> {
    if bytes.len() > MAX_SOUND_BYTES {
        return Err(WavRejection::TooLarge);
    }
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(WavRejection::NotWav);
    }
    let riff_end = 8usize
        .checked_add(u32_at(bytes, 4) as usize)
        .filter(|end| *end <= bytes.len())
        .ok_or(WavRejection::OutOfBounds)?;
    let mut format = None;
    let mut data_len = None;
    let mut at = 12;
    while at < riff_end {
        if riff_end - at < 8 {
            return Err(WavRejection::OutOfBounds);
        }
        let id = &bytes[at..at + 4];
        let size = u32_at(bytes, at + 4) as usize;
        let body = at + 8;
        let end = body
            .checked_add(size)
            .filter(|end| *end <= riff_end)
            .ok_or(WavRejection::OutOfBounds)?;
        match id {
            b"fmt " if format.is_none() => {
                if size < 16 {
                    return Err(WavRejection::Malformed);
                }
                format = Some(&bytes[body..end]);
            }
            b"data" if data_len.is_none() => data_len = Some(size as u64),
            _ => {}
        }
        // Chunks are word aligned; a missing pad byte at the very end is
        // tolerated.
        at = (end + (size & 1)).min(riff_end);
    }
    let format = format.ok_or(WavRejection::NoFormat)?;
    match u16_at(format, 0) {
        1 => {}
        0xFFFE => return Err(WavRejection::Extensible),
        _ => return Err(WavRejection::Compressed),
    }
    let channels = u16_at(format, 2);
    let rate = u32_at(format, 4);
    let byte_rate = u32_at(format, 8);
    let block_align = u16_at(format, 12);
    let bits = u16_at(format, 14);
    if !matches!(bits, 8 | 16) {
        return Err(WavRejection::UnsupportedBits);
    }
    if !matches!(channels, 1 | 2) {
        return Err(WavRejection::UnsupportedChannels);
    }
    if rate == 0
        || u32::from(block_align) != u32::from(channels) * u32::from(bits) / 8
        || u64::from(byte_rate) != u64::from(rate) * u64::from(block_align)
    {
        return Err(WavRejection::Malformed);
    }
    let data_len = data_len.ok_or(WavRejection::NoData)?;
    if data_len * 1000 > MAX_SOUND_MS * u64::from(byte_rate) {
        return Err(WavRejection::TooLong);
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The setting for a WAV that passed the check, named after its original
/// file name (display only; no path).
pub(super) fn custom_setting(name: &str, bytes: &[u8]) -> SoundSetting {
    let name: String = Path::new(name)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    SoundSetting::Custom {
        name: if name.is_empty() {
            SOUND_FILE.into()
        } else {
            name
        },
        size: bytes.len() as u64,
        hash: sha256_hex(bytes),
    }
}

/// Decide the sound from the setting and the file in `data_dir`. The file
/// must still match the setting's size and hash and pass the WAV check;
/// otherwise the bundled beep plays and the reason is kept.
pub fn resolve(data_dir: &Path, setting: &SoundSetting) -> ResolvedSound {
    let SoundSetting::Custom { size, hash, .. } = setting else {
        return ResolvedSound::default_beep();
    };
    let fallback = |reason| ResolvedSound {
        kind: SoundKind::Custom,
        fallback: Some(reason),
        wav: None,
    };
    let bytes = match durable::read_optional(&data_dir.join(SOUND_FILE)) {
        Ok(Some(bytes)) => bytes,
        Ok(None) | Err(_) => return fallback(SoundFallback::FileUnreadable),
    };
    if bytes.len() as u64 != *size || sha256_hex(&bytes) != *hash {
        return fallback(SoundFallback::HashMismatch);
    }
    if check_wav(&bytes).is_err() {
        return fallback(SoundFallback::InvalidWav);
    }
    ResolvedSound {
        kind: SoundKind::Custom,
        fallback: None,
        wav: Some(bytes.into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A PCM WAV of `ms` milliseconds.
    pub(crate) fn wav(bits: u16, channels: u16, rate: u32, ms: u32) -> Vec<u8> {
        let block = channels * bits / 8;
        let data_len = rate * ms / 1000 * u32::from(block);
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * u32::from(block)).to_le_bytes());
        wav.extend_from_slice(&block.to_le_bytes());
        wav.extend_from_slice(&bits.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.resize(44 + data_len as usize, 0x40);
        wav
    }

    fn set_u16(wav: &mut [u8], at: usize, value: u16) {
        wav[at..at + 2].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn wav_check_accepts_8_and_16_bit_mono_and_stereo_pcm() {
        for (bits, channels) in [(8, 1), (8, 2), (16, 1), (16, 2)] {
            assert_eq!(check_wav(&wav(bits, channels, 8_000, 500)), Ok(()));
        }
        // Exactly 5 seconds, and an extra chunk before the data.
        assert_eq!(check_wav(&wav(8, 1, 8_000, 5_000)), Ok(()));
        let mut listed = wav(16, 1, 8_000, 100);
        let data = listed.split_off(36);
        listed.extend_from_slice(b"LIST\x03\x00\x00\x00abc\x00");
        listed.extend_from_slice(&data);
        let riff = (listed.len() - 8) as u32;
        listed[4..8].copy_from_slice(&riff.to_le_bytes());
        assert_eq!(check_wav(&listed), Ok(()));
    }

    #[test]
    fn wav_check_refuses_other_formats_and_broken_files() {
        let base = wav(16, 1, 8_000, 500);
        let mut extensible = base.clone();
        set_u16(&mut extensible, 20, 0xFFFE);
        assert_eq!(check_wav(&extensible), Err(WavRejection::Extensible));
        let mut compressed = base.clone();
        set_u16(&mut compressed, 20, 2); // ADPCM
        assert_eq!(check_wav(&compressed), Err(WavRejection::Compressed));
        assert_eq!(
            check_wav(&wav(24, 1, 8_000, 500)),
            Err(WavRejection::UnsupportedBits)
        );
        assert_eq!(
            check_wav(&wav(16, 3, 8_000, 500)),
            Err(WavRejection::UnsupportedChannels)
        );
        let mut beyond = base.clone();
        beyond[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(check_wav(&beyond), Err(WavRejection::OutOfBounds));
        let mut riff_beyond = base.clone();
        riff_beyond[4..8].copy_from_slice(&(base.len() as u32).to_le_bytes());
        assert_eq!(check_wav(&riff_beyond), Err(WavRejection::OutOfBounds));
        let mut no_data = base[..36].to_vec();
        no_data[4..8].copy_from_slice(&28u32.to_le_bytes());
        assert_eq!(check_wav(&no_data), Err(WavRejection::NoData));
        let mut bad_align = base.clone();
        set_u16(&mut bad_align, 32, 4);
        assert_eq!(check_wav(&bad_align), Err(WavRejection::Malformed));
        assert_eq!(
            check_wav(&wav(8, 1, 8_000, 5_001)),
            Err(WavRejection::TooLong)
        );
        assert_eq!(
            check_wav(&wav(16, 2, 44_100, 6_000)),
            Err(WavRejection::TooLarge),
            "6 s of 16-bit stereo is beyond 1 MB"
        );
        assert_eq!(check_wav(b"OggS not a wav"), Err(WavRejection::NotWav));
        let mut rifx = base.clone();
        rifx[8..12].copy_from_slice(b"AVI ");
        assert_eq!(check_wav(&rifx), Err(WavRejection::NotWav));
    }

    #[test]
    fn resolve_falls_back_with_a_reason() {
        let dir = std::env::temp_dir().join(format!("alarm-sound-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = wav(16, 1, 8_000, 200);
        let setting = custom_setting(
            &Path::new("sounds").join("bell.wav").to_string_lossy(),
            &bytes,
        );
        assert!(setting.is_valid());
        assert!(matches!(&setting, SoundSetting::Custom { name, .. } if name == "bell.wav"));
        assert_eq!(
            resolve(&dir, &SoundSetting::Default),
            ResolvedSound::default_beep()
        );
        let reason = |dir: &Path| resolve(dir, &setting).fallback;
        assert_eq!(reason(&dir), Some(SoundFallback::FileUnreadable));
        std::fs::write(dir.join(SOUND_FILE), wav(16, 1, 8_000, 300)).unwrap();
        assert_eq!(reason(&dir), Some(SoundFallback::HashMismatch));
        std::fs::write(dir.join(SOUND_FILE), &bytes).unwrap();
        let resolved = resolve(&dir, &setting);
        assert_eq!(resolved.fallback, None);
        assert_eq!(resolved.kind, SoundKind::Custom);
        assert_eq!(resolved.wav.as_deref(), Some(bytes.as_slice()));
        // A file that matches the setting but fails the check (a hand edit
        // of both): still the beep.
        let mut broken = bytes.clone();
        set_u16(&mut broken, 20, 0xFFFE);
        std::fs::write(dir.join(SOUND_FILE), &broken).unwrap();
        let broken_setting = SoundSetting::Custom {
            name: "x.wav".into(),
            size: broken.len() as u64,
            hash: sha256_hex(&broken),
        };
        assert_eq!(
            resolve(&dir, &broken_setting).fallback,
            Some(SoundFallback::InvalidWav)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sound_wire_names_follow_the_design() {
        assert_eq!(
            serde_json::to_value(SoundSetting::Default).unwrap(),
            serde_json::json!({"kind": "default"})
        );
        let custom = SoundSetting::Custom {
            name: "a.wav".into(),
            size: 10,
            hash: "0".repeat(64),
        };
        assert_eq!(
            serde_json::to_value(&custom).unwrap(),
            serde_json::json!({"kind": "custom", "name": "a.wav", "size": 10, "hash": "0".repeat(64)})
        );
    }
}
