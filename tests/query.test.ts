import { describe, expect, it } from "vitest";
import { applyPlan, matches, pushDown, type Condition, type QueryPlan } from "@/lib/query";
import type { NeuralRow } from "@/lib/neural";

const condition = (
  column: string,
  op: Condition["op"],
  value = "",
): Condition => ({ column, op, value });

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    table: "leads",
    conditions: [],
    sort_by: "",
    sort_desc: false,
    limit: 0,
    explanation: "",
    unanswerable: false,
    ...overrides,
  };
}

const row = (fields: Record<string, unknown>): NeuralRow => ({
  _id: String(fields.id ?? Math.random()),
  _created_at: "2026-09-18T00:00:00.000Z",
  ...fields,
});

describe("pushDown", () => {
  it("sends only equality to the datastore, which cannot do comparisons", () => {
    const where = pushDown([
      condition("city", "eq", "Austin"),
      condition("monthly_budget", "gt", "5000"),
      condition("email", "contains", "@acme"),
    ]);
    expect(where).toEqual({ city: "Austin" });
  });

  it("sends a numeric equality as a number, since that is how it is stored", () => {
    expect(pushDown([condition("clinic_count", "eq", "3")])).toEqual({
      clinic_count: 3,
    });
  });

  it("keeps a non-numeric value as text", () => {
    expect(pushDown([condition("severity", "eq", "high")])).toEqual({
      severity: "high",
    });
  });
});

describe("matches", () => {
  const lead = row({ company_name: "Belmont Dental", monthly_budget: 2400, city: "Austin" });

  it("compares figures numerically", () => {
    expect(matches(lead, condition("monthly_budget", "gt", "2000"))).toBe(true);
    expect(matches(lead, condition("monthly_budget", "gt", "5000"))).toBe(false);
    expect(matches(lead, condition("monthly_budget", "lte", "2400"))).toBe(true);
    expect(matches(lead, condition("monthly_budget", "gte", "2400"))).toBe(true);
  });

  it("matches text without regard to case", () => {
    expect(matches(lead, condition("company_name", "contains", "dental"))).toBe(true);
    expect(matches(lead, condition("company_name", "contains", "clinic"))).toBe(false);
  });

  it("treats a missing column as unsatisfiable, never as a match", () => {
    expect(matches(lead, condition("fleet_size", "gt", "0"))).toBe(false);
    expect(matches(lead, condition("fleet_size", "eq", "0"))).toBe(false);
    expect(matches(lead, condition("fleet_size", "ne", "5"))).toBe(false);
  });

  it("answers whether a column holds anything at all", () => {
    expect(matches(lead, condition("city", "exists"))).toBe(true);
    expect(matches(lead, condition("fleet_size", "exists"))).toBe(false);
    expect(matches(row({ city: "" }), condition("city", "exists"))).toBe(false);
  });

  it("handles equality and inequality on text", () => {
    expect(matches(lead, condition("city", "eq", "Austin"))).toBe(true);
    expect(matches(lead, condition("city", "ne", "Denver"))).toBe(true);
  });
});

describe("applyPlan", () => {
  const rows = [
    row({ id: "a", company_name: "Belmont Dental", monthly_budget: 2400 }),
    row({ id: "b", company_name: "Northwind Logistics", monthly_budget: 9000 }),
    row({ id: "c", company_name: "Harbor Freight", monthly_budget: 15000 }),
  ];

  it("keeps only rows satisfying every condition", () => {
    const result = applyPlan(rows, plan({ conditions: [condition("monthly_budget", "gt", "5000")] }));
    expect(result.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("requires all conditions, not any", () => {
    const result = applyPlan(
      rows,
      plan({
        conditions: [
          condition("monthly_budget", "gt", "5000"),
          condition("company_name", "contains", "harbor"),
        ],
      }),
    );
    expect(result.map((r) => r.id)).toEqual(["c"]);
  });

  it("sorts by a column, in either direction", () => {
    const desc = applyPlan(rows, plan({ sort_by: "monthly_budget", sort_desc: true }));
    expect(desc.map((r) => r.id)).toEqual(["c", "b", "a"]);

    const asc = applyPlan(rows, plan({ sort_by: "monthly_budget" }));
    expect(asc.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("applies the limit after filtering and sorting", () => {
    const result = applyPlan(
      rows,
      plan({ sort_by: "monthly_budget", sort_desc: true, limit: 2 }),
    );
    expect(result.map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("treats limit 0 as no limit", () => {
    expect(applyPlan(rows, plan({ limit: 0 }))).toHaveLength(3);
  });

  it("returns everything when no condition is given", () => {
    expect(applyPlan(rows, plan())).toHaveLength(3);
  });

  it("does not mutate the rows it was given", () => {
    const original = [...rows];
    applyPlan(rows, plan({ sort_by: "monthly_budget", sort_desc: true }));
    expect(rows).toEqual(original);
  });
});
