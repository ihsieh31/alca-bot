import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { modelList, streamAnthropic, streamResponses } from "./mock-api.ts";

/**
 * A local stand-in for model HTTP APIs (tests, the offline demo): the
 * OpenAI-compatible `POST /v1/chat/completions` (SSE, function tool calls with
 * arguments split across chunks) and Gemini's
 * `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`. Each request
 * is answered by `reply`, which sees the parsed body; every request is kept
 * (headers included) so tests can check the key went only where it should.
 */

export interface MockReply {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Fail with this HTTP status instead. */
  status?: number;
  usage?: { input: number; output: number };
}

export interface MockRequest {
  api: "openai" | "gemini" | "responses" | "anthropic" | "models";
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

export interface MockLlm {
  baseUrl: string;
  /** OpenAI-compatible base (`…/v1`). */
  openaiBase: string;
  /** Gemini base (`…/v1beta`). */
  geminiBase: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

const chunks = (s: string, n: number) => {
  const out: string[] = [];
  const cs = [...s];
  for (let i = 0; i < cs.length; i += n) out.push(cs.slice(i, i + n).join(""));
  return out;
};

export async function startMockLlm(
  reply: (req: MockRequest) => MockReply | Promise<MockReply>,
  o: { key?: string; modelsStatus?: number } = {},
): Promise<MockLlm> {
  const requests: MockRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const openai = req.method === "POST" && url.pathname === "/v1/chat/completions";
        const gem = /^\/v1beta\/models\/([^/:]+):streamGenerateContent$/.exec(url.pathname);
        const responses = req.method === "POST" && url.pathname === "/v1/responses";
        const anthropic = req.method === "POST" && url.pathname === "/v1/messages";
        if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/v1beta/models")) {
          requests.push({ api: "models", path: url.pathname, headers: req.headers, body: {} });
          const shape = url.pathname.startsWith("/v1beta")
            ? "gemini"
            : req.headers["anthropic-version"]
              ? "anthropic"
              : "openai";
          const got =
            shape === "gemini"
              ? req.headers["x-goog-api-key"]
              : shape === "anthropic"
                ? req.headers["x-api-key"]
                : String(req.headers.authorization ?? "").replace(/^Bearer /, "");
          if (o.key && got !== o.key) {
            res.writeHead(401).end('{"error":{"message":"bad key"}}');
            return;
          }
          if (o.modelsStatus) {
            res.writeHead(o.modelsStatus).end("{}");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(modelList(shape)));
          return;
        }
        if (!openai && !responses && !anthropic && !(req.method === "POST" && gem)) {
          res.writeHead(404).end("not found");
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        const r: MockRequest = {
          api: openai ? "openai" : responses ? "responses" : anthropic ? "anthropic" : "gemini",
          path: url.pathname,
          headers: req.headers,
          body,
        };
        requests.push(r);
        if (o.key) {
          const got =
            openai || responses
              ? String(req.headers.authorization ?? "").replace(/^Bearer /, "")
              : anthropic
                ? String(req.headers["x-api-key"] ?? "")
                : String(req.headers["x-goog-api-key"] ?? "");
          if (got !== o.key) {
            res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"bad key"}}');
            return;
          }
        }
        const out = await reply(r);
        if (out.status) {
          res
            .writeHead(out.status, { "content-type": "application/json" })
            .end('{"error":{"message":"mock failure"}}');
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
        if (responses || anthropic) {
          (responses ? streamResponses : streamAnthropic)(out, send);
          res.end();
          return;
        }
        if (openai) {
          for (const piece of chunks(out.text ?? "", 3))
            send({ choices: [{ index: 0, delta: { content: piece } }] });
          (out.toolCalls ?? []).forEach((c, i) => {
            const args = JSON.stringify(c.args);
            const [first, ...rest] = chunks(args, 5);
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: i,
                        id: `call_mock_${i}`,
                        type: "function",
                        function: { name: c.name, arguments: first ?? "" },
                      },
                    ],
                  },
                },
              ],
            });
            for (const p of rest)
              send({
                choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: p } }] } }],
              });
          });
          send({
            choices: [{ index: 0, delta: {}, finish_reason: out.toolCalls?.length ? "tool_calls" : "stop" }],
          });
          send({
            choices: [],
            usage: { prompt_tokens: out.usage?.input ?? 11, completion_tokens: out.usage?.output ?? 7 },
          });
          res.write("data: [DONE]\n\n");
        } else {
          for (const piece of chunks(out.text ?? "", 3))
            send({ candidates: [{ content: { role: "model", parts: [{ text: piece }] } }] });
          for (const c of out.toolCalls ?? [])
            send({
              candidates: [
                { content: { role: "model", parts: [{ functionCall: { name: c.name, args: c.args } }] } },
              ],
            });
          send({
            candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: out.usage?.input ?? 11,
              candidatesTokenCount: out.usage?.output ?? 7,
            },
          });
        }
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    openaiBase: `${baseUrl}/v1`,
    geminiBase: `${baseUrl}/v1beta`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
