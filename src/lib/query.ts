/**
 * Asking questions of a schema you never designed.
 *
 * The point of Formless is that you do not know what shape your database took,
 * so you should not need to know it in order to interrogate it. A question in
 * plain language is planned against the live catalogue and answered.
 *
 * One constraint shapes the whole design: Neural Pulse's `select_data` matches
 * on equality only — there is no `>` or `contains` on the wire. So equality
 * conditions are pushed down into `where`, where the datastore can use them,
 * and everything else is evaluated here over the returned rows. That keeps the
 * query to a single call while still answering "budget over 5000".
 */

import { z } from "zod";
import { runStructured } from "./extract";
import type { NeuralRow } from "./neural";
import type { SchemaSnapshot } from "./registry";

export const OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "exists",
] as const;

export type Operator = (typeof OPERATORS)[number];

const ConditionSchema = z.object({
  column: z.string(),
  op: z.enum(OPERATORS),
  value: z.string().describe("compared as a number when both sides look numeric"),
});

const QueryPlanSchema = z.object({
  table: z.string().describe("which table answers this question"),
  conditions: z.array(ConditionSchema),
  sort_by: z.string().describe("column to sort by, or empty string"),
  sort_desc: z.boolean(),
  limit: z.number().describe("maximum rows to return; 0 means no limit"),
  explanation: z
    .string()
    .describe("one sentence stating, in plain language, what is being looked up"),
  unanswerable: z
    .boolean()
    .describe("true when the schema simply cannot answer this question"),
});

export type Condition = z.infer<typeof ConditionSchema>;
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

const PLANNER_SYSTEM = `You turn a question into a query plan against a database
whose shape was grown from data, not designed.

You are given the live schema. Choose the one table that answers the question
and express the question as conditions over its columns.

Rules:
- Only ever reference tables and columns that appear in the schema.
- Use "eq" wherever an exact match is meant; it is the cheapest operation.
- Use "exists" to mean the column has any value at all.
- "contains" is case-insensitive substring matching on text.
- For a question that names no filter at all ("show me everything"), return no
  conditions rather than inventing one.
- Set unanswerable when the schema holds nothing that could answer the question,
  and say why in explanation.
- limit 0 means return everything that matches.`;

function renderSchema(schema: SchemaSnapshot): string {
  const tables = Object.entries(schema);
  if (tables.length === 0) return "(the database is empty)";
  return tables
    .map(([table, columns]) =>
      `- ${table}(${columns.map((c) => `${c.name}:${c.type}`).join(", ")})`,
    )
    .join("\n");
}

export async function planQuery(
  question: string,
  schema: SchemaSnapshot,
): Promise<QueryPlan> {
  return runStructured(
    PLANNER_SYSTEM,
    `Schema:\n${renderSchema(schema)}\n\nQuestion:\n"""\n${question}\n"""`,
    QueryPlanSchema,
  );
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/** Conditions the datastore itself can apply, as a `where` payload. */
export function pushDown(conditions: readonly Condition[]): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const condition of conditions) {
    if (condition.op !== "eq") continue;
    // A numeric column stores numbers, so the string form would never match.
    const numeric = Number(condition.value);
    where[condition.column] =
      condition.value.trim() !== "" && Number.isFinite(numeric)
        ? numeric
        : condition.value;
  }
  return where;
}

/** Compare as numbers when both sides are numeric, else as text. */
function compare(left: unknown, right: string): number | undefined {
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  if (left === null || left === undefined) return undefined;
  return String(left).localeCompare(right);
}

export function matches(row: NeuralRow, condition: Condition): boolean {
  const value = row[condition.column];

  if (condition.op === "exists") {
    return value !== undefined && value !== null && value !== "";
  }
  // A row missing the column cannot satisfy a comparison against it.
  if (value === undefined || value === null) return false;

  if (condition.op === "contains") {
    return String(value).toLowerCase().includes(condition.value.toLowerCase());
  }

  const delta = compare(value, condition.value);
  if (delta === undefined) return false;

  switch (condition.op) {
    case "eq":
      return delta === 0;
    case "ne":
      return delta !== 0;
    case "gt":
      return delta > 0;
    case "gte":
      return delta >= 0;
    case "lt":
      return delta < 0;
    case "lte":
      return delta <= 0;
  }
}

/** Apply the whole plan to rows the datastore returned. */
export function applyPlan(
  rows: readonly NeuralRow[],
  plan: QueryPlan,
): NeuralRow[] {
  let result = rows.filter((row) =>
    plan.conditions.every((condition) => matches(row, condition)),
  );

  if (plan.sort_by) {
    const column = plan.sort_by;
    result = [...result].sort((a, b) => {
      const left = a[column];
      const right = b[column];
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      const delta =
        Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
          ? leftNumber - rightNumber
          : String(left ?? "").localeCompare(String(right ?? ""));
      return plan.sort_desc ? -delta : delta;
    });
  }

  return plan.limit > 0 ? result.slice(0, plan.limit) : result;
}
