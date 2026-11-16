//! ブザーを鳴らす判断（設計§6、3-E2）。
//!
//! 判断は純粋な状態 [`Buzzer`] に置き、Engine の snapshot と差分（`AlarmChange`）から
//! 「いま鳴り続けるか」「一度だけ鳴らすか」を決める。音を出すのは [`BuzzerPlayer`] で、
//! 端末ごとの実装（Windows の PlaySound など）は呼び出し側が渡す。
//!
//! 規則:
//! - 未確認（ActiveUnacked）の回があり、停止されていなければ鳴り続ける。ActiveUnacked
//!   になるのは `manual`・`autoOnReturn`（`Sound::Continuous`）の定義だけ。
//! - `noneWithSound`（`Sound::Once`）は発生のイベントで一度だけ鳴らす。鳴り続けている
//!   あいだは重ねない（再生を切らない）。停止中・鳴らすものが無いときは一度鳴らす。
//! - ブザー停止は音を止めるだけで ACK ではない。未確認の回の集合に新しい
//!   (occurrence, recurrence) が加わる（新しい回の発生・未確認の回の再発生）と停止を解く。
//! - 未確認の回が無くなったら停止の状態も消す。Engine の停止・未適用では鳴らさず、停止の
//!   状態も消す。新しい session は停止されていない状態から始める（引き継いだ未確認は鳴る）。
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use scada_alarm::{ConditionState, Engine, Event, EventKind, Sound};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::alarm_runtime::AlarmChange;

/// 画面に出すブザーの状態（`alarm_snapshot` の `buzzer`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BuzzerStatus {
    /// 未確認の回があり、鳴っている。
    Ringing,
    /// 未確認の回があるが、端末で止めている。
    Silenced,
    /// 鳴らすものが無い（Engine の停止・未適用を含む）。
    Quiet,
}

/// 再生への指示。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuzzerCommand {
    Loop,
    Once,
    Stop,
}

/// 端末の音を出す口。呼び出しは短く返す（非同期再生）こと。
pub trait BuzzerPlayer: Send + Sync {
    fn play_loop(&self);
    fn play_once(&self);
    fn stop(&self);
}

/// 音を出さず、ログだけ残す（Windows 以外・試験）。
pub struct LogBuzzerPlayer;

impl BuzzerPlayer for LogBuzzerPlayer {
    fn play_loop(&self) {
        eprintln!("alarm buzzer: ringing (no audio on this platform)");
    }
    fn play_once(&self) {
        eprintln!("alarm buzzer: once (no audio on this platform)");
    }
    fn stop(&self) {}
}

/// 未確認の回 (occurrence, recurrence)。
type Unacked = (Option<String>, u32);

/// ブザーの純粋な状態。
#[derive(Debug, Default)]
pub struct Buzzer {
    session: Option<String>,
    seq: u64,
    unacked: BTreeMap<String, Unacked>,
    silenced: bool,
    looping: bool,
}

/// 差分が当てられない（連番の飛び・別の session）。snapshot から揃え直す。
#[derive(Debug, PartialEq, Eq)]
pub struct NeedsSync;

fn unacked_of(state: &ConditionState) -> Option<Unacked> {
    (state.active && !state.acked).then(|| (state.occurrence.clone(), state.recurrence))
}

impl Buzzer {
    pub fn status(&self) -> BuzzerStatus {
        if self.session.is_none() || self.unacked.is_empty() {
            BuzzerStatus::Quiet
        } else if self.silenced {
            BuzzerStatus::Silenced
        } else {
            BuzzerStatus::Ringing
        }
    }

    /// Engine の snapshot から揃える（開始・取り直し）。
    pub fn sync<'a>(
        &mut self,
        session: &str,
        seq: u64,
        conditions: impl IntoIterator<Item = (&'a String, &'a ConditionState)>,
    ) -> Vec<BuzzerCommand> {
        let next: BTreeMap<_, _> = conditions
            .into_iter()
            .filter_map(|(id, state)| unacked_of(state).map(|row| (id.clone(), row)))
            .collect();
        if self.session.as_deref() != Some(session) {
            self.session = Some(session.to_owned());
            self.silenced = false;
            self.unacked.clear();
        }
        self.seq = seq;
        self.replace(next, false)
    }

    /// 差分を当てる。同じ session の古い連番は重複として捨てる。
    pub fn apply(
        &mut self,
        session: &str,
        seq: u64,
        conditions: &BTreeMap<String, Option<ConditionState>>,
        events: &[Event],
    ) -> Result<Vec<BuzzerCommand>, NeedsSync> {
        if self.session.as_deref() != Some(session) {
            return Err(NeedsSync);
        }
        let once = events.iter().any(|event| {
            matches!(
                event.kind,
                EventKind::Occurred {
                    sound: Sound::Once,
                    ..
                }
            )
        });
        if seq <= self.seq {
            // 揃えた snapshot に含まれていた差分（購読で待っていたもの）。状態は揃って
            // いるが、一度鳴らしは状態に残らないので、ここで鳴らす。差分は購読で一度
            // しか届かないので二重には鳴らない。
            return Ok(if once && !self.looping {
                vec![BuzzerCommand::Once]
            } else {
                Vec::new()
            });
        }
        if seq != self.seq + 1 {
            return Err(NeedsSync);
        }
        self.seq = seq;
        let mut next = self.unacked.clone();
        for (id, state) in conditions {
            match state.as_ref().and_then(unacked_of) {
                Some(row) => next.insert(id.clone(), row),
                None => next.remove(id),
            };
        }
        Ok(self.replace(next, once))
    }

    /// 端末の音を止める（ACK ではない）。一度鳴らしの途中でも止める。
    pub fn silence(&mut self) -> Vec<BuzzerCommand> {
        if self.status() == BuzzerStatus::Ringing {
            self.silenced = true;
        }
        self.looping = false;
        vec![BuzzerCommand::Stop]
    }

    /// Engine の停止・未適用。鳴らさず、停止の状態も消す。
    pub fn engine_stopped(&mut self) -> Vec<BuzzerCommand> {
        let looping = self.looping;
        *self = Self::default();
        if looping {
            vec![BuzzerCommand::Stop]
        } else {
            Vec::new()
        }
    }

    fn replace(&mut self, next: BTreeMap<String, Unacked>, once: bool) -> Vec<BuzzerCommand> {
        let added = next
            .iter()
            .any(|(id, row)| self.unacked.get(id) != Some(row));
        if added {
            self.silenced = false;
        }
        self.unacked = next;
        if self.unacked.is_empty() {
            self.silenced = false;
        }
        let want = self.status() == BuzzerStatus::Ringing;
        let command = match (want, self.looping) {
            (true, false) => Some(BuzzerCommand::Loop),
            (false, true) => Some(BuzzerCommand::Stop),
            (false, false) if once => Some(BuzzerCommand::Once),
            _ => None,
        };
        self.looping = want;
        command.into_iter().collect()
    }
}

/// host のブザー: 状態・再生・画面への知らせを一つの排他で扱う。
///
/// pump は `begin` で受け取った印を付けて呼ぶ。Engine を止めた後（`halt`）に遅れて
/// 届いた古い pump の呼び出しは印が合わず捨てる。
pub struct BuzzerDriver {
    inner: Mutex<(u64, Buzzer)>,
    player: Arc<dyn BuzzerPlayer>,
    notify: broadcast::Sender<()>,
}

impl BuzzerDriver {
    /// `notify` には状態が変わったときに送る（画面は snapshot を取り直す）。
    pub fn new(player: Arc<dyn BuzzerPlayer>, notify: broadcast::Sender<()>) -> Self {
        Self {
            inner: Mutex::new((0, Buzzer::default())),
            player,
            notify,
        }
    }

    pub fn status(&self) -> BuzzerStatus {
        self.lock().1.status()
    }

    /// 新しい pump の印。前の pump の呼び出しはこの後すべて捨てる。
    pub fn begin(&self) -> u64 {
        let mut inner = self.lock();
        inner.0 += 1;
        let before = inner.1.status();
        let commands = inner.1.engine_stopped();
        self.run(&inner.1, before, commands);
        inner.0
    }

    pub fn sync(&self, token: u64, engine: &Engine) {
        self.with(token, |buzzer| {
            buzzer.sync(
                &engine.session().id,
                engine.seq(),
                engine.conditions().iter().map(|(id, row)| (id, &row.state)),
            )
        });
    }

    /// 差分を当てる。`false` なら呼び出し側が snapshot から揃え直す。
    pub fn apply(&self, token: u64, change: &AlarmChange) -> bool {
        let mut synced = true;
        self.with(token, |buzzer| {
            match buzzer.apply(
                &change.session.id,
                change.seq,
                &change.conditions,
                &change.events,
            ) {
                Ok(commands) => commands,
                Err(NeedsSync) => {
                    synced = false;
                    Vec::new()
                }
            }
        });
        synced
    }

    /// 自分の pump が Engine の停止を見た。
    pub fn engine_stopped(&self, token: u64) {
        self.with(token, Buzzer::engine_stopped);
    }

    /// service が Engine を止めた。印を進め、遅れた pump の呼び出しを捨てる。
    pub fn halt(&self) {
        self.begin();
    }

    /// ブザー停止（設計§6）。権限は要らない。
    pub fn silence(&self) -> BuzzerStatus {
        let mut inner = self.lock();
        let before = inner.1.status();
        let commands = inner.1.silence();
        self.run(&inner.1, before, commands);
        inner.1.status()
    }

    fn with(&self, token: u64, step: impl FnOnce(&mut Buzzer) -> Vec<BuzzerCommand>) {
        let mut inner = self.lock();
        if inner.0 != token {
            return;
        }
        let before = inner.1.status();
        let commands = step(&mut inner.1);
        self.run(&inner.1, before, commands);
    }

    fn run(&self, buzzer: &Buzzer, before: BuzzerStatus, commands: Vec<BuzzerCommand>) {
        for command in commands {
            match command {
                BuzzerCommand::Loop => self.player.play_loop(),
                BuzzerCommand::Once => self.player.play_once(),
                BuzzerCommand::Stop => self.player.stop(),
            }
        }
        if buzzer.status() != before {
            let _ = self.notify.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (u64, Buzzer)> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scada_alarm::Judgement;

    fn unacked(occurrence: &str, recurrence: u32) -> ConditionState {
        let mut state = ConditionState::initial();
        state.active = true;
        state.acked = false;
        state.occurrence = Some(occurrence.into());
        state.recurrence = recurrence;
        state
    }

    fn acked(occurrence: &str) -> ConditionState {
        let mut state = unacked(occurrence, 0);
        state.acked = true;
        state
    }

    fn occurred(condition: &str, sound: Sound) -> Event {
        Event {
            at_wall_ms: 0,
            condition: Some(condition.into()),
            occurrence: Some("o".into()),
            recurrence: Some(0),
            kind: EventKind::Occurred {
                sound,
                judgement: Judgement {
                    limit: None,
                    deadband: None,
                    value: None,
                    source_timestamp_ms: None,
                },
            },
        }
    }

    fn change(rows: &[(&str, Option<ConditionState>)]) -> BTreeMap<String, Option<ConditionState>> {
        rows.iter()
            .map(|(id, state)| ((*id).to_owned(), state.clone()))
            .collect()
    }

    fn started() -> Buzzer {
        let mut buzzer = Buzzer::default();
        let none: [(&String, &ConditionState); 0] = [];
        assert!(buzzer.sync("s1", 0, none).is_empty());
        buzzer
    }

    #[test]
    fn buzzer_rings_for_unacked_and_stops_on_ack() {
        let mut buzzer = started();
        assert_eq!(buzzer.status(), BuzzerStatus::Quiet);
        let rows = change(&[("a", Some(unacked("o1", 0)))]);
        let events = [occurred("a", Sound::Continuous)];
        assert_eq!(
            buzzer.apply("s1", 1, &rows, &events),
            Ok(vec![BuzzerCommand::Loop])
        );
        assert_eq!(buzzer.status(), BuzzerStatus::Ringing);
        let rows = change(&[("a", Some(acked("o1")))]);
        assert_eq!(
            buzzer.apply("s1", 2, &rows, &[]),
            Ok(vec![BuzzerCommand::Stop])
        );
        assert_eq!(buzzer.status(), BuzzerStatus::Quiet);
    }

    #[test]
    fn buzzer_silence_holds_until_a_new_or_reoccurred_unacked() {
        let mut buzzer = started();
        let rows = change(&[("a", Some(unacked("o1", 0)))]);
        buzzer.apply("s1", 1, &rows, &[]).unwrap();
        assert_eq!(buzzer.silence(), vec![BuzzerCommand::Stop]);
        assert_eq!(buzzer.status(), BuzzerStatus::Silenced);
        // The same occurrence changing other fields does not resume the sound.
        let rows = change(&[("a", Some(unacked("o1", 0)))]);
        assert_eq!(buzzer.apply("s1", 2, &rows, &[]), Ok(vec![]));
        assert_eq!(buzzer.status(), BuzzerStatus::Silenced);
        // Another condition occurring resumes it.
        let rows = change(&[("b", Some(unacked("o2", 0)))]);
        assert_eq!(
            buzzer.apply("s1", 3, &rows, &[]),
            Ok(vec![BuzzerCommand::Loop])
        );
        buzzer.silence();
        // A reoccurrence of the same occurrence (recurrence + 1) resumes it.
        let rows = change(&[("a", Some(unacked("o1", 1)))]);
        assert_eq!(
            buzzer.apply("s1", 4, &rows, &[]),
            Ok(vec![BuzzerCommand::Loop])
        );
    }

    #[test]
    fn buzzer_silence_clears_when_nothing_is_unacked() {
        let mut buzzer = started();
        buzzer
            .apply("s1", 1, &change(&[("a", Some(unacked("o1", 0)))]), &[])
            .unwrap();
        buzzer.silence();
        buzzer
            .apply("s1", 2, &change(&[("a", Some(acked("o1")))]), &[])
            .unwrap();
        assert_eq!(buzzer.status(), BuzzerStatus::Quiet);
        // Silence while quiet does not carry over to the next occurrence.
        buzzer.silence();
        assert_eq!(
            buzzer.apply("s1", 3, &change(&[("a", Some(unacked("o3", 0)))]), &[]),
            Ok(vec![BuzzerCommand::Loop])
        );
    }

    #[test]
    fn buzzer_once_plays_only_when_not_looping() {
        let mut buzzer = started();
        let once = [occurred("n", Sound::Once)];
        let rows = change(&[("n", Some(acked("o1")))]);
        assert_eq!(
            buzzer.apply("s1", 1, &rows, &once),
            Ok(vec![BuzzerCommand::Once])
        );
        assert_eq!(buzzer.status(), BuzzerStatus::Quiet);
        buzzer
            .apply("s1", 2, &change(&[("a", Some(unacked("o2", 0)))]), &[])
            .unwrap();
        // A loop already sounding absorbs the one-shot.
        assert_eq!(buzzer.apply("s1", 3, &rows, &once), Ok(vec![]));
        // While silenced the one-shot still plays, and silence holds.
        buzzer.silence();
        assert_eq!(
            buzzer.apply("s1", 4, &rows, &once),
            Ok(vec![BuzzerCommand::Once])
        );
        assert_eq!(buzzer.status(), BuzzerStatus::Silenced);
        // Continuous and once in the same change: only the loop.
        let rows = change(&[("b", Some(unacked("o3", 0))), ("n", Some(acked("o4")))]);
        assert_eq!(
            buzzer.apply("s1", 5, &rows, &once),
            Ok(vec![BuzzerCommand::Loop])
        );
    }

    #[test]
    fn buzzer_needs_sync_on_gap_or_other_session_and_skips_duplicates() {
        let mut buzzer = started();
        let rows = change(&[("a", Some(unacked("o1", 0)))]);
        assert_eq!(buzzer.apply("s1", 0, &rows, &[]), Ok(vec![]));
        assert_eq!(buzzer.apply("s1", 2, &rows, &[]), Err(NeedsSync));
        assert_eq!(buzzer.apply("s2", 1, &rows, &[]), Err(NeedsSync));
        let state = unacked("o1", 0);
        let id = "a".to_owned();
        assert_eq!(
            buzzer.sync("s1", 5, [(&id, &state)]),
            vec![BuzzerCommand::Loop]
        );
        buzzer.silence();
        // A resync of the same session keeps the silence for known occurrences.
        assert!(buzzer.sync("s1", 6, [(&id, &state)]).is_empty());
        assert_eq!(buzzer.status(), BuzzerStatus::Silenced);
        // A new session starts unsilenced: restored unacked rows ring again.
        assert_eq!(
            buzzer.sync("s2", 0, [(&id, &state)]),
            vec![BuzzerCommand::Loop]
        );
    }

    #[test]
    fn buzzer_plays_a_queued_once_already_covered_by_the_snapshot() {
        // The Engine evaluated before the first snapshot was taken: the snapshot
        // already holds the change, which still waits in the subscription.
        let mut buzzer = Buzzer::default();
        let id = "n".to_owned();
        let state = acked("o1");
        assert!(buzzer.sync("s1", 1, [(&id, &state)]).is_empty());
        let once = [occurred("n", Sound::Once)];
        let rows = change(&[("n", Some(acked("o1")))]);
        assert_eq!(
            buzzer.apply("s1", 1, &rows, &once),
            Ok(vec![BuzzerCommand::Once])
        );
        // A covered change without a one-shot stays silent; a loop absorbs one.
        assert_eq!(buzzer.apply("s1", 1, &rows, &[]), Ok(vec![]));
        let loud = unacked("o2", 0);
        let a = "a".to_owned();
        assert_eq!(
            buzzer.sync("s1", 3, [(&a, &loud)]),
            vec![BuzzerCommand::Loop]
        );
        assert_eq!(buzzer.apply("s1", 2, &rows, &once), Ok(vec![]));
    }

    #[test]
    fn buzzer_engine_stop_quiets_and_forgets_silence() {
        let mut buzzer = started();
        buzzer
            .apply("s1", 1, &change(&[("a", Some(unacked("o1", 0)))]), &[])
            .unwrap();
        assert_eq!(buzzer.engine_stopped(), vec![BuzzerCommand::Stop]);
        assert_eq!(buzzer.status(), BuzzerStatus::Quiet);
        assert_eq!(
            buzzer.apply("s1", 2, &change(&[]), &[]),
            Err(NeedsSync),
            "a stopped buzzer has no session"
        );
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<&'static str>>);
    impl BuzzerPlayer for Recorder {
        fn play_loop(&self) {
            self.0.lock().unwrap().push("loop");
        }
        fn play_once(&self) {
            self.0.lock().unwrap().push("once");
        }
        fn stop(&self) {
            self.0.lock().unwrap().push("stop");
        }
    }

    #[test]
    fn buzzer_driver_drops_stale_pumps_and_notifies_status_changes() {
        let recorder = Arc::new(Recorder::default());
        let (notify, mut notified) = broadcast::channel(16);
        let driver = BuzzerDriver::new(recorder.clone(), notify);
        let token = driver.begin();
        driver.with(token, |buzzer| {
            let none: [(&String, &ConditionState); 0] = [];
            buzzer.sync("s1", 0, none)
        });
        driver.with(token, |buzzer| {
            buzzer
                .apply("s1", 1, &change(&[("a", Some(unacked("o1", 0)))]), &[])
                .unwrap()
        });
        assert_eq!(driver.status(), BuzzerStatus::Ringing);
        assert!(notified.try_recv().is_ok());
        assert_eq!(driver.silence(), BuzzerStatus::Silenced);
        assert!(notified.try_recv().is_ok());
        driver.halt();
        assert_eq!(driver.status(), BuzzerStatus::Quiet);
        assert!(notified.try_recv().is_ok());
        // The old pump's late change is ignored.
        driver.with(token, |buzzer| {
            let id = "a".to_owned();
            let state = unacked("o9", 0);
            buzzer.sync("s1", 9, [(&id, &state)])
        });
        assert_eq!(driver.status(), BuzzerStatus::Quiet);
        assert_eq!(*recorder.0.lock().unwrap(), vec!["loop", "stop"]);
    }
}
