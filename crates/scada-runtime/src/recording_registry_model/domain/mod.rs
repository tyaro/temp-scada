//! Pure bounded resource domain. No native resources, tasks or physical identity checks.
use super::*;
use serde::Serialize;
mod facade;
pub use facade::DomainScope;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimulatedResourceId(String);
impl SimulatedResourceId {
    pub fn new(id: &str) -> Result<Self, ModelError> {
        require(types::valid_id(id), ModelError::InvalidInput)?;
        Ok(Self(id.to_owned()))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DomainLimits {
    pub total_bytes: usize,
    pub live_subscriptions: usize,
    pub scopes: usize,
}
impl Default for DomainLimits {
    fn default() -> Self {
        Self {
            total_bytes: 16 * 1024 * 1024,
            live_subscriptions: 32,
            scopes: 32,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DomainMode {
    Standalone,
    Workflow {
        qualification: SimulatedRunQualification,
    },
}
#[derive(Clone, Debug)]
pub struct DomainRegistration {
    pub resource: SimulatedResourceId,
    pub session: ModelSession,
    pub limits: ModelLimits,
    pub mode: DomainMode,
}
/// Domain-instance capability. Not a serialized scope or native handle.
#[derive(Clone, Debug)]
pub struct DomainScopeTicket {
    identity: Arc<()>,
    sequence: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainStats {
    pub reserved_total: usize,
    pub reserved_read: usize,
    pub reserved_mutation: usize,
    pub reserved_subscriptions: usize,
    pub registered_scopes: usize,
    pub sealed: bool,
    pub clock_fault: bool,
    pub now: ModelInstant,
}
#[derive(Debug)]
struct ScopeRecord {
    resource: SimulatedResourceId,
    mode: DomainMode,
    sequence: u64,
    model: RegistryModel,
}
#[derive(Debug)]
pub struct RegistryDomain {
    identity: Arc<()>,
    limits: DomainLimits,
    sequence: u64,
    records: Vec<ScopeRecord>,
    stats: DomainStats,
}
impl RegistryDomain {
    pub fn new(limits: DomainLimits) -> Result<Self, ModelError> {
        let max = DomainLimits::default();
        require(
            limits.total_bytes <= max.total_bytes
                && limits.live_subscriptions <= max.live_subscriptions
                && limits.scopes <= max.scopes,
            ModelError::InvalidInput,
        )?;
        Ok(Self {
            identity: Arc::new(()),
            limits,
            sequence: 0,
            records: Vec::new(),
            stats: DomainStats {
                reserved_total: 0,
                reserved_read: 0,
                reserved_mutation: 0,
                reserved_subscriptions: 0,
                registered_scopes: 0,
                sealed: false,
                clock_fault: false,
                now: ModelInstant(0),
            },
        })
    }
    pub fn register(&mut self, input: DomainRegistration) -> Result<DomainScopeTicket, ModelError> {
        input.limits.validate()?;
        let collides = |r: &&ScopeRecord| {
            r.resource == input.resource
                || r.model.session.scope["ownerRef"] == input.session.scope["ownerRef"]
        };
        let mut known = self.records.iter().filter(collides);
        require(
            known
                .clone()
                .all(|r| r.model.session.principal == input.session.principal),
            ModelError::Forbidden,
        )?;
        if let Some(r) = known.next() {
            require(
                r.resource == input.resource
                    && r.mode == input.mode
                    && r.model.limits == input.limits
                    && r.model.scope_matches(&input.session.scope),
                ModelError::ProtocolViolation,
            )?;
            return Ok(DomainScopeTicket {
                identity: self.identity.clone(),
                sequence: r.sequence,
            });
        }
        require(!self.stats.sealed, ModelError::Closed)?;
        require(!self.stats.clock_fault, ModelError::ClockFault)?;
        let stats = DomainStats {
            reserved_total: sum(self.stats.reserved_total, input.limits.total_bytes)?,
            reserved_read: sum(self.stats.reserved_read, input.limits.read_bytes)?,
            reserved_mutation: sum(
                self.stats.reserved_mutation,
                input.limits.total_bytes - input.limits.read_bytes,
            )?,
            reserved_subscriptions: sum(
                self.stats.reserved_subscriptions,
                input.limits.live_subscriptions,
            )?,
            registered_scopes: sum(self.stats.registered_scopes, 1)?,
            ..self.stats
        };
        require(
            stats.reserved_total <= self.limits.total_bytes
                && stats.reserved_subscriptions <= self.limits.live_subscriptions
                && stats.registered_scopes <= self.limits.scopes,
            ModelError::Capacity,
        )?;
        let mut model = match input.mode {
            DomainMode::Standalone => RegistryModel::new(input.session, input.limits)?,
            DomainMode::Workflow { qualification } => {
                RegistryModel::new_workflow(input.session, input.limits, qualification)?
            }
        };
        model.advance_to(self.stats.now)?;
        let sequence = self.sequence.checked_add(1).ok_or(ModelError::Capacity)?;
        // No fallible domain checks follow this commit. Whole quotas stay reserved for its lifetime.
        self.records.push(ScopeRecord {
            resource: input.resource,
            mode: input.mode,
            sequence,
            model,
        });
        self.sequence = sequence;
        self.stats = stats;
        Ok(DomainScopeTicket {
            identity: self.identity.clone(),
            sequence,
        })
    }
    pub fn scope<'a>(
        &'a mut self,
        ticket: &DomainScopeTicket,
        session: &ModelSession,
    ) -> Result<DomainScope<'a>, ModelError> {
        require(
            Arc::ptr_eq(&self.identity, &ticket.identity),
            ModelError::Forbidden,
        )?;
        let record = self
            .records
            .iter_mut()
            .find(|r| r.sequence == ticket.sequence)
            .ok_or(ModelError::InvalidInput)?;
        record.model.qualify(session)?;
        Ok(DomainScope {
            model: &mut record.model,
        })
    }
    pub fn advance_to(&mut self, now: ModelInstant) -> Result<(), ModelError> {
        let backwards = now.0 < self.stats.now.0;
        // Every child has the same clock; advance_to has only the backwards-error branch.
        // Apply all sticky faults before returning, with no fallible early exit in this loop.
        for record in &mut self.records {
            let _ = record.model.advance_to(now);
        }
        if backwards {
            self.stats.clock_fault = true;
            Err(ModelError::ClockFault)
        } else {
            self.stats.now = now;
            Ok(())
        }
    }
    pub fn seal(&mut self) {
        self.stats.sealed = true;
    }
    pub fn stats(&self) -> DomainStats {
        self.stats
    }
}
