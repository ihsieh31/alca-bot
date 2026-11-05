// base64url without padding (RFC 4648 §5), the encoding every Web Push key uses.
export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ""), "base64url");
