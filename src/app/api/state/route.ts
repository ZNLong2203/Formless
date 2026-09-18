/**
 * GET /api/state — the current shape of the database plus its contents.
 *
 * Everything is read back out of Neural Pulse, so what the UI renders is the
 * real state of the Virtual Database, never a local cache.
 */

import { NextResponse } from "next/server";
import { NeuralError, selectData, type NeuralRow } from "@/lib/neural";
import { EVENT_TABLE, loadCatalogue, META_TABLE_NAMES } from "@/lib/registry";
import { hasReasoningKey } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { schema, rationales } = await loadCatalogue();
    const businessTables = Object.keys(schema).filter(
      (name) => !META_TABLE_NAMES.includes(name),
    );

    // One read per table; a young table failing shouldn't blank the dashboard.
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

    const events = await selectData(EVENT_TABLE, undefined, "Load activity").catch(
      () => [] as NeuralRow[],
    );

    return NextResponse.json({
      tables,
      events: events.slice(-30).reverse(),
      totalColumns: tables.reduce((sum, t) => sum + t.columns.length, 0),
      totalRows: tables.reduce((sum, t) => sum + t.rowCount, 0),
      reasoningConfigured: hasReasoningKey(),
    });
  } catch (error) {
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
