# Building on Evorozen Neural Pulse

Neural Pulse is the only datastore in this project. Every business record, the
schema catalogue, and the workspace scoping that keeps visitors apart all live
in the Virtual Database and are read back out of it. There is no second store.

This document covers how the API is used, two things that were measured about
it, and the constraints that shaped the architecture.

---

## The surface used

A single endpoint, `POST https://pulse.evorozen.com/api/neural`, authenticated
with `Authorization: Bearer <key>`.

| Concern | Action | Where |
|---|---|---|
| Register or widen a table in LivingDNA | `create_schema` | [`registry.ts`](../src/lib/registry.ts) |
| Write a new record | `insert_data` | [`neural.ts`](../src/lib/neural.ts) |
| Read records, the schema journal, query results | `select_data` | [`neural.ts`](../src/lib/neural.ts) |
| Update a record the sender already had | `update_data` | [`ingest/route.ts`](../src/app/api/ingest/route.ts) |

`delete_data` is implemented in the client for completeness. The `chat` action
is not used, for the reason below.

The client wraps all of this with bounded, status-aware retry — only `408` and
`5xx` and network faults retry, with exponential backoff; a `400` fails fast and
a `429` never retries — and propagates the kernel's `trace_id` on every error
path.

---

## Finding 1: writes are not atomic under concurrency

Five `insert_data` calls into one table, issued concurrently and then
sequentially, against the live API:

| | Issued | Persisted | Rows |
|---|---|---|---|
| Concurrent | 5 | **9** | `[1,1,1,2,3,3,3,4,5]` |
| Sequential | 5 | 5 | `[1,2,3,4,5]` |

Duplicates *and* losses — the signature of a read-modify-write race on the
kernel side. A separate test confirmed that writes aimed at **different** tables
are safe to run concurrently.

This was not theoretical. The first version of the schema catalogue wrote one
row per column, in parallel; seven writes produced six rows, one of them a
duplicate, and two columns vanished from the schema entirely.

### What the architecture does about it

**Writes are queued per table.** [`neural.ts`](../src/lib/neural.ts) holds every
write behind the previous write to the same table, while unrelated tables still
proceed in parallel. A failed write cannot wedge the queue behind it.

**The catalogue is an append-only journal.** Growing a table is one write rather
than one per column, and folding dedupes by column name — so a row the kernel
duplicates collapses back to one column instead of corrupting the schema.

**The ingest path exploits the cross-table result.** The record write and the
journal append target different tables and are issued together; the entity
lookup is a read, so it is not held behind the write queue and runs alongside
schema registration.

### The honest limit

The queue is per-process. It makes one instance correct, not a horizontally
scaled fleet. A multi-instance deployment needs a distributed lock, or an
idempotency key on the API side. The journal's dedupe-on-fold already absorbs
duplicates, which is the failure mode that would otherwise corrupt the schema
rather than merely duplicate a row.

---

## Finding 2: the `chat` action is unavailable

Every call to `action_type: "chat"` returns:

```json
{ "error": "All LLM providers failed. Last error: huggingface: internal error" }
```

Repeated across attempts and prompt shapes. The schema-generation path degrades
more politely — `"Schema design temporarily unavailable"` — but does not work
either. The deterministic data plane (`create_schema`, `insert_data`,
`select_data`, `update_data`, `delete_data`) is solid; the bundled LLM is not.

Formless therefore runs reasoning on an external model and keeps **all** state
in Neural Pulse. Nothing in the demo depends on an endpoint that is down.

The provider is pluggable: one Zod schema drives every model, consumed by Gemini
through the JSON Schema Zod exports and by Claude through `zodOutputFormat`.
Adding a provider is one function, not a second schema to keep in sync. With no
key at all, a deterministic extractor runs and the interface labels itself as
degraded rather than pretending.

---

## Finding 3: 100 calls a month, and no way to buy more

```json
{ "error": "Rate Limit Exceeded. Your Free plan limit of 100 requests/month
   has been reached.", "plan": "Free", "limit": 100, "used": 100,
   "upgrade_url": "/pricing" }
```

The `upgrade_url` resolves to a 404. There is no self-serve paid tier, so the
allowance is a hard ceiling rather than a budget.

An uncached page view costs one call per table plus one for the catalogue. At
that rate a public demo exhausts a month in an afternoon. Four decisions follow
directly:

- **The catalogue is a journal**, so growing a table costs one write, not N.
- **`GET /api/state` holds its payload for 60 seconds.** The app sends
  `?fresh=1` only in the instant after an ingest, so a new column still appears
  immediately while ordinary visitors cost nothing.
- **A workspace minted by the current request is known to be empty**, so the
  read that would prove it empty is never issued.
- **The activity table was deleted entirely.** It cost a write per ingest and a
  read per page view, and nothing rendered it.

Per ingest this is 3 calls, down from 5. Per visitor, 0 rather than 4.

### Degrading with dignity

When the allowance is spent, blanking the page would make the product look
broken when its datastore is merely rate-limited. Instead:

1. the last payload this instance read is served;
2. failing that, a captured snapshot of state the live system actually produced,
   labelled **not live** with the reason and the capture date;
3. `429` is never retried, because each retry spends another call against a
   limit that is already spent.

The snapshot is never presented as live data.

---

## Notes for anyone else building on this API

- `select_data` on a table that does not exist returns **500**, not an empty
  result. Bootstrap your tables before reading them.
- `where` matches on **equality only**. There is no `>`, `<` or `contains`.
  Plan for evaluating comparisons client-side, or design around exact matches.
- A numeric column stores numbers, so `where: { count: "3" }` will not match a
  row written with `count: 3`. Coerce before querying.
- Rows come back with kernel-assigned `_id` and `_created_at` alongside your own
  fields; a declared `id` column is yours to populate.
- `create_schema` is idempotent per table name and can be re-sent with a widened
  column set.
- Errors carry a `trace_id`. Log it — it identifies which module in the
  Security → Database → AI Engine → PostProcess pipeline failed.
