/**
 * Evorozen Neural Pulse — client for the LivingDNA virtual database.
 *
 * Every Formless record lives here. There is no second database: schema
 * definition, writes, reads and migrations all flow through the single
 * `POST /api/neural` kernel endpoint.
 *
 * Server-only. `EVOROZEN_API_KEY` must never reach the browser bundle.
 */

const ENDPOINT = "https://pulse.evorozen.com/api/neural";

/** Column types accepted by the LivingDNA schema registry. */
export type NeuralColumnType =
  | "uuid"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "json";

export interface NeuralColumn {
  name: string;
  type: NeuralColumnType;
  primary?: boolean;
}

export interface NeuralTable {
  name: string;
  columns: NeuralColumn[];
}

/** Rows come back with kernel-assigned metadata alongside user fields. */
export type NeuralRow = Record<string, unknown> & {
  _id: string;
  _created_at: string;
};

export type NeuralAction =
  | "create_schema"
  | "insert_data"
  | "select_data"
  | "update_data"
  | "delete_data"
  | "chat";

interface NeuralRequestBody {
  action_type: NeuralAction;
  prompt?: string;
  data_payload?: Record<string, unknown>;
}

/**
 * Error carrying the kernel trace id, so a failure can be traced to the exact
 * module in the pipeline (Security -> Database -> AI Engine -> PostProcess).
 */
export class NeuralError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = "NeuralError";
  }
}

const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);

/**
 * Quota exhaustion is a 429, but retrying it is pointless — the free tier's
 * monthly allowance is gone until the month turns, and each retry spends
 * another call against a limit that is already spent.
 */
export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof NeuralError &&
    (error.status === 429 || /rate limit/i.test(error.message))
  );
}
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;

function apiKey(): string {
  const key = process.env.EVOROZEN_API_KEY;
  if (!key) {
    throw new NeuralError("EVOROZEN_API_KEY is not configured", 500);
  }
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Single entry point to the kernel. Retries transient failures with
 * exponential backoff; surfaces the trace id on every error path.
 */
export async function neuralRequest<T = Record<string, unknown>>(
  body: NeuralRequestBody,
): Promise<T> {
  let lastError: NeuralError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new NeuralError(
          `Non-JSON response from kernel: ${text.slice(0, 200)}`,
          res.status,
        );
      }

      const payload = parsed as Record<string, unknown>;
      const traceId = (payload.traceId ?? payload.trace_id) as
        | string
        | undefined;

      if (!res.ok || typeof payload.error === "string") {
        const message =
          typeof payload.error === "string"
            ? payload.error
            : `Kernel returned ${res.status}`;
        const err = new NeuralError(message, res.status, traceId);
        if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        lastError = err;
      } else {
        return payload as T;
      }
    } catch (cause) {
      const err =
        cause instanceof NeuralError
          ? cause
          : new NeuralError(
              cause instanceof Error ? cause.message : "Network failure",
              0,
            );
      // Non-retryable kernel rejections propagate immediately.
      if (err.status !== 0 && !RETRYABLE_STATUS.has(err.status)) throw err;
      if (attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }

    await sleep(2 ** (attempt - 1) * 300);
  }

  throw lastError ?? new NeuralError("Neural request failed", 0);
}

/* ------------------------------------------------------------------ */
/* Write serialization                                                 */
/* ------------------------------------------------------------------ */

/**
 * Neural Pulse writes are not atomic.
 *
 * Measured against the live API: five concurrent `insert_data` calls into one
 * table persisted nine rows, three of them duplicates, and dropped others —
 * a read-modify-write race on the kernel side. The same five calls issued
 * sequentially persisted exactly five correct rows. Writes aimed at *different*
 * tables were verified safe to run concurrently.
 *
 * So every write is queued behind the previous write to the same table, while
 * unrelated tables still proceed in parallel.
 *
 * Caveat: this queue is per-process. It makes a single instance correct, not a
 * horizontally-scaled fleet — see the README for how that is handled.
 */
const tableQueues = new Map<string, Promise<unknown>>();

function serializeByTable<T>(table: string, task: () => Promise<T>): Promise<T> {
  const previous = tableQueues.get(table) ?? Promise.resolve();
  // Run whether or not the previous write succeeded, so one failure cannot
  // wedge the queue for that table.
  const result = previous.then(task, task);
  tableQueues.set(
    table,
    result.catch(() => undefined),
  );
  return result;
}

/* ------------------------------------------------------------------ */
/* Typed action helpers                                                */
/* ------------------------------------------------------------------ */

export interface CreateSchemaResult {
  executed: boolean;
  tables_created: string[];
  errors: string[];
}

/** Register tables into the LivingDNA rulebook. Idempotent per table name. */
export async function createSchema(
  tables: NeuralTable[],
  prompt = "Register tables into LivingDNA",
): Promise<CreateSchemaResult> {
  // Schema registration mutates the same per-table state as a row write.
  const key = tables.map((t) => t.name).sort().join("|");
  const res = await serializeByTable(key, () =>
    neuralRequest<Partial<CreateSchemaResult>>({
      action_type: "create_schema",
      prompt,
      data_payload: { tables },
    }),
  );
  return {
    executed: res.executed ?? false,
    tables_created: res.tables_created ?? [],
    errors: res.errors ?? [],
  };
}

export async function insertData(
  table: string,
  record: Record<string, unknown>,
  prompt = `Insert a record into ${table}`,
): Promise<NeuralRow> {
  const res = await serializeByTable(table, () =>
    neuralRequest<{ row: NeuralRow }>({
      action_type: "insert_data",
      prompt,
      data_payload: { table, record },
    }),
  );
  return res.row;
}

export async function selectData(
  table: string,
  where?: Record<string, unknown>,
  prompt = `Read rows from ${table}`,
): Promise<NeuralRow[]> {
  const res = await neuralRequest<{ data: NeuralRow[] }>({
    action_type: "select_data",
    prompt,
    data_payload: where ? { table, where } : { table },
  });
  return res.data ?? [];
}

export async function updateData(
  table: string,
  where: Record<string, unknown>,
  changes: Record<string, unknown>,
  prompt = `Update rows in ${table}`,
): Promise<number> {
  const res = await serializeByTable(table, () =>
    neuralRequest<{ modified_count: number }>({
      action_type: "update_data",
      prompt,
      data_payload: { table, where, changes },
    }),
  );
  return res.modified_count ?? 0;
}

export async function deleteData(
  table: string,
  where: Record<string, unknown>,
  prompt = `Delete rows from ${table}`,
): Promise<number> {
  const res = await serializeByTable(table, () =>
    neuralRequest<{ deleted_count: number }>({
      action_type: "delete_data",
      prompt,
      data_payload: { table, where },
    }),
  );
  return res.deleted_count ?? 0;
}
