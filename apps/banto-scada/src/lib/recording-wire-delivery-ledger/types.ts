import type {
  RecordingWireLeaseRequest,
  RecordingWireLeaseReply,
  RecordingWireCancelRequest,
  RecordingWireCancelReply,
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
  attemptBrand: unique symbol;
export type OriginalCallToken = Readonly<{ [originalBrand]: true }>;
export type InspectionQueryToken = Readonly<{ [queryBrand]: true }>;
export type InspectionAttemptToken = Readonly<{ [attemptBrand]: true }>;
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
  readonly mutationIds: number;
  readonly readIds: number;
  readonly inspectionIds: number;
  readonly inspectionAttempts: number;
}
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
    mutationIds: number;
    readIds: number;
    inspectionIdsUsed: number;
    inspectionIdsReserved: number;
    inspectionAttemptsUsed: number;
    inspectionAttemptsReserved: number;
    awaitingMutationTerminal: number;
    awaitingReadTerminal: number;
    awaitingInspectionReply: number;
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
  current(): DeliveryLedgerState;
  retire(): LedgerResult<null>;
  dispose(): LedgerResult<null>;
}
