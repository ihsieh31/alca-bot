// Alca desktop: start the local core + loopback server.
//
//   node --disable-warning=ExperimentalWarning apps/desktop/src/main.ts [options]
//
//   --engine demo|claude-code   demo = offline scripted engine (default: demo)
//   --claude-bin "<cmd>"        command for the Claude Code CLI (default: "claude")
//   --codex-bin "<cmd>"         command for the Codex CLI a bot can pick (default: $ALCA_CODEX or "codex")
//   --workdir <dir>             folder bots without their own folder work in (default: <data>/bots/<id>/work)
//   --data-dir <dir>            state, secrets and settings (default: ~/.alca or $ALCA_DATA_DIR)
//   --port <n>                  override settings.engineering.port (default 4317)
//   --host <addr>               must be loopback; anything else refuses to start
//   --browser window|headless|off   Alca Browser (default: window)
//   --chromium <path>           Chromium / Chrome for Testing binary (default: $ALCA_CHROMIUM, then system)
//   --no-browser-download       do not fetch Chrome for Testing on first run when no Chromium is found
//   --agents router|direct      router (default): each bot = resident router + workers; direct: one turn does everything
//   --rendezvous <url>          Alca Link rendezvous (phone + hands); default: config advanced.rendezvousUrl
//   --link-lan <port>           also accept devices directly on the LAN (0 = any free port)
//   --pwa-url <url>             where the phone PWA is served, for the QR link (default: the rendezvous)
//   --composio-url <url>        Composio REST base (default: https://backend.composio.dev/api/v3.1)
//   --composio-mock             offline: a local stand-in for Composio (key: mock-composio-key-0001)
//   --no-open                   do not open the window in the browser (it opens by itself in a terminal)
//
// Environment: ALCA_UI_CODES=stdin (set by the desktop shell) — read one-time
// launch codes for the shell's window from stdin, one per line.
//
// The local token is never printed (review 2026-11-04b S2.3: as a service this
// output is core.log). The core opens the window itself, with a one-time code
// that lets it approve; `alca open` asks a running core to open another.
//
// PERF-2026-11: 80–85 % of a cold start is loading ~700 TypeScript modules
// (type stripping + compiling). The compile cache keeps V8's code cache on
// disk, so later starts skip most of it: about −15 % to the banner here.
// Static imports load before any statement runs, so the rest of the core is a
// dynamic import below this line. Review #16: the cache folder is
// <data>/cache/compile (0700), not Node's default in the shared temp dir;
// $NODE_COMPILE_CACHE, when set, wins, and NODE_DISABLE_COMPILE_CACHE=1
// turns it off. A failure to enable it only costs the speed-up.
import { enableCompileCache } from "./compile-cache.ts";

enableCompileCache();

await import("./core-main.ts");
