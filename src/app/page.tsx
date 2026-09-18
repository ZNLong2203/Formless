"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  /** True when the live database could not be read and a capture is shown. */
  degraded?: boolean;
  degradedReason?: string;
  /** True when this visitor's own workspace is still empty. */
  example?: boolean;
  snapshotTaken?: string;
}

interface Verdict {
  name: string;
  decision: "keep" | "merge" | "drop";
  merge_into: string;
  reason: string;
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
  elapsedMs?: number;
}

interface IngestResult {
  summary: string;
  entity: string;
  table: string;
  isNewTable: boolean;
  addedColumns: Column[];
  rejectedColumns: Verdict[];
  merged: boolean;
  identityColumn?: string;
  confidence: number;
  engine: "claude" | "gemini" | "heuristic";
  elapsedMs: number;
}

const SAMPLES = [
  {
    ref: "A",
    note: "an inbound lead",
    text: "Hi, this is Maria Chen from Belmont Dental (maria@belmontdental.com). We run 3 clinics in Austin. Our scheduling vendor contract ends in March and we budget about $2,400/month. Can you call me Tuesday?",
  },
  {
    ref: "B",
    note: "another industry entirely",
    text: "Hello — Raj Patel, Northwind Logistics, raj@northwind.io. We operate 42 trucks across 6 depots and need dispatch software live before Q1. Budget is $9,000/month and our current NPS is 31.",
  },
  {
    ref: "C",
    note: "a different kind of thing",
    text: "URGENT support ticket #4471: customer Acme Tooling reports the export job has failed 14 times since Friday. Severity high. Assigned to the data platform team. First reported 2026-09-12.",
  },
];

const PHASES = [
  { at: 0, label: "reading the current drawing" },
  { at: 1200, label: "deciding what this record is" },
  { at: 6000, label: "amending the schema" },
  { at: 11000, label: "filing the record" },
];

/** Raw provenance is kept, but it must not crowd out the extracted fields. */
const PROVENANCE = "source_message";

function isFigure(type: string): boolean {
  return type === "number";
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value.slice(0, 10);
  }
  return String(value);
}

/* ------------------------------------------------------------------ */

export default function Sheet() {
  const [message, setMessage] = useState(SAMPLES[0].text);
  const [state, setState] = useState<AppState | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState(0);

  /** Columns to mark as amended, keyed `table.column`. */
  const [revised, setRevised] = useState<Set<string>>(new Set());
  const revisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * `fresh` bypasses the server-side hold. Only the moment after an ingest
   * needs that; ordinary visitors are served the held payload, which is what
   * keeps a public demo inside the Neural Pulse quota.
   */
  const refresh = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/state${fresh ? "?fresh=1" : ""}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the drawing");
      setState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the drawing");
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
    if (!message.trim() || busy) return;
    setPhase(0);
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "The amendment failed");

      setResult(data);
      setRevised(
        new Set(
          (data.addedColumns as Column[]).map((c) => `${data.table}.${c.name}`),
        ),
      );
      if (revisionTimer.current) clearTimeout(revisionTimer.current);
      revisionTimer.current = setTimeout(() => setRevised(new Set()), 9000);

      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The amendment failed");
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setError(null);
    setAnswer(null);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "The question could not be put");
      setAnswer(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The question could not be put");
    } finally {
      setAsking(false);
    }
  }

  const engineLabel = useMemo(() => {
    if (!state) return "…";
    if (!state.reasoningConfigured) return "no model — degraded";
    return state.degraded ? "model live · database rate-limited" : "live model";
  }, [state]);

  return (
    <div className="graph min-h-screen overflow-x-hidden">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-7 sm:px-6 sm:py-10">
        <TitleBlock state={state} engineLabel={engineLabel} />

        {state?.degraded ? (
          <SupersededStamp
            label="not live"
            body={`Showing the last captured state, because ${state.degradedReason ?? "the virtual database is unreachable"}. Filing a new record will not work until the allowance returns.`}
            taken={state.snapshotTaken}
          />
        ) : state?.example ? (
          <SupersededStamp
            label="example"
            body="This is what a drawing looks like after three messages. Your own workspace is empty and private — file a message and it becomes yours."
          />
        ) : null}

        <Intake
          message={message}
          setMessage={setMessage}
          busy={busy}
          phase={phase}
          onIngest={ingest}
        />

        {error && (
          <div className="ticked mt-6 border border-red-400/35 bg-red-500/[0.05] px-5 py-4 text-[12px] text-red-200">
            <div className="stamp mb-1 text-red-300/70">fault</div>
            {error}
          </div>
        )}

        <Enquiry
          question={question}
          setQuestion={setQuestion}
          asking={asking}
          answer={answer}
          onAsk={ask}
        />

        {result && <RevisionNote result={result} />}

        <section className="mt-12">
          <SectionRule index="04" title="the drawing" />
          {loading ? (
            <Placeholder>reading the virtual database…</Placeholder>
          ) : state && state.tables.length > 0 ? (
            <div className="mt-6 space-y-12">
              {state.tables.map((table, index) => (
                <Plate
                  key={table.name}
                  table={table}
                  index={index}
                  revised={revised}
                />
              ))}
            </div>
          ) : (
            <Placeholder>
              the sheet is blank. file a message and a table will be drawn.
            </Placeholder>
          )}
        </section>

        <footer className="mt-16 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line pt-5">
          <span className="stamp">formless</span>
          <span className="stamp">
            drawn on evorozen neural pulse · livingdna
          </span>
          <span className="stamp ml-auto">schema is an output, not a plan</span>
        </footer>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Title block                                                         */
/* ------------------------------------------------------------------ */

function TitleBlock({
  state,
  engineLabel,
}: {
  state: AppState | null;
  engineLabel: string;
}) {
  const cells = [
    { label: "subject", value: "a CRM that draws its own database" },
    { label: "datastore", value: "evorozen neural pulse" },
    { label: "engine", value: engineLabel },
  ];

  const figures = [
    { label: "tables", value: state?.tables.length ?? 0 },
    { label: "columns", value: state?.totalColumns ?? 0 },
    { label: "records", value: state?.totalRows ?? 0 },
  ];

  return (
    <header className="ticked border border-line-mid">
      <div className="flex min-w-0 flex-col gap-0 lg:flex-row">
        <div className="flex items-end gap-3 px-6 py-5 lg:border-r lg:border-line">
          <h1 className="font-serif text-[44px] leading-[0.85] tracking-tight text-chalk">
            Formless
          </h1>
          <span className="beacon mb-1.5 inline-block size-1.5 shrink-0 rounded-full bg-mark" />
        </div>

        <dl className="grid min-w-0 flex-1 grid-cols-1 sm:grid-cols-3">
          {cells.map((cell, index) => (
            <div
              key={cell.label}
              className={`px-5 py-3.5 ${
                index > 0 ? "border-t border-line sm:border-l sm:border-t-0" : ""
              }`}
            >
              <dt className="stamp">{cell.label}</dt>
              <dd className="mt-1 text-[12px] leading-snug text-dim">
                {cell.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="grid grid-cols-3 border-t border-line">
        {figures.map((figure, index) => (
          <div
            key={figure.label}
            className={`px-3 py-3 sm:px-5 ${
              index > 0 ? "border-l border-line" : ""
            }`}
          >
            <span className="font-serif text-[24px] leading-none text-chalk tabular-nums sm:text-[26px]">
              {String(figure.value).padStart(2, "0")}
            </span>
            <span className="stamp ml-1.5 sm:ml-2">{figure.label}</span>
          </div>
        ))}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Intake                                                              */
/* ------------------------------------------------------------------ */

function Intake({
  message,
  setMessage,
  busy,
  phase,
  onIngest,
}: {
  message: string;
  setMessage: (value: string) => void;
  busy: boolean;
  phase: number;
  onIngest: () => void;
}) {
  return (
    <section className="mt-12">
      <SectionRule index="01" title="intake" />

      <div className="mt-6 grid gap-px border border-line-mid bg-line lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 bg-sheet">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder="paste an email, a note, a ticket…"
            className="block w-full max-w-full resize-y bg-transparent px-5 py-4 text-[12.5px] leading-[1.75] text-chalk placeholder:text-faint"
          />
        </div>

        <div className="flex min-w-0 flex-col justify-between gap-4 bg-sheet px-5 py-4">
          <div>
            <div className="stamp">specimens</div>
            <ul className="mt-2.5 space-y-1.5">
              {SAMPLES.map((sample) => (
                <li key={sample.ref}>
                  <button
                    type="button"
                    onClick={() => setMessage(sample.text)}
                    className="group flex w-full items-center gap-2.5 text-left"
                  >
                    <span className="flex size-[18px] shrink-0 items-center justify-center border border-line-mid text-[9.5px] text-dim transition group-hover:border-mark group-hover:text-mark">
                      {sample.ref}
                    </span>
                    <span className="text-[12px] text-faint transition group-hover:text-chalk">
                      {sample.note}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <button
              type="button"
              onClick={onIngest}
              disabled={busy || !message.trim()}
              className="w-full border border-chalk bg-chalk px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#071523] transition hover:bg-transparent hover:text-chalk disabled:cursor-not-allowed disabled:border-line-mid disabled:bg-transparent disabled:text-faint"
            >
              {busy ? "amending" : "file this"}
            </button>

            {busy && (
              <div className="mt-2.5 h-[2px] overflow-hidden bg-line">
                <div className="survey relative h-full w-full" />
              </div>
            )}
            <p className="stamp mt-2 h-3 normal-case tracking-[0.1em]">
              {busy ? PHASES[phase].label : ""}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Revision note                                                       */
/* ------------------------------------------------------------------ */

function RevisionNote({ result }: { result: IngestResult }) {
  const amended = result.addedColumns.length > 0;

  return (
    <section className="mt-10">
      <SectionRule index="03" title="revision note" />

      <div className="ticked mt-6 border border-mark/40 bg-mark/[0.035]">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-mark/20 px-5 py-3">
          <span className="font-serif text-[19px] leading-none text-mark">
            {result.isNewTable
              ? "new plate drawn"
              : result.merged
                ? "existing record updated"
                : amended
                  ? "schema amended"
                  : "record filed"}
          </span>
          <span className="text-[12px] text-chalk">{result.table}</span>
          <span className="stamp ml-auto">
            {(result.elapsedMs / 1000).toFixed(1)}s · {result.engine}
          </span>
        </div>

        <p className="px-5 py-4 text-[12.5px] leading-relaxed text-dim">
          {result.summary}
        </p>

        {amended && (
          <ul className="border-t border-mark/20 px-5 py-4">
            {result.addedColumns.map((column) => (
              <li
                key={column.name}
                className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 py-1"
              >
                <span className="text-[9.5px] text-mark/70">+</span>
                <span className="text-[12px] text-mark">{column.name}</span>
                <span className="stamp normal-case tracking-[0.08em]">
                  {column.type}
                </span>
                <span className="leader hidden sm:block" />
                <span className="min-w-0 text-[12px] text-faint">
                  {column.rationale || "structural"}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* The brake, shown working. A schema that only grows is a schema
            nobody can use, so what was refused matters as much as what landed. */}
        {result.rejectedColumns.length > 0 && (
          <ul className="border-t border-mark/20 px-5 py-4">
            <li className="stamp mb-2">held back by review</li>
            {result.rejectedColumns.map((verdict) => (
              <li
                key={verdict.name}
                className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 py-1"
              >
                <span className="text-[9.5px] text-faint">
                  {verdict.decision === "merge" ? "\u2192" : "\u00d7"}
                </span>
                <span className="text-[12px] text-faint line-through">
                  {verdict.name}
                </span>
                {verdict.decision === "merge" && verdict.merge_into && (
                  <span className="text-[12px] text-chalk">
                    {verdict.merge_into}
                  </span>
                )}
                <span className="leader hidden sm:block" />
                <span className="min-w-0 text-[11.5px] text-faint">
                  {verdict.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* A plate — one table, drawn                                          */
/* ------------------------------------------------------------------ */

function Plate({
  table,
  index,
  revised,
}: {
  table: TableState;
  index: number;
  revised: Set<string>;
}) {
  const visible = table.columns.filter((c) => c.name !== PROVENANCE);

  return (
    <article className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="stamp">plate {String.fromCharCode(65 + index)}</span>
        <h3 className="font-serif text-[27px] leading-none text-chalk">
          {table.name}
        </h3>
        <span className="stamp">
          {table.columns.length} columns · {table.rowCount} records
        </span>
      </div>

      <div className="rule mt-3" />

      {/* The parts list: every column, and why it exists. */}
      <ul className="mt-1">
        {table.columns.map((column) => {
          const isNew = revised.has(`${table.name}.${column.name}`);
          const rationale = column.rationale || "structural";
          return (
            <li
              key={column.name}
              className={`border-b border-line px-1 py-2 ${
                isNew ? "revised" : ""
              }`}
            >
              <div className="flex items-baseline gap-x-2.5">
                <span
                  className={`shrink-0 text-[12px] ${
                    isNew ? "text-mark" : "text-chalk"
                  }`}
                >
                  {column.name}
                </span>
                <span
                  className={`stamp shrink-0 normal-case tracking-[0.08em] ${
                    isFigure(column.type) ? "text-figure" : ""
                  }`}
                >
                  {column.type}
                </span>
                {column.primary && (
                  <span className="stamp shrink-0">key</span>
                )}

                {/* The leader only earns its place where there is room. */}
                <span className="leader hidden sm:block" />
                <span
                  title={rationale}
                  className="hidden min-w-0 max-w-[44ch] truncate text-right text-[12px] text-faint sm:block"
                >
                  {rationale}
                </span>

                {isNew && (
                  <span className="stamp ml-auto shrink-0 border border-mark/50 px-1 py-px text-mark sm:ml-0">
                    rev
                  </span>
                )}
              </div>

              <p className="mt-1 text-[11.5px] leading-snug text-faint sm:hidden">
                {rationale}
              </p>
            </li>
          );
        })}
      </ul>

      {table.rows.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {visible.map((column) => (
                  <th
                    key={column.name}
                    className="whitespace-nowrap border-b border-line-mid px-3 py-2 font-normal"
                  >
                    <span className="stamp">{column.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 8).map((row, rowIndex) => (
                <tr key={String(row._id ?? rowIndex)}>
                  {visible.map((column) => {
                    // The kernel assigns `_id`; the declared `id` mirrors it.
                    const raw =
                      column.name === "id" && row.id === undefined
                        ? row._id
                        : row[column.name];
                    const value = formatCell(raw);
                    return (
                      <td
                        key={column.name}
                        title={value}
                        className={`max-w-[240px] truncate border-b border-line px-3 py-2.5 text-[12px] ${
                          value === "—"
                            ? "text-faint"
                            : isFigure(column.type)
                              ? "text-figure tabular-nums"
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
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Enquiry — asking a schema you never designed                        */
/* ------------------------------------------------------------------ */

const QUESTIONS = [
  "which leads have a budget over 5000?",
  "show me everything from Austin",
  "any tickets marked high severity?",
];

function Enquiry({
  question,
  setQuestion,
  asking,
  answer,
  onAsk,
}: {
  question: string;
  setQuestion: (value: string) => void;
  asking: boolean;
  answer: Answer | null;
  onAsk: () => void;
}) {
  return (
    <section className="mt-12">
      <SectionRule index="02" title="enquiry" />

      <div className="mt-6 border border-line-mid">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onAsk();
            }}
            spellCheck={false}
            placeholder="ask anything — you do not need to know the schema"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-chalk outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={onAsk}
            disabled={asking || !question.trim()}
            className="shrink-0 border border-line-strong px-4 py-2 text-[11px] uppercase tracking-[0.16em] text-chalk transition hover:border-chalk disabled:cursor-not-allowed disabled:border-line disabled:text-faint"
          >
            {asking ? "asking" : "ask"}
          </button>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-5 py-2.5">
          {QUESTIONS.map((sample) => (
            <button
              key={sample}
              type="button"
              onClick={() => setQuestion(sample)}
              className="text-[11.5px] text-faint transition hover:text-chalk"
            >
              {sample}
            </button>
          ))}
        </div>

        {answer && <AnswerBlock answer={answer} />}
      </div>
    </section>
  );
}

function AnswerBlock({ answer }: { answer: Answer }) {
  if (answer.unanswerable) {
    return (
      <div className="border-t border-line px-5 py-4 text-[12px] text-dim">
        {answer.explanation}
      </div>
    );
  }

  const visible = answer.columns.filter((c) => c.name !== PROVENANCE);

  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
        <span className="text-[12px] text-chalk">{answer.explanation}</span>
        <span className="stamp ml-auto">
          {answer.matched} of {answer.scanned} · {answer.table}
        </span>
      </div>

      {/* The plan, shown so the answer can be checked rather than trusted. */}
      {answer.conditions && answer.conditions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-2.5">
          {answer.conditions.map((condition, index) => (
            <span
              key={`${condition.column}-${index}`}
              className="border border-line px-2 py-0.5 text-[11px] text-dim"
            >
              {condition.column}{" "}
              <span className="text-faint">{condition.op}</span>{" "}
              {condition.value}
            </span>
          ))}
        </div>
      )}

      {answer.rows.length > 0 ? (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {visible.map((column) => (
                  <th
                    key={column.name}
                    className="whitespace-nowrap border-b border-line-mid px-3 py-2 font-normal"
                  >
                    <span className="stamp">{column.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {answer.rows.map((row, index) => (
                <tr key={String(row._id ?? index)}>
                  {visible.map((column) => {
                    const value = formatCell(row[column.name]);
                    return (
                      <td
                        key={column.name}
                        title={value}
                        className={`max-w-[240px] truncate border-b border-line px-3 py-2.5 text-[12px] ${
                          value === "—"
                            ? "text-faint"
                            : isFigure(column.type)
                              ? "text-figure tabular-nums"
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
      ) : (
        <div className="border-t border-line px-5 py-4 text-[12px] text-faint">
          nothing in the drawing matches that.
        </div>
      )}
    </div>
  );
}

/**
 * A drawing that is no longer current gets stamped rather than thrown away.
 * The same applies here: say plainly that this is a capture, and why.
 */
function SupersededStamp({
  label,
  body,
  taken,
}: {
  label: string;
  body: string;
  taken?: string;
}) {
  return (
    <div className="ticked mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border border-mark/45 bg-mark/[0.05] px-5 py-3.5">
      <span className="stamp shrink-0 border border-mark/60 px-2 py-1 text-mark">
        {label}
      </span>
      <p className="min-w-0 flex-1 text-[12px] leading-snug text-dim">{body}</p>
      {taken && <span className="stamp shrink-0">captured {taken}</span>}
    </div>
  );
}

function SectionRule({ index, title }: { index: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[12px] tracking-[0.1em] text-dim">{index}</span>
      <span className="stamp">{title}</span>
      <span className="rule flex-1" />
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-6 border border-dashed border-line px-6 py-16 text-center text-[12px] text-faint">
      {children}
    </p>
  );
}
