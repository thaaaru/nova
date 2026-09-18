import { describe, expect, it } from "vitest";

import type { TargetManifest, TestCase } from "../src/domain/index.js";
import {
  checkCaseScope,
  checkExecutionAllowed,
  checkRuntimeUrl,
  isDomainAllowed,
} from "../src/services/policy/scope-policy.js";

const manifest: TargetManifest = {
  targetId: "demo-app",
  baseUrl: "https://shop.example.test/",
  allowedDomains: ["shop.example.test"],
  environment: "staging",
  description: "",
  createdAt: new Date().toISOString(),
};

function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "case-1",
    title: "Case",
    preconditions: [],
    steps: [{ kind: "navigate", url: "https://shop.example.test/", timeoutMs: 10_000 }],
    assertions: [{ kind: "urlContains", expected: "shop.example.test" }],
    allowedDomains: ["shop.example.test"],
    executionMode: "read_only",
    riskLevel: "low",
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    ...overrides,
  };
}

describe("isDomainAllowed", () => {
  it("allows the exact configured domain", () => {
    expect(isDomainAllowed("https://shop.example.test/cart", manifest)).toBe(true);
  });

  it("allows a subdomain of a configured domain", () => {
    expect(isDomainAllowed("https://api.shop.example.test/orders", manifest)).toBe(true);
  });

  it("rejects an unrelated domain", () => {
    expect(isDomainAllowed("https://evil.example.com/", manifest)).toBe(false);
  });

  it("rejects an unparseable URL rather than throwing", () => {
    expect(isDomainAllowed("not a url", manifest)).toBe(false);
  });
});

describe("checkRuntimeUrl", () => {
  it("passes for an allowed domain", () => {
    expect(checkRuntimeUrl("https://shop.example.test/checkout", manifest)).toEqual({ ok: true });
  });

  it("reports the specific unknown domain on violation", () => {
    const result = checkRuntimeUrl("https://attacker.test/steal", manifest);
    expect(result).toEqual({ ok: false, violation: { kind: "unknown_domain", domain: "attacker.test" } });
  });
});

describe("checkCaseScope", () => {
  it("passes when the case's domains are within the manifest", () => {
    expect(checkCaseScope(makeCase(), manifest)).toEqual({ ok: true });
  });

  it("rejects a case that declares a domain outside the manifest", () => {
    const result = checkCaseScope(makeCase({ allowedDomains: ["other.test"] }), manifest);
    expect(result).toEqual({
      ok: false,
      violation: { kind: "domain_not_in_manifest", caseId: "case-1", domain: "other.test" },
    });
  });
});

describe("checkExecutionAllowed", () => {
  it("blocks a state-changing case when the plan was never approved", () => {
    const result = checkExecutionAllowed(makeCase({ executionMode: "state_changing" }), undefined);
    expect(result.ok).toBe(false);
  });

  it("blocks a read-only case too when the plan was rejected", () => {
    const result = checkExecutionAllowed(makeCase(), "rejected");
    expect(result.ok).toBe(false);
  });

  it("allows a state-changing case once the plan is approved", () => {
    const result = checkExecutionAllowed(makeCase({ executionMode: "state_changing" }), "approved");
    expect(result).toEqual({ ok: true });
  });
});
