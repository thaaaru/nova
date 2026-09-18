import { describe, expect, it } from "vitest";

import {
  deriveApplicationName,
  deriveDefaultEnvironment,
  normalizeTargetUrl,
} from "../src/services/testmap/discover-input-rules.js";

describe("normalizeTargetUrl", () => {
  it("accepts a plain https URL", () => {
    const result = normalizeTargetUrl("https://teklab.dev");
    expect(result).toEqual({ ok: true, value: "https://teklab.dev" });
  });

  it("strips a bare trailing slash", () => {
    const result = normalizeTargetUrl("https://teklab.dev/");
    expect(result).toEqual({ ok: true, value: "https://teklab.dev" });
  });

  it("preserves a real path's trailing slash", () => {
    const result = normalizeTargetUrl("https://teklab.dev/app/");
    expect(result.ok && result.value).toBe("https://teklab.dev/app/");
  });

  it("rejects Markdown link syntax", () => {
    const result = normalizeTargetUrl("[https://teklab.dev](https://teklab.dev)");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Markdown/);
  });

  it("rejects a non-absolute or malformed URL", () => {
    expect(normalizeTargetUrl("not a url").ok).toBe(false);
    expect(normalizeTargetUrl("teklab.dev").ok).toBe(false);
  });

  it("rejects a non-http(s) protocol", () => {
    const result = normalizeTargetUrl("ftp://teklab.dev");
    expect(result.ok).toBe(false);
  });
});

describe("deriveApplicationName", () => {
  it("capitalizes the primary hostname label", () => {
    expect(deriveApplicationName("https://teklab.dev")).toBe("Teklab");
  });

  it("strips a leading www.", () => {
    expect(deriveApplicationName("https://www.acme.example.com")).toBe("Acme");
  });

  it("returns undefined for an unparseable URL", () => {
    expect(deriveApplicationName("not a url")).toBeUndefined();
  });
});

describe("deriveDefaultEnvironment", () => {
  it("defaults to staging for an ordinary hostname", () => {
    expect(deriveDefaultEnvironment("https://teklab.dev")).toBe("staging");
  });

  it("detects localhost as local", () => {
    expect(deriveDefaultEnvironment("http://localhost:3000")).toBe("local");
  });

  it("detects a .local hostname as local", () => {
    expect(deriveDefaultEnvironment("http://myapp.local")).toBe("local");
  });

  it("detects a dev subdomain as development", () => {
    expect(deriveDefaultEnvironment("https://dev.teklab.dev")).toBe("development");
  });

  it("falls back to staging on an unparseable URL", () => {
    expect(deriveDefaultEnvironment("not a url")).toBe("staging");
  });
});
