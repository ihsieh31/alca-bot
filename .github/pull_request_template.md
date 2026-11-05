## What and why

<!-- What this changes and the problem it solves. Link the issue: "Closes #…". -->

## How it was tested

- [ ] `pnpm check` is green
- [ ] `pnpm evals` passes (add a scenario if this changes routing, approvals, memory, routines, delegation or how outside text reaches a prompt)
- [ ] New behaviour has tests, including the refusal paths

**Not verified** (real devices, real accounts, real CLIs — say so plainly):

## Safety checklist

- [ ] Payment / send / delete / publish still ask every time, whatever the level, skill, bot, routine, delegation or channel
- [ ] Every new action goes through the policy gateway; classifiers fail closed
- [ ] Outside text (web, email, files, tool / app results) is fenced as untrusted data
- [ ] No secret reaches a prompt, log, URL, the phone or the relay
- [ ] No deployment-specific values in code (`pnpm check:deploy-values`)
- [ ] Clean room: nothing copied from other agent projects (docs/CLEANROOM.md); public sources named here

## Docs

- [ ] CHANGELOG.md (_Unreleased_) and, if something on it changed, docs/ROADMAP.md
