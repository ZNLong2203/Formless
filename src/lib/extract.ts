/**
 * Reasoning layer.
 *
 * Two model passes, each with a distinct job:
 *
 *   1. the architect reads an unstructured message alongside the live schema
 *      and proposes a target table, the columns that do not exist yet, and the
 *      record itself;
 *   2. the reviewer challenges those proposals before any of them reach the
 *      database, because a schema that only ever grows is a schema that ends
 *      up with forty ways to say "budget".
 *
 * Neither pass touches Neural Pulse, so the review costs nothing against a
 * datastore quota that is the scarcest resource here.
 *
 * One Zod schema drives every provider: Anthropic consumes it through
 * `zodOutputFormat`, Gemini through the JSON Schema Zod exports. Adding a
 * provider means adding one function, not a second schema to keep in sync.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import type { NeuralColumnType } from "./neural";
import type { SchemaSnapshot } from "./registry";

const COLUMN_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "uuid",
  "json",
] as const;

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const ColumnSpecSchema = z.object({
  name: z.string().describe("snake_case column name"),
  type: z.enum(COLUMN_TYPES),
  rationale: z
    .string()
    .describe("one short clause explaining why this column is needed"),
});

/**
 * Values arrive as strings and are coerced against the column type. A map of
 * arbitrary keys cannot be expressed as a strict JSON schema, so the model
 * emits pairs instead.
 */
const FieldSchema = z.object({
  column: z.string(),
  value: z.string(),
});

const ExtractionSchema = z.object({
  summary: z.string().describe("one sentence describing what arrived"),
  entity_label: z
    .string()
    .describe("human label for the record, e.g. 'Belmont Dental'"),
  table: z.string().describe("snake_case target table name"),
  is_new_table: z.boolean(),
  identity_column: z
    .string()
    .describe(
      "the column that identifies this entity across messages, e.g. 'email' or 'company_name'. Empty string if nothing identifies it.",
    ),
  new_columns: z.array(ColumnSpecSchema),
  fields: z.array(FieldSchema),
  confidence: z.number().describe("0 to 1"),
});

const VerdictSchema = z.object({
  name: z.string().describe("the proposed column being judged"),
  decision: z.enum(["keep", "merge", "drop"]),
  merge_into: z
    .string()
    .describe("when merging, the existing column to use instead. Else empty."),
  reason: z.string().describe("one short clause"),
});

const ReviewSchema = z.object({
  verdicts: z.array(VerdictSchema),
});

export type ColumnSpec = z.infer<typeof ColumnSpecSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;

export type Engine = "claude" | "gemini" | "heuristic";

export interface ExtractionResult extends Extraction {
  record: Record<string, unknown>;
  engine: Engine;
  /** Proposals the reviewer rejected, kept so the UI can show the brake working. */
  rejected: Verdict[];
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

const ARCHITECT_SYSTEM = `You are the schema architect for Formless, a CRM whose
database grows to fit the data instead of forcing data into fixed fields.

You receive a raw inbound message and the current schema. Decide:
- which table the record belongs to; reuse an existing table whenever the record
  is the same kind of thing, and only start a new table for a genuinely new kind;
- which columns are missing and must be added, using the most specific type that
  fits (a monthly figure is a number, a deadline is a date);
- the record's values;
- which column identifies this entity across messages, so a later message about
  the same company updates it rather than duplicating it.

Rules:
- snake_case for every table and column name.
- Never re-declare a column that already exists; put it in fields instead.
- Only propose a column when the message actually carries a value for it.
- Prefer few, meaningful columns over many sparse ones.
- Every column in new_columns must also appear in fields.
- Dates are ISO-8601. Booleans are "true"/"false". Omit unknown values entirely.`;

const REVIEWER_SYSTEM = `You review proposed additions to a live database schema.

A schema that only ever grows becomes unusable: forty columns that all mean
"budget", each populated once. Your job is to stop that, without discarding
information that genuinely has no home yet.

For each proposed column decide:
- "merge" when an existing column already means the same thing. Give the
  existing column in merge_into. Be willing to merge across wording: a
  "deadline" and a "renewal_date" are usually the same fact.
- "drop" when the value is incidental to this one message and would never be
  queried — pleasantries, restated context, one-off prose.
- "keep" when it is a genuinely new, queryable attribute of this kind of record.

Bias towards merge over keep, and towards keep over drop. Dropping loses data;
merging only renames it. Never merge into a column that is not in the existing
list.`;

/* ------------------------------------------------------------------ */
/* Provider dispatch                                                   */
/* ------------------------------------------------------------------ */

export function activeEngine(): Engine {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  return "heuristic";
}

export function hasReasoningKey(): boolean {
  return activeEngine() !== "heuristic";
}

/** Gemini rejects the dialect marker Zod emits. */
function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/**
 * One structured call, routed to whichever provider is configured.
 *
 * `shallow` is for judgements rather than design work. Reviewing whether two
 * column names mean the same thing is a classification; deciding what shape a
 * database should take is not, and only the latter repays deep thinking.
 */
export async function runStructured<T>(
  system: string,
  user: string,
  schema: z.ZodType<T>,
  shallow = false,
): Promise<T> {
  if (activeEngine() === "gemini") {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
      contents: user,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchemaFor(schema),
        temperature: 0,
        ...(shallow
          ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
          : {}),
      },
    });

    const text = response.text;
    if (!text) throw new Error("Gemini returned an empty response");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 200)}`);
    }
    // The schema is enforced server-side, but a malformed response must fail
    // loudly here rather than corrupt the database shape downstream.
    return schema.parse(parsed);
  }

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
    max_tokens: 4000,
    system,
    output_config: { format: zodOutputFormat(schema) },
    messages: [{ role: "user", content: user }],
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Claude returned no parseable output");
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Rendering the schema for the model                                  */
/* ------------------------------------------------------------------ */

function renderSchema(schema: SchemaSnapshot): string {
  const tables = Object.entries(schema);
  if (tables.length === 0) {
    return "(the database is empty — this is the first record)";
  }
  return tables
    .map(([table, columns]) => {
      const cols = columns.map((c) => `${c.name}:${c.type}`).join(", ");
      return `- ${table}(${cols})`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Coercion                                                            */
/* ------------------------------------------------------------------ */

/** Coerce a string value into the JS type the column declares. */
export function coerceValue(raw: string, type: NeuralColumnType): unknown {
  const value = raw.trim();
  if (value === "") return undefined;

  switch (type) {
    case "number": {
      // Tolerate "$2,400/month" and "2400 USD".
      const cleaned = value.replace(/[^0-9.\-]/g, "");
      const numeric = Number(cleaned);
      // Stripping a value with no digits leaves "", and Number("") is 0 — so
      // an unreadable figure would silently be filed as zero. Keep the text.
      return cleaned !== "" && Number.isFinite(numeric) ? numeric : value;
    }
    case "boolean":
      return /^(true|yes|y|1)$/i.test(value);
    case "date": {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    case "json":
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

function buildRecord(
  extraction: Extraction,
  schema: SchemaSnapshot,
): Record<string, unknown> {
  // Type lookup spans both the columns that exist and the ones being added.
  const types = new Map<string, NeuralColumnType>();
  for (const col of schema[extraction.table] ?? []) {
    types.set(col.name, col.type);
  }
  for (const col of extraction.new_columns) {
    types.set(col.name, col.type);
  }

  const record: Record<string, unknown> = {};
  for (const field of extraction.fields) {
    const coerced = coerceValue(field.value, types.get(field.column) ?? "text");
    if (coerced !== undefined) record[field.column] = coerced;
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* The review pass                                                     */
/* ------------------------------------------------------------------ */

/**
 * Apply the reviewer's verdicts to an extraction, in place of the proposals.
 * Pure, so the merge and drop rules are testable without a model.
 */
export function applyVerdicts(
  extraction: Extraction,
  verdicts: readonly Verdict[],
  schema: SchemaSnapshot,
): { extraction: Extraction; rejected: Verdict[] } {
  const existing = new Set((schema[extraction.table] ?? []).map((c) => c.name));
  const byName = new Map(verdicts.map((v) => [v.name, v]));

  const keptColumns: ColumnSpec[] = [];
  const rejected: Verdict[] = [];
  /** proposed column name -> the existing column its value should go to */
  const renames = new Map<string, string>();

  for (const column of extraction.new_columns) {
    const verdict = byName.get(column.name);

    // No verdict means the reviewer did not object.
    if (!verdict || verdict.decision === "keep") {
      keptColumns.push(column);
      continue;
    }

    if (verdict.decision === "merge") {
      // A merge is only safe into a column that actually exists.
      if (verdict.merge_into && existing.has(verdict.merge_into)) {
        renames.set(column.name, verdict.merge_into);
        rejected.push(verdict);
        continue;
      }
      keptColumns.push(column);
      continue;
    }

    rejected.push(verdict); // dropped
  }

  const dropped = new Set(
    rejected.filter((v) => v.decision === "drop").map((v) => v.name),
  );

  const fields = extraction.fields
    .filter((field) => !dropped.has(field.column))
    .map((field) => ({
      ...field,
      column: renames.get(field.column) ?? field.column,
    }));

  return {
    extraction: { ...extraction, new_columns: keptColumns, fields },
    rejected,
  };
}

/* ------------------------------------------------------------------ */
/* Heuristic fallback                                                  */
/* ------------------------------------------------------------------ */

/**
 * Deterministic extractor used when no reasoning key is configured, so the
 * product still demonstrates schema growth end to end.
 */
function heuristicExtraction(
  message: string,
  schema: SchemaSnapshot,
): Extraction {
  const patterns: Array<[string, NeuralColumnType, RegExp]> = [
    ["email", "text", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["phone", "text", /\+?\d[\d\s().-]{7,}\d/],
    ["monthly_budget", "number", /(?:\$|usd\s*)([\d,]+(?:\.\d+)?)/i],
    ["company", "text", /\bfrom\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)/],
  ];

  const existing = new Set((schema.inbound_messages ?? []).map((c) => c.name));
  const newColumns: ColumnSpec[] = [];
  const fields: Array<{ column: string; value: string }> = [];

  for (const [name, type, pattern] of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    fields.push({ column: name, value: match[1] ?? match[0] });
    if (!existing.has(name)) {
      newColumns.push({ name, type, rationale: "detected in message body" });
    }
  }

  if (!existing.has("body")) {
    newColumns.push({
      name: "body",
      type: "text",
      rationale: "original message kept for audit",
    });
  }
  fields.push({ column: "body", value: message.slice(0, 2000) });

  return {
    summary: "Extracted without a reasoning model (no provider key set).",
    entity_label: message.slice(0, 48),
    table: "inbound_messages",
    is_new_table: !schema.inbound_messages,
    identity_column: "email",
    new_columns: newColumns,
    fields,
    confidence: 0.3,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function extractEntity(
  message: string,
  schema: SchemaSnapshot,
): Promise<ExtractionResult> {
  const engine = activeEngine();

  if (engine === "heuristic") {
    const extraction = heuristicExtraction(message, schema);
    return {
      ...extraction,
      record: buildRecord(extraction, schema),
      engine,
      rejected: [],
    };
  }

  const proposed = await runStructured(
    ARCHITECT_SYSTEM,
    `Current schema:\n${renderSchema(schema)}\n\nInbound message:\n"""\n${message}\n"""`,
    ExtractionSchema,
  );

  // Guard against a model re-declaring a column that already exists.
  const known = new Set((schema[proposed.table] ?? []).map((c) => c.name));
  proposed.new_columns = proposed.new_columns.filter((c) => !known.has(c.name));

  let extraction = proposed;
  let rejected: Verdict[] = [];

  // Reviewing a table that does not exist yet is pointless: every column is
  // new by definition, and there is nothing to merge into. The brake only
  // earns its latency where a column could already mean the same thing.
  const existingColumnsList = schema[proposed.table] ?? [];
  const worthReviewing =
    proposed.new_columns.length > 0 && existingColumnsList.length > 0;

  if (worthReviewing) {
    try {
      const existingColumns = existingColumnsList
        .map((c) => `${c.name}:${c.type}`)
        .join(", ");

      const review = await runStructured(
        REVIEWER_SYSTEM,
        `Table: ${proposed.table}\n` +
          `Existing columns: ${existingColumns}\n\n` +
          `Proposed additions:\n` +
          proposed.new_columns
            .map((c) => `- ${c.name}:${c.type} — ${c.rationale}`)
            .join("\n") +
          `\n\nThe message they came from:\n"""\n${message}\n"""`,
        ReviewSchema,
        true, // a judgement, not a design decision
      );

      const applied = applyVerdicts(proposed, review.verdicts, schema);
      extraction = applied.extraction;
      rejected = applied.rejected;
    } catch {
      // The brake is an improvement, not a dependency. If review fails, the
      // architect's proposal stands rather than the ingest failing.
      rejected = [];
    }
  }

  return {
    ...extraction,
    record: buildRecord(extraction, schema),
    engine,
    rejected,
  };
}
