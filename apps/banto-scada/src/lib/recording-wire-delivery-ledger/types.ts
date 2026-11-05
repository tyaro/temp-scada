import type {
  RecordingWireLeaseRequest,
  RecordingWireLeaseReply,
  RecordingWireCancelRequest,
  RecordingWireCancelReply,
  RecordingWireObservationTarget,
  RecordingWireObservationRequest,
  RecordingWireObservationReply,
  RecordingWireScope,
  RecordingWireCallInspectionRequest,
  RecordingWireCallInspectionReply,
} from "../recording-wire-contract";
import type {
  RecordingAdmissionRequest,
  RecordingAdmissionReply,
  RecordingAdmissionInspectionRequest,
  RecordingAdmissionInspectionReply,
} from "../recording-admission-contract";
import type {
  RecordingAcceptedRef,
  RecordingReconciliationDelivery,
} from "../recording-admission-contract";
import type { RecordingOperationResult } from "../recording-operations-contract";
export type OriginalRequest =
  | RecordingWireLeaseRequest
  | RecordingAdmissionRequest
  | RecordingAdmissionInspectionRequest
  | RecordingWireCancelRequest;
export type OriginalReply =
  | RecordingWireLeaseReply
  | RecordingAdmissionReply
  | RecordingAdmissionInspectionReply
  | RecordingWireCancelReply;
declare const originalBrand: unique symbol,
  queryBrand: unique symbol,
  attemptBrand: unique symbol,
  observationTargetBrand: unique symbol,
  observationQueryBrand: unique symbol,
  observationAttemptBrand: unique symbol;
export type OriginalCallToken = Readonly<{ [originalBrand]: true }>;
export type InspectionQueryToken = Readonly<{ [queryBrand]: true }>;
export type InspectionAttemptToken = Readonly<{ [attemptBrand]: true }>;
export type ObservationTargetToken = Readonly<{
  [observationTargetBrand]: true;
}>;
export type ObservationQueryToken = Readonly<{ [observationQueryBrand]: true }>;
export type ObservationAttemptToken = Readonly<{
  [observationAttemptBrand]: true;
}>;
export type LedgerError =
  | "busy"
  | "foreignToken"
  | "invalidRequest"
  | "unsupportedKind"
  | "invalidDocument"
  | "protocolViolation"
  | "capacity"
  | "retired"
  | "disposed";
export type LedgerResult<T> = Readonly<
  { ok: true; value: T } | { ok: false; reason: LedgerError }
>;
export type DeliveryAcceptResult = Readonly<
  | {
      ok: true;
      value: Readonly<{
        disposition: "stored" | "duplicate";
        terminalStored: boolean;
        attemptStored: boolean;
      }>;
    }
  | {
      ok: false;
      reason: LedgerError;
      terminalStored: boolean;
      attemptStored: boolean;
    }
>;
export interface DeliveryLimits {
  readonly mutationBytes: number;
  readonly readBytes: number;
  readonly observationBytes: number;
  readonly mutationIds: number;
  readonly readIds: number;
  readonly inspectionIds: number;
  readonly inspectionAttempts: number;
  readonly observationTargets: number;
  readonly observationQueries: number;
  readonly observationAttempts: number;
}
export type ObservationTargetResult =
  RecordingOperationResult | RecordingReconciliationDelivery;
export type ObservationTargetState = Readonly<{
  target: RecordingWireObservationTarget;
  admission: RecordingAdmissionRequest;
  accepted: RecordingAcceptedRef;
  result: ObservationTargetResult | null;
}>;
export type ObservationQueryState = Readonly<{
  request: RecordingWireObservationRequest;
  firstAttempt: ObservationAttemptToken;
  latestAttempt: ObservationAttemptToken;
  terminal: RecordingWireObservationReply | null;
}>;
export type ObservationAttemptState = Readonly<{
  request: RecordingWireObservationRequest;
  reply: RecordingWireObservationReply | null;
}>;
export type ObservationAcceptFlags = Readonly<{
  attemptStored: boolean;
  queryTerminalStored: boolean;
  targetResultStored: boolean;
}>;
export type ObservationAcceptResult = Readonly<
  | {
      ok: true;
      value: Readonly<
        { disposition: "stored" | "duplicate" } & ObservationAcceptFlags
      >;
    }
  | ({ ok: false; reason: LedgerError } & ObservationAcceptFlags)
>;
export type OriginalState = Readonly<{
  request: OriginalRequest;
  terminal: OriginalReply | null;
  learnedBy: "direct" | "inspection" | null;
}>;
export type AttemptState = Readonly<{
  request: RecordingWireCallInspectionRequest;
  reply: RecordingWireCallInspectionReply | null;
}>;
export type QueryState = Readonly<{
  request: RecordingWireCallInspectionRequest;
  original: OriginalCallToken;
  latestAttempt: InspectionAttemptToken;
  terminal: OriginalReply | null;
}>;
export interface DeliveryLedgerState {
  readonly scope: RecordingWireScope;
  readonly retired: boolean;
  readonly disposed: boolean;
  readonly stoppedReason: "invalidDocument" | "protocolViolation" | null;
  readonly usage: Readonly<{
    mutationBytes: number;
    readBytes: number;
    observationBytes: number;
    mutationIds: number;
    readIds: number;
    inspectionIdsUsed: number;
    inspectionIdsReserved: number;
    inspectionAttemptsUsed: number;
    inspectionAttemptsReserved: number;
    awaitingMutationTerminal: number;
    awaitingReadTerminal: number;
    awaitingInspectionReply: number;
    observationTargets: number;
    observationQueries: number;
    observationAttempts: number;
    awaitingObservationReply: number;
    pendingObservationQueries: number;
  }>;
}
export interface WireDeliveryLedger {
  beginOriginal(request: unknown): LedgerResult<OriginalCallToken>;
  acceptOriginal(
    token: OriginalCallToken,
    reply: unknown,
  ): DeliveryAcceptResult;
  original(token: OriginalCallToken): LedgerResult<OriginalState>;
  beginInspection(
    original: OriginalCallToken,
    request: unknown,
  ): LedgerResult<
    Readonly<{ query: InspectionQueryToken; attempt: InspectionAttemptToken }>
  >;
  repeatInspection(
    query: InspectionQueryToken,
  ): LedgerResult<InspectionAttemptToken>;
  acceptInspection(
    attempt: InspectionAttemptToken,
    reply: unknown,
  ): DeliveryAcceptResult;
  inspection(query: InspectionQueryToken): LedgerResult<QueryState>;
  attempt(token: InspectionAttemptToken): LedgerResult<AttemptState>;
  bindObservationTarget(
    source: OriginalCallToken,
  ): LedgerResult<ObservationTargetToken>;
  observationTarget(
    token: ObservationTargetToken,
  ): LedgerResult<ObservationTargetState>;
  beginObservation(
    target: ObservationTargetToken,
    request: unknown,
  ): LedgerResult<
    Readonly<{ query: ObservationQueryToken; attempt: ObservationAttemptToken }>
  >;
  repeatObservation(
    query: ObservationQueryToken,
  ): LedgerResult<ObservationAttemptToken>;
  acceptObservation(
    attempt: ObservationAttemptToken,
    reply: unknown,
  ): ObservationAcceptResult;
  observation(
    query: ObservationQueryToken,
  ): LedgerResult<ObservationQueryState>;
  observationAttempt(
    token: ObservationAttemptToken,
  ): LedgerResult<ObservationAttemptState>;
  current(): DeliveryLedgerState;
  retire(): LedgerResult<null>;
  dispose(): LedgerResult<null>;
}
