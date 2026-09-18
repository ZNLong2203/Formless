/**
 * GET /api/state — the current shape of this workspace's database, and its
 * contents.
 *
 * Everything is read back out of Neural Pulse, so what the UI renders is the
 * real state of the Virtual Database, never a local cache of record.
 *
 * Two things shape this route. First, each visitor has their own workspace, so
 * one person's customer emails are never shown to the next. Second, the free
 * Neural Pulse tier allows 100 calls a month, and an uncached read costs one
 * call per table per visitor — so the payload is held briefly, and a visitor
 * whose workspace was minted moments ago is not queried at all.
 */

import { NextResponse } from "next/server";
import {
  isQuotaError,
  NeuralError,
  selectData,
  type NeuralRow,
} from "@/lib/neural";
import { HIDDEN_COLUMNS, loadCatalogue, META_TABLE_NAMES } from "@/lib/registry";
import { hasReasoningKey } from "@/lib/extract";
import { examplePayload, snapshotPayload } from "@/lib/snapshot";
import { attachWorkspace, resolveWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Several Neural Pulse reads; comfortably above the ~3s warm path. */
export const maxDuration = 30;

const PAYLOAD_TTL_MS = 60_000;
const cache = new Map<string, { at: number; payload: unknown }>();

async function buildPayload(workspaceId: string) {
  const { schema, rationales } = await loadCatalogue(workspaceId);
  const businessTables = Object.keys(schema).filter(
    (name) => !META_TABLE_NAMES.includes(name),
  );

  if (businessTables.length === 0) return examplePayload();

  // Reads don't mutate, so every table loads together. A young table failing
  // shouldn't blank the whole drawing, hence allSettled.
  const reads = await Promise.allSettled(
    businessTables.map((table) =>
      selectData(table, { workspace_id: workspaceId }, `Load ${table}`),
    ),
  );

  const tables = businessTables.map((name, index) => {
    const result = reads[index];
    const rows: NeuralRow[] = result.status === "fulfilled" ? result.value : [];
    return {
      name,
      columns: (schema[name] ?? [])
        .filter((column) => !HIDDEN_COLUMNS.includes(column.name))
        .map((column) => ({
          ...column,
          rationale: rationales[`${name}.${column.name}`] ?? "",
        })),
      rows: rows.slice(-50).reverse(),
      rowCount: rows.length,
      error: result.status === "rejected" ? String(result.reason) : undefined,
    };
  });

  return {
    tables,
    totalColumns: tables.reduce((sum, t) => sum + t.columns.length, 0),
    totalRows: tables.reduce((sum, t) => sum + t.rowCount, 0),
    reasoningConfigured: hasReasoningKey(),
  };
}

export async function GET(request: Request) {
  const workspace = resolveWorkspace(request);
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";

  // A workspace minted by this request holds nothing, so proving it empty
  // would spend a call to learn what we already know.
  if (workspace.isNew) {
    return attachWorkspace(NextResponse.json(examplePayload()), workspace);
  }

  const held = cache.get(workspace.id);
  if (!fresh && held && Date.now() - held.at < PAYLOAD_TTL_MS) {
    return attachWorkspace(NextResponse.json(held.payload), workspace);
  }

  try {
    const payload = await buildPayload(workspace.id);
    cache.set(workspace.id, { at: Date.now(), payload });
    return attachWorkspace(NextResponse.json(payload), workspace);
  } catch (error) {
    // A fault must never blank the drawing. Prefer what this workspace last
    // read; otherwise serve the captured snapshot, labelled as such.
    if (held) {
      return attachWorkspace(NextResponse.json(held.payload), workspace);
    }

    const reason = isQuotaError(error)
      ? "the Neural Pulse free tier's monthly call allowance is spent"
      : error instanceof NeuralError
        ? `the virtual database is unreachable (${error.message})`
        : "the virtual database is unreachable";

    return attachWorkspace(
      NextResponse.json(snapshotPayload(reason)),
      workspace,
    );
  }
}
