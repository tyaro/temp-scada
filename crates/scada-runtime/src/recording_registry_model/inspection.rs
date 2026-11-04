use super::*;
impl RegistryModel {
    pub fn inspect_admission(
        &mut self,
        session: &ModelSession,
        request: RecordingAdmissionInspectionRequest,
    ) -> Result<RecordingAdmissionInspectionReply, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(
            self.admission_matches_scope(&q["original"]),
            ModelError::Forbidden,
        )?;
        let id = q["inspectionId"].as_str().expect("validated ID");
        if let Some((old, reply)) = self.inspections.get(id) {
            require(
                same_recording_admission_inspection_request(old, &request),
                ModelError::ProtocolViolation,
            )?;
            return Ok(reply.clone());
        }
        require(
            self.inspections.len() < self.limits.admission_inspections,
            ModelError::Capacity,
        )?;
        let outcome = if let Some(r) = self
            .admissions
            .get(q["original"]["admissionId"].as_str().expect("validated ID"))
        {
            let original = RecordingAdmissionRequest::from_value(q["original"].clone())
                .map_err(|_| ModelError::InvalidInput)?;
            require(
                same_recording_admission_request(&original, &r.request),
                ModelError::ProtocolViolation,
            )?;
            let current=r.proof.as_ref().or(r.terminal.as_ref()).map(|r|r.as_value().clone()).unwrap_or_else(||json!({"version":1,"kind":"recordingAdmissionReply","request":r.request.as_value(),"outcome":{"kind":"unknown","error":"workerFailure"}}));
            json!({"kind":"found","reply":current})
        } else {
            json!({"kind":"notFound"})
        };
        let reply=RecordingAdmissionInspectionReply::from_value(json!({"version":1,"kind":"recordingAdmissionInspectionReply","request":q,"outcome":outcome})).map_err(|_|ModelError::InvalidInput)?;
        let cost = sum(bytes(q)?, bytes(reply.as_value())?)?;
        self.can_charge(Role::Read, cost)?;
        let id = id.to_owned();
        self.charge(Role::Read, cost);
        self.inspections.insert(id, (request, reply.clone()));
        Ok(reply)
    }
    pub fn inspect_call(
        &mut self,
        session: &ModelSession,
        request: RecordingWireCallInspectionRequest,
    ) -> Result<RecordingWireCallInspectionReply, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(self.scope_matches(&q["scope"]), ModelError::Forbidden)?;
        let id = q["callInspectionId"].as_str().expect("validated ID");
        let fresh = if let Some(old) = self.call_inspections.get(id) {
            require(
                same_recording_wire_request(old.as_document(), request.as_document()),
                ModelError::ProtocolViolation,
            )?;
            false
        } else {
            require(
                self.call_inspections.len() < self.limits.call_inspections,
                ModelError::Capacity,
            )?;
            true
        };
        let original = &q["original"];
        let outcome = match original["kind"].as_str().expect("validated kind") {
            "recordingWireLeaseRequest" => {
                if let Some(r) = self
                    .leases
                    .get(original["leaseRequestId"].as_str().expect("validated ID"))
                {
                    let old = RecordingWireLeaseRequest::from_value(original.clone())
                        .map_err(|_| ModelError::InvalidInput)?;
                    require(
                        same_recording_wire_request(&old.clone().into(), r.request.as_document()),
                        ModelError::ProtocolViolation,
                    )?;
                    json!({"kind":"terminal","reply":r.reply.as_value()})
                } else {
                    json!({"kind":"notFound"})
                }
            }
            "recordingAdmissionRequest" => {
                if let Some(r) = self
                    .admissions
                    .get(original["admissionId"].as_str().expect("validated ID"))
                {
                    let old = RecordingAdmissionRequest::from_value(original.clone())
                        .map_err(|_| ModelError::InvalidInput)?;
                    require(
                        same_recording_admission_request(&old, &r.request),
                        ModelError::ProtocolViolation,
                    )?;
                    if let Some(reply) = &r.terminal {
                        json!({"kind":"terminal","reply":reply.as_value()})
                    } else {
                        json!({"kind":"pending"})
                    }
                } else {
                    json!({"kind":"notFound"})
                }
            }
            "recordingAdmissionInspectionRequest" => {
                if let Some((old, reply)) = self
                    .inspections
                    .get(original["inspectionId"].as_str().expect("validated ID"))
                {
                    let current = RecordingAdmissionInspectionRequest::from_value(original.clone())
                        .map_err(|_| ModelError::InvalidInput)?;
                    require(
                        same_recording_admission_inspection_request(old, &current),
                        ModelError::ProtocolViolation,
                    )?;
                    json!({"kind":"terminal","reply":reply.as_value()})
                } else {
                    json!({"kind":"notFound"})
                }
            }
            "recordingWireCancelRequest" => {
                if let Some(r) = self
                    .cancels
                    .get(original["cancelId"].as_str().expect("validated ID"))
                {
                    let current = RecordingWireCancelRequest::from_value(original.clone())
                        .map_err(|_| ModelError::InvalidInput)?;
                    require(
                        same_recording_wire_request(r.request.as_document(), current.as_document()),
                        ModelError::ProtocolViolation,
                    )?;
                    if r.terminal {
                        json!({"kind":"terminal","reply":r.decision.as_ref().expect("terminal decision").as_value()})
                    } else {
                        json!({"kind":"pending"})
                    }
                } else {
                    json!({"kind":"notFound"})
                }
            }
            "recordingWireAttachRequest" => {
                if let Some(record) = self
                    .attaches
                    .get(original["attachId"].as_str().expect("validated ID"))
                {
                    let q = RecordingWireAttachRequest::from_value(original.clone())
                        .map_err(|_| ModelError::InvalidInput)?;
                    require(
                        same_recording_wire_request(record.request.as_document(), q.as_document()),
                        ModelError::ProtocolViolation,
                    )?;
                    json!({"kind":"terminal","reply":self.attach_reply(record)?.as_value()})
                } else {
                    json!({"kind":"notFound"})
                }
            }
            "recordingWireControlRequest" => {
                if let Some(record) = self
                    .controls
                    .get(original["controlId"].as_str().expect("validated ID"))
                {
                    let q = RecordingWireControlRequest::from_value(original.clone())
                        .map_err(|_| ModelError::InvalidInput)?;
                    require(
                        same_recording_wire_request(record.request.as_document(), q.as_document()),
                        ModelError::ProtocolViolation,
                    )?;
                    json!({"kind":"terminal","reply":self.control_reply(record)?.as_value()})
                } else {
                    json!({"kind":"notFound"})
                }
            }
            _ => json!({"kind":"unavailable","error":"ownerUnavailable"}),
        };
        let reply=RecordingWireCallInspectionReply::from_value(json!({"version":1,"kind":"recordingWireCallInspectionReply","request":q,"outcome":outcome})).map_err(|_|ModelError::InvalidInput)?;
        if fresh {
            let cost = bytes(q)?;
            self.can_charge(Role::Read, cost)?;
            let id = id.to_owned();
            self.charge(Role::Read, cost);
            self.call_inspections.insert(id, request);
        }
        Ok(reply)
    }
}
