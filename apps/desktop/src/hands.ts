import { isAlwaysConfirm } from "@alca/config";
import type { HostTool } from "@alca/core";
import type { HostSession } from "@alca/link";
import { classifyToolCall } from "@alca/policy";

/**
 * Hands (plan v4 §7): stateless executors on other machines, paired over
 * Alca Link. The core keeps all state; a hands daemon only runs what the core
 * sends, inside its own allowed work directory. Every call is a host tool, so
 * it goes through inspect → policy gateway (+ audit) → approval card like any
 * other tool before a single byte leaves for the device.
 */

export interface HandsInfo {
  deviceId: string;
  name: string;
  online: boolean;
  workdir?: string;
  platform?: string;
}

export class HandsRegistry {
  private live = new Map<string, { session: HostSession; info: Record<string, unknown> }>();
  private known: () => Array<{ id: string; name: string }>;

  constructor(known: () => Array<{ id: string; name: string }> = () => []) {
    this.known = known;
  }

  setKnown(known: () => Array<{ id: string; name: string }>): void {
    this.known = known;
  }

  attach(s: HostSession): void {
    const entry = { session: s, info: {} as Record<string, unknown> };
    this.live.set(s.device.id, entry);
    s.peer.onClose(() => {
      if (this.live.get(s.device.id) === entry) this.live.delete(s.device.id);
    });
    // The daemon says where it works; nothing else is asked of it.
    s.peer
      .request<Record<string, unknown>>("hands.info", {}, 10_000)
      .then((info) => {
        entry.info = info ?? {};
      })
      .catch(() => undefined);
  }

  list(): HandsInfo[] {
    return this.known().map((d) => {
      const l = this.live.get(d.id);
      return {
        deviceId: d.id,
        name: d.name,
        online: !!l,
        ...(typeof l?.info.workdir === "string" ? { workdir: l.info.workdir } : {}),
        ...(typeof l?.info.platform === "string" ? { platform: l.info.platform } : {}),
      };
    });
  }

  /** The device a call goes to: by id or name, else the only one online. */
  pick(device?: unknown): { id: string; name: string; session: HostSession } {
    const all = this.list();
    const want = typeof device === "string" && device.trim() ? device.trim() : undefined;
    const d = want ? all.find((x) => x.deviceId === want || x.name === want) : all.filter((x) => x.online)[0];
    if (!d) throw new Error(want ? `沒有叫「${want}」的手腳裝置` : "沒有在線上的手腳裝置");
    const l = this.live.get(d.deviceId);
    if (!l) throw new Error(`手腳裝置「${d.name}」目前離線`);
    if (!want && all.filter((x) => x.online).length > 1)
      throw new Error("有多台手腳裝置在線上，請指定 device");
    return { id: d.deviceId, name: d.name, session: l.session };
  }
}

const deviceArg = { device: { type: "string", description: "手腳裝置的名字或 id（只有一台在線時可省略）" } };

function deviceName(reg: HandsRegistry, device: unknown): string {
  try {
    return reg.pick(device).name;
  } catch {
    return typeof device === "string" && device ? device : "手腳裝置";
  }
}

async function call(
  reg: HandsRegistry,
  device: unknown,
  op: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs: number,
) {
  const d = reg.pick(device);
  const p = d.session.peer.request<{ text?: string } & Record<string, unknown>>(op, args, timeoutMs);
  const aborted = new Promise<never>((_, rej) => {
    if (signal.aborted) rej(new Error("已中斷"));
    signal.addEventListener("abort", () => rej(new Error("已中斷")), { once: true });
  });
  const r = await Promise.race([p, aborted]);
  return { device: d, r };
}

export function handsTools(reg: HandsRegistry): HostTool[] {
  return [
    {
      spec: {
        name: "hands_devices",
        description: "列出已配對的手腳裝置（其他電腦上的無狀態執行器）與是否在線",
        inputSchema: { type: "object", properties: {} },
      },
      actionClass: "read",
      run: async () => JSON.stringify(reg.list()),
    },
    {
      spec: {
        name: "hands_run",
        description: "在手腳裝置的允許工作資料夾裡執行一個 shell 指令，回傳結束碼與輸出",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeoutSec: { type: "number", description: "預設 60，最多 600" },
            ...deviceArg,
          },
          required: ["command"],
        },
      },
      actionClass: "execute",
      inspect: async (a) => {
        const command = String(a.command ?? "");
        const cls = classifyToolCall("hands_run", { command });
        return {
          ...(isAlwaysConfirm(cls) ? { actionClass: cls } : {}),
          summary: `在「${deviceName(reg, a.device)}」執行：${command.slice(0, 200)}`,
          target: `hands:${deviceName(reg, a.device)}`,
        };
      },
      run: async (a, signal) => {
        const timeoutSec = Math.min(Math.max(Number(a.timeoutSec) || 60, 1), 600);
        const { r } = await call(
          reg,
          a.device,
          "shell",
          { command: String(a.command ?? ""), timeoutSec },
          signal,
          (timeoutSec + 10) * 1000,
        );
        return JSON.stringify(r);
      },
    },
    {
      spec: {
        name: "hands_read_file",
        description: "讀手腳裝置工作資料夾裡的一個文字檔",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, ...deviceArg },
          required: ["path"],
        },
      },
      actionClass: "read",
      run: async (a, signal) => {
        const { r } = await call(reg, a.device, "read", { path: String(a.path ?? "") }, signal, 30_000);
        return String(r.text ?? "");
      },
    },
    {
      spec: {
        name: "hands_write_file",
        description: "在手腳裝置工作資料夾裡寫入（覆寫）一個文字檔",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" }, ...deviceArg },
          required: ["path", "content"],
        },
      },
      actionClass: "write",
      inspect: async (a) => ({
        summary: `在「${deviceName(reg, a.device)}」寫入 ${String(a.path ?? "")}（${String(a.content ?? "").length} 字）`,
        target: `hands:${deviceName(reg, a.device)}:${String(a.path ?? "")}`,
      }),
      run: async (a, signal) => {
        const { r } = await call(
          reg,
          a.device,
          "write",
          { path: String(a.path ?? ""), content: String(a.content ?? "") },
          signal,
          30_000,
        );
        return JSON.stringify(r);
      },
    },
    {
      spec: {
        name: "hands_list_files",
        description: "列出手腳裝置工作資料夾裡的檔案",
        inputSchema: { type: "object", properties: { path: { type: "string" }, ...deviceArg } },
      },
      actionClass: "read",
      run: async (a, signal) => {
        const { r } = await call(reg, a.device, "list", { path: String(a.path ?? ".") }, signal, 30_000);
        return JSON.stringify(r);
      },
    },
  ];
}
