//! Reuse the reader's lease and panic-safe snapshot cleanup for management reads.
use super::*;
use crate::store::{maintenance::sqlite_failure, StoreResult};
use serde::Serialize;

impl HistoryReader {
    pub(in crate::store) fn store_snapshot<T: Serialize>(
        &mut self,
        control: &QueryControl,
        action: impl FnOnce(&Connection, &mut Budget) -> StoreResult<T>,
    ) -> StoreResult<T> {
        control.validate()?;
        let mut budget = Budget::new(control);
        budget.work.check()?;
        if !self.healthy {
            self.connection.take();
            return Err(StoreError::Control(QueryError::ReaderUnusable));
        }
        let connection = self
            .connection
            .as_mut()
            .ok_or(StoreError::Control(QueryError::ReaderUnusable))?;
        let result = {
            let snapshot = Snapshot {
                connection,
                healthy: &mut self.healthy,
            };
            let result = (|| {
                let progress = Arc::clone(&budget.work);
                snapshot
                    .connection
                    .progress_handler(1000, Some(move || progress.progress()))?;
                budget.work.statement()?;
                snapshot.connection.execute_batch("BEGIN DEFERRED")?;
                let result = action(snapshot.connection, &mut budget)?;
                budget.result(&serde_json::to_value(&result)?)?;
                Ok(result)
            })();
            match result {
                Err(StoreError::Sqlite(error)) => Err(sqlite_failure(error, &budget)),
                other => other,
            }
        };
        if !self.healthy {
            self.connection.take();
            return Err(StoreError::Control(QueryError::ReaderUnusable));
        }
        // Preserve real database failures; only successful reads can become cancelled.
        result.and_then(|value| {
            budget.work.check()?;
            Ok(value)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        recording_plan::tests::{apply, control, enabled_store, register},
        test_support::{spec, tick},
    };
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};

    #[test]
    fn management_uses_a_read_only_connection_and_only_read_statements() {
        let (_dir, store) = enabled_store();
        let mut reader = store.reader().unwrap();
        assert!(reader
            .connection
            .as_ref()
            .unwrap()
            .is_readonly("main")
            .unwrap());
        reader
            .connection
            .as_mut()
            .unwrap()
            .authorizer(Some(|c: AuthContext<'_>| match c.action {
                AuthAction::Select
                | AuthAction::Read { .. }
                | AuthAction::Function { .. }
                | AuthAction::Transaction {
                    operation: TransactionOperation::Begin | TransactionOperation::Rollback,
                } => Authorization::Allow,
                _ => Authorization::Deny,
            }))
            .unwrap();
        reader
            .preflight_recording_mapping(&register("next", Some(1)), &control())
            .unwrap();
        reader
            .preflight_recording_plan(&apply("next", None, true), &control())
            .unwrap();
        assert!(reader.connection.as_ref().unwrap().is_autocommit());
    }
    #[test]
    fn real_sql_failure_is_preserved_even_when_cancellation_arrives() {
        let (_dir, store) = enabled_store();
        let mut reader = store.reader().unwrap();
        let c = control();
        let result: StoreResult<()> = reader.store_snapshot(&c, |db, _| {
            c.cancellation.cancel();
            db.execute_batch("SELECT * FROM deliberately_missing_table")?;
            Ok(())
        });
        assert!(matches!(result, Err(StoreError::Sqlite(_))));
        assert!(reader.connection.as_ref().unwrap().is_autocommit());
        reader
            .preflight_recording_plan(&apply("next", None, true), &control())
            .unwrap();
        let mut limited = control();
        limited.limits.max_vm_steps = 4_000;
        let interrupted: StoreResult<i64> = reader.store_snapshot(&limited, |db, b| {
            b.work.statement()?;
            Ok(db.query_row("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000) SELECT sum(x) FROM n", [], |r| r.get(0))?)
        });
        assert!(matches!(
            interrupted,
            Err(StoreError::Control(QueryError::WorkLimit))
        ));
        reader
            .preflight_recording_mapping(&register("next", Some(1)), &control())
            .unwrap();
    }
    #[test]
    fn cleanup_failure_disables_both_management_and_history_but_not_writer() {
        for panic in [false, true] {
            let (_dir, mut store) = enabled_store();
            let mut reader = store.reader().unwrap();
            reader
                .connection
                .as_mut()
                .unwrap()
                .authorizer(Some(|c: AuthContext<'_>| {
                    if matches!(
                        c.action,
                        AuthAction::Transaction {
                            operation: TransactionOperation::Rollback
                        }
                    ) {
                        Authorization::Deny
                    } else {
                        Authorization::Allow
                    }
                }))
                .unwrap();
            if panic {
                assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _: StoreResult<()> =
                        reader.store_snapshot(&control(), |_, _| panic!("read boundary"));
                }))
                .is_err());
                // Removing the injected fault cannot erase the persistent poison.
                reader
                    .connection
                    .as_mut()
                    .unwrap()
                    .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
                    .unwrap();
            } else {
                assert!(matches!(
                    reader.preflight_recording_plan(&apply("next", None, true), &control()),
                    Err(StoreError::Control(QueryError::ReaderUnusable))
                ));
            }
            assert!(matches!(
                reader.preflight_recording_mapping(&register("next", Some(1)), &control()),
                Err(StoreError::Control(QueryError::ReaderUnusable))
            ));
            let q = json!({"version":1,"kind":"query","requestId":"query","seriesIds":["number"],"fromMs":0,"toMs":2000,"mode":"raw","maxPointsPerSeries":10});
            assert_eq!(
                reader.query_raw(&q, &control()),
                Err(QueryError::ReaderUnusable)
            );
            assert!(reader.connection.is_none());
            assert!(!store.needs_reopen);
            store.begin_session(spec("writer:alive")).unwrap();
            store.append_tick(tick("writer:alive", 1, 1000)).unwrap();
        }
    }
}
