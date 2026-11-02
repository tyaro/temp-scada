//! Bounded compact-JSON traversal and Unicode text semantics for pure contracts.
use serde_json::Value;
#[derive(Debug)]
pub(crate) struct JsonContractError;
pub(crate) struct JsonBudget {
    pub(crate) bytes: usize,
    max_bytes: usize,
    max_nodes: usize,
    nodes: usize,
}
impl JsonBudget {
    pub(crate) fn new(max_bytes: usize, max_nodes: usize) -> Self {
        Self {
            bytes: 0,
            nodes: 0,
            max_bytes,
            max_nodes,
        }
    }
    fn add(&mut self, count: usize) -> Result<(), JsonContractError> {
        self.bytes = self.bytes.checked_add(count).ok_or(JsonContractError)?;
        if self.bytes > self.max_bytes {
            return Err(JsonContractError);
        }
        Ok(())
    }
    // Compact JSON UTF-8 bytes, with the same escaping as JSON.stringify.
    fn string(&mut self, text: &str) -> Result<(), JsonContractError> {
        self.add(text.len())?;
        self.add(2)?;
        for c in text.chars() {
            self.add(match c {
                '"' | '\\' | '\u{0008}' | '\u{0009}' | '\u{000a}' | '\u{000c}' | '\u{000d}' => 1,
                '\u{0000}'..='\u{001f}' => 5,
                _ => 0,
            })?;
        }
        Ok(())
    }
    pub(crate) fn visit(&mut self, value: &Value, depth: usize) -> Result<(), JsonContractError> {
        self.nodes += 1;
        if self.nodes > self.max_nodes || depth > 32 {
            return Err(JsonContractError);
        }
        match value {
            Value::Null => self.add(4),
            Value::Bool(b) => self.add(if *b { 4 } else { 5 }),
            Value::String(s) => self.string(s),
            Value::Number(n) => {
                let f = n.as_f64().ok_or(JsonContractError)?;
                // All accepted number fields are small nonnegative integers.
                // Normalize 1.0/1e0/-0 for size, without rewriting caller data.
                let length =
                    if f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
                        (f as i64).to_string().len()
                    } else {
                        n.to_string().len()
                    };
                self.add(length)
            }
            Value::Array(rows) => {
                self.add(2 + rows.len().saturating_sub(1))?;
                for row in rows {
                    self.visit(row, depth + 1)?;
                }
                Ok(())
            }
            Value::Object(rows) => {
                self.add(2 + rows.len().saturating_sub(1))?;
                for (key, row) in rows {
                    self.string(key)?;
                    self.add(1)?;
                    self.visit(row, depth + 1)?;
                }
                Ok(())
            }
        }
    }
}
pub(crate) fn blank(text: &str) -> bool {
    text.chars().all(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{0085}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
