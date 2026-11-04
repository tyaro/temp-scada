//! Bounded immutable snapshot references and publication credits; no live JSON cache.
use super::*;
pub(super) const DESCRIPTOR_BYTES: usize = 1024;
pub(super) const MAX_REVISION: u64 = 9_007_199_254_740_991;
const ENVELOPE: WireBound = WireBound {
    bytes: 65536,
    nodes: 4096,
    depth: 3,
};
const ZERO: WireBound = WireBound {
    bytes: 0,
    nodes: 0,
    depth: 0,
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AdmissionView {
    pub id: String,
    pub proof: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SnapshotDescriptor {
    pub revision: u64,
    pub closed: bool,
    pub blocked: bool,
    pub admission: Option<AdmissionView>,
    pub operation: Option<HandleKey>,
    pub read: Option<HandleKey>,
}
#[derive(Clone, Copy, Debug)]
pub(super) struct ProjectionBudget {
    pub admission: WireBound,
    pub operation: WireBound,
    pub read: WireBound,
}
#[derive(Debug)]
pub(super) struct ProjectionState {
    pub current: SnapshotDescriptor,
    pub budget: ProjectionBudget,
    pub reserved: u64,
    pub close_credit: bool,
}
impl ProjectionState {
    pub fn new() -> Self {
        Self {
            current: SnapshotDescriptor {
                revision: 1,
                closed: false,
                blocked: false,
                admission: None,
                operation: None,
                read: None,
            },
            budget: ProjectionBudget {
                admission: ZERO,
                operation: ZERO,
                read: ZERO,
            },
            reserved: 1,
            close_credit: true,
        }
    }
}
pub(super) enum ProjectionEvent<'a> {
    Admission {
        id: &'a str,
        sequence: u64,
        request: &'a RecordingAdmissionRequest,
    },
    Knowledge {
        id: &'a str,
        sequence: u64,
        reply: &'a RecordingAdmissionReply,
    },
    Completion {
        key: &'a HandleKey,
        value: &'a SimulatedCompletion,
        recovery: bool,
    },
    Close,
}
fn measured(v: &Value) -> Result<WireBound, ModelError> {
    conservative_recording_json_bound(v, WIRE_INSPECTION_REPLY_LIMIT)
        .map_err(|_| ModelError::InvalidInput)
}
pub(super) fn fits_bound(a: WireBound, b: WireBound) -> bool {
    a.bytes <= b.bytes && a.nodes <= b.nodes && a.depth <= b.depth
}
fn max_bound(a: WireBound, b: WireBound) -> WireBound {
    WireBound {
        bytes: a.bytes.max(b.bytes),
        nodes: a.nodes.max(b.nodes),
        depth: a.depth.max(b.depth),
    }
}
fn envelope(a: WireBound, b: WireBound, da: usize, db: usize) -> Result<WireBound, ModelError> {
    Ok(WireBound {
        bytes: sum(sum(a.bytes, b.bytes)?, ENVELOPE.bytes)?,
        nodes: sum(sum(a.nodes, b.nodes)?, ENVELOPE.nodes)?,
        depth: (a.depth + da).max(b.depth + db).max(ENVELOPE.depth),
    })
}
impl RegistryModel {
    pub(super) fn projection_bound(&self, b: ProjectionBudget) -> Result<WireBound, ModelError> {
        let s = measured(&self.session.scope)?;
        Ok(WireBound {
            bytes: sum(
                sum(
                    sum(sum(s.bytes, b.admission.bytes)?, b.operation.bytes)?,
                    b.read.bytes,
                )?,
                ENVELOPE.bytes,
            )?,
            nodes: sum(
                sum(
                    sum(sum(s.nodes, b.admission.nodes)?, b.operation.nodes)?,
                    b.read.nodes,
                )?,
                ENVELOPE.nodes,
            )?,
            depth: (s.depth + 1)
                .max(b.admission.depth + 1)
                .max(b.operation.depth + 2)
                .max(b.read.depth + 1)
                .max(3),
        })
    }
    pub(super) fn admission_projection(
        &self,
        q: &RecordingAdmissionRequest,
    ) -> Result<ProjectionBudget, ModelError> {
        let request = q.as_value();
        let action = &request["action"];
        let handle = match action["kind"].as_str().expect("validated action") {
            "preflight" => Some(
                json!({"version":1,"kind":"recordingOperationRequest","operationId":"r".repeat(64),"stage":"preflight","change":action["change"]}),
            ),
            "pauseJoin" | "apply" => Some(action["operation"].clone()),
            "reconcile" => Some(action["reconciliation"].clone()),
            "discard" => None,
            _ => unreachable!("closed action"),
        };
        let h = handle.as_ref().map(measured).transpose()?.unwrap_or(ZERO);
        let mut b = self.projection.budget;
        b.admission = max_bound(b.admission, envelope(measured(request)?, h, 1, 3)?);
        if handle.is_some() {
            if admission_role(request) == Role::Read {
                let mut bound = envelope(h, h, 3, 3)?;
                bound.depth = bound.depth.max(6);
                b.read = max_bound(b.read, bound);
            } else {
                let mut bound = envelope(h, ZERO, 1, 0)?;
                bound.depth = bound.depth.max(4);
                b.operation = max_bound(b.operation, bound);
            }
        }
        require(
            fits_bound(self.projection_bound(b)?, self.limits.projection_limit),
            ModelError::Capacity,
        )?;
        let reserved = self
            .projection
            .reserved
            .checked_add(3)
            .and_then(|r| r.checked_add(self.projection.current.revision));
        require(
            reserved.is_some_and(|r| r <= self.limits.revision_ceiling),
            ModelError::Capacity,
        )?;
        Ok(b)
    }
    fn snapshot_descriptor(&self, event: Option<&ProjectionEvent<'_>>) -> SnapshotDescriptor {
        let mut d = self.projection.current.clone();
        d.closed = self.closed || matches!(event, Some(ProjectionEvent::Close));
        d.blocked = self.recovery_required
            || matches!(
                event,
                Some(ProjectionEvent::Completion { recovery: true, .. })
            );
        let current = self.admissions.iter().max_by_key(|(_, r)| r.sequence);
        d.admission = current.map(|(id, r)| AdmissionView {
            id: id.clone(),
            proof: r.proof.is_some(),
        });
        if let Some(ProjectionEvent::Admission { id, sequence, .. }) = event {
            if current.is_none_or(|(_, r)| r.sequence < *sequence) {
                d.admission = Some(AdmissionView {
                    id: (*id).to_owned(),
                    proof: false,
                });
            }
        }
        if let Some(ProjectionEvent::Knowledge { id, .. }) = event {
            if d.admission.as_ref().is_some_and(|v| v.id == *id) {
                d.admission = Some(AdmissionView {
                    id: (*id).to_owned(),
                    proof: true,
                });
            }
        }
        for role in [Role::Mutation, Role::Read] {
            let mut head = self
                .handles
                .iter()
                .filter(|(k, _)| k.0 == role)
                .max_by_key(|(_, h)| h.sequence)
                .map(|(k, h)| (k.clone(), h.sequence));
            if let Some(ProjectionEvent::Knowledge {
                sequence, reply, ..
            }) = event
            {
                if reply.as_value()["outcome"]["kind"] == "accepted" {
                    let key = handle::ref_key(&reply.as_value()["outcome"]["handle"]);
                    if key.0 == role && head.as_ref().is_none_or(|(_, s)| sequence > s) {
                        head = Some((key, *sequence));
                    }
                }
            }
            let completed = head.and_then(|(key, _)| {
                let ready = self
                    .handles
                    .get(&key)
                    .is_some_and(|h| h.completion.is_some())
                    || matches!(event,Some(ProjectionEvent::Completion{key:k,..}) if **k==key);
                ready.then_some(key)
            });
            if role == Role::Mutation {
                d.operation = completed;
            } else {
                d.read = completed;
            }
        }
        d
    }
    pub(super) fn snapshot_value(
        &self,
        d: &SnapshotDescriptor,
        event: Option<&ProjectionEvent<'_>>,
    ) -> Result<Value, ModelError> {
        let admission = if let Some(a) = &d.admission {
            if a.proof {
                if let Some(ProjectionEvent::Knowledge { id, reply, .. }) = event {
                    if *id == a.id {
                        reply.as_value().clone()
                    } else {
                        self.admissions[&a.id]
                            .proof
                            .as_ref()
                            .ok_or(ModelError::InvalidInput)?
                            .as_value()
                            .clone()
                    }
                } else {
                    self.admissions[&a.id]
                        .proof
                        .as_ref()
                        .ok_or(ModelError::InvalidInput)?
                        .as_value()
                        .clone()
                }
            } else {
                let request = if let Some(ProjectionEvent::Admission { id, request, .. }) = event {
                    if *id == a.id {
                        request.as_value()
                    } else {
                        self.admissions[&a.id].request.as_value()
                    }
                } else {
                    self.admissions[&a.id].request.as_value()
                };
                json!({"version":1,"kind":"recordingAdmissionReply","request":request,"outcome":{"kind":"unknown","error":"workerFailure"}})
            }
        } else {
            Value::Null
        };
        let completion = |key: &HandleKey| -> Result<&Value, ModelError> {
            let c = if let Some(ProjectionEvent::Completion { key: k, value, .. }) = event {
                if *k == key {
                    *value
                } else {
                    self.handles
                        .get(key)
                        .and_then(|h| h.completion.as_ref())
                        .ok_or(ModelError::InvalidInput)?
                }
            } else {
                self.handles
                    .get(key)
                    .and_then(|h| h.completion.as_ref())
                    .ok_or(ModelError::InvalidInput)?
            };
            Ok(match c {
                SimulatedCompletion::Operation(v) => v.as_value(),
                SimulatedCompletion::Reconciliation(v) => v.as_value(),
            })
        };
        let operation = d
            .operation
            .as_ref()
            .map(|key| completion(key).map(|v| json!({"operationRef":key.1,"result":v})))
            .transpose()?
            .unwrap_or(Value::Null);
        let read = d
            .read
            .as_ref()
            .map(|key| completion(key).cloned())
            .transpose()?
            .unwrap_or(Value::Null);
        Ok(
            json!({"scope":self.session.scope,"revision":d.revision,"closed":d.closed,"ownerBlocked":d.blocked,"admission":admission,"operation":operation,"reconciliation":read}),
        )
    }
    pub(super) fn validate_snapshot(
        &self,
        v: &Value,
        b: ProjectionBudget,
    ) -> Result<(), ModelError> {
        require(
            fits_bound(measured(v)?, self.limits.projection_limit),
            ModelError::Capacity,
        )?;
        for (payload, bound) in [
            (&v["admission"], b.admission),
            (&v["operation"]["result"], b.operation),
            (&v["reconciliation"], b.read),
        ] {
            if !payload.is_null() {
                require(fits_bound(measured(payload)?, bound), ModelError::Capacity)?;
            }
        }
        RecordingWireStateFrame::from_value(json!({"version":1,"kind":"recordingWireStateFrame","subscriptionRef":"validation","snapshot":v})).map_err(|_|ModelError::InvalidInput)?;
        Ok(())
    }
    pub(super) fn prepare_publication(
        &self,
        event: &ProjectionEvent<'_>,
        budget: ProjectionBudget,
    ) -> Result<Option<SnapshotDescriptor>, ModelError> {
        let mut d = self.snapshot_descriptor(Some(event));
        if d == self.projection.current {
            return Ok(None);
        }
        let credit = match event {
            ProjectionEvent::Admission { .. } => 3,
            ProjectionEvent::Knowledge { id, .. } => self.admissions[*id].projection_credits,
            ProjectionEvent::Completion { key, .. } => {
                self.admissions[&self.handles[*key].admission_id].projection_credits
            }
            ProjectionEvent::Close => u8::from(self.projection.close_credit),
        };
        require(credit > 0, ModelError::Capacity)?;
        d.revision = d
            .revision
            .checked_add(1)
            .filter(|r| *r <= self.limits.revision_ceiling)
            .ok_or(ModelError::Capacity)?;
        let value = self.snapshot_value(&d, Some(event))?;
        self.validate_snapshot(&value, budget)?;
        Ok(Some(d))
    }
    pub(super) fn commit_publication(
        &mut self,
        publication: Option<SnapshotDescriptor>,
        admission: Option<&str>,
    ) {
        if let Some(d) = publication {
            self.projection.reserved -= 1;
            if let Some(id) = admission {
                self.admissions
                    .get_mut(id)
                    .expect("reserved record")
                    .projection_credits -= 1;
            } else {
                self.projection.close_credit = false;
            }
            let closing = d.closed && !self.projection.current.closed;
            self.projection.current = d.clone();
            for s in self.subscriptions.values_mut().filter(|s| s.active) {
                s.state = Some(d.clone());
                if closing {
                    s.control = true;
                }
            }
        }
    }
    pub fn owner_snapshot(&self, session: &ModelSession) -> Result<Value, ModelError> {
        self.qualify(session)?;
        let v = self.snapshot_value(&self.projection.current, None)?;
        self.validate_snapshot(&v, self.projection.budget)?;
        Ok(v)
    }
}
