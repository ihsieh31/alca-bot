// 用 Google 登入 (P10, P12), desktop side: sign in with Google on this
// computer and list it under that account on the relay; then a new phone
// that signs in with the same account and picks this computer shows a
// 6-digit code, and a sheet here asks for it 「輸入手機上的驗證碼」. The code
// is a PAKE password (enroll.ts): a right code stores the phone's key with no
// further prompt, like a paired phone (same device list, same revoke); later
// connections use its key only.
//
// Two ways to sign in: through the phone site (the default; its Web client,
// no secret on this computer) or, for self-hosters who set one up, a Desktop
// OAuth client (installed-app flow, google-signin.ts).
import {
  type CodeRequest,
  type EnrollHandler,
  type LinkHost,
  type PairedDevice,
  parseEnrollCode,
} from "@alca/link";
import { type GoogleOAuthConfig, type GoogleSignIn, startGoogleSignIn } from "./google-signin.ts";
import type { LinkPrefs } from "./link-prefs.ts";
import { type SiteSignInConfig, startSiteSignIn } from "./site-signin.ts";

export interface EnrollmentView {
  id: string;
  /** Tries left for this code, this one included. */
  left: number;
  /** The last try was wrong. */
  wrong: boolean;
  /** waiting for the person to type · checking with the phone. */
  state: "code" | "checking";
  createdAt: string;
  expiresAt: string;
}

export interface RemoteView {
  /** Google sign-in can be used (the site or a Desktop client is configured). */
  available: boolean;
  /** How the computer signs in: through the phone site, or a self-hosted Desktop client. */
  via?: "site" | "desktop";
  state: "off" | "signing_in" | "registering" | "on" | "error";
  email?: string;
  registeredAt?: string;
  /** The relay this computer is listed on. */
  relayUrl?: string;
  /** While signing in: the page to open in the browser. */
  authUrl?: string;
  /** The core opened `authUrl` in the default browser itself. */
  opened?: boolean;
  error?: string;
}

/** What 送出 on the code sheet answers. */
export type CodeOutcome =
  | { ok: true; label: string }
  | { ok: false; error: "wrong_code"; left: number }
  | { ok: false; error: "failed"; message: string };

interface Pending extends EnrollmentView {
  /** The person's answer for the current try. */
  answer?: { resolve(code: string): void; reject(e: Error): void };
  /** Who waits for the outcome of the code just typed. */
  outcome?: (o: CodeOutcome) => void;
}

const BROWSERS = /(Safari|Chrome|Firefox|Edge|Samsung)/;

/** 「iPhone · Safari」 from the name the phone gave and its browser label. */
export function deviceLabel(name: string, platform: string): string {
  const b = BROWSERS.exec(platform)?.[1];
  return b ? `${name} · ${b}` : platform ? `${name} · ${platform}` : name;
}

export class RemoteAccess {
  private pending = new Map<string, Pending>();
  private signIn: GoogleSignIn | undefined;
  private state: RemoteView["state"] = "off";
  private error: string | undefined;
  private n = 0;
  private readonly o: {
    host: LinkHost;
    /** Self-host: a Desktop OAuth client (wins when set). */
    google: GoogleOAuthConfig | undefined;
    /** The phone site that signs this computer in (official default or 連線). */
    site: () => SiteSignInConfig | undefined;
    coreName: () => string;
    prefs(): LinkPrefs;
    savePrefs(p: LinkPrefs): void;
    /** Store an enrolled device (same checks as pairing); returns its id and scopes. */
    addDevice(d: PairedDevice): { id: string; scopes: string[] };
    changed(): void;
    /** Open the sign-in page in the default browser (false = the UI opens it). */
    openUrl?: (url: string) => boolean;
    fetch?: typeof fetch;
  };
  private opened = false;

  constructor(o: RemoteAccess["o"]) {
    this.o = o;
    if (o.prefs().google) this.state = "on";
  }

  private via(): RemoteView["via"] {
    if (this.o.google?.clientId) return "desktop";
    return this.o.site() ? "site" : undefined;
  }

  view(): RemoteView {
    const g = this.o.prefs().google;
    const via = this.via();
    return {
      available: !!via,
      ...(via ? { via } : {}),
      state: this.state,
      ...(g?.email ? { email: g.email } : {}),
      ...(g ? { registeredAt: g.registeredAt, relayUrl: g.relayUrl } : {}),
      ...(this.signIn && this.state === "signing_in"
        ? { authUrl: this.signIn.authUrl, opened: this.opened }
        : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Start the Google sign-in; the returned view carries the page to open. */
  async start(): Promise<RemoteView> {
    const via = this.via();
    if (!via)
      throw new Error("這個版本沒有設定 Alca 網站；請在「連線」填自架的網站，或設定 Google 用戶端 ID");
    this.signIn?.cancel();
    const site = this.o.site();
    const s =
      via === "desktop" && this.o.google
        ? await startGoogleSignIn(this.o.google, this.o.fetch ? { fetch: this.o.fetch } : {})
        : await startSiteSignIn(site as SiteSignInConfig);
    this.signIn = s;
    this.state = "signing_in";
    this.error = undefined;
    this.opened = this.o.openUrl?.(s.authUrl) ?? false;
    void s.result.then(
      async (r) => {
        if (this.signIn !== s) return;
        this.state = "registering";
        this.o.changed();
        try {
          await this.o.host.registerComputer(r.idToken, this.o.coreName());
          this.o.savePrefs({
            ...this.o.prefs(),
            google: {
              ...(r.email ? { email: r.email } : {}),
              relayUrl: this.o.host.relayUrl,
              registeredAt: new Date().toISOString(),
            },
          });
          this.state = "on";
        } catch (e) {
          this.state = "error";
          this.error =
            e instanceof Error &&
            /bad_token|not accepted/.test(`${(e as { code?: string }).code} ${e.message}`)
              ? "會合伺服器不接受這個 Google 登入（用戶端 ID 不符？）"
              : `無法登記這台電腦：${e instanceof Error ? e.message : String(e)}`;
        }
        this.signIn = undefined;
        this.o.changed();
      },
      (e: Error) => {
        if (this.signIn !== s) return;
        this.signIn = undefined;
        this.state = this.o.prefs().google ? "on" : "error";
        this.error = e.message;
        this.o.changed();
      },
    );
    return this.view();
  }

  /** 停用: off the account's list on the relay. Devices already allowed keep working (revoke them separately). */
  async disable(): Promise<RemoteView> {
    this.signIn?.cancel();
    this.signIn = undefined;
    await this.o.host.unregisterComputer().catch(() => undefined);
    const { google: _g, ...rest } = this.o.prefs();
    this.o.savePrefs(rest);
    this.state = "off";
    this.error = undefined;
    for (const p of [...this.pending.values()]) this.cancel(p.id, "電腦停用了 Google 遠端");
    this.o.changed();
    return this.view();
  }

  enrollments(): EnrollmentView[] {
    return [...this.pending.values()].map(({ answer: _a, outcome: _o, ...v }) => v);
  }

  /** 送出 on the sheet: the code typed; resolves when the phone answered (right, wrong, or gone). */
  submitCode(id: string, typed: string): Promise<CodeOutcome> | undefined {
    const p = this.pending.get(id);
    if (!p?.answer) return undefined;
    const code = parseEnrollCode(typed);
    if (!code) return Promise.resolve({ ok: false, error: "failed", message: "驗證碼是 6 位數字" });
    const a = p.answer;
    delete p.answer;
    p.state = "checking";
    const out = new Promise<CodeOutcome>((r) => {
      p.outcome = r;
    });
    a.resolve(code);
    this.o.changed();
    return out;
  }

  /** 取消 on the sheet: the phone is told no. */
  cancel(id: string, why = "電腦上按了取消"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.answer?.reject(new Error(why));
    delete p.answer;
    this.pending.delete(id);
    this.o.changed();
    return true;
  }

  /** P10 compatibility: {allow:false} cancels; there is nothing to allow without the code. */
  decide(id: string, allow: boolean): boolean {
    return allow ? false : this.cancel(id);
  }

  /** LinkHost's onEnroll: one handler per new-device channel. */
  readonly onEnroll = (): EnrollHandler => {
    if (this.pending.size >= 4) throw new Error("電腦上還有其他裝置在等你輸入驗證碼");
    const id = `enr_${Date.now().toString(36)}${(++this.n).toString(36)}`;
    let p: Pending | undefined;
    const report = (o: CodeOutcome) => {
      const w = p?.outcome;
      if (p) delete p.outcome;
      w?.(o);
    };
    return {
      askCode: (r: CodeRequest) =>
        new Promise<string>((resolve, reject) => {
          if (!p) {
            p = {
              id,
              left: r.left,
              wrong: r.wrong,
              state: "code",
              createdAt: new Date().toISOString(),
              expiresAt: new Date(r.expiresAt).toISOString(),
            };
            this.pending.set(id, p);
          } else if (!this.pending.has(id)) return reject(new Error("已取消"));
          if (r.wrong) report({ ok: false, error: "wrong_code", left: r.left });
          Object.assign(p, { left: r.left, wrong: r.wrong, state: "code", answer: { resolve, reject } });
          this.o.changed();
        }),
      accept: async (d: PairedDevice) => {
        const rec = this.o.addDevice(d);
        report({ ok: true, label: deviceLabel(d.name, d.platform) });
        return { deviceId: rec.id, scopes: rec.scopes };
      },
      end: (r) => {
        if (!r.ok)
          report(
            r.error === "wrong_code"
              ? { ok: false, error: "wrong_code", left: 0 }
              : { ok: false, error: "failed", message: failText(r.error) },
          );
        if (p) p.answer?.reject(new Error("ended"));
        this.pending.delete(id);
        this.o.changed();
      },
    };
  };

  close() {
    this.signIn?.cancel();
    for (const p of [...this.pending.values()]) this.cancel(p.id, "電腦關閉了");
  }
}

function failText(code: string | undefined): string {
  if (code === "expired") return "驗證碼已過期，請在手機上重新產生";
  if (code === "closed") return "手機離開了連線";
  if (code === "refused") return "這支手機已經配對過，或它的金鑰已被撤銷";
  return "沒有完成連線，請在手機上重試";
}
