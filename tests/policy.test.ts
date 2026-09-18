import { describe, expect, it } from "vitest";

import { PolicyViolationError, getSafeDiscoveryUrl, normalizePolicy } from "../src/policy.js";

describe("discovery policy", () => {
  it("allows same-origin safe routes and removes fragments", () => {
    const policy = normalizePolicy("https://staging.example.test", {
      allowedOrigins: [],
      maxPages: 5,
      maxControlsPerPage: 20,
      maxLinksPerPage: 20,
      allowInsecureHttp: false,
    });

    expect(getSafeDiscoveryUrl("/orders#drafts", "https://staging.example.test", policy)?.toString()).toBe(
      "https://staging.example.test/orders",
    );
  });

  it("blocks cross-origin and potentially destructive routes", () => {
    const policy = normalizePolicy("https://staging.example.test", {
      allowedOrigins: [],
      maxPages: 5,
      maxControlsPerPage: 20,
      maxLinksPerPage: 20,
      allowInsecureHttp: false,
    });

    expect(
      getSafeDiscoveryUrl("https://example.test", "https://staging.example.test", policy),
    ).toBeUndefined();
    expect(
      getSafeDiscoveryUrl("/orders/delete?id=1", "https://staging.example.test", policy),
    ).toBeUndefined();
  });

  it("requires explicit opt-in for insecure HTTP", () => {
    expect(() =>
      normalizePolicy("http://localhost:3000", {
        allowedOrigins: [],
        maxPages: 5,
        maxControlsPerPage: 20,
        maxLinksPerPage: 20,
        allowInsecureHttp: false,
      }),
    ).toThrow(PolicyViolationError);
  });
});
