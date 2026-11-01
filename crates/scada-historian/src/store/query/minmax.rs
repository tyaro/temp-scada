use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde_json::{json, Value};

use super::{control::Budget, QueryError};

/// All arithmetic stays integral: query width <= 1h and count <= 2000.
struct Grid {
    from: i64,
    width: i64,
    count: i64,
}
impl Grid {
    fn new(query: &Value) -> Self {
        let from = crate::integer(&query["fromMs"]);
        let width = crate::integer(&query["toMs"]) - from;
        Self {
            from,
            width,
            count: width.min(crate::integer(&query["maxPointsPerSeries"])),
        }
    }
    fn edge(&self, index: i64) -> i64 {
        self.from + index * self.width / self.count
    }
}

struct Aggregate {
    index: i64,
    valid: i64,
    invalid: i64,
    min: Option<f64>,
    max: Option<f64>,
    segment: String,
    mixed: bool,
}

pub(super) fn bins(
    connection: &Connection,
    series: &str,
    query: &Value,
    segments: &[Value],
    budget: &mut Budget,
) -> Result<Vec<Value>, QueryError> {
    let grid = Grid::new(query);
    let mut parameters = vec![
        SqlValue::Text(series.to_owned()),
        SqlValue::Integer(grid.from),
        SqlValue::Integer(grid.from + grid.width),
        SqlValue::Integer(grid.count),
    ];
    let mut declarations = Vec::new();
    for (index, descriptor) in segments.iter().enumerate() {
        let first = 5 + index * 4;
        declarations.push(format!(
            "(?{first}, ?{}, ?{}, ?{})",
            first + 1,
            first + 2,
            first + 3
        ));
        for field in ["segmentId", "valueType", "source", "hubInstanceId"] {
            parameters.push(SqlValue::Text(crate::text(&descriptor[field]).to_owned()));
        }
    }
    let sql = include_str!("minmax.sql").replace("{descriptors}", &declarations.join(", "));
    budget.work.statement()?;
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(parameters))?;
    let mut aggregated = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        // Reject corruption BEFORE deriving counts/states, including mixed bins.
        if row.get::<_, i64>(13)? != 0 {
            return Err(QueryError::CorruptData);
        }
        let total: i64 = row.get(1)?;
        let valid: i64 = row.get(2)?;
        if total <= 0 || total > super::super::types::MAX_SAFE as i64 || valid < 0 || valid > total
        {
            return Err(QueryError::CorruptData);
        }
        let index: i64 = row.get(0)?;
        if index < 0
            || index >= grid.count
            || aggregated
                .last()
                .is_some_and(|old: &Aggregate| old.index >= index)
        {
            return Err(QueryError::CorruptData);
        }
        let segment: String = row.get(5)?;
        let min: Option<f64> = row.get(3)?;
        let max: Option<f64> = row.get(4)?;
        if valid > 0
            && !matches!((min, max), (Some(a), Some(b)) if a.is_finite() && b.is_finite() && a <= b)
        {
            return Err(QueryError::CorruptData);
        }
        let mixed = segment != row.get::<_, String>(6)?
            || row.get::<_, String>(7)? != row.get::<_, String>(8)?
            || row.get::<_, String>(9)? != row.get::<_, String>(10)?
            || row.get::<_, Option<i64>>(11)? != row.get::<_, Option<i64>>(12)?;
        aggregated.push(Aggregate {
            index,
            valid,
            invalid: total - valid,
            min,
            max,
            segment,
            mixed,
        });
    }
    let mut aggregated = aggregated.into_iter().peekable();
    let mut bins = Vec::new();
    for index in 0..grid.count {
        budget.work.check()?;
        let (valid, invalid, min, max, segment, source, state) =
            if aggregated.peek().is_some_and(|a| a.index == index) {
                let row = aggregated.next().expect("peeked aggregate");
                if row.mixed {
                    (
                        row.valid,
                        row.invalid,
                        Value::Null,
                        Value::Null,
                        Value::Null,
                        Value::Null,
                        "mixedSegment",
                    )
                } else {
                    let descriptor = segments
                        .iter()
                        .find(|d| d["segmentId"] == row.segment)
                        .ok_or(QueryError::CorruptData)?;
                    if row.valid == 0 {
                        (
                            0,
                            row.invalid,
                            Value::Null,
                            Value::Null,
                            json!(row.segment),
                            descriptor["source"].clone(),
                            "gap",
                        )
                    } else {
                        (
                            row.valid,
                            row.invalid,
                            json!(row.min),
                            json!(row.max),
                            json!(row.segment),
                            descriptor["source"].clone(),
                            "partial",
                        )
                    }
                }
            } else {
                if segments.len() != 1 {
                    return Err(QueryError::MetadataAmbiguous);
                }
                (
                    0,
                    0,
                    Value::Null,
                    Value::Null,
                    segments[0]["segmentId"].clone(),
                    segments[0]["source"].clone(),
                    "gap",
                )
            };
        let bin = json!({"fromMs": grid.edge(index), "toMs": grid.edge(index + 1), "min": min, "max": max,
            "validCount": valid, "invalidCount": invalid, "segmentId": segment, "source": source, "state": state});
        budget.value(&bin)?;
        bins.push(bin);
    }
    Ok(bins)
}

#[cfg(test)]
mod tests;
