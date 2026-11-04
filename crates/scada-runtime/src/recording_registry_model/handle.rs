//! Model-owned handle completion and bounded read-only observation, no native wait.
use super::*;
fn ref_key(handle: &Value) -> HandleKey {
    if handle["kind"] == "operation" {
        (
            Role::Mutation,
            handle["operationRef"]
                .as_str()
                .expect("validated ref")
                .to_owned(),
        )
    } else {
        (
            Role::Read,
            handle["readRef"]
                .as_str()
                .expect("validated ref")
                .to_owned(),
        )
    }
}
pub(super) fn completion_reservation(role: Role) -> usize {
    if role == Role::Mutation {
        WIRE_OPERATION_RESULT_UPPER.bytes
    } else {
        MAX_RECORDING_ADMISSION_JSON_BYTES
    }
}
impl RegistryModel {
    /// Registers metadata only after all checks. Caller then stores the Accepted proof atomically.
    pub(super) fn register_handle(
        &mut self,
        ticket: &SimulationTicket,
        reply: &RecordingAdmissionReply,
    ) -> Result<(), ModelError> {
        let handle = &reply.as_value()["outcome"]["handle"];
        let key = ref_key(handle);
        require(
            !self.handles.contains_key(&key),
            ModelError::ProtocolViolation,
        )?;
        let original_operation = if key.0 == Role::Read {
            let action = &reply.as_value()["request"]["action"];
            let original = (
                Role::Mutation,
                action["operationRef"]
                    .as_str()
                    .expect("validated ref")
                    .to_owned(),
            );
            let r = self
                .handles
                .get(&original)
                .ok_or(ModelError::ProtocolViolation)?;
            let request = self.handle_request(r);
            require(
                request["stage"] == "apply" && same_value(request, &handle["request"]["operation"]),
                ModelError::ProtocolViolation,
            )?;
            Some(original)
        } else {
            None
        };
        self.handles.insert(
            key,
            HandleRecord {
                admission_id: ticket.admission_id.clone(),
                sequence: ticket.sequence,
                original_operation,
                completion: None,
                cancel_notified: false,
            },
        );
        Ok(())
    }
    pub(super) fn handle_request<'a>(&'a self, record: &HandleRecord) -> &'a Value {
        &self.admissions[&record.admission_id]
            .proof
            .as_ref()
            .expect("registered accepted handle")
            .as_value()["outcome"]["handle"]["request"]
    }
    pub fn accepted_handle(
        &self,
        admission: &SimulationTicket,
    ) -> Result<SimulatedHandleTicket, ModelError> {
        let r = self.record(admission)?;
        let reply = r
            .proof
            .as_ref()
            .filter(|p| p.as_value()["outcome"]["kind"] == "accepted")
            .ok_or(ModelError::InvalidInput)?;
        let key = ref_key(&reply.as_value()["outcome"]["handle"]);
        let h = self.handles.get(&key).ok_or(ModelError::InvalidInput)?;
        require(
            h.admission_id == admission.admission_id && h.sequence == admission.sequence,
            ModelError::InvalidInput,
        )?;
        Ok(SimulatedHandleTicket {
            identity: Arc::clone(&self.identity),
            admission_id: admission.admission_id.clone(),
            sequence: admission.sequence,
            key,
        })
    }
    pub fn complete_handle(
        &mut self,
        handle: &SimulatedHandleTicket,
        completion: SimulatedCompletion,
    ) -> Result<(), ModelError> {
        require(
            Arc::ptr_eq(&handle.identity, &self.identity),
            ModelError::Forbidden,
        )?;
        let record = self
            .handles
            .get(&handle.key)
            .filter(|r| r.admission_id == handle.admission_id && r.sequence == handle.sequence)
            .ok_or(ModelError::InvalidInput)?;
        let request = self.handle_request(record);
        let (value, recovery) = match &completion {
            SimulatedCompletion::Operation(result) => {
                require(
                    handle.key.0 == Role::Mutation
                        && same_value(&result.as_value()["request"], request),
                    ModelError::ProtocolViolation,
                )?;
                conservative_recording_json_bound(result.as_value(), WIRE_OPERATION_RESULT_UPPER)
                    .map_err(|_| ModelError::InvalidInput)?;
                (
                    result.as_value(),
                    result.as_value()["recoveryRequired"] == true,
                )
            }
            SimulatedCompletion::Reconciliation(delivery) => {
                let d = delivery.as_value();
                require(
                    handle.key.0 == Role::Read
                        && same_value(&d["request"], request)
                        && d["ownerRef"] == self.session.scope["ownerRef"]
                        && d["readRef"] == handle.key.1,
                    ModelError::ProtocolViolation,
                )?;
                conservative_recording_json_bound(
                    d,
                    WireBound {
                        bytes: MAX_RECORDING_ADMISSION_JSON_BYTES,
                        nodes: MAX_RECORDING_ADMISSION_JSON_NODES,
                        depth: MAX_RECORDING_ADMISSION_JSON_DEPTH,
                    },
                )
                .map_err(|_| ModelError::InvalidInput)?;
                if d["outcome"]["kind"] == "result" {
                    let result = &d["outcome"]["result"];
                    let original = record
                        .original_operation
                        .as_ref()
                        .and_then(|k| self.handles.get(k))
                        .and_then(|r| r.completion.as_ref());
                    let op = match original {
                        Some(SimulatedCompletion::Operation(v)) => Some(v.as_value()),
                        _ => None,
                    };
                    if result["quiescence"] == "confirmed" {
                        require(
                            op.is_some_and(|v| v["quiescence"] == "confirmed"),
                            ModelError::ProtocolViolation,
                        )?;
                    }
                    if result["recoveryRequired"] == false {
                        require(
                            op.is_some_and(|v| {
                                v["quiescence"] == "confirmed" && v["recoveryRequired"] == false
                            }),
                            ModelError::ProtocolViolation,
                        )?;
                    }
                }
                (
                    d,
                    d["outcome"]["kind"] == "readUncertain"
                        || d["outcome"]["result"]["recoveryRequired"] == true,
                )
            }
        };
        if let Some(old) = &record.completion {
            return require(
                same_value(completion_value(old), value),
                ModelError::ProtocolViolation,
            );
        }
        self.handles
            .get_mut(&handle.key)
            .expect("validated handle")
            .completion = Some(completion);
        self.recovery_required |= recovery;
        Ok(())
    }
}

fn completion_value(c: &SimulatedCompletion) -> &Value {
    match c {
        SimulatedCompletion::Operation(v) => v.as_value(),
        SimulatedCompletion::Reconciliation(v) => v.as_value(),
    }
}
