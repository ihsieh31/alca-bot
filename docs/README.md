# Documentation

Start with the [README](../README.md) (繁體中文) or [README.en.md](../README.en.md) (English) for what Alca is and how
to install it. The pages below go deeper.

## Using and running Alca

| Page                             | What it covers                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [RUNNING.md](RUNNING.md)         | Every way to start the core: the demo engine, real engines, the browser, phone pairing, the always-on service, installers, backups, all command-line options |
| [PROVIDERS.md](PROVIDERS.md)     | Engines and model providers: kinds, built-in models, custom providers, approval levels                                                                       |
| [DEPLOY.md](DEPLOY.md)           | Running the hosted pieces yourself: the relay (Node or Cloudflare Workers), the phone site, Google sign-in                                                   |
| [RELEASE.md](RELEASE.md)         | How releases are built and signed, the publish checklist, `alca update`                                                                                      |
| [DEVICE-TEST.md](DEVICE-TEST.md) | Manual test checklist for real iPhones, Macs and Android phones                                                                                              |

## How it works

| Page                                               | What it covers                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                 | Module map, trust boundaries, the data flow of one turn, implementation notes |
| [PROTOCOL.md](PROTOCOL.md)                         | Alca Event Protocol v0, its channels, and the Alca Link wire format           |
| [SECURITY.md](SECURITY.md)                         | Security model: assets, parties, decisions, known limits                      |
| [CRYPTO.md](CRYPTO.md)                             | The cryptography in Alca Link and what an external reviewer should look at    |
| [design/DESIGN-SYSTEM.md](design/DESIGN-SYSTEM.md) | The 「素 Plain」 design system for the desktop and phone UI                   |
| [design/CARE-MOMENTS.md](design/CARE-MOMENTS.md)   | 關心時刻: when Alca says one caring line, and when it stays quiet             |
| [design/PERFORMANCE.md](design/PERFORMANCE.md)     | Performance decisions and measurements (code comments tagged `PERF-2026-11`)  |

## Project

| Page                                           | What it covers                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [ROADMAP.md](ROADMAP.md)                       | What is built, what is not verified yet, what comes next                   |
| [CLEANROOM.md](CLEANROOM.md)                   | Clean-room rules: how Alca learns from other projects without copying them |
| [screenshots/README.md](screenshots/README.md) | The screenshots in this folder and how to regenerate them                  |
| [../CONTRIBUTING.md](../CONTRIBUTING.md)       | How to contribute                                                          |
| [../SECURITY.md](../SECURITY.md)               | Reporting a vulnerability                                                  |
| [../CHANGELOG.md](../CHANGELOG.md)             | What changed in each version                                               |
