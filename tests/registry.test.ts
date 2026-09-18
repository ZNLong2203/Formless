import { describe, expect, it } from "vitest";
import { foldJournal, planGrowth } from "@/lib/registry";
import type { NeuralRow } from "@/lib/neural";

/** Build a journal row the way `commitGrowth` writes one. */
function entry(
  table: string,
  columns: Array<{ name: string; type: string; rationale: string }>,
  createdAt: string,
): NeuralRow {
  return {
    _id: `${table}-${createdAt}`,
    _created_at: createdAt,
    table_name: table,
    columns_json: JSON.stringify(columns),
    created_at: createdAt,
  };
}

describe("foldJournal", () => {
  it("folds entries into a schema with types and rationales", () => {
    const { schema, rationales } = foldJournal([
      entry(
        "leads",
        [
          { name: "id", type: "uuid", rationale: "structural column" },
          { name: "monthly_budget", type: "number", rationale: "spend" },
        ],
        "2026-09-18T10:00:00.000Z",
      ),
    ]);

    expect(schema.leads.map((c) => c.name)).toEqual(["id", "monthly_budget"]);
    expect(schema.leads[1].type).toBe("number");
    expect(rationales["leads.monthly_budget"]).toBe("spend");
  });

  it("marks id as the primary key", () => {
    const { schema } = foldJournal([
      entry("leads", [{ name: "id", type: "uuid", rationale: "" }], "2026-09-18T10:00:00.000Z"),
    ]);
    expect(schema.leads[0].primary).toBe(true);
  });

  /**
   * The kernel can duplicate a row under concurrent writes. Folding must
   * absorb that rather than render the same column twice.
   */
  it("dedupes a column that the kernel duplicated", () => {
    const columns = [{ name: "email", type: "text", rationale: "contact" }];
    const { schema } = foldJournal([
      entry("leads", columns, "2026-09-18T10:00:00.000Z"),
      entry("leads", columns, "2026-09-18T10:00:00.000Z"),
      entry("leads", columns, "2026-09-18T10:00:01.000Z"),
    ]);

    expect(schema.leads).toHaveLength(1);
    expect(schema.leads[0].name).toBe("email");
  });

  it("keeps the earliest rationale when a column is journalled twice", () => {
    const { rationales } = foldJournal([
      entry("leads", [{ name: "nps", type: "number", rationale: "first" }], "2026-09-18T09:00:00.000Z"),
      entry("leads", [{ name: "nps", type: "number", rationale: "second" }], "2026-09-18T11:00:00.000Z"),
    ]);
    expect(rationales["leads.nps"]).toBe("first");
  });

  it("orders by creation time regardless of the order rows arrive in", () => {
    const { schema } = foldJournal([
      entry("leads", [{ name: "later", type: "text", rationale: "" }], "2026-09-18T12:00:00.000Z"),
      entry("leads", [{ name: "earlier", type: "text", rationale: "" }], "2026-09-18T08:00:00.000Z"),
    ]);
    expect(schema.leads.map((c) => c.name)).toEqual(["earlier", "later"]);
  });

  it("survives malformed or missing journal payloads", () => {
    const { schema } = foldJournal([
      { _id: "1", _created_at: "2026-09-18T10:00:00.000Z", table_name: "leads", columns_json: "not json" },
      { _id: "2", _created_at: "2026-09-18T10:00:01.000Z", table_name: "leads", columns_json: JSON.stringify({ not: "an array" }) },
      { _id: "3", _created_at: "2026-09-18T10:00:02.000Z", columns_json: "[]" },
      { _id: "4", _created_at: "2026-09-18T10:00:03.000Z", table_name: "leads", columns_json: JSON.stringify([{ type: "text" }]) },
      entry("leads", [{ name: "ok", type: "text", rationale: "" }], "2026-09-18T10:00:04.000Z"),
    ]);

    expect(schema.leads.map((c) => c.name)).toEqual(["ok"]);
  });

  it("falls back to text for a type it does not recognise", () => {
    const { schema } = foldJournal([
      entry("leads", [{ name: "odd", type: "geography", rationale: "" }], "2026-09-18T10:00:00.000Z"),
    ]);
    expect(schema.leads[0].type).toBe("text");
  });

  it("returns an empty catalogue for an empty journal", () => {
    expect(foldJournal([])).toEqual({ schema: {}, rationales: {} });
  });
});

describe("planGrowth", () => {
  const addition = (name: string, type: "text" | "number" = "text") => ({
    name,
    type,
    rationale: `because ${name}`,
  });

  it("gives a brand-new table its traceability columns first", () => {
    const growth = planGrowth("leads", [addition("company_name")], {});
    expect(growth.added.map((c) => c.name)).toEqual([
      "id",
      "source_message",
      "ingested_at",
      "company_name",
    ]);
  });

  it("does not re-add a column the table already has", () => {
    const schema = {
      leads: [
        { name: "id", type: "uuid" as const, primary: true },
        { name: "email", type: "text" as const },
      ],
    };
    const growth = planGrowth("leads", [addition("email"), addition("city")], schema);

    expect(growth.added.map((c) => c.name)).toEqual(["city"]);
    expect(growth.columns.map((c) => c.name)).toEqual(["id", "email", "city"]);
  });

  it("reports no growth when the message brings nothing new", () => {
    const schema = { leads: [{ name: "email", type: "text" as const }] };
    const growth = planGrowth("leads", [addition("email")], schema);

    expect(growth.added).toEqual([]);
    expect(growth.columns.map((c) => c.name)).toEqual(["email"]);
  });

  it("ignores a repeated addition within one message", () => {
    const growth = planGrowth("leads", [addition("city"), addition("city")], {});
    const cities = growth.added.filter((c) => c.name === "city");
    expect(cities).toHaveLength(1);
  });
});
