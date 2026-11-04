//! Bounded read-only observation. Completion storage is owned by handle.rs.
use super::*;
fn target_key(target: &Value) -> HandleKey {
    if target["kind"] == "operation" {
        (
            Role::Mutation,
            target["operationRef"]
                .as_str()
                .expect("validated ref")
                .to_owned(),
        )
    } else {
        (
            Role::Read,
            target["readRef"]
                .as_str()
                .expect("validated ref")
                .to_owned(),
        )
    }
}
impl RegistryModel {
    pub fn observe_result(
        &mut self,
        session: &ModelSession,
        request: RecordingWireObservationRequest,
    ) -> Result<RecordingWireObservationReply, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(self.scope_matches(&q["scope"]), ModelError::Forbidden)?;
        let id = q["observationId"].as_str().expect("validated ID");
        let key = target_key(&q["target"]);
        let existing = self.observations.get(id);
        if let Some(old) = existing {
            require(
                same_recording_wire_request(old.request.as_document(), request.as_document()),
                ModelError::ProtocolViolation,
            )?;
        }
        let target = if let Some(old) = existing {
            old.target.clone()
        } else if let Some(h) = self.handles.get(&key) {
            require(
                same_value(self.handle_request(h), &q["target"]["request"]),
                ModelError::ProtocolViolation,
            )?;
            Some(key.clone())
        } else {
            None
        };
        let completion = target
            .as_ref()
            .and_then(|key| self.handles.get(key))
            .and_then(|h| h.completion.as_ref());
        let pending = target.is_some() && completion.is_none();
        let outcome = match completion {
            Some(SimulatedCompletion::Operation(r)) => {
                json!({"kind":"operation","result":r.as_value()})
            }
            Some(SimulatedCompletion::Reconciliation(d)) => {
                json!({"kind":"reconciliation","delivery":d.as_value()})
            }
            None if pending => json!({"kind":"pending"}),
            None => json!({"kind":"unavailable","error":"ownerUnavailable"}),
        };
        let reply=RecordingWireObservationReply::from_value(json!({"version":1,"kind":"recordingWireObservationReply","request":q,"outcome":outcome})).map_err(|_|ModelError::InvalidInput)?;
        if existing.is_some() {
            if !pending {
                self.observations
                    .get_mut(id)
                    .expect("existing observation")
                    .pending = false;
            }
            return Ok(reply);
        }
        let (limit, pending_limit) = if key.0 == Role::Mutation {
            (
                self.limits.operation_observations,
                self.limits.pending_operation_observations,
            )
        } else {
            (
                self.limits.read_observations,
                self.limits.pending_read_observations,
            )
        };
        require(
            self.observations
                .values()
                .filter(|o| o.role == key.0)
                .count()
                < limit,
            ModelError::Capacity,
        )?;
        if pending {
            require(
                self.observations
                    .values()
                    .filter(|o| o.role == key.0 && o.pending)
                    .count()
                    < pending_limit,
                ModelError::Capacity,
            )?;
        }
        let cost = bytes(q)?;
        self.can_charge(Role::Read, cost)?;
        let id = id.to_owned();
        self.charge(Role::Read, cost);
        self.observations.insert(
            id,
            ObservationRecord {
                request,
                role: key.0,
                target,
                pending,
            },
        );
        Ok(reply)
    }
}
