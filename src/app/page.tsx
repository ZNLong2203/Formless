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
  events: Record<string, unknown>[];
  totalColumns: number;
  totalRows: number;
  reasoningConfigured: boolean;
}

interface IngestResult {
  summary: string;
  entity: string;
  table: string;
  isNewTable: boolean;
  addedColumns: Column[];
  confidence: number;
  engine: "claude" | "gemini" | "heuristic";
  elapsedMs: number;
}

const SAMPLES = [
  {
    label: "Inbound lead",
    text: "Hi, this is Maria Chen from Belmont Dental (maria@belmontdental.com). We run 3 clinics in Austin. Our scheduling vendor contract ends in March and we budget about $2,400/month. Can you call me Tuesday?",
  },
  {
    label: "Different shape",
    text: "Hello — Raj Patel, Northwind Logistics, raj@northwind.io. We operate 42 trucks across 6 depots and need dispatch software live before Q1. Budget is $9,000/month and our current NPS is 31.",
  },
  {
    label: "New kind of thing",
    text: "URGENT support ticket #4471: customer Acme Tooling reports the export job has failed 14 times since Friday. Severity high. Assigned to the data platform team. First reported 2026-09-12.",
  },
];

/* ------------------------------------------------------------------ */

function typeColor(type: string): string {
  switch (type) {
    case "number":
      return "text-amber";
    case "date":
      return "text-violet";
    case "uuid":
      return "text-faint";
    case "boolean":
      return "text-accent";
    default:
      return "text-muted";
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function Console() {
  const [message, setMessage] = useState(SAMPLES[0].text);
  const [state, setState] = useState<AppState | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingState, setLoadingState] = useState(true);

  /** Columns to highlight as newly grown, keyed `table.column`. */
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load state");
      setState(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load state");
    } finally {
      setLoadingState(false);
    }
  }, []);

  // Initial load. The rule fires because `refresh` reaches a setState, but the
  // write happens after the network response resolves, not during this render.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => void refresh(), [refresh]);

  useEffect(
    () => () => {
      if (freshTimer.current) clearTimeout(freshTimer.current);
    },
    [],
  );

  async function ingest() {
    if (!message.trim() || busy) return;
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
      if (!res.ok) throw new Error(data.error ?? "Ingest failed");

      setResult(data);
      setFresh(
        new Set(
          (data.addedColumns as Column[]).map(
            (column) => `${data.table}.${column.name}`,
          ),
        ),
      );
      if (freshTimer.current) clearTimeout(freshTimer.current);
      freshTimer.current = setTimeout(() => setFresh(new Set()), 6000);

      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ingest failed");
    } finally {
      setBusy(false);
    }
  }

  const stats = useMemo(
    () => [
      { label: "Tables", value: state?.tables.length ?? 0 },
      { label: "Columns", value: state?.totalColumns ?? 0 },
      { label: "Records", value: state?.totalRows ?? 0 },
    ],
    [state],
  );

  return (
    <div className="grid-field min-h-screen">
      <header className="border-b border-edge">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-5">
          <div className="flex items-baseline gap-3">
            <span className="text-[17px] font-semibold tracking-tight">
              Formless
            </span>
            <span className="text-[13px] text-faint">
              the CRM that builds its own database
            </span>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Pill tone="accent">
              <span className="pulse-ring inline-block size-1.5 rounded-full bg-accent" />
              Neural Pulse · LivingDNA
            </Pill>
            {state && !state.reasoningConfigured && (
              <Pill tone="amber">Heuristic mode — no reasoning key</Pill>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] gap-6 px-6 py-8 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* ---------------- Composer ---------------- */}
        <section className="flex flex-col gap-4">
          <div className="rounded-xl border border-edge bg-raised p-5">
            <h2 className="text-[13px] font-medium text-muted">
              Forward anything
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-faint">
              An email, a note, a ticket. No form, no field mapping. The schema
              is an output of your data, not a precondition for it.
            </p>

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={7}
              spellCheck={false}
              className="mt-4 w-full resize-y rounded-lg border border-edge bg-inset px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none transition placeholder:text-faint focus:border-edge-strong"
              placeholder="Paste a message…"
            />

            <div className="mt-3 flex flex-wrap gap-1.5">
              {SAMPLES.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  onClick={() => setMessage(sample.text)}
                  className="rounded-md border border-edge px-2.5 py-1 text-[11.5px] text-muted transition hover:border-edge-strong hover:text-ink"
                >
                  {sample.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={ingest}
              disabled={busy || !message.trim()}
              className="mt-4 w-full rounded-lg bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-[#06281f] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Growing the schema…" : "Ingest"}
            </button>

            {busy && (
              <p className="mt-2.5 text-center text-[11.5px] text-faint">
                Extracting entities, then widening the table to fit them
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4 text-[12.5px] text-red-300">
              {error}
            </div>
          )}

          {result && <ResultCard result={result} />}
        </section>

        {/* ---------------- Database ---------------- */}
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="flex-1 rounded-xl border border-edge bg-raised px-4 py-3"
              >
                <div className="font-mono text-2xl tabular-nums">
                  {stat.value}
                </div>
                <div className="mt-0.5 text-[11.5px] text-faint">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          {loadingState ? (
            <Empty>Reading the Virtual Database…</Empty>
          ) : state && state.tables.length > 0 ? (
            state.tables.map((table) => (
              <TableCard key={table.name} table={table} fresh={fresh} />
            ))
          ) : (
            <Empty>
              The database is empty. Ingest a message and watch a table appear.
            </Empty>
          )}
        </section>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Pill({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "accent" | "amber";
}) {
  const tones = {
    muted: "border-edge text-muted",
    accent: "border-accent/25 text-accent",
    amber: "border-amber/30 text-amber",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-edge bg-raised/40 px-6 py-14 text-center text-[13px] text-faint">
      {children}
    </div>
  );
}

function ResultCard({ result }: { result: IngestResult }) {
  const grew = result.addedColumns.length > 0;
  return (
    <div className="rounded-xl border border-edge bg-raised p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={grew ? "accent" : "muted"}>
          {result.isNewTable
            ? "Table created"
            : grew
              ? "Schema grew"
              : "Record added"}
        </Pill>
        <span className="font-mono text-[12px] text-muted">{result.table}</span>
        <span className="ml-auto text-[11.5px] text-faint">
          {(result.elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>

      <p className="mt-3 text-[13px] leading-relaxed text-ink">
        {result.summary}
      </p>

      {grew && (
        <div className="mt-4">
          <div className="text-[11.5px] text-faint">
            Columns that did not exist before
          </div>
          <ul className="mt-2 space-y-1.5">
            {result.addedColumns.map((column) => (
              <li key={column.name} className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] text-accent">
                  {column.name}
                </span>
                <span className={`font-mono text-[11px] ${typeColor(column.type)}`}>
                  {column.type}
                </span>
                {column.rationale && (
                  <span className="text-[11.5px] text-faint">
                    — {column.rationale}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3 border-t border-edge pt-3 text-[11px] text-faint">
        <span>engine: {result.engine}</span>
        <span>confidence: {(result.confidence * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

function TableCard({
  table,
  fresh,
}: {
  table: TableState;
  fresh: Set<string>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-raised">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-5 py-3.5">
        <span className="font-mono text-[13px]">{table.name}</span>
        <span className="text-[11.5px] text-faint">
          {table.columns.length} columns · {table.rowCount} rows
        </span>
      </div>

      {/* Column list: the schema itself is the primary object here. */}
      <div className="flex flex-wrap gap-1.5 border-b border-edge px-5 py-3.5">
        {table.columns.map((column) => {
          const isFresh = fresh.has(`${table.name}.${column.name}`);
          return (
            <span
              key={column.name}
              title={column.rationale || undefined}
              className={`inline-flex items-baseline gap-1.5 rounded-md border px-2 py-1 font-mono text-[11.5px] transition ${
                isFresh
                  ? "column-arrive border-accent/50"
                  : "border-edge"
              }`}
            >
              <span className={isFresh ? "text-accent" : "text-ink"}>
                {column.name}
              </span>
              <span className={typeColor(column.type)}>{column.type}</span>
              {isFresh && (
                <span className="rounded bg-accent/15 px-1 text-[9.5px] font-semibold tracking-wide text-accent">
                  NEW
                </span>
              )}
            </span>
          );
        })}
      </div>

      {table.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-edge text-faint">
                {table.columns.map((column) => (
                  <th
                    key={column.name}
                    className="whitespace-nowrap px-4 py-2 font-mono text-[11px] font-normal"
                  >
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 8).map((row, index) => (
                <tr
                  key={String(row._id ?? index)}
                  className="border-b border-edge/60 last:border-0"
                >
                  {table.columns.map((column) => (
                    <td
                      key={column.name}
                      className="max-w-[260px] truncate px-4 py-2.5 text-muted"
                      title={formatCell(row[column.name])}
                    >
                      {formatCell(row[column.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
