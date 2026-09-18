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
