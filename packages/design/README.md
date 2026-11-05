# @alca/design

`tokens.css` is the single source of design tokens for the 「素 Plain」 direction (spec: [docs/design/DESIGN-SYSTEM.md](../../docs/design/DESIGN-SYSTEM.md)): native-first, Apple system greys, one accent (Alca Blue), and colour that only means state — accent for "you can tap this / this is selected", orange (`--waiting`) while Alca waits on you, red (`--danger`) for destructive or failed, green (`--success`) for a completed check. No decorative tints, no gradients.

It holds system font stacks (`--font-text`, `--font-display`, `--font-mono`; Latin face first, then PingFang TC / Noto Sans TC, no web fonts), a 4 px spacing grid (`--s-1` … `--s-14`), concentric radii (`--r-xs` 4 … `--r-xl` 16; `--r-full` only for count badges, the composer and the phone segmented thumb), motion (`--d-*`, `--e-*`), three elevation levels (`--shadow-1` … `--shadow-3`), the focus ring, and light / dark colour sets (`--bg`, `--bg-grouped`, `--bg-cell`, `--bg-elevated`, `--fill*`, `--separator`, `--hairline`, `--label`, `--label-2`, `--label-3`, `--accent`, `--accent-fill`, …). The theme follows the system; `data-theme="light" | "dark"` pins it. Each surface sets its own type scale (`--t-*`): desktop in `apps/desktop/ui/base.css` (14 px body with a CJK bump), phone in the PWA.

The 墨 Mono names (`--c-*`, `--space-*`, `--radius-*`, `--text-*`) remain as aliases for one release so screens can migrate; new code uses the names above.

Surfaces import it and define no raw colours of their own (the fixed dark caption over a live page frame is the one exception, `--overlay`). The desktop server serves it at `/ui/tokens.css`; the phone PWA imports the same file.

`src/i18n/` holds the shared string tables (`zh/` and `en/`, one file per area: `common.*`, `desktop-*`, `phone-*`); `pnpm check:i18n` keeps both languages complete and flags unused keys.
