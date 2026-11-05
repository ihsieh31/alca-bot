export type LinkErrorCode =
  | "wrong_code"
  | "bad_signature"
  | "fingerprint_mismatch"
  | "unknown_device"
  | "revoked"
  | "replay"
  | "out_of_order"
  | "tampered"
  | "malformed"
  | "closed"
  | "timeout"
  | "protocol"
  | "refused"
  | "offline"
  | "rate_limited"
  | "no_such_code"
  | "relay"
  // P10: Google-account enrollment.
  | "denied"
  | "bad_token"
  | "no_such_computer"
  // P12: the code typed on the computer.
  | "expired"
  // G1: PAKE version negotiation.
  | "upgrade_required"
  | "downgrade";

/** Every Link failure carries a stable code; messages are for logs only. */
export class LinkError extends Error {
  readonly code: LinkErrorCode;
  constructor(code: LinkErrorCode, message: string = code) {
    super(message);
    this.name = "LinkError";
    this.code = code;
  }
}
