import { networkInterfaces } from "node:os";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Best-effort LAN-reachable IPv4 address for this machine, for printing a
 * convenience URL when a server is bound to a non-loopback host such as
 * 0.0.0.0. Returns undefined if none is found (e.g. no network interface).
 */
export function detectLanAddress(): string | undefined {
  const interfaces = networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return undefined;
}
