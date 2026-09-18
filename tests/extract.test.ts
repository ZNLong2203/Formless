import { afterEach, describe, expect, it, vi } from "vitest";
import { activeEngine, coerceValue, hasReasoningKey } from "@/lib/extract";

/**
 * The model emits every value as a string, because a map of arbitrary keys
 * cannot be expressed as a strict JSON schema. Coercion is therefore the only
 * thing standing between "3 clinics" and a column that is secretly text.
 */
describe("coerceValue", () => {
  it("reads a figure out of a formatted amount", () => {
    expect(coerceValue("$2,400/month", "number")).toBe(2400);
    expect(coerceValue("9000 USD", "number")).toBe(9000);
    expect(coerceValue("42", "number")).toBe(42);
  });

  it("keeps decimals and negatives intact", () => {
    expect(coerceValue("12.5", "number")).toBe(12.5);
    expect(coerceValue("-31", "number")).toBe(-31);
  });

  it("keeps the original text when a figure cannot be read", () => {
    expect(coerceValue("not a number", "number")).toBe("not a number");
  });

  it("accepts the several ways a model writes yes", () => {
    for (const truthy of ["true", "TRUE", "yes", "y", "1"]) {
      expect(coerceValue(truthy, "boolean")).toBe(true);
    }
    for (const falsy of ["false", "no", "0", "maybe"]) {
      expect(coerceValue(falsy, "boolean")).toBe(false);
    }
  });

  it("normalises a date to ISO", () => {
    expect(coerceValue("2026-09-12", "date")).toBe("2026-09-12T00:00:00.000Z");
  });

  it("leaves an unparseable date as written", () => {
    expect(coerceValue("before Q1", "date")).toBe("before Q1");
  });

  it("parses json, and falls back to the raw string when it cannot", () => {
    expect(coerceValue('{"a":1}', "json")).toEqual({ a: 1 });
    expect(coerceValue("{oops", "json")).toBe("{oops");
  });

  it("drops empty and whitespace-only values rather than storing blanks", () => {
    expect(coerceValue("", "text")).toBeUndefined();
    expect(coerceValue("   ", "number")).toBeUndefined();
  });

  it("trims text", () => {
    expect(coerceValue("  Belmont Dental  ", "text")).toBe("Belmont Dental");
  });
});

describe("provider selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers Gemini when both providers are configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "g");
    vi.stubEnv("ANTHROPIC_API_KEY", "a");
    expect(activeEngine()).toBe("gemini");
  });

  it("falls back to Claude when only Anthropic is configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "a");
    expect(activeEngine()).toBe("claude");
  });

  it("degrades to the deterministic extractor with no key at all", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(activeEngine()).toBe("heuristic");
    expect(hasReasoningKey()).toBe(false);
  });
});

import { applyVerdicts, type Extraction, type Verdict } from "@/lib/extract";
import type { SchemaSnapshot } from "@/lib/registry";

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    summary: "",
    entity_label: "Acme",
    table: "leads",
    is_new_table: false,
    identity_column: "email",
    new_columns: [],
    fields: [],
    confidence: 0.9,
    ...overrides,
  };
}

const verdict = (
  name: string,
  decision: Verdict["decision"],
  merge_into = "",
): Verdict => ({ name, decision, merge_into, reason: "because" });

const SCHEMA: SchemaSnapshot = {
  leads: [
    { name: "renewal_date", type: "date" },
    { name: "monthly_budget", type: "number" },
  ],
};

/**
 * A schema that only ever grows ends up with forty ways to say "budget". The
 * reviewer is the brake; these guard what it is allowed to do.
 */
describe("applyVerdicts", () => {
  it("keeps a column the reviewer approved", () => {
    const result = applyVerdicts(
      extraction({
        new_columns: [{ name: "nps", type: "number", rationale: "score" }],
        fields: [{ column: "nps", value: "31" }],
      }),
      [verdict("nps", "keep")],
      SCHEMA,
    );

    expect(result.extraction.new_columns.map((c) => c.name)).toEqual(["nps"]);
    expect(result.rejected).toEqual([]);
  });

  it("redirects a merged column's value into the existing column", () => {
    const result = applyVerdicts(
      extraction({
        new_columns: [{ name: "deadline", type: "date", rationale: "when" }],
        fields: [{ column: "deadline", value: "2026-11-30" }],
      }),
      [verdict("deadline", "merge", "renewal_date")],
      SCHEMA,
    );

    // No new column, and the value lands in the column that already meant this.
    expect(result.extraction.new_columns).toEqual([]);
    expect(result.extraction.fields).toEqual([
      { column: "renewal_date", value: "2026-11-30" },
    ]);
    expect(result.rejected).toHaveLength(1);
  });

  it("refuses to merge into a column that does not exist", () => {
    const result = applyVerdicts(
      extraction({
        new_columns: [{ name: "deadline", type: "date", rationale: "when" }],
        fields: [{ column: "deadline", value: "2026-11-30" }],
      }),
      [verdict("deadline", "merge", "imaginary_column")],
      SCHEMA,
    );

    // Better a new column than a value written into nowhere.
    expect(result.extraction.new_columns.map((c) => c.name)).toEqual(["deadline"]);
    expect(result.rejected).toEqual([]);
  });

  it("discards a dropped column along with its value", () => {
    const result = applyVerdicts(
      extraction({
        new_columns: [{ name: "greeting", type: "text", rationale: "pleasantry" }],
        fields: [
          { column: "greeting", value: "Hope you are well" },
          { column: "monthly_budget", value: "2400" },
        ],
      }),
      [verdict("greeting", "drop")],
      SCHEMA,
    );

    expect(result.extraction.new_columns).toEqual([]);
    expect(result.extraction.fields).toEqual([
      { column: "monthly_budget", value: "2400" },
    ]);
    expect(result.rejected[0].decision).toBe("drop");
  });

  it("keeps a column the reviewer said nothing about", () => {
    const result = applyVerdicts(
      extraction({
        new_columns: [{ name: "nps", type: "number", rationale: "score" }],
        fields: [{ column: "nps", value: "31" }],
      }),
      [],
      SCHEMA,
    );
    expect(result.extraction.new_columns.map((c) => c.name)).toEqual(["nps"]);
  });

  it("leaves values for existing columns untouched", () => {
    const result = applyVerdicts(
      extraction({
        new_columns: [{ name: "deadline", type: "date", rationale: "when" }],
        fields: [
          { column: "deadline", value: "2026-11-30" },
          { column: "monthly_budget", value: "2400" },
        ],
      }),
      [verdict("deadline", "merge", "renewal_date")],
      SCHEMA,
    );

    expect(result.extraction.fields).toContainEqual({
      column: "monthly_budget",
      value: "2400",
    });
  });
});
