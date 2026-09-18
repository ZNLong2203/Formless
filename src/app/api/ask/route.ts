/**
 * POST /api/ask — answer a question against a schema nobody designed.
 *
 * The planner reads the live catalogue and expresses the question as
 * conditions over real columns. Equality conditions are pushed into the
 * datastore's `where`; the rest are applied to the rows that come back, because
 * `select_data` matches on equality only. Either way it is one call.
 */

import { NextResponse } from "next/server";
import { isQuotaError, NeuralError, selectData } from "@/lib/neural";
import { hasReasoningKey } from "@/lib/extract";
import { HIDDEN_COLUMNS, loadCatalogue, META_TABLE_NAMES } from "@/lib/registry";
import { applyPlan, planQuery, pushDown } from "@/lib/query";
import { attachWorkspace, resolveWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_QUESTION_CHARS = 500;

export async function POST(request: Request) {
  const workspace = resolveWorkspace(request);

  if (!hasReasoningKey()) {
    return NextResponse.json(
      { error: "Asking questions needs a reasoning model; none is configured." },
      { status: 503 },
    );
  }

  let question: string;
  try {
    const body = await request.json();
    question = typeof body?.question === "string" ? body.question.trim() : "";
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  if (!question) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `question exceeds ${MAX_QUESTION_CHARS} characters` },
      { status: 413 },
    );
  }

  const startedAt = Date.now();

  try {
    if (workspace.isNew) {
      return attachWorkspace(
        NextResponse.json({
          question,
          unanswerable: true,
          explanation:
            "This workspace has no drawing yet. File a message first, then ask.",
          rows: [],
          columns: [],
        }),
        workspace,
      );
    }

    const { schema } = await loadCatalogue(workspace.id);
    const businessTables = Object.keys(schema).filter(
      (name) => !META_TABLE_NAMES.includes(name),
    );

    if (businessTables.length === 0) {
      return attachWorkspace(
        NextResponse.json({
          question,
          unanswerable: true,
          explanation:
            "This workspace has no drawing yet. File a message first, then ask.",
          rows: [],
          columns: [],
        }),
        workspace,
      );
    }

    const visible = Object.fromEntries(
      businessTables.map((name) => [
        name,
        (schema[name] ?? []).filter((c) => !HIDDEN_COLUMNS.includes(c.name)),
      ]),
    );

    const plan = await planQuery(question, visible);

    if (plan.unanswerable || !businessTables.includes(plan.table)) {
      return attachWorkspace(
        NextResponse.json({
          question,
          unanswerable: true,
          explanation:
            plan.explanation ||
            "Nothing in this drawing can answer that question.",
          rows: [],
          columns: [],
          elapsedMs: Date.now() - startedAt,
        }),
        workspace,
      );
    }

    const rows = await selectData(
      plan.table,
      { ...pushDown(plan.conditions), workspace_id: workspace.id },
      `Answer: ${question.slice(0, 60)}`,
    );

    const answered = applyPlan(rows, plan);

    return attachWorkspace(
      NextResponse.json({
        question,
        unanswerable: false,
        table: plan.table,
        explanation: plan.explanation,
        conditions: plan.conditions,
        columns: visible[plan.table] ?? [],
        rows: answered,
        matched: answered.length,
        scanned: rows.length,
        elapsedMs: Date.now() - startedAt,
      }),
      workspace,
    );
  } catch (error) {
    if (isQuotaError(error)) {
      return NextResponse.json(
        {
          error:
            "Neural Pulse has no calls left this month on the free tier, so this question cannot be answered.",
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
