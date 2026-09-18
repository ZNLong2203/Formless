/**
 * POST /api/ingest — the whole product in one request.
 *
 * Raw text goes in; the schema grows to fit it and the record lands in the
 * Virtual Database. The response narrates each step so the UI can show the
 * database changing shape rather than just reporting success.
 */

import { NextResponse } from "next/server";
import {
  insertData,
  isQuotaError,
  NeuralError,
  selectData,
  updateData,
} from "@/lib/neural";
import { extractEntity, hasReasoningKey } from "@/lib/extract";
import {
  commitGrowth,
  growSchema,
  loadSchema,
  META_TABLE_NAMES,
} from "@/lib/registry";
import { attachWorkspace, resolveWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

/**
 * An ingest is two model calls plus several Neural Pulse round trips — about
 * 20s. Serverless defaults cut well below that, which would fail the request in
 * production while working locally, so the ceiling is declared explicitly.
 */
export const maxDuration = 60;

const MAX_MESSAGE_CHARS = 8000;

export async function POST(request: Request) {
  const workspace = resolveWorkspace(request);

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
    // A workspace minted by this very request is known to be empty, so the
    // read that would prove it empty is skipped.
    const schemaBefore = workspace.isNew ? {} : await loadSchema(workspace.id);
    const extraction = await extractEntity(message, schemaBefore);

    // Never let the model write into Formless's own bookkeeping tables.
    if (META_TABLE_NAMES.includes(extraction.table)) {
      extraction.table = `${extraction.table}_records`;
    }

    const isNewTable = schemaBefore[extraction.table] === undefined;

    // Entity resolution: a second message about the same company should update
    // that company, not file a duplicate beside it. Only worth looking when the
    // table already existed — a table created moments ago holds nothing.
    //
    // This is a read, so it is not held behind the table's write queue, and it
    // does not depend on the widened schema. It therefore runs alongside the
    // schema registration rather than after it.
    const identity = extraction.identity_column;
    const identityValue = identity ? extraction.record[identity] : undefined;

    const [growth, existing] = await Promise.all([
      growSchema(extraction.table, extraction.new_columns, schemaBefore),
      !isNewTable && identity && identityValue !== undefined
        ? selectData(
            extraction.table,
            { workspace_id: workspace.id, [identity]: identityValue },
            `Look for an existing ${extraction.entity_label}`,
          ).catch(() => [])
        : Promise.resolve([]),
    ]);

    const matched = existing[0]?._id;

    const payload = {
      ...extraction.record,
      workspace_id: workspace.id,
      source_message: message.slice(0, 2000),
      ingested_at: new Date().toISOString(),
    };

    const [writeResult] = await Promise.allSettled([
      matched
        ? updateData(
            extraction.table,
            { workspace_id: workspace.id, [identity]: identityValue },
            { ...extraction.record, source_message: payload.source_message },
            `Update ${extraction.entity_label}`,
          ).then(() => ({ ...payload, _id: matched }))
        : insertData(
            extraction.table,
            { id: crypto.randomUUID(), ...payload },
            `Store ${extraction.entity_label} in ${extraction.table}`,
          ),
      commitGrowth(growth, workspace.id),
    ]);

    if (writeResult.status === "rejected") throw writeResult.reason;

    return attachWorkspace(
      NextResponse.json({
        summary: extraction.summary,
        entity: extraction.entity_label,
        table: extraction.table,
        isNewTable,
        merged: Boolean(matched),
        identityColumn: identity || undefined,
        addedColumns: growth.added,
        rejectedColumns: extraction.rejected,
        columns: growth.columns,
        record: writeResult.value,
        confidence: extraction.confidence,
        engine: extraction.engine,
        reasoningConfigured: hasReasoningKey(),
        elapsedMs: Date.now() - startedAt,
      }),
      workspace,
    );
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
