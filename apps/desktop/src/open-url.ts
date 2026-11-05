// Open a web page in the person's default browser (P12): the Google sign-in
// must leave the app window (a desktop shell's web view does not open
// `window.open` tabs). Only https / loopback http URLs we built ourselves.
import { spawn } from "node:child_process";

export function openInBrowser(url: string): boolean {
  if (!/^https:\/\/|^http:\/\/127\.0\.0\.1[:/]/.test(url)) return false;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => undefined);
    p.unref();
    return true;
  } catch {
    return false;
  }
}
