import { describe, expect, it } from "vitest";

import {
  ApplicationAreaSchema,
  ApplicationTestMapSchema,
  ApprovedScopeSchema,
  CheckpointSchema,
  ExecutionModeLabelSchema,
  JourneyStatusSchema,
  KnownConstraintSchema,
  RecoveryActionSchema,
  TestDataFixtureSchema,
  TestMapRunContextSchema,
  TestPersonaSchema,
  TestTemplateSchema,
  UserJourneySchema,
} from "../src/domain/index.js";

describe("ApprovedScopeSchema", () => {
  it("accepts a minimal valid scope, applying defaults", () => {
    const parsed = ApprovedScopeSchema.parse({ allowedDomains: ["shop.example.test"] });
    expect(parsed.allowedMethods).toEqual(["GET", "POST"]);
    expect(parsed.executionMode).toBe("safe_test");
  });

  it("rejects an empty allowedDomains array", () => {
    expect(() => ApprovedScopeSchema.parse({ allowedDomains: [] })).toThrow();
  });
});

describe("CheckpointSchema", () => {
  const valid = {
    id: "checkpoint-1",
    name: "Page loads",
    expectedOutcome: "The page renders.",
    riskLevel: "low",
  };

  it("accepts a minimal valid checkpoint, defaulting steps/assertions/evidenceRequirements", () => {
    const parsed = CheckpointSchema.parse(valid);
    expect(parsed.steps).toEqual([]);
    expect(parsed.assertions).toEqual([]);
    expect(parsed.evidenceRequirements).toEqual(["screenshot"]);
    expect(parsed.requiresApproval).toBe(false);
  });

  it("rejects an invalid riskLevel enum value", () => {
    expect(() => CheckpointSchema.parse({ ...valid, riskLevel: "extreme" })).toThrow();
  });
});

describe("TestPersonaSchema", () => {
  const valid = {
    id: "standard_customer",
    name: "Standard Customer",
    description: "A registered shopper.",
    credentialReferenceId: "cred-standard-customer",
    allowedEnvironments: ["staging"],
  };

  it("accepts a minimal valid persona", () => {
    const parsed = TestPersonaSchema.parse(valid);
    expect(parsed.permissions).toEqual([]);
  });

  it("rejects an empty allowedEnvironments array", () => {
    expect(() => TestPersonaSchema.parse({ ...valid, allowedEnvironments: [] })).toThrow();
  });
});

describe("TestDataFixtureSchema", () => {
  const valid = {
    id: "in-stock-product",
    name: "In-Stock Product",
    description: "A product with guaranteed inventory.",
    dataReferenceId: "fixture-in-stock-product-1",
  };

  it("accepts a minimal valid fixture, defaulting lockRequired to false", () => {
    const parsed = TestDataFixtureSchema.parse(valid);
    expect(parsed.lockRequired).toBe(false);
  });

  it("rejects a missing (empty) dataReferenceId", () => {
    expect(() => TestDataFixtureSchema.parse({ ...valid, dataReferenceId: "" })).toThrow();
  });
});

describe("TestTemplateSchema", () => {
  it("accepts an empty object, applying defaults", () => {
    const parsed = TestTemplateSchema.parse({});
    expect(parsed.preconditions).toEqual([]);
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it("rejects a non-positive timeoutMs", () => {
    expect(() => TestTemplateSchema.parse({ timeoutMs: 0 })).toThrow();
  });
});

function makeValidJourney() {
  return {
    id: "journey-1",
    areaId: "area-1",
    name: "Journey",
    description: "A test journey.",
    mode: "quick_test",
    checkpoints: [
      {
        id: "checkpoint-1",
        name: "Checkpoint",
        expectedOutcome: "The page loads.",
        riskLevel: "low",
      },
    ],
  };
}

describe("UserJourneySchema", () => {
  it("accepts a minimal valid journey, defaulting status to draft", () => {
    const parsed = UserJourneySchema.parse(makeValidJourney());
    expect(parsed.status).toBe("draft");
    expect(parsed.requiredPersonaIds).toEqual([]);
  });

  it("rejects a journey with zero checkpoints", () => {
    expect(() => UserJourneySchema.parse({ ...makeValidJourney(), checkpoints: [] })).toThrow();
  });
});

describe("ApplicationAreaSchema", () => {
  const valid = { id: "checkout", name: "Checkout", riskLevel: "high" };

  it("accepts a minimal valid area, defaulting journeys to an empty array", () => {
    const parsed = ApplicationAreaSchema.parse(valid);
    expect(parsed.journeys).toEqual([]);
  });

  it("rejects an invalid riskLevel enum value", () => {
    expect(() => ApplicationAreaSchema.parse({ ...valid, riskLevel: "extreme" })).toThrow();
  });
});

describe("KnownConstraintSchema", () => {
  const valid = { id: "constraint-1", description: "A known limitation." };

  it("accepts a minimal valid constraint, defaulting severity to info", () => {
    const parsed = KnownConstraintSchema.parse(valid);
    expect(parsed.severity).toBe("info");
  });

  it("rejects an invalid severity enum value", () => {
    expect(() => KnownConstraintSchema.parse({ ...valid, severity: "critical" })).toThrow();
  });
});

describe("ApplicationTestMapSchema", () => {
  function makeValidMap() {
    const now = new Date().toISOString();
    return {
      id: "map-1",
      version: "1.0.0",
      applicationName: "Shop Staging",
      targetUrl: "https://shop.example.test",
      environment: "staging",
      approvedScope: { allowedDomains: ["shop.example.test"] },
      createdAt: now,
      updatedAt: now,
    };
  }

  it("accepts a minimal valid map, defaulting status to draft", () => {
    const parsed = ApplicationTestMapSchema.parse(makeValidMap());
    expect(parsed.status).toBe("draft");
    expect(parsed.areas).toEqual([]);
  });

  it("rejects a non-URL targetUrl", () => {
    expect(() => ApplicationTestMapSchema.parse({ ...makeValidMap(), targetUrl: "not-a-url" })).toThrow();
  });
});

describe("TestMapRunContextSchema", () => {
  const valid = { mapId: "map-1", mapVersion: "1.0.0", areaId: "area-1", journeyId: "journey-1" };

  it("accepts a minimal valid run context, defaulting fixtureIds to an empty array", () => {
    const parsed = TestMapRunContextSchema.parse(valid);
    expect(parsed.fixtureIds).toEqual([]);
  });

  it("rejects an empty mapId", () => {
    expect(() => TestMapRunContextSchema.parse({ ...valid, mapId: "" })).toThrow();
  });
});

describe("ExecutionModeLabelSchema", () => {
  it("accepts every declared execution mode label", () => {
    for (const value of ["quick_test", "guided_test", "controlled_test"]) {
      expect(ExecutionModeLabelSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an undeclared execution mode label", () => {
    expect(() => ExecutionModeLabelSchema.parse("slow_test")).toThrow();
  });
});

describe("JourneyStatusSchema", () => {
  it("accepts every declared journey status", () => {
    for (const value of ["draft", "approved", "deprecated"]) {
      expect(JourneyStatusSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an undeclared journey status", () => {
    expect(() => JourneyStatusSchema.parse("pending")).toThrow();
  });
});

describe("RecoveryActionSchema", () => {
  it("accepts every declared recovery action", () => {
    for (const value of [
      "role_name_match",
      "common_role_match",
      "visible_text_match",
      "accessible_label_match",
      "declared_selector_match",
    ]) {
      expect(RecoveryActionSchema.parse(value)).toBe(value);
    }
  });

  it("rejects an undeclared recovery action", () => {
    expect(() => RecoveryActionSchema.parse("guess_and_check")).toThrow();
  });
});
