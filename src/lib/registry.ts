/**
 * Schema registry — the record of what shape the database currently has.
 *
 * Neural Pulse registers tables into LivingDNA but exposes no "describe schema"
 * action, so Formless keeps the catalogue in Neural Pulse itself. There is no
 * second database and no local state.
 *
 * The catalogue is an append-only journal: one row per growth event, holding
 * the columns added. Folding the journal yields the live schema. Two properties
 * fall out of that choice, both of which matter against this API:
 *   - growing a table costs exactly one write, not one write per column;
 *   - a duplicated row (which the kernel's non-atomic writes can produce) is
 *     harmless, because folding dedupes by column name.
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

export const JOURNAL_TABLE = "formless_schema_journal";
export const EVENT_TABLE = "formless_events";

/** Reserved names that hold Formless's own bookkeeping, not business records. */
export const META_TABLE_NAMES: readonly string[] = [JOURNAL_TABLE, EVENT_TABLE];

/** Columns every ingested table carries, so records are always traceable. */
const BASE_COLUMNS: NeuralColumn[] = [
  { name: "id", type: "uuid", primary: true },
  { name: "source_message", type: "text" },
  { name: "ingested_at", type: "date" },
];

const META_TABLES: NeuralTable[] = [
  {
    name: JOURNAL_TABLE,
    columns: [
      { name: "id", type: "uuid", primary: true },
      { name: "table_name", type: "text" },
      { name: "columns_json", type: "text" },
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

const VALID_TYPES: readonly string[] = [
  "uuid",
  "text",
  "number",
  "boolean",
  "date",
  "json",
];

let metaReady: Promise<void> | undefined;

/** Register the meta tables once per process. */
export function ensureMeta(): Promise<void> {
  metaReady ??= createSchema(META_TABLES, "Register Formless catalogue").then(
    () => undefined,
  );
  // A failed bootstrap must not be cached as success.
  metaReady = metaReady.catch((error) => {
    metaReady = undefined;
    throw error;
  });
  return metaReady;
}

/** A single entry in the journal, as written and read back. */
interface JournalColumn {
  name: string;
  type: NeuralColumnType;
  rationale: string;
}

function parseJournalColumns(raw: unknown): JournalColumn[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const columns: JournalColumn[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, type, rationale } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name) continue;
    columns.push({
      name,
      type: (VALID_TYPES.includes(type as string)
        ? type
        : "text") as NeuralColumnType,
      rationale: typeof rationale === "string" ? rationale : "",
    });
  }
  return columns;
}

/** Why each column exists, keyed as `table.column` — used by the UI. */
export type RationaleMap = Record<string, string>;

export interface Catalogue {
  schema: SchemaSnapshot;
  rationales: RationaleMap;
}

/** Fold the journal into the live schema. */
export async function loadCatalogue(): Promise<Catalogue> {
  await ensureMeta();
  const rows = await selectData(JOURNAL_TABLE, undefined, "Fold LivingDNA journal");

  // Oldest first, so the earliest rationale for a column is the one kept.
  const ordered = [...rows].sort((a, b) =>
    String(a._created_at ?? "").localeCompare(String(b._created_at ?? "")),
  );

  const schema: SchemaSnapshot = {};
  const rationales: RationaleMap = {};

  for (const row of ordered) {
    const table = row.table_name;
    if (typeof table !== "string" || !table) continue;

    const columns = (schema[table] ??= []);
    const known = new Set(columns.map((c) => c.name));

    for (const column of parseJournalColumns(row.columns_json)) {
      if (known.has(column.name)) continue; // dedupe replayed/duplicated rows
      known.add(column.name);
      columns.push({
        name: column.name,
        type: column.type,
        primary: column.name === "id",
      });
      rationales[`${table}.${column.name}`] = column.rationale;
    }
  }

  return { schema, rationales };
}

export async function loadSchema(): Promise<SchemaSnapshot> {
  return (await loadCatalogue()).schema;
}

export interface GrowthResult {
  table: string;
  added: JournalColumn[];
  /** Full column set after growth, as registered into LivingDNA. */
  columns: NeuralColumn[];
}

/**
 * Widen a table to fit new columns.
 *
 * `create_schema` is re-sent with the complete column set (not just the delta)
 * so LivingDNA holds the whole shape. The journal row is written by the caller
 * via `commitGrowth`, which lets it overlap with the record insert.
 */
export async function growSchema(
  table: string,
  additions: Array<{ name: string; type: NeuralColumnType; rationale: string }>,
  schema: SchemaSnapshot,
): Promise<GrowthResult> {
  const existing = schema[table] ?? [];
  const known = new Set(existing.map((c) => c.name));

  const added: JournalColumn[] = [];

  // A brand-new table gets the traceability columns before anything else.
  if (existing.length === 0) {
    for (const column of BASE_COLUMNS) {
      known.add(column.name);
      added.push({
        name: column.name,
        type: column.type,
        rationale: "structural column",
      });
    }
  }

  for (const addition of additions) {
    if (known.has(addition.name)) continue;
    known.add(addition.name);
    added.push(addition);
  }

  const columns: NeuralColumn[] = [
    ...existing,
    ...added.map((c) => ({
      name: c.name,
      type: c.type,
      primary: c.name === "id",
    })),
  ];

  if (added.length === 0) return { table, added, columns };

  await createSchema(
    [{ name: table, columns }],
    `Grow ${table} to fit newly observed fields`,
  );

  return { table, added, columns };
}

/** Append the growth to the journal. Safe to run alongside the record insert. */
export async function commitGrowth(growth: GrowthResult): Promise<void> {
  if (growth.added.length === 0) return;
  await insertData(
    JOURNAL_TABLE,
    {
      table_name: growth.table,
      columns_json: JSON.stringify(growth.added),
      created_at: new Date().toISOString(),
    },
    `Journal ${growth.added.length} new column(s) on ${growth.table}`,
  );
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
