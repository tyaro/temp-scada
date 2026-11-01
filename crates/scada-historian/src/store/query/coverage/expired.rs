//! Expiry is proof of actual observation removal, independent of clock domains.
use super::*;

pub(super) fn overlay(
    connection: &Connection,
    series: &str,
    query: &Value,
    base: Vec<Span>,
    budget: &mut Budget,
) -> Result<Vec<Span>, QueryError> {
    let from = crate::integer(&query["fromMs"]);
    let to = crate::integer(&query["toMs"]);
    for _ in 0..3 {
        budget.work.statement()?;
        budget.row()?;
    }
    let (fence, revision) = crate::store::retention::fence(connection).map_err(|e| match e {
        crate::store::StoreError::Sqlite(error) => QueryError::from(error),
        _ => QueryError::CorruptData,
    })?;
    budget.work.statement()?;
    let mut statement = connection.prepare(
        "SELECT e.sample_time_ms, e.deleted_records, e.operation_id, o.cutoff_ms, o.commit_version,
         o.deleted_observations, o.deleted_ticks
         FROM expired_samples AS e
         LEFT JOIN retention_operations AS o ON o.request_id = e.operation_id
         WHERE e.series_id = ?1 AND e.sample_time_ms >= ?2 AND e.sample_time_ms < ?3
         ORDER BY e.sample_time_ms LIMIT 1025",
    )?;
    let mut rows = statement.query(params![series, from, to])?;
    let mut expired = Vec::new();
    let mut count = 0;
    while let Some(row) = rows.next()? {
        budget.row()?;
        count += 1;
        if count > GAP_LIMIT {
            return Err(QueryError::EvidenceLimit);
        }
        let time: i64 = required(row, "sample_time_ms")?;
        let records: i64 = required(row, "deleted_records")?;
        let operation: String = required(row, "operation_id")?;
        // Column positions distinguish the operation's cutoff from current state.
        let cutoff: i64 = row.get(3).map_err(|_| QueryError::CorruptData)?;
        let commit: i64 = row.get(4).map_err(|_| QueryError::CorruptData)?;
        let removed: i64 = row.get(5).map_err(|_| QueryError::CorruptData)?;
        let ticks: i64 = row.get(6).map_err(|_| QueryError::CorruptData)?;
        let fence = fence.ok_or(QueryError::CorruptData)?;
        if !id(&operation)
            || time < -(MAX_SAFE as i64)
            || time >= cutoff
            || cutoff > MAX_SAFE as i64
            || cutoff > fence
            || fence > MAX_SAFE as i64
            || records <= 0
            || records > removed
            || ticks <= 0
            || ticks > 1024
            || removed < ticks
            || removed > ticks * 8
            || commit <= 0
            || commit > revision
        {
            return Err(QueryError::CorruptData);
        }
        append(
            &mut expired,
            Span {
                from: time,
                to: time + 1,
                reason: Reason::Expired,
            },
        )?;
    }
    let mut result = Vec::new();
    for span in base {
        budget.work.check()?;
        let mut cursor = span.from;
        for expiry in &expired {
            budget.work.check()?;
            if expiry.to <= cursor {
                continue;
            }
            if expiry.from >= span.to {
                break;
            }
            if cursor < expiry.from {
                append(
                    &mut result,
                    Span {
                        from: cursor,
                        to: expiry.from,
                        reason: span.reason,
                    },
                )?;
            }
            let end = expiry.to.min(span.to);
            append(
                &mut result,
                Span {
                    from: cursor.max(expiry.from),
                    to: end,
                    reason: Reason::Expired,
                },
            )?;
            cursor = end;
        }
        if cursor < span.to {
            append(
                &mut result,
                Span {
                    from: cursor,
                    to: span.to,
                    reason: span.reason,
                },
            )?;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
