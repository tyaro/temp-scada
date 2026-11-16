//! The terminal alarm buzzer (design §6, 3-E2). The host decides when to
//! sound; this module only plays a bundled beep generated in memory, so no
//! audio file ships with the app and WebView autoplay rules do not apply.
use std::sync::{Arc, OnceLock};

use scada_host::alarm_buzzer::{BuzzerPlayer, LogBuzzerPlayer};

const RATE: u32 = 22_050;
const TONE_HZ: f32 = 880.0;
const BEEP_MS: u32 = 300;
const GAP_MS: u32 = 200;
const FADE_MS: u32 = 5;

/// A mono 16-bit PCM WAV: one beep followed by silence, so a loop beeps
/// at a steady interval.
pub fn beep_wav() -> &'static [u8] {
    static WAV: OnceLock<Vec<u8>> = OnceLock::new();
    WAV.get_or_init(|| {
        let beep = RATE * BEEP_MS / 1000;
        let total = beep + RATE * GAP_MS / 1000;
        let fade = (RATE * FADE_MS / 1000) as f32;
        let data_len = total * 2;
        let mut wav = Vec::with_capacity(44 + data_len as usize);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&RATE.to_le_bytes());
        wav.extend_from_slice(&(RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..total {
            let sample = if i < beep {
                let edge = (i as f32).min((beep - 1 - i) as f32);
                let envelope = (edge / fade).min(1.0);
                let phase = 2.0 * std::f32::consts::PI * TONE_HZ * i as f32 / RATE as f32;
                (phase.sin() * envelope * 0.5 * i16::MAX as f32) as i16
            } else {
                0
            };
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    })
}

/// The player for this platform.
pub fn player() -> Arc<dyn BuzzerPlayer> {
    #[cfg(windows)]
    {
        Arc::new(windows::PlaySoundPlayer)
    }
    #[cfg(not(windows))]
    {
        Arc::new(LogBuzzerPlayer)
    }
}

#[cfg(windows)]
pub mod windows {
    use super::{beep_wav, BuzzerPlayer, LogBuzzerPlayer};
    use windows_sys::Win32::Media::Audio::{
        PlaySoundW, SND_ASYNC, SND_FLAGS, SND_LOOP, SND_MEMORY, SND_NODEFAULT,
    };

    /// `PlaySoundW` with `SND_MEMORY | SND_ASYNC`; the WAV is a `'static`
    /// buffer, so it outlives the asynchronous playback.
    pub struct PlaySoundPlayer;

    impl PlaySoundPlayer {
        pub fn play(flags: SND_FLAGS) -> bool {
            let wav = beep_wav();
            // SAFETY: SND_MEMORY reads a complete WAV image from a pointer that
            // stays valid for the program's lifetime.
            unsafe {
                PlaySoundW(
                    wav.as_ptr().cast(),
                    std::ptr::null_mut(),
                    SND_MEMORY | SND_ASYNC | SND_NODEFAULT | flags,
                ) != 0
            }
        }

        pub fn silence() -> bool {
            // SAFETY: a null sound stops any sound playing for this process.
            unsafe { PlaySoundW(std::ptr::null(), std::ptr::null_mut(), 0) != 0 }
        }
    }

    impl BuzzerPlayer for PlaySoundPlayer {
        fn play_loop(&self) {
            if !Self::play(SND_LOOP) {
                eprintln!("alarm buzzer: PlaySound failed");
                LogBuzzerPlayer.play_loop();
            }
        }
        fn play_once(&self) {
            if !Self::play(0) {
                eprintln!("alarm buzzer: PlaySound failed");
                LogBuzzerPlayer.play_once();
            }
        }
        fn stop(&self) {
            Self::silence();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_beep_is_a_pcm_wav() {
        let wav = beep_wav();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        let data_len = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize;
        assert_eq!(wav.len(), 44 + data_len);
        assert_eq!(
            u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]) as usize,
            wav.len() - 8
        );
        assert!(wav[44..].chunks(2).any(|pair| pair != [0, 0]));
    }

    #[cfg(windows)]
    #[test]
    fn play_sound_accepts_the_bundled_beep() {
        use windows::PlaySoundPlayer;
        // SND_NODEFAULT: without an audio device the call fails instead of
        // playing the system default, so only a real device is asserted.
        let played = PlaySoundPlayer::play(0);
        assert!(PlaySoundPlayer::silence());
        if !played {
            eprintln!("PlaySound refused the beep (no audio device?)");
        }
        if std::env::var_os("BANTO_EXPECT_AUDIO").is_some() {
            assert!(played, "PlaySound must accept the bundled beep");
        }
    }
}
