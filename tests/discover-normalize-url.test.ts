import { describe, expect, it } from "vitest";

import { normalizeUrl } from "../src/services/browser/discover.js";

describe("normalizeUrl", () => {
  it("treats a trailing-slash root and a bare host as the same page", () => {
    expect(normalizeUrl("https://example.com/")).toBe(normalizeUrl("https://example.com"));
  });

  it("strips hash fragments", () => {
    expect(normalizeUrl("https://example.com/about#team")).toBe(normalizeUrl("https://example.com/about"));
  });

  it("trims a trailing slash on non-root paths", () => {
    expect(normalizeUrl("https://example.com/pricing/")).toBe(normalizeUrl("https://example.com/pricing"));
  });

  it("keeps the bare root path as a single slash", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("does not collapse genuinely distinct paths", () => {
    expect(normalizeUrl("https://example.com/pricing")).not.toBe(
      normalizeUrl("https://example.com/pricing2"),
    );
  });
});
