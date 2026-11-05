# Security policy

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab → **Report a vulnerability**
   (<https://github.com/ihsieh31/alca-bot/security/advisories/new>).
2. Describe the problem, the affected version or commit, and the steps or proof of concept to reproduce
   it. Say what an attacker needs (a paired phone, the relay, a malicious web page or email, local access …).
3. If you can, suggest a fix or a mitigation.

Only the maintainers and you can see the report. If private reporting is not available to you, open an
issue that says only "security contact requested" (no details) and a maintainer will reach out.

### What to expect

- An acknowledgement within **7 days**.
- An assessment (accepted / not a vulnerability / needs more information) within **30 days**.
- A fix, an advisory (with a CVE where it applies) and credit to you, unless you ask not to be named.
  We ask you to keep the issue private until a fix is released or 90 days have passed, whichever comes first;
  we will tell you if we need longer and why.

There is no bug bounty.

## Scope

In scope: everything in this repository — the core (`packages/*`, `apps/desktop`), the phone PWA, the hands
daemon, the relay (`services/*`), the installer scripts and the release workflow. Particularly welcome:

- a way around an approval card (payment / send / delete / publish must always ask), the policy gateway,
  or a bot's or device's scope;
- prompt injection that makes the agent act (text in a web page, email, file or tool result treated as an
  instruction);
- anything that breaks Alca Link's guarantees (a relay reading or changing frames, getting a key accepted
  without the code, replay) — the hand-written P-256 / SPAKE2 code has not had an external review yet, see
  [docs/CRYPTO.md](docs/CRYPTO.md);
- secrets leaving the local vault, the loopback API reachable from a web page, a path out of the hands
  work directory.

Out of scope: the third-party services Alca talks to (model providers, Composio, Google), problems that
need an attacker who already controls the core's computer or the person's unlocked phone, and the limits
the security model already states as known (see [docs/SECURITY.md](docs/SECURITY.md)).

## Supported versions

Alca is pre-1.0. Only the latest release and `main` receive fixes. There is no published release yet (`v0.2.0` is a draft); until then `main` is the supported version. How releases are signed and how an installed core verifies an update: [docs/RELEASE.md](docs/RELEASE.md).

Pairing: a computer accepts only pairing protocol v2 (PAKE v2, RFC 9382 with key confirmation). **PAKE v1 has been removed**, with no setting to re-enable it: a device that offers only v1 is refused (`upgrade_required`, audited, nothing stored). Phones, pages and computers set up with `v0.2.0` speak only v1: they must update and pair again ([docs/RELEASE.md § 5](docs/RELEASE.md)).

## Security model

How Alca is meant to resist each party (relay, network, PWA host, paired devices, connected apps), and its
known limits: [docs/SECURITY.md](docs/SECURITY.md). Cryptography and its review status:
[docs/CRYPTO.md](docs/CRYPTO.md).
