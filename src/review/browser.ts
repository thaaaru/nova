import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  const platformCommand: Record<string, [string, string[]]> = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const [command, args] = platformCommand[process.platform] ?? ["xdg-open", [url]];

  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}
