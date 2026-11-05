# Third-party notices

Alca is licensed under the [Apache License 2.0](LICENSE). It depends on, and its release builds
redistribute, software from other projects under their own licenses. This file lists that software.
Development-only tools (TypeScript, Biome, Vitest, the Tauri CLI) are not redistributed and are not listed.

## Vendored into the phone page

`@alca/link` reaches these packages; the phone page (`apps/phone-pwa`, built by `scripts/build.ts`) copies
their files unchanged into `vendor/noble/<package>/`, next to each package's `LICENSE` (MIT License,
Copyright (c) Paul Miller, https://paulmillr.com). See [docs/CLEANROOM.md](docs/CLEANROOM.md) rule 5.

| Package         | Version (exact) | License | Used by                                     | Lockfile integrity                                                                                |
| --------------- | --------------- | ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@noble/curves` | 2.3.0           | MIT     | `@alca/link` (PAKE v2 group operations)     | `sha512-v7cY+4oWYPQszRj6ZFGzTVL7uP2TaLo1xMhWHzYC5wj0ZhOXQ5x+sBre8rF3hi8cAoi0bh1qXoovoOkdFtvqEg==` |
| `@noble/hashes` | 2.3.0           | MIT     | dependency of `@noble/curves` (HMAC, utils) | `sha512-oN+QwyX7VSHotibwubG3kpzbwKrfnyR6OOO+3Nk/53ADL7FmgHHz4TgrbaYKvvOw09u6QTx0oiH1cNCIOuN0CQ==` |

`packages/link/test/deps.test.ts` fails if the pins, the lockfile integrity values or this table drift
apart. Upgrading: read the upstream diff and release notes, update the pin, the lockfile and this table in
one change.

## Packed with the core (Node runtime dependencies)

`scripts/pack-core.ts` copies the runtime dependencies of the workspace packages, with their own
`LICENSE` files, into the packed core that the installers and the desktop app ship.

| Package                                                                                    | Version | License      | Pulled in by                                   |
| ------------------------------------------------------------------------------------------ | ------- | ------------ | ---------------------------------------------- |
| `zod`                                                                                      | 4.6.7   | MIT          | `@alca/protocol`, `@alca/core`, `@alca/config` |
| `@noble/curves`, `@noble/hashes`                                                           | 2.3.0   | MIT          | `@alca/link`                                   |
| `quickjs-emscripten-core`                                                                  | 0.32.0  | MIT          | `@alca/browser` (sandboxed page scripts)       |
| `@jitl/quickjs-wasmfile-release-sync`, `@jitl/quickjs-ffi-types`                           | 0.32.0  | MIT          | `quickjs-emscripten-core`                      |
| `werift` (optional)                                                                        | 0.26.0  | MIT          | `@alca/link` (WebRTC direct path)              |
| `buffer` 6.0.3, `base64-js` 1.5.1                                                          | —       | MIT          | `werift`                                       |
| `ieee754`                                                                                  | 1.2.1   | BSD-3-Clause | `buffer`                                       |
| `multicast-dns` 7.2.5, `dns-packet` 5.6.1, `@leichtgewicht/ip-codec` 2.0.5, `thunky` 1.1.0 | —       | MIT          | `werift`                                       |
| `mediabunny`                                                                               | 1.65.0  | MPL-2.0      | `werift`                                       |
| `@types/dom-webcodecs` 0.1.13, `@types/dom-mediacapture-transform` 0.1.12                  | —       | MIT          | `mediabunny` (type declarations only)          |

Notes:

- `mediabunny` is under the Mozilla Public License 2.0, a file-level copyleft license that is compatible with
  Apache-2.0 when its files are redistributed unmodified. Alca does not modify it; its source is available at
  https://github.com/Vanilagy/mediabunny. If you change its files, those changed files stay under MPL-2.0.
- The `werift` package on npm does not include a license file; its `package.json` declares MIT
  (https://github.com/shinyoshiaki/werift-webrtc).

## Desktop app (Tauri, Rust crates)

`apps/desktop-shell/src-tauri/Cargo.lock` pins about 470 crates (Tauri 2 and its dependencies). All of them are
under permissive licenses (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, CC0-1.0, Unlicense; most dual
MIT OR Apache-2.0), with these exceptions worth knowing:

- MPL-2.0 (file-level copyleft, unmodified, compatible with Apache-2.0): `cssparser`, `cssparser-macros`,
  `selectors`, `dtoa-short`, `option-ext`.
- `r-efi` is `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; Alca uses it under MIT or Apache-2.0.

No crate is GPL- or AGPL-only. To re-check after a dependency update, run a license tool such as
`cargo deny check licenses` or `cargo about` in `apps/desktop-shell/src-tauri`.
