import type { Readable, Writable } from "node:stream";
import type { CdpTransport } from "./connection.ts";

/**
 * `--remote-debugging-pipe` transport: Chromium reads commands on fd 3 and
 * writes responses on fd 4, each message terminated by a NUL byte. No port is
 * opened, so no other local process can attach to the browser.
 */
export class PipeTransport implements CdpTransport {
  private readonly out: Writable;
  private buf: Buffer = Buffer.alloc(0);
  private readonly messageFns: Array<(t: string) => void> = [];
  private readonly closeFns: Array<(r: string) => void> = [];
  private done = false;

  constructor(toBrowser: Writable, fromBrowser: Readable) {
    this.out = toBrowser;
    fromBrowser.on("data", (chunk: Buffer) => this.onData(chunk));
    fromBrowser.on("close", () => this.finish("pipe closed"));
    fromBrowser.on("error", (e) => this.finish(`pipe error: ${e.message}`));
    toBrowser.on("error", (e) => this.finish(`pipe error: ${e.message}`));
  }

  send(text: string): void {
    if (this.done) return;
    this.out.write(`${text}\0`);
  }
  onMessage(fn: (text: string) => void): void {
    this.messageFns.push(fn);
  }
  onClose(fn: (reason: string) => void): void {
    this.closeFns.push(fn);
  }
  close(): void {
    this.out.end();
    this.finish("closed by host");
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let at = this.buf.indexOf(0);
    while (at >= 0) {
      const text = this.buf.subarray(0, at).toString("utf8");
      this.buf = this.buf.subarray(at + 1);
      for (const fn of this.messageFns) fn(text);
      at = this.buf.indexOf(0);
    }
  }

  private finish(reason: string): void {
    if (this.done) return;
    this.done = true;
    for (const fn of this.closeFns) fn(reason);
  }
}
