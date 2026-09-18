/**
 * POST /api/ingest — the whole product in one request.
 *
 * Raw text goes in; the schema grows to fit it and the record lands in the
 * Virtual Database. The response narrates each step so the UI can show the
 * database changing shape rather than just reporting success.
 */

import { NextResponse } from "next/server";
import { insertData, NeuralError } from "@/lib/neural";
import { extractEntity, hasReasoningKey } from "@/lib/extract";
import { growSchema, loadSchema, logEvent } from "@/lib/registry";

export const runtime = "nodejs";

const MAX_MESSAGE_CHARS = 8000;

export async function POST(request: Request) {
  let message: string;
  try {
    const body = await request.json();
    message = typeof body?.message === "string" ? body.message.trim() : "";
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: `message exceeds ${MAX_MESSAGE_CHARS} characters` },
      { status: 413 },
    );
  }

  const startedAt = Date.now();

  try {
    const schemaBefore = await loadSchema();
    const extraction = await extractEntity(message, schemaBefore);

    const growth = await growSchema(
      extraction.table,
      extraction.new_columns,
      schemaBefore,
    );

    const row = await insertData(
      extraction.table,
      {
        ...extraction.record,
        source_message: message.slice(0, 2000),
        ingested_at: new Date().toISOString(),
      },
      `Store ${extraction.entity_label} in ${extraction.table}`,
    );

    await logEvent(
      growth.added.length > 0 ? "schema_grown" : "record_added",
      growth.added.length > 0
        ? `${extraction.table} gained ${growth.added.map((c) => c.name).join(", ")}`
        : `${extraction.entity_label} added to ${extraction.table}`,
      extraction.table,
    );

    return NextResponse.json({
      summary: extraction.summary,
      entity: extraction.entity_label,
      table: extraction.table,
      isNewTable: extraction.is_new_table && schemaBefore[extraction.table] === undefined,
      addedColumns: growth.added.map((column) => ({
        ...column,
        rationale:
          extraction.new_columns.find((c) => c.name === column.name)?.rationale ??
          "structural column",
      })),
      columns: growth.columns,
      record: row,
      confidence: extraction.confidence,
      engine: extraction.engine,
      reasoningConfigured: hasReasoningKey(),
      elapsedMs: Date.now() - startedAt,
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
