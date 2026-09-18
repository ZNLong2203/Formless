/**
 * GET /api/state — the current shape of the database plus its contents.
 *
 * Everything is read back out of Neural Pulse, so what the UI renders is the
 * real state of the Virtual Database, never a local cache of record.
 *
 * The payload is held briefly between requests because the free Neural Pulse
 * tier allows only 100 calls a month, and an uncached read costs one call per
 * table per visitor — enough for a public demo to exhaust the quota in an
 * afternoon. `?fresh=1` bypasses the hold, which is what the app itself sends
 * immediately after an ingest so a new column is never shown late.
 */

import { NextResponse } from "next/server";
import { NeuralError, selectData, type NeuralRow } from "@/lib/neural";
import { loadCatalogue, META_TABLE_NAMES } from "@/lib/registry";
import { hasReasoningKey } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Several Neural Pulse reads; comfortably above the ~3s warm path. */
export const maxDuration = 30;

const PAYLOAD_TTL_MS = 60_000;
let cached: { at: number; payload: unknown } | undefined;

async function buildPayload() {
  const { schema, rationales } = await loadCatalogue();
  const businessTables = Object.keys(schema).filter(
    (name) => !META_TABLE_NAMES.includes(name),
  );

  // Reads don't mutate, so every table loads together. A young table failing
  // shouldn't blank the whole drawing, hence allSettled.
  const reads = await Promise.allSettled(
    businessTables.map((table) => selectData(table, undefined, `Load ${table}`)),
  );

  const tables = businessTables.map((name, index) => {
    const result = reads[index];
    const rows: NeuralRow[] = result.status === "fulfilled" ? result.value : [];
    return {
      name,
      columns: (schema[name] ?? []).map((column) => ({
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
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";

  if (!fresh && cached && Date.now() - cached.at < PAYLOAD_TTL_MS) {
    return NextResponse.json(cached.payload);
  }

  try {
    const payload = await buildPayload();
    cached = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    // A quota or network fault should not blank a drawing we already hold.
    if (cached) return NextResponse.json(cached.payload);

    if (error instanceof NeuralError) {
      return NextResponse.json(
        { error: error.message, traceId: error.traceId, layer: "neural-pulse" },
        { status: error.status === 0 ? 503 : error.status },
      );
    }
    const detail = error instanceof Error ? error.message : "Unknown failure";
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
