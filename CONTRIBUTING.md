# Contributing to Alca Agent

Thanks for wanting to help. Alca is a local-first personal agent: it runs on the person's own computer, can
pay, send, delete and publish on their behalf, and holds their memory. That makes **safety and privacy the
first review question for every change**.

> **License.** Alca is licensed under the [Apache License 2.0](LICENSE). Unless you say otherwise, any
> contribution you submit is licensed under the same terms (section 5 of the license). Only submit work you
> have the right to license that way.

## Before you start

- Security problems go through private reporting, never a public issue: [SECURITY.md](SECURITY.md).
- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and, for the area you touch,
  [docs/SECURITY.md](docs/SECURITY.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

Node ≥ 22.18 and pnpm (the version in `package.json`'s `packageManager`; `corepack enable` picks it up).

```sh
pnpm install
pnpm check      # typecheck · lint · file size · deploy values · versions · names · prompt budget · i18n · spec · tests
pnpm evals      # scripted safety / behaviour scenarios against fake engines (report in evals-report/)
pnpm desktop:demo   # run the app with an offline demo engine
```

More ways to run it: [docs/RUNNING.md](docs/RUNNING.md). Some tests start a real headless Chromium; they
skip when none is installed and always run in CI.

## Rules the CI enforces

- `pnpm check` is green. `pnpm evals` passes (it runs as its own CI job).
- **No source file over 800 lines** (`pnpm check:size`). Split by responsibility instead.
- **No deployment-specific values in code** (`pnpm check:deploy-values`): no real domains, OAuth client
  IDs, keys or hosted URLs anywhere in the tree, docs included. Official endpoints come from config, environment or build-time
  variables with empty defaults.
- The protocol JSON Schema in `spec/` is regenerated when protocol types change (`pnpm spec:gen`).
- Biome formatting (`pnpm format`).

## Rules reviewers will hold you to

- **Payment, send, delete and publish always ask the person.** These classes are a host constant, not a
  setting; no permission level, skill, bot, routine, delegation or remote channel may skip them.
- **Every action goes through the policy gateway**, and its audit row is written before it runs.
  Classifiers fail closed (unknown → the stricter class).
- **Untrusted text stays data.** Web pages, emails, files, tool and app results are fenced as untrusted and
  never read as instructions. If your change brings new outside text into a prompt, fence it and add an
  eval scenario (`packages/evals/scenarios/`).
- **Delegation only narrows** permissions (bots, peers, workers, connected-app accounts).
- **Secrets never reach a prompt, a log, a URL, the phone or the relay.** Keys live in the local vault.
- **Clean room.** Do not copy code from other agent projects; see [docs/CLEANROOM.md](docs/CLEANROOM.md).
  Write from public documentation and specs, and say which ones in the PR.
- Tests for new behaviour, including the refusal paths. A security-relevant change needs a test that would
  have failed before it.
- User-facing text is Traditional Chinese first; keep docs in English.

## Commits and pull requests

- Small, focused commits; message style `type(scope): what and why` (`fix(link): …`, `feat(evals): …`,
  `docs: …`).
- Fill in the pull request template. Update [CHANGELOG.md](CHANGELOG.md) under _Unreleased_, and
  [docs/ROADMAP.md](docs/ROADMAP.md) when something on it changes.
- If you checked something on a real device, say which [docs/DEVICE-TEST.md](docs/DEVICE-TEST.md) items you
  ran and on what.
- Say plainly what you could **not** verify (real devices, real accounts, real CLIs). Mock-only is fine
  when it is stated.
