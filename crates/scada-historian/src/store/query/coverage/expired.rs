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
    let mut statement = connection.prepare(include_str!("expired.sql"))?;
    let mut rows = statement.query(params![series, from, to, fence, revision])?;
    let mut expired = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        let start: i64 = required(row, "from_ms")?;
        let end: i64 = required(row, "to_ms")?;
        let corrupt: i64 = required(row, "corrupt")?;
        if corrupt != 0 || start < from || end > to || start >= end {
            return Err(QueryError::CorruptData);
        }
        if expired.len() == COVERAGE_LIMIT {
            return Err(QueryError::CoverageLimit);
        }
        expired.push(Span {
            from: start,
            to: end,
            reason: Reason::Expired,
        });
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
