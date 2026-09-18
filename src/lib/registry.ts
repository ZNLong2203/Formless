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
  type NeuralRow,
  type NeuralTable,
} from "./neural";

/** Catalogue of columns, keyed by table name. */
export type SchemaSnapshot = Record<string, NeuralColumn[]>;

export const JOURNAL_TABLE = "formless_schema_journal";

/** Reserved names that hold Formless's own bookkeeping, not business records. */
export const META_TABLE_NAMES: readonly string[] = [JOURNAL_TABLE];

/** Columns every ingested table carries, so records are always traceable. */
const BASE_COLUMNS: NeuralColumn[] = [
  { name: "id", type: "uuid", primary: true },
  { name: "workspace_id", type: "text" },
  { name: "source_message", type: "text" },
  { name: "ingested_at", type: "date" },
];

/** Columns that exist for bookkeeping and should never be shown as fields. */
export const HIDDEN_COLUMNS: readonly string[] = ["workspace_id"];

const META_TABLES: NeuralTable[] = [
  {
    name: JOURNAL_TABLE,
    columns: [
      { name: "id", type: "uuid", primary: true },
      { name: "workspace_id", type: "text" },
      { name: "table_name", type: "text" },
      { name: "columns_json", type: "text" },
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

/**
 * Catalogue cache.
 *
 * The journal only changes when this app appends to it, so the folded result is
 * held briefly instead of re-read on every request — that removes one ~3s round
 * trip from each page load. `invalidateCatalogue` clears it the moment the
 * schema grows, and the TTL bounds staleness for other instances in a scaled
 * deployment, where a stale read means a slightly late column, never a wrong
 * record.
 */
const CATALOGUE_TTL_MS = 10_000;
const catalogueCache = new Map<string, { at: number; value: Catalogue }>();

export function invalidateCatalogue(workspaceId?: string): void {
  if (workspaceId) catalogueCache.delete(workspaceId);
  else catalogueCache.clear();
}

/**
 * Fold journal rows into the live schema.
 *
 * Pure, and deliberately tolerant: the kernel's non-atomic writes can duplicate
 * a row, so folding dedupes by column name rather than trusting the journal to
 * contain each column exactly once.
 */
export function foldJournal(rows: readonly NeuralRow[]): Catalogue {
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

/** Read one workspace's journal and fold it, holding the result briefly. */
export async function loadCatalogue(workspaceId: string): Promise<Catalogue> {
  const held = catalogueCache.get(workspaceId);
  if (held && Date.now() - held.at < CATALOGUE_TTL_MS) return held.value;

  await ensureMeta();
  const rows = await selectData(
    JOURNAL_TABLE,
    { workspace_id: workspaceId },
    "Fold this workspace's LivingDNA journal",
  );

  const catalogue = foldJournal(rows);
  catalogueCache.set(workspaceId, { at: Date.now(), value: catalogue });
  return catalogue;
}

export async function loadSchema(workspaceId: string): Promise<SchemaSnapshot> {
  return (await loadCatalogue(workspaceId)).schema;
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
export function planGrowth(
  table: string,
  additions: Array<{ name: string; type: NeuralColumnType; rationale: string }>,
  schema: SchemaSnapshot,
): GrowthResult {
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

  return { table, added, columns };
}

/** Plan the growth, then register the widened shape into LivingDNA. */
export async function growSchema(
  table: string,
  additions: Array<{ name: string; type: NeuralColumnType; rationale: string }>,
  schema: SchemaSnapshot,
): Promise<GrowthResult> {
  const growth = planGrowth(table, additions, schema);
  if (growth.added.length === 0) return growth;

  await createSchema(
    [{ name: table, columns: growth.columns }],
    `Grow ${table} to fit newly observed fields`,
  );

  return growth;
}

/** Append the growth to the journal. Safe to run alongside the record insert. */
export async function commitGrowth(
  growth: GrowthResult,
  workspaceId: string,
): Promise<void> {
  if (growth.added.length === 0) return;
  await insertData(
    JOURNAL_TABLE,
    {
      workspace_id: workspaceId,
      table_name: growth.table,
      columns_json: JSON.stringify(growth.added),
      created_at: new Date().toISOString(),
    },
    `Journal ${growth.added.length} new column(s) on ${growth.table}`,
  );
  invalidateCatalogue(workspaceId);
}
