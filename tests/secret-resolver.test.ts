import { afterEach, describe, expect, it } from "vitest";

import {
  EnvSecretResolver,
  isSecretReference,
  resolveIfSecretReference,
} from "../src/services/policy/secret-resolver.js";

describe("isSecretReference", () => {
  it("recognizes the secret: prefix", () => {
    expect(isSecretReference("secret:standard_user_password")).toBe(true);
  });

  it("treats a plain value as not a secret reference", () => {
    expect(isSecretReference("standard_user@example.test")).toBe(false);
  });
});

describe("resolveIfSecretReference", () => {
  const key = "NOVA_SECRET_TEST_TOKEN";

  afterEach(() => {
    delete process.env[key];
  });

  it("passes a non-reference value through unchanged", () => {
    const resolver = new EnvSecretResolver();
    expect(resolveIfSecretReference("plain-value", resolver)).toBe("plain-value");
  });

  it("resolves a reference from the environment, by opaque id", () => {
    process.env[key] = "s3cr3t";
    const resolver = new EnvSecretResolver();
    expect(resolveIfSecretReference("secret:test_token", resolver)).toBe("s3cr3t");
  });

  it("throws rather than silently continuing when the reference doesn't resolve", () => {
    const resolver = new EnvSecretResolver();
    expect(() => resolveIfSecretReference("secret:missing_token", resolver)).toThrow(/did not resolve/);
  });
});
