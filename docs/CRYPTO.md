# Cryptography in Alca Link — status: needs external review

> **This code has not been reviewed by an independent cryptographer.** Since Phase G1 the elliptic-curve
> group operations come from an audited library (`@noble/curves`), but the protocol assembly — message
> order, key confirmation, AAD and version negotiation, key schedule, identity binding — is our own code.
> Do not treat Alca Link as audited until a review is recorded at the end of this file. **An external
> review by a third party is still required; no agent or self-review substitutes for it.** Reports:
> [SECURITY.md § Reporting a vulnerability](../SECURITY.md#reporting-a-vulnerability).

Wire format and message flow: [PROTOCOL.md § Alca Link](PROTOCOL.md#alca-link-p4). Threat model:
[SECURITY.md](SECURITY.md).

## What is used, and who implements it

| Piece                                                 | Algorithm                                                                          | Implemented by                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Long-term identities (core, phone, hands)             | ECDSA P-256 / SHA-256                                                              | WebCrypto (`crypto.subtle`)                                                                        |
| Session key agreement                                 | ECDH P-256 (ephemeral)                                                             | WebCrypto                                                                                          |
| Frame sealing                                         | AES-256-GCM, strict per-direction counters                                         | WebCrypto                                                                                          |
| Key derivation, MACs                                  | HKDF-SHA-256, HMAC-SHA-256 (verify = WebCrypto `verify`, constant-time compare)    | WebCrypto                                                                                          |
| **Pairing / enrollment PAKE v2** (the only version)   | **SPAKE2 as RFC 9382, ciphersuite SPAKE2-P256-SHA256-HKDF-HMAC, key confirmation** | `packages/link/src/spake2.ts` (protocol, ours) on `@noble/curves` (group operations)               |
| P-256 group: add, negate, scalar multiply, validation | short-Weierstrass, fixed-window scalar multiply with blinding (per noble's docs)   | `@noble/curves` 2.3.0 `abstract/weierstrass.js`, built in `src/curve.ts` with the SEC 2 parameters |
| PAKE v1 — **removed**                                 | pre-G1 SPAKE2 variant: hashed `M`/`N`, our transcript, no key confirmation         | not shipped; a frozen copy in `test/fixtures/v1/` plays an old peer in the refusal tests           |

`@noble/curves` and its only dependency `@noble/hashes` are pinned to exact versions (2.3.0 / 2.3.0; lockfile
integrity in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)); a test fails if a pin or an integrity
value changes. 2.3.0 is the version the library's README lists as audited by Trail of Bits (2026-08,
scope "everything"; README read 2026-11-05). The phone page loads the same files, copied at build time
(`apps/phone-pwa/scripts/build.ts`, vendor/noble/), so the computer and the phone run one implementation.

## Threat model for pairing

- **Who attacks:** the relay (or anyone who can open a channel through it: someone who saw the nameplate,
  or who holds the person's Google token for enrollment) can play either end, record everything, and
  drop or rewrite messages. It does not know the 6-digit code.
- **What must hold:** without the code, (1) no key of the attacker's is accepted by either end; (2) a
  passive recording lets no code be tested offline; (3) an active attacker gets **one online guess per
  code** — and since G1, one guess per code _ever_: any failure after a share arrived burns a pairing
  code, and a rejected enrollment code is replaced on the phone by a new one; (4) after pairing, the
  session layer (signed ephemeral ECDH against pinned keys) does not depend on the code at all.
- **Out of scope:** whoever serves the phone page (fully trusted, SECURITY.md); a compromised computer or
  phone; the person reading the code aloud to the attacker.

## PAKE v2 (RFC 9382) as used

- Roles: the device speaks first, so it is **A** and uses `M`; the core is **B** and uses `N`. `M`, `N`
  are the RFC 9382 §6 P-256 points (`02886e2f…a12f`, `03d8bbd6…2b49`); nothing is hashed to the curve, so
  RFC 9380 hash-to-curve is not needed (v1's try-and-increment `hashToPoint` was removed with v1).
- `w = OS2IP(HKDF-SHA256(ikm = code, salt = context, info = "alca-link/v2 spake2 w", 48 bytes)) mod n`;
  context = `pair|<nameplate>` or the enrollment salt `enroll|<mailbox>|<b64u(n)>`.
- `x`, `y` uniform in `[1, n)` by rejection sampling from `crypto.getRandomValues`.
- `TT` exactly as RFC 9382 §3.3 with implicit identities `A = "alca-link device"`,
  `B = "alca-link core"`; `Ke ‖ Ka = SHA-256(TT)`;
  `KcA ‖ KcB = HKDF(Ka, nil, "ConfirmationKeys" ‖ AAD, 32)`; `cA = HMAC(KcA, TT)`, `cB = HMAC(KcB, TT)`.
- `AAD = framed("alca-link/v2", purpose, context, offered versions, chosen version)` (RFC 9382 §3.2's
  downgrade defence): a stripped or rewritten version list fails confirmation.
- **Order:** the device sends `cA` before anything keyed by `K`; the core checks it and only then sends
  `cB` (inside its first sealed frame); the device checks `cB` before it sends its identity. Long-term
  keys sign `framed("alca-link/v2 pair" | "alca-link/v2 enroll", TT, …)` inside the channel keyed by `Ke`.
- Every received point is decoded and validated by noble (on the curve, not infinity); a share that
  unblinds to infinity is refused.

## Known limits

- **JavaScript cannot promise constant time.** noble documents fixed-window, blinded secret-scalar
  multiplication and its own timing tests, and also states that JIT and GC make true constant time
  impossible in JS. We rely on that, not on our own measurement. Comparisons of secrets use WebCrypto
  HMAC `verify`.
- **Ephemeral scalars are no longer non-extractable WebCrypto keys** (v2 needs the full point `K`, which
  ECDH `deriveBits` does not give). They live in JS memory for one pairing attempt.
- **No memory-hard function on the code.** A 6-digit code has 10⁶ values; an MHF cannot stop offline
  search over that space, so the defence is that no offline test exists (SPAKE2) and the online guess is
  bounded (burned codes), not a slow hash.
- **v1 is removed.** No code path, option or setting runs v1 (`engineering.link.pakeV1` and `allowPakeV1`
  are gone). A core answers a `pair1` / `enroll1` without `2` in `pk` with `fail upgrade_required` before
  any PAKE; the refusal is audited (`detail.pake = 0`, `detail.refused = "pake_v1"`) and the 手機與裝置
  dialog says an old phone was refused. A phone offers `pk: [2]` with only the v2 share and stops with
  `downgrade` on any answer that is not `pk: 2`, so stripping v2 no longer yields v1 — it only fails.
- **Devices paired under v1 stay paired.** v1 only authenticated the exchange of the two long-term identity
  keys, which each side generates itself; no key derived from the v1 PAKE is stored or used after pairing.
  Every later connection is the session handshake (signed ephemeral ECDH against the pinned keys, fresh
  keys each time, unchanged frame format), which never ran a PAKE. A v1 pairing still gave one online
  guess per code (see the next item), so a device record from it carries the same assurance; anyone who
  wants to can revoke it in 手機與裝置 and pair again.
- **About the pre-G1 analysis (design 2 §R4.2).** The design reasoned that v1's order (the core sends a
  sealed frame before the device proves anything) lets an attacker playing the device test codes
  offline. Our test (`pake-v2.test.ts`, "v1 for comparison", run while v1 still shipped and removed with it;
  see git history before pake-v1-remove) did not reproduce that: with a committed
  wrong guess, none of 151 candidate codes — the real one included — opens v1's first sealed frame, as
  SPAKE2's security argument predicts (the attacker cannot compute `x·w·M` for another `w`). The same
  holds for v2's `cA` received by an attacker playing B. A test cannot prove absence; the reviewer is
  asked to settle it (item 3). G1's order change and confirmation MACs stand on their own (RFC 9382
  conformance, explicit authentication, early abort before any sealed frame).

## What the tests check

- `test/spake2.test.ts`: all four RFC 9382 Appendix B vectors verbatim (`pA`, `pB`, `K`, `TT`, `Ke`, `KcA`,
  `KcB`, `cA`, `cB`; key schedule cross-checked with `node:crypto`); `M`, `N` encodings; `w` re-derived
  with `node:crypto`; confirmation fails when the code, either identity, either share, or any AAD field
  (purpose, context, offered list, chosen version) differs; every `TT` field is committed; forged / flipped
  / reflected MACs refused; invalid and infinity-unblinding shares refused; `curve.ts` parameters equal
  noble's own `p256` and OpenSSL.
- `test/pake-v2.test.ts`: an attacker playing the phone receives only `pair2` / `enroll2` (a public point)
  and then `fail` / `enroll.again` — never a sealed frame; an attacker playing the computer receives `cA`,
  which verifies for none of 151 candidate codes unless its committed guess was the code (control test);
  the phone sends nothing sealed before `cB` verifies; tampering with `pk`, `pA`, `pB`, `cA` or the frame
  carrying `cB` fails; stripping `pk` / `share2` in transit → `upgrade_required`; every v1-shaped first
  message (no `pk`, `pk: [1]`, `pk` not a list, empty `pk`) is refused `upgrade_required` with nothing
  stored and no PAKE chosen; the frozen pre-G1 phone (`test/fixtures/v1/`) is refused by the new core and
  the new phone stops with `downgrade` against the frozen pre-G1 core (pairing and enrollment); a phone
  paired under v1 reconnects to the new core.
- `test/v1-removed.test.ts`: a grep guard over everything that ships (link library, desktop, phone page and
  its build script, hands, config) for v1 PAKE functions, labels, the version constant and the removed
  option / setting; it checks itself against the frozen fixtures.
- `test/crypto.test.ts` (a share-swapping man in the middle on v2 gets `fail wrong_code` and never a
  sealed frame), `test/enroll.test.ts`; relay level
  `services/rendezvous/test/relay.test.ts` (one wrong code burns the code on core and relay);
  `apps/phone-pwa/test/pake-build.test.ts` (the built phone page passes the RFC vectors and pairs /
  enrolls with the source core on v2); `test/deps.test.ts` (exact pins, lockfile integrity, notices).

## What a reviewer is asked to look at

1. v2's message order and `cA` / `cB` handling (`src/handshake.ts`, `src/enroll.ts`, `src/spake2.ts`).
2. AAD and version negotiation (`pk`; v1 removed, refused `upgrade_required` before any PAKE).
3. Whether design 2 §R4.2 (offline guessing against v1) held; our test said it did not. It now matters only
   for devices paired under v1 before the removal (they stay paired, see Known limits).
4. The use of noble: point validation, encodings, scalar sampling, the curve parameters in `curve.ts`.
5. Unchanged from before: identity binding and signature labels, the session handshake, `channel.ts`
   nonces and counters.

## Review log

| Date | Reviewer | Scope | Outcome  |
| ---- | -------- | ----- | -------- |
| —    | —        | —     | none yet |
