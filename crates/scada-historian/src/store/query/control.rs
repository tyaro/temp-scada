use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use super::QueryError;

/// Flagging cancellation does not report that a running query has finished.
#[derive(Clone, Default, Debug)]
pub struct CancellationToken(Arc<AtomicBool>);
impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Initial library safety caps, not measured deployment capacity guarantees.
#[derive(Clone, Copy, Debug)]
pub struct QueryLimits {
    pub max_decoded_rows: u32,
    pub max_output_bytes: usize,
    /// SQLite progress callbacks are sampled every 1000 VM instructions.
    pub max_vm_steps: u64,
}
impl Default for QueryLimits {
    fn default() -> Self {
        Self {
            max_decoded_rows: 9000,
            max_output_bytes: 8 * 1024 * 1024,
            max_vm_steps: 5_000_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct QueryControl {
    pub cancellation: CancellationToken,
    pub deadline: Instant,
    pub limits: QueryLimits,
}
impl QueryControl {
    pub fn with_timeout(timeout: Duration) -> Result<Self, QueryError> {
        if timeout > Duration::from_secs(10) {
            return Err(QueryError::InvalidLimits);
        }
        Ok(Self {
            cancellation: CancellationToken::default(),
            deadline: Instant::now() + timeout,
            limits: QueryLimits::default(),
        })
    }

    pub(super) fn validate(&self) -> Result<(), QueryError> {
        let caps = QueryLimits::default();
        if self.deadline.saturating_duration_since(Instant::now()) > Duration::from_secs(10)
            || self.limits.max_decoded_rows == 0
            || self.limits.max_decoded_rows > caps.max_decoded_rows
            || self.limits.max_output_bytes == 0
            || self.limits.max_output_bytes > caps.max_output_bytes
            || self.limits.max_vm_steps == 0
            || self.limits.max_vm_steps > caps.max_vm_steps
        {
            return Err(QueryError::InvalidLimits);
        }
        Ok(())
    }
}

pub(super) struct Work {
    control: QueryControl,
    vm_steps: AtomicU64,
}
impl Work {
    pub fn new(control: &QueryControl) -> Self {
        Self {
            control: control.clone(),
            vm_steps: AtomicU64::new(0),
        }
    }
    pub fn check(&self) -> Result<(), QueryError> {
        if self.control.cancellation.is_cancelled() {
            return Err(QueryError::Cancelled);
        }
        if Instant::now() >= self.control.deadline {
            return Err(QueryError::Deadline);
        }
        if self.vm_steps.load(Ordering::Relaxed) >= self.control.limits.max_vm_steps {
            return Err(QueryError::WorkLimit);
        }
        Ok(())
    }
    pub fn progress(&self) -> bool {
        self.vm_steps.fetch_add(1000, Ordering::Relaxed);
        self.check().is_err()
    }

    pub fn statement(&self) -> Result<(), QueryError> {
        // Pay for up to 999 instructions invisible between callbacks in each
        // short statement. Conservative accounting can stop before the cap.
        self.vm_steps.fetch_add(1000, Ordering::Relaxed);
        self.check()
    }
}

pub(super) struct Budget {
    pub work: Arc<Work>,
    limits: QueryLimits,
    rows: u32,
    bytes: usize,
    input_bytes: usize,
}
impl Budget {
    pub fn new(control: &QueryControl) -> Self {
        Self {
            work: Arc::new(Work::new(control)),
            limits: control.limits,
            rows: 0,
            bytes: 0,
            input_bytes: 0,
        }
    }
    pub fn row(&mut self) -> Result<(), QueryError> {
        self.work.check()?;
        self.rows += 1;
        if self.rows > self.limits.max_decoded_rows {
            return Err(QueryError::WorkLimit);
        }
        Ok(())
    }
    pub fn value(&mut self, value: &serde_json::Value) -> Result<(), QueryError> {
        self.bytes += serialized_size(value, self.limits.max_output_bytes - self.bytes)?;
        self.work.check()
    }
    pub fn evidence_text(&mut self, text: &str) -> Result<(), QueryError> {
        if text.len() > 64 * 1024 {
            return Err(QueryError::EvidenceLimit);
        }
        self.input_bytes += text.len();
        // Input parsing has its own hard cap, independent of caller output caps.
        if self.input_bytes > 8 * 1024 * 1024 {
            return Err(QueryError::ByteLimit);
        }
        self.work.check()
    }
    pub fn result(&self, value: &serde_json::Value) -> Result<(), QueryError> {
        serialized_size(value, self.limits.max_output_bytes)?;
        self.work.check()
    }
}

pub(super) fn serialized_size(
    value: &serde_json::Value,
    limit: usize,
) -> Result<usize, QueryError> {
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if data.len() > self.limit - self.bytes {
                return Err(std::io::Error::other("query byte limit"));
            }
            self.bytes += data.len();
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut writer, value).map_err(|_| QueryError::ByteLimit)?;
    Ok(writer.bytes)
}
