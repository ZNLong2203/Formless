/**
 * POST /api/ingest — the whole product in one request.
 *
 * Raw text goes in; the schema grows to fit it and the record lands in the
 * Virtual Database. The response narrates each step so the UI can show the
 * database changing shape rather than just reporting success.
 */

import { NextResponse } from "next/server";
import { insertData, isQuotaError, NeuralError } from "@/lib/neural";
import { extractEntity, hasReasoningKey } from "@/lib/extract";
import {
  commitGrowth,
  growSchema,
  loadSchema,
  META_TABLE_NAMES,
} from "@/lib/registry";

export const runtime = "nodejs";

/**
 * An ingest is a model call plus several Neural Pulse round trips — about 16s.
 * Serverless defaults cut well below that, which would fail the request in
 * production while working locally, so the ceiling is declared explicitly.
 */
export const maxDuration = 60;

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

    // Never let the model write into Formless's own bookkeeping tables.
    if (META_TABLE_NAMES.includes(extraction.table)) {
      extraction.table = `${extraction.table}_records`;
    }

    const isNewTable = schemaBefore[extraction.table] === undefined;
    const growth = await growSchema(
      extraction.table,
      extraction.new_columns,
      schemaBefore,
    );

    // Two different tables, so these are safe to run concurrently — writes are
    // only serialized within a table. A failed journal append must not take the
    // record down with it, hence allSettled.
    const [recordResult] = await Promise.allSettled([
      insertData(
        extraction.table,
        {
          // The schema declares `id` as the primary key, so it gets a real
          // value rather than sitting empty next to the kernel's own `_id`.
          id: crypto.randomUUID(),
          ...extraction.record,
          source_message: message.slice(0, 2000),
          ingested_at: new Date().toISOString(),
        },
        `Store ${extraction.entity_label} in ${extraction.table}`,
      ),
      commitGrowth(growth),
    ]);

    if (recordResult.status === "rejected") throw recordResult.reason;

    return NextResponse.json({
      summary: extraction.summary,
      entity: extraction.entity_label,
      table: extraction.table,
      isNewTable,
      addedColumns: growth.added,
      columns: growth.columns,
      record: recordResult.value,
      confidence: extraction.confidence,
      engine: extraction.engine,
      reasoningConfigured: hasReasoningKey(),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (isQuotaError(error)) {
      return NextResponse.json(
        {
          error:
            "Neural Pulse has no calls left this month on the free tier, so this record cannot be written. The drawing below is the last captured state.",
          layer: "neural-pulse",
          quota: true,
        },
        { status: 429 },
      );
    }
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
