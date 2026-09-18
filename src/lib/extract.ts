/**
 * Extraction engine.
 *
 * Reads an unstructured message plus the current LivingDNA schema, then decides
 * three things at once:
 *   1. which table the record belongs to (existing, or a new one),
 *   2. which columns do not exist yet and must be grown onto the schema,
 *   3. the record itself.
 *
 * Step 2 is what makes Formless different from a normal CRM: the database
 * shape is an output of the data, not a precondition for it.
 *
 * Neural Pulse ships its own `chat` action, but its upstream LLM providers are
 * currently failing (`All LLM providers failed`), so reasoning runs on Claude
 * and every byte of resulting state is persisted through Neural Pulse.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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
  new_columns: z.array(ColumnSpecSchema),
  fields: z.array(FieldSchema),
  confidence: z.number().describe("0 to 1"),
});

export type ColumnSpec = z.infer<typeof ColumnSpecSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

/** The extraction plus the coerced record ready for Neural Pulse. */
export interface ExtractionResult extends Extraction {
  record: Record<string, unknown>;
  engine: "claude" | "heuristic";
}

const SYSTEM = `You are the schema architect for Formless, a CRM whose database
grows to fit the data instead of forcing data into fixed fields.

You receive a raw inbound message and the current schema. Decide:
- which table the record belongs to; reuse an existing table whenever the record
  is the same kind of thing, and only start a new table for a genuinely new kind;
- which columns are missing and must be added, using the most specific type that
  fits (a monthly figure is a number, a deadline is a date);
- the record's values.

Rules:
- snake_case for every table and column name.
- Never re-declare a column that already exists; put it in fields instead.
- Only propose a column when the message actually carries a value for it.
- Prefer few, meaningful columns over many sparse ones.
- Every column in new_columns must also appear in fields.
- Dates are ISO-8601. Booleans are "true"/"false". Omit unknown values entirely.`;

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

/** Coerce a string value into the JS type the column declares. */
export function coerceValue(raw: string, type: NeuralColumnType): unknown {
  const value = raw.trim();
  if (value === "") return undefined;

  switch (type) {
    case "number": {
      // Tolerate "$2,400/month" and "2400 USD".
      const numeric = Number(value.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(numeric) ? numeric : value;
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
    summary: "Extracted without a reasoning model (no ANTHROPIC_API_KEY set).",
    entity_label: message.slice(0, 48),
    table: "inbound_messages",
    is_new_table: !schema.inbound_messages,
    new_columns: newColumns,
    fields,
    confidence: 0.3,
  };
}

export function hasReasoningKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function extractEntity(
  message: string,
  schema: SchemaSnapshot,
): Promise<ExtractionResult> {
  if (!hasReasoningKey()) {
    const extraction = heuristicExtraction(message, schema);
    return {
      ...extraction,
      record: buildRecord(extraction, schema),
      engine: "heuristic",
    };
  }

  const client = new Anthropic();

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(ExtractionSchema) },
    messages: [
      {
        role: "user",
        content: `Current schema:\n${renderSchema(schema)}\n\nInbound message:\n"""\n${message}\n"""`,
      },
    ],
  });

  const extraction = response.parsed_output;
  if (!extraction) {
    throw new Error("Extraction failed: model did not return valid output");
  }

  // Guard against the model re-declaring a column that already exists.
  const known = new Set((schema[extraction.table] ?? []).map((c) => c.name));
  extraction.new_columns = extraction.new_columns.filter(
    (c) => !known.has(c.name),
  );

  return {
    ...extraction,
    record: buildRecord(extraction, schema),
    engine: "claude",
  };
}
