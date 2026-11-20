//! The operation history window's rows (operation stage-3 design §9 照会;
//! O4b): the record of the applied Project, newest first, narrowed by the
//! period, the equipment and the outcome, read a page at a time. Read-only:
//! nothing is recorded, and neither the transition lock nor the send slot is
//! taken.
//!
//! A `pending` row is resolved as for the faceplate's last request
//! ([`LatestRow`]): `sending` for the row this process sends now,
//! `unrecorded` otherwise. The webview never reads `pending` by itself.
use serde::{Deserialize, Serialize};

use super::view::LatestRow;
use super::{reason, MAX_ID_CHARS};
use crate::operation_db::{HistoryFilter, OperationLog, Outcome, PENDING};

/// The most rows one read answers (and the default).
pub const HISTORY_PAGE: usize = 500;

/// The `operation_history` request. Every condition is optional; the
/// Project is the host's applied one, never the webview's.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationHistoryRequest {
    /// The period on the request time, both ends included (ms since epoch).
    #[serde(default)]
    pub from_ms: Option<i64>,
    #[serde(default)]
    pub to_ms: Option<i64>,
    #[serde(default)]
    pub equipment_id: Option<String>,
    /// The outcomes to list; `None` is every one, an empty set is none.
    #[serde(default)]
    pub outcomes: Option<Vec<HistoryOutcome>>,
    /// The cursor: only rows older than this `seq` (the previous page's
    /// `nextBeforeSeq`).
    #[serde(default)]
    pub before_seq: Option<i64>,
    /// 1 to [`HISTORY_PAGE`]; the default is [`HISTORY_PAGE`].
    #[serde(default)]
    pub limit: Option<usize>,
}

/// An outcome to list: the §5 words, and `pending` for a row whose outcome
/// is not in the record (sending now, or not recorded).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryOutcome {
    Ok,
    Refused,
    NotSent,
    Stopped,
    Failed,
    Uncertain,
    Pending,
}

impl HistoryOutcome {
    const fn word(self) -> &'static str {
        match self {
            Self::Ok => Outcome::Ok.as_str(),
            Self::Refused => Outcome::Refused.as_str(),
            Self::NotSent => Outcome::NotSent.as_str(),
            Self::Stopped => Outcome::Stopped.as_str(),
            Self::Failed => Outcome::Failed.as_str(),
            Self::Uncertain => Outcome::Uncertain.as_str(),
            Self::Pending => PENDING,
        }
    }
}

/// The answer of `operation_history`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistory {
    /// The applied Project; `None` (and no rows) when there is none.
    pub project_id: Option<String>,
    pub rows: Vec<HistoryRow>,
    /// The cursor of the next page; `None` when there are no older rows.
    pub next_before_seq: Option<i64>,
}

/// One request of the record. The finish fields and `value` are those of
/// the faceplate's [`LatestRow`]; `input` is the typed text of an input.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub seq: i64,
    #[serde(flatten)]
    pub row: LatestRow,
    pub user: String,
    pub equipment_id: String,
    pub equipment_code: Option<String>,
    pub slot: String,
    pub input: Option<String>,
    /// The identical refusals folded into this row (§7); 1 otherwise.
    pub repeat_count: i64,
}

/// Read a page of the history of the applied Project (`project_id`). `Err`
/// (a §4 code) is a malformed request (`invalid_request`), or a record that
/// is not open or could not be read (`record_failed`).
pub async fn operation_history(
    log: Option<&OperationLog>,
    project_id: Option<&str>,
    request: &OperationHistoryRequest,
) -> Result<OperationHistory, &'static str> {
    let limit = request.limit.unwrap_or(HISTORY_PAGE);
    if !(1..=HISTORY_PAGE).contains(&limit) {
        return Err(reason::INVALID_REQUEST);
    }
    if let Some(id) = &request.equipment_id {
        let chars = id.chars().count();
        if chars == 0 || chars > MAX_ID_CHARS {
            return Err(reason::INVALID_REQUEST);
        }
    }
    let log = log.ok_or(reason::RECORD_FAILED)?;
    let Some(project_id) = project_id else {
        return Ok(OperationHistory {
            project_id: None,
            rows: Vec::new(),
            next_before_seq: None,
        });
    };
    let filter = HistoryFilter {
        from_ms: request.from_ms,
        to_ms: request.to_ms,
        equipment_id: request.equipment_id.clone(),
        outcomes: request
            .outcomes
            .as_ref()
            .map(|outcomes| outcomes.iter().map(|outcome| outcome.word()).collect()),
        before_seq: request.before_seq,
    };
    // One more than the page tells whether older rows remain.
    let mut found = log
        .history(project_id, &filter, limit + 1)
        .await
        .map_err(|error| {
            eprintln!("operation history: the record could not be read: {error:?}");
            reason::RECORD_FAILED
        })?;
    let more = found.len() > limit;
    found.truncate(limit);
    let rows: Vec<HistoryRow> = found
        .into_iter()
        .map(|(row, state)| {
            let input = row
                .request
                .value
                .get("input")
                .and_then(|input| input.as_str())
                .map(str::to_owned);
            HistoryRow {
                seq: row.seq,
                user: row.request.user.clone(),
                equipment_id: row.request.equipment_id.clone(),
                equipment_code: row.request.equipment_code.clone(),
                slot: row.request.slot.clone(),
                input,
                repeat_count: row.repeat_count,
                row: LatestRow::new(row, state),
            }
        })
        .collect();
    let next_before_seq = more.then(|| rows.last().map(|row| row.seq)).flatten();
    Ok(OperationHistory {
        project_id: Some(project_id.to_owned()),
        rows,
        next_before_seq,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::operation_db::{KeyRef, OperationDb, RequestRecord};

    const PROJECT: &str = "4f6c1b0e-6d0e-4b8a-9f00-000000000001";

    fn request(slot: &str, at: i64) -> RequestRecord {
        RequestRecord {
            requested_at_ms: at,
            user: "未ログイン".into(),
            phase: "setup".into(),
            hub_endpoint: Some("http://127.0.0.1:8722".into()),
            project_id: PROJECT.into(),
            project_digest: "a".repeat(64),
            screen_id: "main".into(),
            object_id: "pump1".into(),
            equipment_id: "eq-1".into(),
            equipment_code: Some("P-101".into()),
            slot: slot.into(),
            tag: Some("Line1.P101.Command".into()),
            value: json!({"button": 0, "value": true}),
        }
    }

    async fn log() -> OperationLog {
        let dir = std::env::temp_dir().join(format!("operation-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (db, _) = OperationDb::open(&dir.join("operations.db"), 0)
            .await
            .unwrap();
        let log = OperationLog::new(db);
        let key = KeyRef {
            endpoint: "http://127.0.0.1:8722".into(),
            id: "k0".into(),
        };
        log.key_registered(0, &key).await.unwrap();
        log
    }

    #[tokio::test]
    async fn operation_history_answers_rows_with_their_state_count_and_cursor() {
        let log = log().await;
        let refused = request("command", 1_000);
        log.refuse(&refused, "phase_unavailable", 1_000)
            .await
            .unwrap();
        log.refuse(&refused, "phase_unavailable", 1_010)
            .await
            .unwrap();
        let mut input = request("speedSp", 2_000);
        input.value = json!({"input": "12.5", "value": 12.5});
        log.refuse(&input, "out_of_range", 2_000).await.unwrap();
        let sending = log
            .begin(&request("command", 3_000), Duration::ZERO, "k0")
            .await
            .unwrap();

        let all = OperationHistoryRequest::default();
        let history = operation_history(Some(&log), Some(PROJECT), &all)
            .await
            .unwrap();
        assert_eq!(history.project_id.as_deref(), Some(PROJECT));
        assert_eq!(history.next_before_seq, None);
        let [first, second, third] = &history.rows[..] else {
            panic!("{history:?}");
        };
        assert_eq!(first.row.id, sending);
        assert_eq!(first.row.state, super::super::LatestState::Sending);
        assert_eq!(first.row.outcome, None);
        assert_eq!(second.input.as_deref(), Some("12.5"));
        assert_eq!(second.row.value, Some(json!(12.5)));
        assert_eq!(second.slot, "speedSp");
        assert_eq!(third.repeat_count, 2);
        assert_eq!(third.row.outcome, Some(Outcome::Refused));
        assert_eq!(third.row.reason.as_deref(), Some("phase_unavailable"));
        assert_eq!(third.user, "未ログイン");
        assert_eq!(third.equipment_code.as_deref(), Some("P-101"));

        // The webview's words: `pending` is the row being sent.
        let pending = OperationHistoryRequest {
            outcomes: Some(vec![HistoryOutcome::Pending]),
            ..OperationHistoryRequest::default()
        };
        let rows = operation_history(Some(&log), Some(PROJECT), &pending)
            .await
            .unwrap()
            .rows;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].row.id, sending);

        // A page of 2 says where the next one starts; the last page does not.
        let page = OperationHistoryRequest {
            limit: Some(2),
            ..OperationHistoryRequest::default()
        };
        let history = operation_history(Some(&log), Some(PROJECT), &page)
            .await
            .unwrap();
        assert_eq!(history.rows.len(), 2);
        assert_eq!(history.next_before_seq, Some(history.rows[1].seq));
        let next = OperationHistoryRequest {
            before_seq: history.next_before_seq,
            ..page
        };
        let history = operation_history(Some(&log), Some(PROJECT), &next)
            .await
            .unwrap();
        assert_eq!(history.rows.len(), 1);
        assert_eq!(history.next_before_seq, None);

        let serialized = serde_json::to_value(&history.rows[0]).unwrap();
        assert_eq!(serialized["repeatCount"], 2, "{serialized}");
        assert_eq!(serialized["state"], "finished");
        assert_eq!(serialized["requestedAtMs"], 1_000);
        assert_eq!(serialized["equipmentId"], "eq-1");
        log.close().await;
    }

    #[tokio::test]
    async fn operation_history_refuses_a_malformed_request_and_a_closed_record() {
        let log = log().await;
        for request in [
            OperationHistoryRequest {
                limit: Some(0),
                ..OperationHistoryRequest::default()
            },
            OperationHistoryRequest {
                limit: Some(HISTORY_PAGE + 1),
                ..OperationHistoryRequest::default()
            },
            OperationHistoryRequest {
                equipment_id: Some(String::new()),
                ..OperationHistoryRequest::default()
            },
            OperationHistoryRequest {
                equipment_id: Some("e".repeat(MAX_ID_CHARS + 1)),
                ..OperationHistoryRequest::default()
            },
        ] {
            assert_eq!(
                operation_history(Some(&log), Some(PROJECT), &request).await,
                Err(reason::INVALID_REQUEST),
                "{request:?}"
            );
        }
        let all = OperationHistoryRequest::default();
        assert_eq!(
            operation_history(None, Some(PROJECT), &all).await,
            Err(reason::RECORD_FAILED)
        );
        // No applied Project: nothing to list.
        let history = operation_history(Some(&log), None, &all).await.unwrap();
        assert_eq!(history.project_id, None);
        assert!(history.rows.is_empty());
        assert!(serde_json::from_value::<OperationHistoryRequest>(
            json!({"outcomes": ["sending"]})
        )
        .is_err());
        assert!(
            serde_json::from_value::<OperationHistoryRequest>(json!({"projectId": PROJECT}))
                .is_err()
        );
        log.close().await;
    }
}
