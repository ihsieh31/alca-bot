# Alca Event Protocol v0

Source of truth: `packages/protocol/src/events.ts` (zod). Generated artefact: `spec/alca-event-protocol.v0.schema.json` (JSON Schema 2020-12) for non-TypeScript adapters. Regenerate with `pnpm spec:gen`; CI fails if it is stale (`pnpm spec:check`).

## Transport

Events are JSON objects, one per frame (NDJSON over pipes, one message per WebSocket / DataChannel frame). Over Alca Link each frame is sealed end to end; relays never see plaintext.

## Envelope

| Field       | Type                                         | Notes                                        |
| ----------- | -------------------------------------------- | -------------------------------------------- |
| `v`         | `0`                                          | Protocol major version                       |
| `id`        | `evt_…`                                      | Unique event id                              |
| `ts`        | ISO 8601 with offset                         | Producer clock; never decreases within a run |
| `sessionId` | `ses_…`, optional                            | Connection / device session                  |
| `threadId`  | `thr_…`                                      | Conversation                                 |
| `runId`     | `run_…`                                      | One agent run inside a thread                |
| `seq`       | integer ≥ 0                                  | Per run, starts at 0, +1 per event, no gaps  |
| `initiator` | `{kind: user\|schedule\|agent\|webhook, id}` | Who caused the run; policy authority         |
| `actor`     | `{kind: user\|agent\|tool\|system, id}`      | Who emitted this event                       |
| `type`      | string                                       | One of the event types below                 |
| `data`      | object                                       | Type-specific payload                        |

Ids are `<prefix>_<26 Crockford base32>` (`evt thr run msg call apr qst hof ses`, and since P2 `bot spc tab`) (10 chars time + 16 random), roughly time-sortable. All objects are strict: unknown keys are rejected in v0.

## Events

| Type                 | Data                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `run.started`        | `engine?`, `model?`, `parentRunId?`                                                                  |
| `message.delta`      | `messageId`, `role: "assistant"`, `delta`                                                            |
| `message.completed`  | `messageId`, `role: user\|assistant\|system`, `text`                                                 |
| `tool.requested`     | `callId`, `tool`, `args`, `actionClass`                                                              |
| `tool.completed`     | `callId`, `ok`, `result?`, `error?`, `durationMs`                                                    |
| `approval.requested` | `approvalId`, `callId?`, `botId?`, `actionClass`, `summary`, `expiresAt?`                            |
| `approval.resolved`  | `approvalId`, `decision: approved\|denied\|expired`, `by` (actor)                                    |
| `question.asked`     | `questionId`, `prompt`, `choices?`                                                                   |
| `question.answered`  | `questionId`, `answer`                                                                               |
| `handoff.requested`  | `handoffId`, `to: user\|agent`, `targetId?`, `surface: chat\|browser`, `reason`                      |
| `run.finished`       | `reason: completed\|cancelled\|failed\|interrupted\|max_turns\|awaiting_input\|handed_off`, `usage?` |
| `error`              | `code`, `message`, `retryable`                                                                       |

`actionClass` ∈ `read, write, execute, network, payment, send, delete, publish`. The last four always require approval.

## Ordering invariants (`checkSequence`, `RunSequenceTracker`)

Per run:

1. First event is `run.started` with `seq = 0`.
2. `seq` increases by exactly 1 (`seq_gap`, `seq_not_increasing`).
3. `threadId` never changes (`thread_mismatch`); `ts` never decreases (`ts_regressed`).
4. Nothing after `run.finished` (`after_finish`).
5. `tool.completed`, `approval.resolved`, `question.answered` must close an earlier open request exactly once.
6. No `message.delta` after that message's `message.completed`.

Runs may interleave on one stream; they are tracked independently. `orderBySeq` re-sorts a batch delivered out of order (e.g. after a relay reconnect).

## API

```ts
import { RunEmitter, newId, validateEvent, parseEvent, checkSequence } from "@alca/protocol";

const em = new RunEmitter({
  threadId: newId("thread"),
  runId: newId("run"),
  initiator: { kind: "user", id: "me" },
  actor: { kind: "agent", id: "main" },
});
const e = em.emit("run.started", { engine: "claude-code" }); // validated, seq 0
```

## Browser channel (P2)

Source: `packages/protocol/src/browser.ts`; schema `spec/alca-browser-channel.v0.schema.json`. Spaces outlive runs and a person can take one over while no run is active, so these events are **host-scoped**: envelope `v, id, ts, seq` (per channel, no `threadId` / `runId`). Desktop delivers them over `GET /api/browser/events` (SSE `event: browser`); P4 carries the same frames over Alca Link.

| Type            | Data                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `space.updated` | `space`: `SpaceState`                                                                                               |
| `space.closed`  | `spaceId`, `botId`                                                                                                  |
| `space.control` | `spaceId`, `botId`, `controller: agent\|user`, `by` (actor), `reason`                                               |
| `space.action`  | `spaceId`, `botId`, `tabId?`, `kind`, `label`, `ok`, `gated?` (always-confirm class the gate saw), `error?`         |
| `space.frame`   | not sequenced or stored: `spaceId`, `botId`, `tabId`, `mime`, base64 `data`, `width`, `height` (SSE `event: frame`) |

`SpaceState`: `spaceId`, **`botId`** (owner, never changes), `title`, `threadId?`, `workerId?` (the worker the Space belongs to, P3), `profile: shared|isolated`, `persistent`, `controller`, `status: idle|working|queued|waiting_user`, `tabs[] {tabId, title, url, loading}`, `activeTabId?`, `lastAction?`, `handoffReason?`. On connect the desktop stream first sends one `space.snapshot` per open Space (a convenience message, not part of the schema).

When control changes during a run of the Space's thread, the run also gets `handoff.requested {to, surface: "browser", targetId: spaceId, reason}`.

## Agents channel (P3)

Source: `packages/protocol/src/agents.ts`; schema `spec/alca-agents-channel.v0.schema.json`. Workers outlive the router run that started them and triggers fire with no run at all, so this channel is **host-scoped** like the browser channel (envelope `v, id, ts, seq`, per channel). It only says which workers exist and how they are doing; a worker's own text, tool calls and cards stay on the main protocol under the worker's own `runId`. Desktop sends it on the thread stream as SSE `event: agents`.

| Type               | Data                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker.updated`   | `worker`: `WorkerState`                                                                                                                                                                |
| `trigger.fired`    | `triggerId`, `eventId`, `botId`, `source`, `streamId?`, `rule: drop\|candidate\|explicit` (stage 1), `judged?: wake\|skip` (stage 2, when it ran), `outcome: dropped\|router\|workers` |
| `watchdog.flagged` | `workerId`, `botId`, `kind: stuck\|looping\|over_budget`, `detail`, `action: stopped`                                                                                                  |

`WorkerState`: `workerId`, `botId`, `threadId`, `title`, `status: queued|running|waiting|succeeded|failed|stopped|needs_review`, `speculative`, `runId?` (current or last run), `parentRunId?` (the router run that dispatched it), `steps`, `createdAt`, `startedAt?`, `finishedAt?`, `lastActivityAt?`, `stopReason?` (`user`, `router`, `watchdog.<kind>`, `restart…`), `result? {mode: inline|spill, summary, chars, spillId?}`, `subscriptions[]` (stream ids).

P6 adds three host-scoped types on the same channel:

| Type                | Data                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routine.checked`   | `routineId`, `runId`, `botId`, `threadId`, `outcome: quiet\|new\|read_failed\|capped\|ai_done\|ai_invalid\|ai_failed`, `items`, `workerId?`, `error?` (words, never a key), `nextAt?` |
| `connector.changed` | `accountId?`, `op: key\|connecting\|active\|failed\|removed\|renamed\|grants\|trigger` (no account details: a surface reads them over the API or Link)                                |
| `draft.ready`       | `draftId`, `botId`, `threadId`, `title`, `kind: reply\|message\|note` (the body is read through the API; using it is a new, confirmed request)                                        |

A connected-app action reaches people as an ordinary `approval.requested` whose `summary` names the account, the app, the action and its target (`用「工作」Gmail寄送：GMAIL_SEND_EMAIL（recipient_email：…｜subject：…｜body：…）`, each value cut to 80 characters); the phone draws its send sheet from it.

On the main protocol, `approval.requested` carries `workerId?` next to `botId?`, so a card says which bot and which worker the yes is for. A worker's cards (`approval.*`, `question.*`, `handoff.requested`) are also forwarded to the thread's stream so the person sees them where they talk to the router.

Per-worker stream: `GET /api/workers/:id/events` (SSE) replays the worker's runs' main-protocol events, then streams them live; the router's context never sees this stream.

## Team (P7)

Two more host-scoped types on the agents channel:

| Type           | Data                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `peer.updated` | `requestId`, `kind: ask\|delegate`, `fromBotId`, `toBotId`, `rootThreadId` (the person's conversation the chain started from), `fromThreadId`, `peerThreadId?`, `depth`, `status: running\|done\|failed\|denied\|refused\|stopped`, `title`, `reason?` |
| `team.changed` | `botId?`, `op: created\|updated\|archived\|restored\|lead\|rules\|providers` (no profile details: a surface reads them over the API or Link)                                                                                                           |

The conversation itself stays on the main protocol: the peer conversation is an ordinary thread, its cards are forwarded to `rootThreadId`, and the asking router reads the answer as a system note `<alca:peer-report id bot kind status>…</alca:peer-report>` (a request the teammate receives is `<alca:peer id kind from depth>…</alca:peer>`). A message's speaker is `actor.id` (`bot_…`) on `message.delta` / `message.completed`, and stored messages carry `botId` in `GET /api/threads/:id` and the `threads.get` Link op.

Loopback routes (`apps/desktop/src/team-routes.ts`): `GET /api/team` (roster with activity, archived bots, rules, lead, engines, presets, colours), `GET|POST /api/bots`, `PATCH /api/bots/:id`, `POST /api/bots/:id/archive|restore`, `POST /api/team/lead {botId|null}`, `PATCH /api/team/rules {peerApproval?, maxDepth?, maxOpen?}`, `GET /api/peers?thread=&bot=&full=1`, `GET /api/peers/:id` (with its events and the peer conversation), `POST /api/peers/:id/stop`, `POST /api/engines/providers {kind, label, baseUrl, model, key?}` (the key goes to the local vault and is never returned), `DELETE /api/engines/providers/:id`. `POST /api/threads {botId?}` starts a conversation with a bot (else the lead, else the default); `POST /api/threads/:id/messages {text, botId?}` or a leading `@name` picks who answers.

Link ops (phone): `team.get` (bots, rules, lead, default bot, engines as `{id, label, kind}` — no base URL, key or preset), `peers.list {threadId?, botId?, limit?}` and `peers.get {requestId}` need `chat`; `peers.stop {requestId}` needs `approve`. `threads.create {title?, botId?}` and `threads.send {threadId, text, botId?}` (or `@name`) as on the desktop. There is no op that creates, edits or archives a bot.

## Learning channel (P5)

Source: `packages/protocol/src/learning.ts`; schema `spec/alca-learning-channel.v0.schema.json`. Memory and skills belong to a bot, not to a run, so this channel is **host-scoped** like the browser and agents channels (envelope `v, id, ts, seq`, per channel). **Memory events never carry the remembered text**: a surface that wants it reads it over the loopback API (`/api/memory`) or a scoped Link op (`memory.list`, `memory.get`). Skill events carry what an approval sheet needs to be drawn: the name, the triggers and which action classes the steps touch. Desktop sends it on the thread stream as SSE `event: learning`; Link pushes the same events on the `learning` channel to a phone that watches a thread.

| Type             | Data                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.changed` | `botId`, `memoryId`, `op: added\|superseded\|confirmed\|rescoped\|forgotten`, `kind: fact\|preference\|person\|project`, `origin: user\|inferred`, `scope: shared\|bot`, `replaces?` (for `superseded`), `threadId?` |
| `skill.proposed` | `skill`: `SkillSummary`                                                                                                                                                                                              |
| `skill.updated`  | `skill`: `SkillSummary`, `op: approved\|rejected\|edited\|disabled\|enabled\|deleted\|used\|revision`                                                                                                                |

`SkillSummary`: `skillId`, `botId`, `name`, `status: proposed|active|disabled|rejected`, `version` (current approved version, 0 while only proposed), `pendingVersion?` (a proposal waiting for the person: a new skill or a revision), `triggers[]`, `stepCount`, `actionClasses[]` (anything always-confirm is still asked at run time), `sourceThreadId?`, `sourceWorkerId?`, `uses`, `updatedAt`.

Link ops (phone): `memory.list {q?, kind?, origin?, scope?, bot?}`, `memory.get`, `memory.update {memoryId, body?, kind?, scope?}` (an edit returns the new version's id), `memory.confirm`, `memory.forget`, `memory.export` need `chat`; `skills.list {status?: "proposed"}` and `skills.get` need `chat`; `skills.approve {skillId, version?, edit?}`, `skills.reject {skillId, version?}`, `skills.edit`, `skills.enable {skillId, enabled}`, `skills.delete` need `approve`. `threads.get` also returns `skillProposals` (the proposals learned in that thread).

## Alca Link (P4)

Source: `packages/link/src` (`relay-protocol.ts`, `spake2.ts`, `handshake.ts`, `channel.ts`, `rpc.ts`); phone RPC surface `apps/desktop/src/link-rpc.ts`; hands ops `apps/hands/src/executor.ts`. Link version `LINK_VERSION = 1`, relay protocol `v0` at `/v0/link`. All byte strings on the wire are base64url without padding. `framed(a, b, …)` = each part prefixed with its 4-byte big-endian length, concatenated; every hash and signature input below is `framed`, so no two field layouts can collide.

### Layers

```
relay frames (JSON text over WebSocket)      ← relay reads these
  └ wire messages {t: …}  (handshake, then {t:"f", d})  ← relay forwards `d` unread
      └ sealed frame (AES-256-GCM, counter)
          └ RPC message {k: …}  (req / res / evt / ready / bye)
```

A LAN path (`node/lan.ts`, `--link-lan`) carries the same wire messages directly over one WebSocket per device, with no relay frames. The loopback HTTP API is never reachable from either path.

### Relay frames (`relay-protocol.ts`)

| Who    | Sends                                                             | Gets                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core   | `core.hello {v, pub}`                                             | `challenge {nonce}`                                                                                                                                                                   |
| core   | `core.auth {sig}` over `framed("alca-relay/v0 core auth", nonce)` | `core.ready {mailbox}`                                                                                                                                                                |
| core   | `nameplate.open {ttlSec, req}`                                    | `nameplate {req, nameplate, expiresAt}`                                                                                                                                               |
| core   | `nameplate.close {nameplate}`                                     | —                                                                                                                                                                                     |
| core   | `nameplate.reopen {nameplate}` (P9, after a wrong code)           | — (the code takes the next claim; the relay caps claims per code)                                                                                                                     |
| core   | `ping` (P9, the self-check)                                       | `pong`                                                                                                                                                                                |
| core   | `ch.msg {ch, d}`, `ch.close {ch}`                                 | `ch.open {ch, via: claim\|dial, nameplate?}`, `ch.msg {ch, d}`, `ch.closed {ch}`                                                                                                      |
| device | `claim {v, nameplate}` (pairing) or `dial {v, mailbox}` (session) | `open`                                                                                                                                                                                |
| device | `probe {v, mailbox}` (P9; no channel is opened)                   | `probe {online}`, then the relay closes the socket                                                                                                                                    |
| device | `msg {d}`                                                         | `msg {d}`                                                                                                                                                                             |
| either | —                                                                 | `error {code, message}`; `code` ∈ `bad_request`, `rate_limited`, `no_such_code`, `offline`, `auth_failed`, `too_many`, `too_big`, P10: `bad_token`, `no_such_computer`, `not_enabled` |

The core keeps one connection with many channels; a device connection is one channel. **Mailbox** = the first 128 bits of the core's key fingerprint; only the holder of the key can listen on it (signed challenge). A nameplate takes one claimer at a time; success closes it, and so does any failure once the device has sent a PAKE share (G1: a wrong code burns the code on both sides). Only a connection that dropped before that makes the core send `nameplate.reopen`, up to `maxClaimsPerNameplate` claims in all (5 by default). A `probe` answers one bit — is this mailbox registered right now — and opens nothing; it shares the per-address dial limit, so it cannot be used to scan faster than dialing. The relay is in memory only and rate-limits claims and dials per client address, core hellos, messages per connection, nameplates and channels per core, nameplate TTL and frame size (4 MiB default).

### Pairing (once per device)

Code: `NNN-SSS-SSS` (9–10 digits; spaces / dashes ignored). The leading 3–4 digits are the public **nameplate**, the last 6 the **secret** (uniform, never sent). QR / link form: `<pwa>/#pair=<digits>&fp=<core fingerprint>&pk=2[&r=<relay ws url>]` — a URL fragment, so the page host never receives it. `pk=2` (G1) says the core runs PAKE v2 — the only version since v1 was removed; it stays as the version list for later negotiation.

**PAKE v2** (G1, `spake2.ts`, the only version): SPAKE2 exactly as RFC 9382, SPAKE2-P256-SHA256-HKDF-HMAC, with the device as A (`M`) and the core as B (`N`), the RFC's `M`/`N`, `w = HKDF-SHA256(ikm=secret, salt="pair|"‖nameplate, info="alca-link/v2 spake2 w", 48 bytes) mod n`, implicit identities `"alca-link device"` / `"alca-link core"`, and `AAD = framed("alca-link/v2", "pair", nameplate, offered versions, chosen version)`. Details: [CRYPTO.md](CRYPTO.md). The PAKE version is negotiated with `pk` and is independent of `LINK_VERSION`, which stays 1 so paired devices' `hello` keeps working.

**PAKE v1 is removed.** A `pair1` whose `pk` has no `2` (a pre-G1 page: no `pk`, only a v1 `share`) is answered `fail {code: "upgrade_required", message: "…update … and pair again…"}` before any PAKE; nothing is stored and the refusal is audited. There is no setting to accept it. A device that gets a `pair2` without `pk: 2` sends `fail {downgrade}` and stops.

| #   | Direction     | Message                                                                                                       |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | device → core | `{t:"pair1", v:1, pk:[2], share2: pA}`                                                                        |
| 2   | core → device | `{t:"pair2", pk:2, share: pB}` — nothing derived from `K`                                                     |
| 3   | device → core | `{t:"pair3", c: cA}`; a wrong `cA` → `fail {wrong_code}` and the code is burned                               |
| 4   | core → device | sealed `{k:"pair.core", pub, sig, name, c: cB}`; `sig` over `framed("alca-link/v2 pair", TT, "core")`         |
| 5   | device → core | (after `cB` verifies) sealed `{k:"pair.device", pub, sig, name, kind: phone\|hands, platform}` (`… "device"`) |
| 6   | core → device | sealed `{k:"pair.done", deviceId, mailbox, scopes[], coreName}` or `{k:"pair.refused", reason}`               |

Frames use keys `deriveChannelKeys(Ke, salt = "", "alca-link/v2 pair keys")`. The device checks the core key's fingerprint against `fp` from the QR (`fingerprint_mismatch`). A v1-only `pair1` gets `fail {upgrade_required}` (above). The code is burned after any outcome once a share arrived. Either side may send `{t:"fail", code, message?}` in the clear before closing.

### Session (every connection)

Signed ephemeral ECDH, SIGMA-style. `TH = SHA-256(framed("alca-link/v1 session", mailbox, deviceId, eD, nD, eC, nC))`.

| #   | Direction     | Message                                                                                                                 |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | device → core | `{t:"hello", v:1, device: deviceId, e: eD, n: nD}` (16-byte nonce)                                                      |
| 2   | core → device | `{t:"welcome", e: eC, n: nC, sig}`; `sig` by the pinned core key over `framed("alca-link/v1 session auth", TH, "core")` |
| 3   | device → core | `{t:"auth", sig}` by the device key over `… TH, "device")`                                                              |
| 4   | core → device | sealed `{k:"ready", deviceId, name, kind, scopes, coreName, relays, direct, lan?}` (P9: every relay + direct address)   |

Keys: `HKDF-SHA256(ikm = ECDH(eD, eC), salt = TH, info = "alca-link/v1 session keys", 80 bytes)` → device→core key (32), core→device key (32), session id (16). An unknown or revoked device id gets `fail {code: unknown_device | revoked}`; a revoked device stops reconnecting for good.

**Endpoints (P9).** `relays` lists the relay in use first, then the person's own stable relay and any other the core knows (as `wss://…/v0/link`); `direct` lists the 連線 direct addresses (Tailscale / LAN, `wss://`). When they change (連線 saved, or `setRelayUrl` moving to another relay) the core sends a sealed `{k:"evt", ch:"link", e:{type:"endpoints", relays, direct}}` to every live device _before_ it leaves the old path. A device stores the lists with its credentials and, on reconnect, tries the direct addresses, then each relay, remembering the one that worked — no re-pairing. The mailbox it dials never changes: it is derived from the core's long-term Link key (below).

### Google account and new devices (P10)

Source: `packages/link/src/enroll.ts`, `account.ts`; relay `services/rendezvous/src/google.ts`, `accounts.ts`. Only on a relay started with Google client IDs (`--google-client-id`, or `GOOGLE_CLIENT_IDS` on the Worker); elsewhere these ops answer `error {code: not_enabled}`.

| Who    | Sends                                                                      | Gets                                                                                                                |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| core   | `computer.register {req, idToken, name}` (after `core.ready`)              | `computer.registered {req, mailbox, fingerprint}` or `error {req, code: bad_token \| too_many}`                     |
| core   | `computer.unregister {req}`                                                | `computer.unregistered {req}`                                                                                       |
| device | `computers.list {v, idToken}`                                              | `computers {computers: [{mailbox, name, fingerprint, registeredAt, lastSeen, online}]}`, then closed                |
| device | `connect {v, mailbox, idToken}` (the token's account must own the mailbox) | `open`; the core gets `ch.open {ch, via: "connect"}`; else `error {code: bad_token \| no_such_computer \| offline}` |

**Tokens.** `idToken` is a Google ID token (JWT). The relay checks the RS256 signature against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached for the response's `max-age`, refetched on an unknown `kid` at most every 30 s), `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}, `aud` ∈ the configured client IDs (the phone site's Web client — since P12 also what the computer signs in with — and, for self-hosters, a Desktop client), `exp` / `iat` / `nbf` within 120 s, and takes `sub` only. **Account key** = base64url(HMAC-SHA-256(relay secret, `"alca-relay/v0 account" ‖ 0x00 ‖ sub`)). The registry is `account key → [{mailbox, name, fingerprint, registeredAt, lastSeen}]` (≤ 10 per account; a mailbox belongs to one account; `lastSeen` moves on each `core.ready`). Limits: token checks per client address (20 burst, 20 / min) and lists / connects per account (30 / min), on top of the dial limit.

**Enrollment** (P12) runs on a `connect` channel (`enroll.ts`). The phone shows a fresh 6-digit code (`newEnrollCode`, uniform); the person types it on the computer's sheet 「輸入手機上的驗證碼」. The code is a SPAKE2 password (`spake2.ts`, PAKE v2, the same construction as pairing) and each long-term key signs the PAKE transcript inside the channel it keys, so both ends are authenticated by the code and a relay without it can play neither side.

| #   | Direction     | Message                                                                                                                                                         |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | device → core | `{t:"enroll1", v:1, n, pk:[2], share2: pA}` — `n` 16 random bytes, fresh per try; no `2` in `pk` → `fail {upgrade_required}`                                    |
| 2   | core → device | `{t:"enroll2", pk:2, share: pB}` — sent once the person typed the code                                                                                          |
| 3   | device → core | `{t:"enroll3", c: cA}`                                                                                                                                          |
| 4   | core → device | wrong code (`cA` does not verify): `{t:"enroll.again", left}`; the phone shows a **new** code, back to 1 with a new `n`; after the last try `fail {wrong_code}` |
|     |               | right code: sealed `{k:"enroll.ok", c: cB}`                                                                                                                     |
| 5   | device → core | (after `cB` verifies) sealed `{k:"enroll.device", pub: pubD, sig, name, kind, platform}`                                                                        |
| 6   | core → device | sealed `{k:"enroll.done", pub: pubC, sig, deviceId, mailbox, scopes, coreName}` (or `{k:"enroll.refused", reason}`)                                             |

`salt = "enroll|" ‖ mailbox ‖ "|" ‖ b64u(n)`; v2: `w = passwordScalarV2(code, salt)`, `AAD = framed("alca-link/v2", "enroll", salt, offered, 2)`, `sig = ECDSA(framed("alca-link/v2 enroll", TT, mailbox, pub, "device" | "core"))`, sealed frames under `deriveChannelKeys(Ke, "", "alca-link/v2 enroll keys")`. PAKE v1 is removed: an `enroll1` without `2` in `pk` (an old phone) is refused `upgrade_required` before the computer asks for the code; a phone answered without `pk: 2` sends `fail {downgrade}`. The device checks `mailboxOf(pubC) = mailbox`, the listed fingerprint and `sig`; the core checks `sig` against `pubD`. Limits: 5 tries (`ENROLL_MAX_TRIES`, each with a fresh code since G1) and 5 minutes (`ENROLL_TTL_MS`), enforced on both ends; `enroll.again` is unauthenticated, so a forged one can only cost a try. A right code stores the device with no other prompt; afterwards the device holds ordinary credentials (`corePublicKey = pubC`) and connects with a plain `dial` + the session handshake below — no token, no code. (P10's number comparison, `enroll1…enroll4` with a commitment and a SAS, is replaced.)

**Computer sign-in through the site (P12).** The computer listens once on `127.0.0.1:<random port>` and opens `<site>/computer-signin?state=S&port=P`. The site sends the browser to Google (OIDC implicit, `response_type=id_token`, `redirect_uri=<site>/`, OAuth `state = "c." ‖ S`, `nonce = b64u(SHA-256("alca-link/v1 computer-signin " ‖ S))`), checks on return that the state is the one it stored (sessionStorage), the nonce and the port (1024–65535), then navigates top level to `http://127.0.0.1:P/google-callback#id_token=…&state=S`. That page (script pinned by a CSP hash) posts the fragment to the same listener; the computer requires its own origin, compares `state` in constant time and checks `nonce`, `aud` (the site's Web client, when known) and `exp`, then sends the token in `computer.register`. The relay verifies the signature and `aud` as above. The Desktop-client flow (PKCE + loopback, `google-signin.ts`) remains for self-hosters who configure one.

### Sealed frames (`channel.ts`)

`{t:"f", d: base64url(frame)}`, `frame = 0x01 ‖ counter (8 bytes BE) ‖ AES-256-GCM ciphertext ‖ tag`, `nonce = 0x00000000 ‖ counter`, `aad = 0x01 ‖ counter ‖ sessionId`. One key and one counter per direction, starting at 0; the receiver accepts exactly the next counter, so a replayed, dropped, reordered or tampered frame closes the channel. Counters stop at 2^48.

### RPC inside a session (`rpc.ts`)

`{k:"req", id, op, args}` → `{k:"res", id, ok:true, value}` | `{k:"res", id, ok:false, error:{code, message}}`; pushed `{k:"evt", ch, e}`; `{k:"bye", reason}`. Requests go both ways (the core calls a hands daemon).

**Phone ops** (default deny; each needs a device scope, read live from the store, so a scope change applies to the open session):

| Scope              | Ops                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`             | `threads.list`, `threads.create`, `threads.get`, `threads.send`, `threads.interrupt`, `watch.thread`, `questions.answer`, `workers.list`, `watch.worker`, `workers.stop`; P5: `memory.*`, `skills.list`, `skills.get`; P6: `connectors.status`, `connectors.refresh` (no key and no key preview), `routines.list`, `drafts.use`, `drafts.discard` |
| `approve`          | `approvals.answer`; P5: `skills.approve`, `skills.reject`, `skills.edit`, `skills.enable`, `skills.delete`; P6: `connectors.connect {toolkit, label, botId?}` (→ Connect Link), `connectors.disconnect`, `connectors.grant {accountId, botId, access}`, `routines.enable {routineId, enabled}`, `routines.run`                                    |
| `view_screen`      | `browser.spaces`, `watch.browser`                                                                                                                                                                                                                                                                                                                 |
| `control_computer` | `browser.takeover`, `browser.handback`, `browser.input`                                                                                                                                                                                                                                                                                           |
| any paired device  | `devices.list`, `devices.revoke`; P8: `push.*`; P9: `link.health` (relays, last self-check, repairs)                                                                                                                                                                                                                                              |

There is no op to set, read or clear the Composio key: it is entered on the desktop only.

Pushed channels: `alca` (main protocol of the watched thread), `agents` (worker states; P6 routine / connector / draft events), `worker` (`{workerId, e}`, the watched worker's stream), `browser` (browser channel + `space.snapshot`), `frame` (the watched Space's video; dropped while earlier frames are still in flight), `link` (device list changed; P9 `endpoints`), `learning` (learning channel, P5, while a thread is watched). The person on the phone acts as `user:device:<deviceId>`, so audit rows and resolved cards say which device said yes.

**Hands ops** (core → daemon): `ping`, `hands.info`, `shell {command, timeoutSec}` (1–600 s, own process group), `read {path}`, `write {path, content}`, `list {path}` — all inside the daemon's one work directory (real paths, symlinks that escape are refused, clean environment). The core exposes them as host tools (`hands_devices`, `hands_run`, `hands_read_file`, `hands_write_file`, `hands_list_files`), so every call passes inspect → policy gateway → audit → approval card before it is sent.

### P13: queued sends, phone forms, WebRTC direct path

**New phone ops.** All additive (optional fields, new op names) inside Link v1.

| Scope             | Op                                       | Args → value                                                                                                                                                                                        |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`            | `threads.create`, `threads.send`         | optional `clientKey` (below); a repeated key answers the first value with `duplicate: true`                                                                                                         |
| `approve`         | `team.bots.create`, `team.bots.update`   | the phone's bot fields only (name, avatar, colour, role, instructions, approval level); no folder, shell review, 提前做 or engine — those stay on the desktop. `update` needs `botId` and ≥ 1 field |
| `approve`         | `routines.create`                        | name, app (+ account), schedule (every N min / h, daily at a time in the phone's zone, once), what to do, which bot                                                                                 |
| any paired device | `rtc.offer {sdp}` → `{sdp}` (the answer) | `unavailable` when the core offers no WebRTC; `busy` while one setup for this device is already running or 8 are pending; `bad_request` for a malformed offer (SDP ≤ 16 KiB)                        |

**`clientKey` rule** (`apps/desktop/src/link-once.ts`, table `link_client_ops`, migrations 13–14). A phone gives every queued `threads.create` / `threads.send` a random key, 8–64 characters of `[A-Za-z0-9_-]`, made once when the message is typed and reused on every retry. The core runs an op at most once per `(device, clientKey)`:

1. A key already **done** answers its stored value with `duplicate: true`; nothing runs.
2. A key used for the other op is refused (`conflict`); a malformed key is refused (`bad_request`); no key = the op runs as before.
3. A new key is **reserved** (`state = 'pending'`, committed) _before_ the op runs and set to **done** with the value right after. An op that throws before writing anything (a busy thread, a missing thread) frees the key, so the same key can be retried.
4. A key found **pending** (the core stopped between running the op and storing its value) is resolved, not run blind: the core looks for this device's run of a user message with exactly this text on the thread, written from 5 s before to 60 s after the reservation and not already another key's value. Found → that run is the answer (`duplicate: true`); not found → the send was never written and runs now.
5. `threads.create` runs reservation, creation and value in one SQLite transaction, so it never stays pending.

Keys are kept 7 days (pruned when Link starts). The phone flushes its outbox in the order typed, one at a time; `busy` waits and retries; a lost connection leaves the item queued with the same key; any other error marks it failed until the person retries or removes it.

**WebRTC direct path** (`packages/link/src/rtc.ts`, core side `node/werift.ts`). Off unless settings `engineering.rtc.iceServers` lists STUN servers (`stun:` / `stuns:`, host + optional port, no credentials, ≤ 4; nothing is built in; TURN is not accepted). When on, `ready` carries `rtc: {iceServers}`.

1. Over the existing sealed session the device sends `rtc.offer {sdp}` (its offer after ICE gathering); the core answers `{sdp}`. The relay never sees SDP, ICE candidates or DTLS fingerprints.
2. When the DataChannel (label `alca-link/v1`) opens, it is a new Wire: each Link message is one JSON string in chunks of 16 KiB, every chunk prefixed `+` (more follow) or `.` (last), ≤ 4 MiB reassembled; anything else closes it.
3. The full session handshake (above) runs again on that wire against the pinned keys, then sealed frames as usual. The core binds the new session to the device that sent the offer; a session authenticated as another device is closed.
4. The device moves its traffic to the channel. When it drops, the device goes back to the relay at once and tries again after 2 minutes; one try (offer → channel → handshake) has 12 s.

診斷 shows the path (`relay` / `lan` / `rtc`) and the WebRTC state (`trying`, `up`, `failed` with the reason, `unavailable` when the page has no `RTCPeerConnection`).

## P14: add-ons, offers, reply check

Source: `packages/protocol/src/agents.ts`; schema `spec/alca-agents-channel.v0.schema.json` (regenerated by `pnpm spec:gen`, checked by `pnpm spec:check`). Four more host-scoped types on the agents channel, all additive:

| Type            | Data                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addon.capped`  | `botId`, `addonId`, `day` (`YYYY-MM-DD`, the local day the cap is for), `reason: tokens\|runs`. Sent once per bot, add-on and day; the add-on does not run again until the next local day                                                   |
| `offer.created` | `offerId`, `botId`, `threadId?`, `source` (`chat_end` for an offer at the end of a reply, `addon:proactive` for a 主動留意 card), `category: project\|errand\|money_account\|social\|study\|other`, `text` (what the person sees), `dueAt?` |
| `offer.updated` | `offerId`, `botId`, `threadId?`, `status: pending\|accepted\|declined\|ignored\|expired`, `workerId?` (the worker a 好 started). A decided offer never changes again                                                                        |
| `reply.revised` | `botId`, `threadId`, `messageId`, `text` (the rewritten reply), `issues` (≤ 6 short lines). 回覆檢查 rewrote a router reply once; the stored message now has this text and surfaces swap it in place and mark it 已修改                     |

`reply.revised` comes **after** the original reply's `message.completed`: the reply streams and is delivered as usual (the phone may already have shown it, and a push may already carry it), then the check runs and, if it rewrites, the stored text is replaced. A client that missed the event reads the revised text from `GET /api/threads/:id` / `threads.get`.

Loopback routes (`apps/desktop/src/addons-api.ts`): `GET /api/bots/:id/addons` (each built-in add-on with `enabled`, `settings`, `defaults`, `unmet` requirements in words, today's `usage {day, runs, tokens, runCap, tokenCap, capped}`, `notes`, and for 回覆檢查 `modelChoices[] {engine, model, label}`), `PATCH /api/bots/:id/addons/:addonId {enabled?, settings?}` (settings are merged over the current ones and checked whole by the add-on's schema; unknown fields are refused), `GET /api/offers?botId=` (the 主動留意 cards waiting for an answer), `POST /api/offers/:id/answer {choice: yes|later|never}`.

Link ops (phone), all inside Link v1:

| Scope     | Op                      | Args → value                                                                                                                                  |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`    | `team.bots.addons.list` | `{botId}` → `{botId, addons[]}` (the same views as the loopback route)                                                                        |
| `approve` | `team.bots.addons.set`  | `{botId, addonId, enabled?, settings?}` → the add-on's view; same checks as `PATCH`                                                           |
| `chat`    | `offers.list`           | `{botId?}` → `{offers[] {id, botId, threadId, category, text, status, dueAt, shownAt, workerId}}`                                             |
| `approve` | `offers.answer`         | `{offerId, choice: yes\|later\|never}` → the offer; `yes` starts an ordinary worker (sends, payments, deletes and posts it reaches still ask) |

**回覆檢查's model.** Its settings carry `engine` and `model`. `engine: null` (the default) runs the check and the rewrite on the bot's own router model; otherwise the pair must be one of `modelChoices` — the bot's configured model services that can run now (no missing key), each with its default model (`model: null`) and up to eight models from its built-in list. A pair outside the list is refused (`400` / `bad_request`); a stored pick whose service is later removed falls back to the router model at run time. Stored in `bot_addons.settings_json` (no migration).

A 主動留意 card that is shown also goes out as a Web Push of kind `offer` (only the kind and the offer id; the phone shows a fixed local sentence and reads the card over Link). `devices.pushPreview: none` sends no push, as for every kind.

## Worker harness

Source: `packages/protocol/src/agents.ts`; schema `spec/alca-agents-channel.v0.schema.json` (regenerated by `pnpm spec:gen`). All additive inside v0: `worker.updated` carries a richer `WorkerState`, and next round Phase D2 adds one event type, `dispatch.event` (below), plus the optional `WorkerHarness.cap`.

**`WorkerState.harness`** (`WorkerHarness`, optional — absent for a plain worker and from older cores, so older clients keep working). Read only from the store (the worker row, its dispatch, its open wait and the dispatch's append-only events) by `core/src/agents/harness-run/view.ts`, so a reload shows the same thing:

- `kind: coding|general`, `phase` (`HarnessPhase`: `queued`, `running`, `verifying`, `waiting_input`, `waiting_event`, `continued`, `done`, `partial`, `unverified`, `needs_review`, `blocked`, `failed`, `stopped`, `expired`), `dispatchId?`, `doneWhen?`.
- `verification? {state: running|passed|failed|none, round, checks[] {command, exitCode|null, ok, summary}, feedback?}` — the last round of host verification; `exitCode: null` (stopped or timed out) never counts as green.
- `budget {steps, maxSteps?, tokens, maxTokens?, waitedMs, maxRunMs?}` — `waitedMs` is time spent waiting for a person, not counted against `maxRunMs`.
- `questions?` (at most 3, `{question, options?, personOnly}`, `options[0]` is the recommended answer) and `questionsExpireAt?` (text questions only; questions with options never expire).
- `gaps?` — the independent reviewer's gaps when it found the task not met.
- `autoAllowed?` — calls that ran only because the bot is at 完全授權, `{at, tool, summary}`, newest last, at most 20.
- `cap?` (Phase D2, design §0.2.5) — the step budget ran out with the task not done: `{state: waiting|continued|refused|expired|stopped, n, continues, max, refusal?, expiresAt?}`. `waiting` = the person or the router may 續做 it until `expiresAt` (72 h); `max` is 6.

**Dispatch ledger events** (`dispatch_events`, migration 18; the only source — Phase D2 projects each committed row onto the agents channel as `dispatch.event`, see below). Kinds written by `store/src/repos/dispatches.ts` and `core/src/agents/harness-run/*`: `queued`, `run.started`, `turn.completed` / `turn.failed` / `turn.interrupted` (one per turn; a stop that races a completion is always recorded as `turn.interrupted`), `reported`, `awaiting` (an event wait, with `wakeAt`), `answered` / `woken`, `stopped`, `expired`, `requeued`, `reconciled`, `harness.progress` (throttled), `outward`, `verify.started {round}`, `verify.result {round, ok, checks}`, `auto_allowed {reason, tool, actionClass, auditId, runId, callId, summary}` (`core/src/phases/human.ts`), `snapshot {ref, commit, repo}` and (Phase D2) `cap.exhausted {n, handoff, progress}`, `continued {n, workerId, by}`, `cap.refused`, `cap.expired`; `awaiting` also carries `streamId` for a stream wait. The worker's job also records `harness.verified`, `harness.reviewed`, `harness.summary_prepared` and `harness.compacted`.

**`dispatch.event`** (Phase D2, design §0.2.3): `{dispatchId, seq, kind, at, runId?, turnId?, waitId?, workerId?, detail?}`, sent only after the row's transaction commits (a rolled-back row is never sent). `seq` is the ledger's own, strictly increasing and shared by all dispatches. `detail` carries only whitelisted short fields (`level`, `outcome`, `status`, `wakeAt`, `streamId`, `tool`, `round`, `ok`, `met`, `reason`, `steps`, `n`, `actionClass`; strings ≤ 200 chars) — never a check's output, a call's summary, a snapshot ref or a handoff path (`core/src/agents/harness-run/wire.ts`). Resume with `GET /api/dispatches/:id/events?after=<seq>` (below).

**Router tools** (host tools, not protocol events). `worker_start` (`core/src/agents/router.ts`, `HARNESS_START_PROPERTIES` in `core/src/harness/dispatch.ts`) gains optional `harness: coding|general`, `doneWhen` (≤ 400 chars), `workdir` (coding), `ownsPaths[]` (coding, ≤ 32), `checks[]` (coding, ≤ 8), `budget {maxSteps?, maxWallSec?, maxTokens?}` (can only lower the bot's caps) `handoffFrom` (the worker a handover comes from; once per task), and (Phase D2) `resultSchema` (a JSON Schema in the subset `core/src/harness/schema.ts` checks, ≤ 8 KB serialized; kept in the grants, carried to continuations) and `continueDispatch` (`dsp_…`: 續做 a dispatch whose step budget ran out; the host checks the limit of 6 and progress, the other fields come from the original task). With a `resultSchema`, `report_result` takes `data` and checks it with the same validator as tool arguments: `status=done` needs it, `partial` may carry it, a mismatch goes back to the model as a tool error. Routines dispatch with their own schema and read `data`; the text JSON is read only for a result without `data`. The independent reviewer hands its verdict through one read-only host tool, `review_verdict {met, gaps[]}`; an engine that cannot call it falls back to the first JSON object in its reply. `await_event` takes `stream` (≤ 200 chars, the same keys as `worker_start.subscribe`): the next event on that stream wakes the dispatch. A refusal from the capability check comes back as an error with code `harness.engine_unfit`. `worker_answer {workerId, answers[1..3]}` (`core/src/agents/router-answer.ts`) answers a NEEDS_INPUT in question order; a person-only question takes only the person's own words, and a second answer to the same wait is refused by the database.

**Loopback routes:**

- `POST /api/workers/:id/answer {answers: string[]}` (`apps/desktop/src/agents-routes.ts`) — the person answers a worker's NEEDS_INPUT; needs the approve key (person-only questions are answered here). Returns `{worker}`, the continuation worker's `WorkerState` (`AgentSystem.answerWorker`; at most 3 answers, each cut to 4000 chars).
- `POST /api/workers/:id/continue` (Phase D2) — the person's 續做 of a run-out task; needs the approve key; `409` with the reason (the limit of 6, two continuations without progress, nothing waiting). Returns `{worker}`.
- `GET /api/dispatches/:id/events?after=<seq>` (Phase D2) — the ledger after a cursor as `dispatch.event` data, `{events, next}`; `after` 0 (or none) is the start; a cursor older than the oldest kept row answers `410 {error: "gone", minSeq, refetch}` (re-read the worker, then start over). `GET /api/runs/:id/events?after=` answers the same `410` for a pruned run cursor.
- `GET /api/connectors/logins`, `POST /api/connectors/logins {origin, password, username?, label?, botIds?}`, `DELETE /api/connectors/logins/:id` (Phase D2, design §0.2.7) — website logins for `browser_fill_secret`. POST and DELETE need the approve key. No answer carries a password: a row is `{id, origin, username?, label?, botIds?, bots[{id, name}]}`.
- `GET /api/snapshots?dispatch=&repo=`, `POST /api/snapshots/restore {repo, ref}`, `POST /api/snapshots/purge {dispatchId? | repo? [, ref]}` (`apps/desktop/src/snapshot-routes.ts`) — the hidden git snapshots taken before coding turns at 完全授權. A restore only takes a snapshot the ledger knows and keeps the current files as one more snapshot first; git errors come back as `409`.
- `POST /api/bots` / `PATCH /api/bots/:id` accept `harness` (default harness, `reviewer`, budget caps per harness; merged by `apps/desktop/src/bot-harness.ts`, the stored per-harness engine and model are kept) and `approvalLevel: "full_access"`. Turning 完全授權 on needs the approve key (`fullAccessApproved` from `carriedApproveKey`); without it the route answers `403`. Turning it off, or editing a bot that is already at 完全授權, needs no key.

**Link ops (phone):** `workers.answer {workerId, answers[]}` needs `approve` (≤ 3 answers, each ≤ 4000 chars) and returns `{worker}`. Phase D2: `workers.continue {workerId}` (`approve`, another step budget), `dispatches.events {dispatchId, after?}` (`chat`; `{gone: true, minSeq, refetch}` for a pruned cursor), `connectors.logins` (`chat`, the list without passwords) and `connectors.logins.remove {loginId}` (`approve`). There is no op to add a website login: a password never travels the relay. The phone cannot turn 完全授權 on (`apps/desktop/src/link-team-ops.ts` refuses it); it can only turn it off.

**Waking an event wait:** the clock (`wakeDue`, when `wakeInMinutes` comes) and, since Phase D2, outside triggers: `TriggerHub.fire` first looks for open, unexpired event waits of the same bot on the event's stream (`await_event { stream }`) and calls `WorkerSupervisor.wake` for each, after the rule filter (a dropped event wakes nothing). The claim is a compare-and-set, so a repeated event wakes a wait once; the event reaches the continuation fenced as `<alca:trigger … trust="untrusted">` and the trigger event is recorded with `outcome: workers`. A wake that cannot create its continuation leaves the wait open and the event takes the normal path.

## Versioning

Additive changes inside v0 were allowed until P3. P3 has shipped, so from here on a new required field or a removed type means `v: 1` and a new schema file next to the old one; optional fields and new event types stay additive. Alca Link has its own version (`LINK_VERSION`, in every `pair1` / `hello`) and relay version (`/v0/link`); a peer with another version is refused with `fail {code: protocol}`. The PAKE version (G1) is negotiated separately with `pk`, so `LINK_VERSION` stays 1.
