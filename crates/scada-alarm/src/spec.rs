//! condition の評価に関わる定義（設計§3・§5.2）。
//!
//! Project の `alarms.definitions` を condition（しきい値なら定義×限界、bit なら定義そのもの）へ
//! 展開したあとの形を受け取る。名前・message・severity は表示の情報なので host が持ち、ここには
//! 持たない（変えても状態を引き継ぐ）。

use serde::{Deserialize, Serialize};

/// on／off delay の上限（設計§3、0〜600000 ms）。
pub const MAX_DELAY_MS: u64 = 600_000;

/// しきい値の限界の名前。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LimitKind {
    Hh,
    H,
    L,
    Ll,
}

impl LimitKind {
    /// 上の限界（HH・H）なら true。
    pub fn is_upper(self) -> bool {
        matches!(self, LimitKind::Hh | LimitKind::H)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LimitKind::Hh => "hh",
            LimitKind::H => "h",
            LimitKind::L => "l",
            LimitKind::Ll => "ll",
        }
    }
}

/// condition の発生元。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// 数値タグの 1 つの限界。
    #[serde(rename_all = "camelCase")]
    Threshold {
        tag: String,
        limit: LimitKind,
        value: f64,
        #[serde(default)]
        deadband: f64,
    },
    /// bit タグ。`activeWhen` と等しい値で成立する。
    #[serde(rename_all = "camelCase")]
    Bit { tag: String, active_when: bool },
}

impl Source {
    pub fn tag(&self) -> &str {
        match self {
            Source::Threshold { tag, .. } | Source::Bit { tag, .. } => tag,
        }
    }
}

/// ACK の種類（設計§3）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AckMode {
    #[default]
    Manual,
    AutoOnReturn,
    None,
    NoneWithSound,
}

impl AckMode {
    /// 発生で未確認になる（ACK が要る）なら true。
    pub fn requires_ack(self) -> bool {
        matches!(self, AckMode::Manual | AckMode::AutoOnReturn)
    }

    fn as_str(self) -> &'static str {
        match self {
            AckMode::Manual => "manual",
            AckMode::AutoOnReturn => "autoOnReturn",
            AckMode::None => "none",
            AckMode::NoneWithSound => "noneWithSound",
        }
    }
}

/// 1 つの condition の評価に関わる定義。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionSpec {
    pub source: Source,
    #[serde(default)]
    pub on_delay_ms: u64,
    #[serde(default)]
    pub off_delay_ms: u64,
    #[serde(default)]
    pub ack_mode: AckMode,
}

/// 定義の検査の失敗。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpecError {
    EmptyTag,
    NonFiniteLimit,
    InvalidDeadband,
    DelayTooLong,
}

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            SpecError::EmptyTag => "タグの外部名が空です",
            SpecError::NonFiniteLimit => "限界の値が有限ではありません",
            SpecError::InvalidDeadband => "deadband は有限で 0 以上にしてください",
            SpecError::DelayTooLong => "delay は 0〜600000 ms にしてください",
        };
        f.write_str(text)
    }
}

impl std::error::Error for SpecError {}

impl ConditionSpec {
    /// condition 単体で確かめられることだけを検査する。限界の順序・deadband と限界の差・
    /// タグの型・名前と id の重複は Project の検査（3-B）が受け持つ。
    pub fn validate(&self) -> Result<(), SpecError> {
        if self.source.tag().is_empty() {
            return Err(SpecError::EmptyTag);
        }
        if let Source::Threshold {
            value, deadband, ..
        } = &self.source
        {
            if !value.is_finite() {
                return Err(SpecError::NonFiniteLimit);
            }
            if !deadband.is_finite() || *deadband < 0.0 {
                return Err(SpecError::InvalidDeadband);
            }
        }
        if self.on_delay_ms > MAX_DELAY_MS || self.off_delay_ms > MAX_DELAY_MS {
            return Err(SpecError::DelayTooLong);
        }
        Ok(())
    }

    /// 評価に関わる内容の正規の文字列（設計§5.2 の hash の元）。
    ///
    /// 発生元の種類・タグ・`activeWhen`、自分の限界の名前と値、deadband、on／off delay、
    /// `ackMode` を含む。表示の情報は含めない。host はこれを hash にして「最後の状態」の
    /// 行と突き合わせる。タグは長さを前置して区切り文字との衝突を避ける。
    pub fn evaluation_key(&self) -> String {
        let source = match &self.source {
            Source::Threshold {
                tag,
                limit,
                value,
                deadband,
            } => format!(
                "threshold|{}:{}|{}|{:?}|{:?}",
                tag.len(),
                tag,
                limit.as_str(),
                value,
                deadband
            ),
            Source::Bit { tag, active_when } => {
                format!("bit|{}:{}|{}", tag.len(), tag, active_when)
            }
        };
        format!(
            "v1|{}|on={}|off={}|ack={}",
            source,
            self.on_delay_ms,
            self.off_delay_ms,
            self.ack_mode.as_str()
        )
    }
}
