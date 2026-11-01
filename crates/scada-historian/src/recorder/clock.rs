use super::*;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Process-local monotonic origin and separately sampled actual UTC wall clock.
pub struct SystemRecorderClock {
    origin: Instant,
    clock_epoch: String,
}
impl SystemRecorderClock {
    pub fn new(clock_epoch: String) -> Result<Self, ClockError> {
        if !store::id(&clock_epoch) {
            return Err(ClockError::InvalidReading);
        }
        Ok(Self {
            origin: Instant::now(),
            clock_epoch,
        })
    }
    fn monotonic_ms(&self) -> Result<u64, ClockError> {
        u64::try_from(self.origin.elapsed().as_millis()).map_err(|_| ClockError::DeadlineOutOfRange)
    }
}
impl RecorderClock for SystemRecorderClock {
    fn read(&mut self) -> Result<ClockReading, ClockError> {
        let monotonic_ms = self.monotonic_ms()?;
        let wall = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => i128::try_from(d.as_millis()).map_err(|_| ClockError::InvalidReading)?,
            Err(e) => {
                -i128::try_from(e.duration().as_millis()).map_err(|_| ClockError::InvalidReading)?
            }
        };
        let now = ClockReading {
            monotonic_ms,
            wall_time_ms: i64::try_from(wall).map_err(|_| ClockError::InvalidReading)?,
            clock_epoch: self.clock_epoch.clone(),
        };
        valid_reading(&now)?;
        Ok(now)
    }
    fn wait_until(&mut self, deadline: u64, cancel: &CancellationToken) -> Result<(), ClockError> {
        self.origin
            .checked_add(Duration::from_millis(deadline))
            .ok_or(ClockError::DeadlineOutOfRange)?;
        loop {
            if cancel.is_cancelled() {
                return Err(ClockError::Cancelled);
            }
            let now = self.monotonic_ms()?;
            if now >= deadline {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis((deadline - now).min(10)));
        }
    }
}
