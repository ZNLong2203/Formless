"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Types mirroring the API responses                                   */
/* ------------------------------------------------------------------ */

interface Column {
  name: string;
  type: string;
  primary?: boolean;
  rationale?: string;
}

interface TableState {
  name: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: string;
}

interface AppState {
  tables: TableState[];
  totalColumns: number;
  totalRows: number;
  reasoningConfigured: boolean;
  degraded?: boolean;
  degradedReason?: string;
  example?: boolean;
  snapshotTaken?: string;
}

interface Verdict {
  name: string;
  decision: "keep" | "merge" | "drop";
  merge_into: string;
  reason: string;
}

interface IngestResult {
  summary: string;
  entity: string;
  table: string;
  isNewTable: boolean;
  merged: boolean;
  addedColumns: Column[];
  rejectedColumns: Verdict[];
  confidence: number;
  engine: string;
  elapsedMs: number;
}

interface Answer {
  question: string;
  unanswerable: boolean;
  table?: string;
  explanation: string;
  conditions?: Array<{ column: string; op: string; value: string }>;
  columns: Column[];
  rows: Record<string, unknown>[];
  matched?: number;
  scanned?: number;
}

/* ------------------------------------------------------------------ */

const SAMPLES = [
  {
    label: "a sales lead",
    text: "Hi, this is Maria Chen from Belmont Dental (maria@belmontdental.com). We run 3 clinics in Austin. Our scheduling vendor contract ends in March and we budget about $2,400/month. Can you call me Tuesday?",
  },
  {
    label: "a different industry",
    text: "Hello — Raj Patel, Northwind Logistics, raj@northwind.io. We operate 42 trucks across 6 depots and need dispatch software live before Q1. Budget is $9,000/month and our current NPS is 31.",
  },
  {
    label: "a support ticket",
    text: "URGENT support ticket #4471: customer Acme Tooling reports the export job has failed 14 times since Friday. Severity high. Assigned to the data platform team. First reported 2026-09-12.",
  },
];

const QUESTIONS = [
  { label: "which leads have a budget over 5000?", text: "which leads have a budget over 5000?" },
  { label: "show me everything from Austin", text: "show me everything from Austin" },
  { label: "any tickets marked high severity?", text: "any tickets marked high severity?" },
];

type Mode = "send" | "ask";

const MODES: Array<{ id: Mode; label: string }> = [
  { id: "send", label: "Send a message" },
  { id: "ask", label: "Ask a question" },
];

const MODE_CONFIG: Record<
  Mode,
  {
    lead: string;
    placeholder: string;
    action: string;
    samples: Array<{ label: string; text: string }>;
  }
> = {
  send: {
    lead: "An email, a note, a ticket. No form, no field mapping — the columns get created for you.",
    placeholder: "paste a message…",
    action: "send",
    samples: SAMPLES,
  },
  ask: {
    lead: "You never designed this schema, so you should not need to know it to question it.",
    placeholder: "ask anything about what you have sent…",
    action: "ask",
    samples: QUESTIONS,
  },
};

const PHASES = [
  { at: 0, label: "reading your schema" },
  { at: 1500, label: "working out what this is" },
  { at: 7000, label: "reviewing the new columns" },
  { at: 14000, label: "writing it down" },
];

/** Raw provenance is kept, but it must not crowd out the extracted fields. */
const PROVENANCE = "source_message";

/** One hue per type, so a grown schema can be read at a glance. */
const TYPE_COLOR: Record<string, string> = {
  text: "text-t-text",
  number: "text-t-number",
  date: "text-t-date",
  boolean: "text-t-boolean",
  uuid: "text-t-uuid",
  json: "text-t-json",
};

const typeColor = (type: string) => TYPE_COLOR[type] ?? "text-t-text";

function formatCell(value: unknown, column: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  // A full uuid is thirty-six characters of noise in a table of real facts.
  if (column === "id") return text.slice(0, 8);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10);
  return text;
}

/** Counts climb to their value, so a schema growing reads as growth. */
function useCountUp(value: number, duration = 550): number {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;

    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - started) / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      setShown(Math.round(from + (value - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return shown;
}

/* ------------------------------------------------------------------ */

export default function Console() {
  const [mode, setMode] = useState<Mode>("send");
  const [draft, setDraft] = useState(SAMPLES[0].text);
  const [state, setState] = useState<AppState | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState(0);

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);

  /** Columns to mark as amended, keyed `table.column`. */
  const [revised, setRevised] = useState<Set<string>>(new Set());
  const revisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/state${fresh ? "?fresh=1" : ""}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the database");
      setState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the database");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => void refresh(), [refresh]);

  useEffect(() => {
    if (!busy) return;
    const timers = PHASES.map((step, index) =>
      setTimeout(() => setPhase(index), step.at),
    );
    return () => timers.forEach(clearTimeout);
  }, [busy]);

  useEffect(
    () => () => {
      if (revisionTimer.current) clearTimeout(revisionTimer.current);
    },
    [],
  );

  async function ingest() {
    if (!draft.trim() || busy) return;
    setPhase(0);
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not file that");

      setResult(data);
      setRevised(
        new Set(
          (data.addedColumns as Column[]).map((c) => `${data.table}.${c.name}`),
        ),
      );
      if (revisionTimer.current) clearTimeout(revisionTimer.current);
      revisionTimer.current = setTimeout(() => setRevised(new Set()), 9000);

      await refresh(true);
      // On a phone the workspace sits below the fold, so the change would
      // otherwise happen out of sight.
      workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not file that");
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    if (!draft.trim() || asking) return;
    setAsking(true);
    setError(null);
    setAnswer(null);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not answer that");
      setAnswer(data);
      workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer that");
    } finally {
      setAsking(false);
    }
  }

  const active = MODE_CONFIG[mode];
  const working = busy || asking;
  const run = mode === "send" ? ingest : ask;

  const live = state
    ? !state.reasoningConfigured
      ? "no model"
      : state.degraded
        ? "rate-limited"
        : "live"
    : "…";

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pb-20 sm:px-8">
      {/* ---------------- Masthead ---------------- */}
      <header className="double-rule flex flex-wrap items-baseline gap-x-5 gap-y-2 pb-5 pt-9">
        <h1 className="font-serif text-[31px] font-bold leading-none tracking-tight">
          Formless
        </h1>
        <p className="text-[12.5px] text-dim">a CRM that builds its own database</p>
        <span className="label ml-auto flex items-center gap-2">
          <span
            className={`inline-block size-1.5 rounded-full ${
              state?.degraded ? "bg-mark" : "bg-t-number"
            }`}
          />
          neural pulse · {live}
        </span>
      </header>

      {/* One line, before anything else, answering "what is this". */}
      <p className="mt-5 text-[13px] text-dim">
        Send any message; the columns get created for you.{" "}
        <span className="marker font-semibold text-ink">
          You never design a schema.
        </span>
      </p>

      {error && (
        <div className="mt-6 border-l-2 border-red-800 bg-red-800/[0.06] px-4 py-3 text-[12.5px] text-red-900">
          {error}
        </div>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,370px)_minmax(0,1fr)] lg:gap-12">
        {/* ---------------- Left rail: the two things you can do ------- */}
        <div>
          {/* Send and Ask are two modes of one input, not two features. Built
              as separate panels they duplicated a heading, a lead, a field,
              examples and a button each — twice the furniture for one job. */}
          <div className="flex gap-5 border-b border-rule pb-2.5">
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setMode(item.id)}
                data-active={mode === item.id}
                className="tab text-[13px]"
              >
                {item.label}
              </button>
            ))}
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-faint">
            {active.lead}
          </p>

          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // A question is one line, so Enter sends it. A message is not.
              if (mode === "ask" && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                run();
              }
            }}
            rows={7}
            spellCheck={false}
            placeholder={active.placeholder}
            className="mt-3 block w-full max-w-full resize-y border border-rule bg-inset px-3.5 py-3 text-[12.5px] leading-relaxed text-ink transition placeholder:text-faint focus:border-rule-strong"
          />

          <div className="mt-2.5 flex flex-col gap-1">
            {active.samples.map((sample) => (
              <button
                key={sample.label}
                type="button"
                onClick={() => setDraft(sample.text)}
                className="text-left text-[11.5px] text-faint underline decoration-rule underline-offset-4 transition hover:text-ink hover:decoration-rule-strong"
              >
                {sample.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={run}
            disabled={working || !draft.trim()}
            className="mt-4 w-full bg-ink py-2.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-paper transition hover:opacity-85 disabled:cursor-not-allowed disabled:bg-rule disabled:text-faint"
          >
            {working ? "working" : active.action}
          </button>

          {busy && (
            <div className="mt-3">
              <div className="relative h-px overflow-hidden bg-rule">
                <div className="working absolute inset-0" />
              </div>
              <p className="label mt-2 normal-case tracking-[0.08em]">
                {PHASES[phase].label}
              </p>
            </div>
          )}
          {mode === "send" && <Integrate />}
        </div>

        {/* ---------------- Right: the workspace ---------------------- */}
        <div ref={workspaceRef} className="min-w-0 scroll-mt-6">
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 border-b border-rule pb-3">
            <h2 className="font-serif text-[23px] font-bold leading-none tracking-tight">
              Your database
            </h2>
            <span className="flex items-baseline gap-4">
              <Figure value={state?.tables.length ?? 0} label="tables" />
              <Figure value={state?.totalColumns ?? 0} label="columns" />
              <Figure value={state?.totalRows ?? 0} label="records" />
            </span>
          </div>

          {state?.degraded ? (
            <Notice label="not live">
              Showing the last captured state, because{" "}
              {state.degradedReason ?? "the database is unreachable"}.
            </Notice>
          ) : state?.example ? (
            <Notice label="example">
              None of this was designed — it grew from three messages. Yours is
              empty and private until you send one.
            </Notice>
          ) : null}

          {result && <Revision result={result} />}
          {answer && <AnswerBlock answer={answer} />}

          <div className="mt-8 space-y-10">
            {loading ? (
              <Skeleton />
            ) : state && state.tables.length > 0 ? (
              state.tables.map((table) => (
                <Table key={table.name} table={table} revised={revised} />
              ))
            ) : (
              <p className="text-[12.5px] text-faint">
                Nothing yet. Send a message and a table appears here.
              </p>
            )}
          </div>
        </div>
      </div>

      <footer className="mt-20 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-rule pt-5">
        <span className="label">schema is an output, not a plan</span>
        <span className="label ml-auto">
          built on evorozen neural pulse · livingdna
        </span>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** The shape of a table, before the table arrives. */
function Skeleton() {
  return (
    <div aria-hidden className="space-y-3">
      <div className="skeleton h-5 w-40" />
      <div className="flex flex-wrap gap-1.5">
        {[88, 124, 96, 140, 104, 116, 92].map((width, index) => (
          <div
            key={index}
            className="skeleton h-[26px]"
            style={{ width, animationDelay: `${index * 90}ms` }}
          />
        ))}
      </div>
      <div className="space-y-2 pt-3">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="skeleton h-4 w-full"
            style={{ animationDelay: `${row * 140}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The honest answer to "nobody pastes emails by hand".
 *
 * The box above is one client. The endpoint behind it is the product: point an
 * inbox, a form or a ticket system at it and the database builds itself. That
 * has been true since the first commit; it was simply invisible.
 */
function Integrate() {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  // Read on the client so the example carries whatever host this is served on.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setOrigin(window.location.origin), []);

  const snippet = `curl -X POST ${origin || "https://formless-rose.vercel.app"}/api/ingest \\
  -H 'Content-Type: application/json' \\
  -d '{"message": "Maria Chen, Belmont Dental, 3 clinics in Austin, $2,400/month."}'`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is blocked in some contexts; the text is selectable anyway.
    }
  }

  return (
    <details className="disclose mt-5 border-t border-rule pt-3">
      <summary className="text-[11.5px]">
        Not going to paste emails by hand? Send from anywhere
      </summary>

      <div className="mt-3">
        <p className="text-[11.5px] leading-relaxed text-faint">
          This box is one client. Point an inbox, a form or a ticket system at
          the endpoint and the database builds itself the same way.
        </p>

        <pre className="mt-2.5 overflow-x-auto border border-rule bg-inset px-3 py-2.5 text-[11px] leading-relaxed text-dim">
          {snippet}
        </pre>

        <button
          type="button"
          onClick={copy}
          className="mt-2 text-[11px] text-faint underline decoration-rule underline-offset-4 transition hover:text-ink"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </details>
  );
}

function Figure({ value, label }: { value: number; label: string }) {
  const shown = useCountUp(value);
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-serif text-[20px] font-bold leading-none tabular-nums text-mark">
        {shown}
      </span>
      <span className="label">{label}</span>
    </span>
  );
}

function Notice({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 border-mark bg-mark/[0.06] px-4 py-3">
      <span className="label text-mark">{label}</span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-dim">
        {children}
      </p>
    </div>
  );
}

/** One column, compact. The reasoning is a tooltip, not a permanent row. */
function ColumnChip({ column, isNew }: { column: Column; isNew: boolean }) {
  return (
    <span
      title={column.rationale || undefined}
      className={`chip inline-flex cursor-default items-baseline gap-1.5 border px-2 py-1 text-[12px] ${
        isNew ? "revised border-mark" : "border-rule"
      }`}
    >
      <span className={isNew ? "text-mark" : "text-ink"}>{column.name}</span>
      <span className={`text-[10.5px] ${typeColor(column.type)}`}>
        {column.type}
      </span>
    </span>
  );
}

function Revision({ result }: { result: IngestResult }) {
  const grew = result.addedColumns.length > 0;
  const headline = result.isNewTable
    ? "New table created"
    : result.merged
      ? "Existing record updated"
      : grew
        ? "Schema grew"
        : "Record added";

  return (
    <div className="panel-in mt-5 border-l-2 border-mark bg-mark/[0.06] px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-serif text-[17px] font-bold leading-none text-mark">
          {headline}
        </span>
        <span className="text-[12px] text-dim">{result.table}</span>
        <span className="label ml-auto">
          {(result.elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>

      <p className="mt-2.5 text-[12.5px] leading-relaxed text-dim">
        {result.summary}
      </p>

      {grew && (
        <div className="mt-4">
          <p className="label mb-2">columns it had to create</p>
          <ul className="space-y-1">
            {result.addedColumns.map((column) => (
              <li
                key={column.name}
                className="flex flex-wrap items-baseline gap-x-2 text-[12px]"
              >
                <span className="text-mark">{column.name}</span>
                <span className={`text-[10.5px] ${typeColor(column.type)}`}>
                  {column.type}
                </span>
                <span className="text-faint">
                  {column.rationale || "structural"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The brake, shown working. What was refused matters as much as what
          landed: a schema that only grows is a schema nobody can use. */}
      {result.rejectedColumns.length > 0 && (
        <div className="mt-4">
          <p className="label mb-2">columns it refused to create</p>
          <ul className="space-y-1">
            {result.rejectedColumns.map((verdict) => (
              <li
                key={verdict.name}
                className="flex flex-wrap items-baseline gap-x-2 text-[12px]"
              >
                <span className="text-faint line-through">{verdict.name}</span>
                {verdict.decision === "merge" && verdict.merge_into && (
                  <>
                    <span className="text-faint">→</span>
                    <span className="text-ink">{verdict.merge_into}</span>
                  </>
                )}
                <span className="text-faint">{verdict.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AnswerBlock({ answer }: { answer: Answer }) {
  if (answer.unanswerable) {
    return (
      <p className="panel-in mt-5 border-l-2 border-rule-strong px-4 py-2.5 text-[12.5px] text-dim">
        {answer.explanation}
      </p>
    );
  }

  return (
    <div className="panel-in mt-5 border-l-2 border-rule-strong px-4 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-[12.5px] text-ink">{answer.explanation}</p>
        <span className="label ml-auto">
          {answer.matched} of {answer.scanned}
        </span>
      </div>

      {/* The plan, so the answer can be checked rather than trusted. */}
      {answer.conditions && answer.conditions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {answer.conditions.map((condition, index) => (
            <span
              key={`${condition.column}-${index}`}
              className="border border-rule px-2 py-0.5 text-[11px] text-dim"
            >
              {condition.column}{" "}
              <span className="text-t-number">{condition.op}</span>{" "}
              {condition.value}
            </span>
          ))}
        </div>
      )}

      {answer.rows.length > 0 ? (
        <Rows columns={answer.columns} rows={answer.rows} />
      ) : (
        <p className="mt-3 text-[12.5px] text-faint">Nothing matches that.</p>
      )}
    </div>
  );
}

function Rows({
  columns,
  rows,
}: {
  columns: Column[];
  rows: Record<string, unknown>[];
}) {
  const visible = columns.filter((c) => c.name !== PROVENANCE);

  return (
    <div className="scroller mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {visible.map((column) => (
              <th
                key={column.name}
                className="whitespace-nowrap border-b border-rule-strong px-3 py-2 font-normal"
              >
                <span className="label">{column.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((row, index) => (
            <tr key={String(row._id ?? index)}>
              {visible.map((column) => {
                const value = formatCell(row[column.name], column.name);
                return (
                  <td
                    key={column.name}
                    title={value}
                    className={`max-w-[230px] truncate border-b border-rule px-3 py-2.5 text-[12px] ${
                      value === "—"
                        ? "text-faint"
                        : column.type === "number"
                          ? "text-t-number tabular-nums"
                          : column.type === "date"
                            ? "text-t-date"
                            : "text-dim"
                    }`}
                  >
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Table({
  table,
  revised,
}: {
  table: TableState;
  revised: Set<string>;
}) {
  return (
    <article className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-serif text-[21px] font-bold leading-none tracking-tight">
          {table.name}
        </h3>
        <span className="label">
          {table.columns.length} columns · {table.rowCount} records
        </span>
        <span className="label ml-auto normal-case tracking-[0.06em]">
          hover a column for why it exists
        </span>
      </div>

      {/* Compact by design. One full-width row per column turned sixteen
          columns into a wall; as chips they read in three lines. */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {table.columns.map((column) => (
          <ColumnChip
            key={column.name}
            column={column}
            isNew={revised.has(`${table.name}.${column.name}`)}
          />
        ))}
      </div>

      {table.rows.length > 0 && (
        <Rows columns={table.columns} rows={table.rows} />
      )}
    </article>
  );
}
