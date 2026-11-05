// The few Cloudflare Workers runtime types this package uses (no dependency
// on @cloudflare/workers-types; shapes from developers.cloudflare.com).
export interface CfWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", h: (e: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close" | "error", h: () => void): void;
  readonly readyState: number;
}

export interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(o?: { prefix?: string }): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  /** Everything in this object (the hooks mailbox removes itself after a week idle). */
  deleteAll?(): Promise<void>;
  /** Wake the object's `alarm()` at this time (ms since the epoch). */
  setAlarm?(at: number): Promise<void>;
}

export interface DurableState {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T>;
}

export interface DurableStub {
  fetch(req: Request): Promise<Response>;
}

export interface DurableNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStub;
}

export interface RelayEnv {
  RELAY: DurableNamespace;
  /** Review M3: one HookObject per webhook mailbox id (`/v0/hooks/<id>`); unset = no hooks. */
  HOOKS?: DurableNamespace;
  /** Comma list of accepted Google OAuth client IDs (Web + Desktop). */
  GOOGLE_CLIENT_IDS?: string;
  /** `wrangler secret put ALCA_RELAY_SECRET`. */
  ALCA_RELAY_SECRET?: string;
  /** Comma list of browser origins allowed to open a relay socket (the phone site). Required with RELAY_MODE=production. */
  ALLOWED_ORIGINS?: string;
  /**
   * `production` (the official deployment): refuse browser sockets while ALLOWED_ORIGINS is
   * empty and report the relay as not ok in /healthz. Anything else: a loud warning only.
   */
  RELAY_MODE?: string;
  /** Review M2: sockets this one Durable Object accepts (default 5000); past it, `relay is full`. */
  MAX_SOCKETS?: string;
  /** Tests: a fake issuer's JWKS. */
  GOOGLE_JWKS_URL?: string;
}
