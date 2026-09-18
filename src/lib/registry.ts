/**
 * Schema registry — the record of what shape the database currently has.
 *
 * Neural Pulse registers tables into LivingDNA but exposes no "describe schema"
 * action, so Formless keeps the catalogue in Neural Pulse itself: two meta
 * tables that are read back with `select_data`. There is no second database and
 * no local state, which is what makes the deployment stateless.
 */

import {
  createSchema,
  insertData,
  selectData,
  type NeuralColumn,
  type NeuralColumnType,
  type NeuralTable,
} from "./neural";

/** Catalogue of columns, keyed by table name. */
export type SchemaSnapshot = Record<string, NeuralColumn[]>;

export const COLUMN_TABLE = "formless_columns";
export const EVENT_TABLE = "formless_events";

/** Columns every ingested table carries, so records are always traceable. */
const BASE_COLUMNS: NeuralColumn[] = [
  { name: "id", type: "uuid", primary: true },
  { name: "source_message", type: "text" },
  { name: "ingested_at", type: "date" },
];

const META_TABLES: NeuralTable[] = [
  {
    name: COLUMN_TABLE,
    columns: [
      { name: "id", type: "uuid", primary: true },
      { name: "table_name", type: "text" },
      { name: "column_name", type: "text" },
      { name: "column_type", type: "text" },
      { name: "rationale", type: "text" },
      { name: "created_at", type: "date" },
    ],
  },
  {
    name: EVENT_TABLE,
    columns: [
      { name: "id", type: "uuid", primary: true },
      { name: "kind", type: "text" },
      { name: "detail", type: "text" },
      { name: "table_name", type: "text" },
      { name: "created_at", type: "date" },
    ],
  },
];

let metaReady: Promise<void> | undefined;

/** Register the meta tables once per process. */
export function ensureMeta(): Promise<void> {
  metaReady ??= createSchema(
    META_TABLES,
    "Register Formless schema catalogue",
  ).then(() => undefined);
  return metaReady;
}

function isColumnType(value: unknown): value is NeuralColumnType {
  return (
    typeof value === "string" &&
    ["uuid", "text", "number", "boolean", "date", "json"].includes(value)
  );
}

/** Read the live catalogue back out of Neural Pulse. */
export async function loadSchema(): Promise<SchemaSnapshot> {
  await ensureMeta();
  const rows = await selectData(COLUMN_TABLE, undefined, "Load LivingDNA catalogue");

  const snapshot: SchemaSnapshot = {};
  for (const row of rows) {
    const table = row.table_name;
    const name = row.column_name;
    if (typeof table !== "string" || typeof name !== "string") continue;

    const columns = (snapshot[table] ??= []);
    if (columns.some((c) => c.name === name)) continue; // tolerate duplicates
    columns.push({
      name,
      type: isColumnType(row.column_type) ? row.column_type : "text",
      primary: name === "id",
    });
  }
  return snapshot;
}

export interface GrowthResult {
  table: string;
  added: NeuralColumn[];
  /** Full column set after growth, as registered into LivingDNA. */
  columns: NeuralColumn[];
}

/**
 * Widen a table to fit new columns.
 *
 * `create_schema` is re-sent with the complete column set (not just the delta)
 * so LivingDNA holds the whole shape, then the catalogue is updated to match.
 */
export async function growSchema(
  table: string,
  additions: Array<{ name: string; type: NeuralColumnType; rationale: string }>,
  schema: SchemaSnapshot,
): Promise<GrowthResult> {
  const existing = schema[table] ?? [];
  const known = new Set(existing.map((c) => c.name));

  const baseToAdd = existing.length === 0 ? BASE_COLUMNS : [];
  for (const column of baseToAdd) known.add(column.name);

  const fresh: NeuralColumn[] = [];
  for (const addition of additions) {
    if (known.has(addition.name)) continue;
    known.add(addition.name);
    fresh.push({ name: addition.name, type: addition.type });
  }

  const columns = [...existing, ...baseToAdd, ...fresh];
  if (fresh.length === 0 && baseToAdd.length === 0) {
    return { table, added: [], columns };
  }

  await createSchema(
    [{ name: table, columns }],
    `Grow ${table} to fit newly observed fields`,
  );

  const now = new Date().toISOString();
  const rationales = new Map(additions.map((a) => [a.name, a.rationale]));

  // Catalogue writes are independent; one failure should not hide the others.
  await Promise.all(
    [...baseToAdd, ...fresh].map((column) =>
      insertData(
        COLUMN_TABLE,
        {
          table_name: table,
          column_name: column.name,
          column_type: column.type,
          rationale: rationales.get(column.name) ?? "structural column",
          created_at: now,
        },
        `Catalogue ${table}.${column.name}`,
      ),
    ),
  );

  return { table, added: [...baseToAdd, ...fresh], columns };
}

export async function logEvent(
  kind: string,
  detail: string,
  table: string,
): Promise<void> {
  try {
    await insertData(
      EVENT_TABLE,
      { kind, detail, table_name: table, created_at: new Date().toISOString() },
      "Record a Formless activity event",
    );
  } catch {
    // The activity feed is cosmetic; never fail an ingest because of it.
  }
}
