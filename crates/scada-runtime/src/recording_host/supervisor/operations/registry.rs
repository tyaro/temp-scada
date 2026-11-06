use super::*;
use std::collections::HashSet;
pub const MAX_OWNER_IDS: usize = 4096;
#[derive(Default)]
pub(super) struct Registry {
    pub(super) used: HashSet<(bool, String)>,
    reserved: usize,
    counter: u64,
}
impl Registry {
    pub(super) fn is_pristine(&self) -> bool {
        self.used.is_empty() && self.reserved == 0 && self.counter == 0
    }
    pub fn prepare(&self, change: &str) -> Result<(String, u64), OperationErrorCode> {
        if self.used.contains(&(false, change.into())) {
            return Err(OperationErrorCode::Consumed);
        }
        if self.used.len() + self.reserved > MAX_OWNER_IDS - 4 {
            return Err(OperationErrorCode::BudgetExceeded);
        }
        let mut candidate = None;
        let mut counter = self.counter;
        for _ in 0..=MAX_OWNER_IDS {
            counter = counter
                .checked_add(1)
                .filter(|v| *v <= projection::MAX_SAFE)
                .ok_or(OperationErrorCode::BudgetExceeded)?;
            let id = format!("native-op:{}", counter);
            if !self.used.contains(&(true, id.clone())) {
                candidate = Some(id);
                break;
            }
        }
        let id = candidate.ok_or(OperationErrorCode::BudgetExceeded)?;
        Ok((id, counter))
    }
    pub fn begin(&mut self, change: &str, id: &str, counter: u64) {
        self.counter = counter;
        self.used.insert((false, change.into()));
        self.used.insert((true, id.into()));
        self.reserved += 2;
    }
    pub fn check_stage(&self, id: &str) -> Result<(), OperationErrorCode> {
        if self.used.contains(&(true, id.into())) {
            Err(OperationErrorCode::Consumed)
        } else if self.reserved == 0 {
            Err(OperationErrorCode::BudgetExceeded)
        } else {
            Ok(())
        }
    }
    pub fn stage(&mut self, id: &str) -> Result<(), OperationErrorCode> {
        if self.used.contains(&(true, id.into())) {
            return Err(OperationErrorCode::Consumed);
        }
        if self.reserved == 0 {
            return Err(OperationErrorCode::BudgetExceeded);
        }
        self.reserved -= 1;
        self.used.insert((true, id.into()));
        Ok(())
    }
    pub fn release(&mut self, credits: usize) {
        self.reserved -= credits;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caller_ids_cannot_collide_with_the_checked_preflight_allocator() {
        let mut r = Registry::default();
        r.used.insert((true, "native-op:1".into()));
        r.used.insert((true, "native-op:2".into()));
        let (id, counter) = r.prepare("change").unwrap();
        assert_eq!(id, "native-op:3");
        assert!(id.len() <= 64);
        r.begin("change", &id, counter);
        assert_eq!(r.prepare("change"), Err(OperationErrorCode::Consumed));
        r.release(2);
        r.counter = projection::MAX_SAFE;
        assert_eq!(r.prepare("next"), Err(OperationErrorCode::BudgetExceeded));
    }
}
