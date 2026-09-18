# Formless

**The CRM that builds its own database.**

Forward an email. Formless reads it, decides what the record *is*, and grows the
database to fit — creating tables and columns that did not exist a second
earlier. There is no schema to design, no field mapping, no "custom field" admin
screen. The schema is an output of your data, not a precondition for it.

Built for **Evorozen Apex: NextGen AI Buildathon** on the **Evorozen Neural Pulse**
LivingDNA virtual database.

**Documentation**

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The system module by module, both request flows, failure behaviour |
| [docs/neural-pulse.md](docs/neural-pulse.md) | How the Evorozen API is used, what was measured about it, notes for others building on it |
| [docs/decisions.md](docs/decisions.md) | Why the system is built this way — including what turned out to be wrong |

---

## The problem

Every CRM makes you describe your business before you can record it. You pick an
object model on day one — `Lead`, `Account`, `Opportunity` — and then spend the
next two years bending reality to fit it. The dental group with three clinics and
the logistics firm with 42 trucks get the same twelve fields, so the parts that
actually matter end up pasted into a free-text "Notes" box where nothing can
query them.

SMBs and agencies feel this hardest: they abandon CRM setup precisely because the
setup comes *before* the value.

## The approach

Formless inverts the order. You send raw text; the system decides the shape.

```
inbound message
      │
      ▼
┌─────────────────┐   current schema    ┌──────────────────────────┐
│  Extraction     │◄────────────────────│  LivingDNA journal       │
│  (Claude)       │                     │  (Neural Pulse)          │
└────────┬────────┘                     └──────────────────────────┘
         │  target table · missing columns · record
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Neural Pulse — create_schema → insert_data                      │
│  the table widens, then the record lands                         │
└─────────────────────────────────────────────────────────────────┘
```

The extraction step is given the **live schema** alongside the message, so it
reuses a column when the concept already exists and proposes a new one only when
the message carries something genuinely new.

A second pass then challenges what it proposed. A schema that only ever grows
ends up with forty ways to say "budget", so the reviewer merges a proposal into
an existing column when they mean the same thing, and drops values that are
incidental to one message. On a real run it caught both of these:

```
merge  warehouse_count → depot_count   semantically equivalent facility count
merge  renewal_date    → deadline      the renewal date is the operative deadline
```

Without that pass, `leads` would carry four columns for two facts. The review
runs on the reasoning model, not on Neural Pulse, so the brake costs nothing
against the datastore's quota — and it is skipped for a table being created,
where every column is new by definition and there is nothing to merge into.

### Asking questions of a schema you never designed

Because you did not design the schema, you should not need to know it to
interrogate it. A question in plain language is planned against the live
catalogue:

```
"which leads have a budget over 5000?"
  → monthly_budget gt 5000     →  1 of 2 rows
```

One constraint shapes this. Neural Pulse's `select_data` matches on equality
only — there is no `>` on the wire. So equality conditions are pushed down into
`where` where the datastore can use them, and the rest are evaluated over the
rows that come back. Either way it is a single call. A question the schema
cannot answer is refused rather than guessed at.

### The same company twice

A second message about a company already on file updates that record rather
than filing a duplicate beside it. The architect names the column that
identifies the entity — usually an email — and the lookup runs alongside the
schema registration rather than after it, since a read is not held behind the
table's write queue.

### One drawing per visitor

Each visitor gets their own workspace, carried in a cookie rather than behind a
sign-up, because a product whose whole claim is that it works before you
configure anything should not open with a registration wall. Every read is
filtered to that workspace, so one person's customer emails are never shown to
the next. A workspace minted by the current request is known to be empty, so the
read that would prove it empty is skipped — which matters at 100 calls a month.

A visitor whose workspace is still empty is shown a captured example rather than
a blank sheet, labelled so nobody mistakes it for their own data.

---

## How the Evorozen Neural Pulse API is used

Neural Pulse is the **only** datastore. There is no Postgres, no Supabase table,
no local file, no in-memory store of record. Every byte of application state —
business records, the schema catalogue, and the activity feed — lives in the
Virtual Database and is read back out of it.

| Concern | Action used | Where |
|---|---|---|
| Register / widen a table in LivingDNA | `create_schema` | [`src/lib/registry.ts`](src/lib/registry.ts) |
| Write a new record | `insert_data` | [`src/lib/neural.ts`](src/lib/neural.ts) |
| Read records, the schema journal, query results | `select_data` | [`src/lib/neural.ts`](src/lib/neural.ts) |
| Update a record the sender already had | `update_data` | [`src/app/api/ingest/route.ts`](src/app/api/ingest/route.ts) |

`delete_data` is implemented in the client for completeness.

### Reading the schema back

Neural Pulse registers tables into LivingDNA but exposes no "describe schema"
action. Rather than keep a local copy — which would mean a second source of
truth — Formless stores its catalogue **inside Neural Pulse** as an append-only
journal: one row per growth event holding the columns added. Folding the journal
in timestamp order yields the live schema.

That choice pays for itself twice:

- growing a table costs **one** write instead of one write per column;
- a duplicated journal row is **harmless**, because folding dedupes by column
  name — which matters for the reason below.

### Two findings about the API, and what they cost

These were measured against the live API, not assumed.

**1. `insert_data` is not atomic under concurrency.**

Five concurrent inserts into one table, repeated deliberately:

| | Issued | Persisted | Rows |
|---|---|---|---|
| Concurrent | 5 | **9** | `[1,1,1,2,3,3,3,4,5]` |
| Sequential | 5 | 5 | `[1,2,3,4,5]` |

Duplicates *and* losses — the signature of a read-modify-write race. Writes
aimed at **different** tables were separately verified safe to run concurrently.

So [`src/lib/neural.ts`](src/lib/neural.ts) queues every write behind the
previous write **to the same table**, while unrelated tables still proceed in
parallel. The ingest path exploits that: the record, the journal entry and the
activity event target three different tables and are issued together.

*Honest limit:* the queue is per-process. It makes one instance correct, not a
horizontally-scaled fleet. A multi-instance deployment needs either a distributed
lock (Redis) or an idempotency key on the API side; the journal's dedupe-on-fold
already absorbs duplicates, which is the failure mode that would otherwise
corrupt the schema.

**2. The free tier allows 100 calls a month, which shapes the architecture.**

`Rate Limit Exceeded. Your Free plan limit of 100 requests/month has been
reached.` An uncached page view costs one call per table plus one for the
catalogue, so a public demo can burn the month's quota in an afternoon. Three
decisions follow directly:

- the schema catalogue is a journal, so growing a table costs **one** write
  rather than one per column;
- `GET /api/state` holds its payload for 60s, and the app sends `?fresh=1` only
  in the instant after an ingest, so visitors cost nothing while a new column
  still appears immediately;
- a quota fault serves the last good payload rather than blanking the drawing.

Per ingest this is 3 calls, down from 5; per visitor, 0 rather than 4.

**3. The `chat` action is currently unavailable.**

Every call returns `All LLM providers failed. Last error: huggingface: internal
error`, across repeated attempts. Neural Pulse's deterministic data plane
(`create_schema`, `insert_data`, `select_data`) is solid; its bundled LLM is not.

Formless therefore runs reasoning on **Gemini (`gemini-3.8-flash`)** with
structured outputs, and keeps **all** logic, memory and data in Neural Pulse.
Nothing in the demo depends on an endpoint that is down. The provider is
pluggable — one Zod schema drives both Gemini (via the JSON Schema it exports)
and Claude (via `zodOutputFormat`), so there is no second schema to keep in
sync and swapping providers is one function, not a rewrite. If a reasoning key is absent the app
falls back to a deterministic extractor so the schema-growth behaviour is still
demonstrable end to end — degraded, clearly labelled in the UI, never broken.

---

## Architecture

```
src/
  lib/
    neural.ts     Neural Pulse client — typed actions, retry with backoff,
                  trace-id propagation, per-table write serialization
    registry.ts   LivingDNA catalogue — append-only journal, fold, growth,
                  cached read path, scoped per workspace
    extract.ts    Reasoning — the architect that proposes a shape, and the
                  reviewer that challenges it. Deterministic fallback.
    query.ts      Question → plan → answer, with the parts the datastore
                  cannot evaluate applied here
    workspace.ts  Cookie-scoped identity, so one visitor's rows stay theirs
    snapshot.ts   The captured drawing, shown as an example or on a fault
  app/
    api/ingest    POST — extract → review → grow → store or update
    api/ask       POST — plan a question against the live catalogue
    api/state     GET  — the current shape and contents of this workspace
    page.tsx      Console — the schema is the primary object on screen
```

Design notes worth calling out:

- **Errors carry the kernel `trace_id`**, so a failure points at the exact module
  in the Neural Pulse pipeline rather than a generic 500.
- **Retries are bounded and status-aware** — only `408/429/5xx` and network
  faults retry, with exponential backoff; a `400` fails fast.
- **The activity feed can never fail an ingest.** Cosmetic writes are isolated.
- **The model cannot write into Formless's own bookkeeping tables**; a proposed
  table name that collides is redirected.
- **The catalogue is cached in-process** with a short TTL, invalidated the moment
  the schema grows. `GET /api/state` went 7.7s → 2.6s warm.

### Tests

```bash
npm test
```

29 tests, no network, covering the three places where correctness actually
proved fragile:

| Area | What is guarded |
|---|---|
| Write queue | Two writes to one table never overlap; submission order is preserved; different tables still run concurrently; a failed write does not wedge the queue |
| Journal fold | A duplicated row collapses to one column; ordering is by creation time; malformed payloads are survived; unknown types fall back to `text` |
| Coercion | `"$2,400/month"` becomes `2400`; an unreadable figure keeps its text instead of silently becoming `0` |

That last one was a real bug the suite caught on its first run: stripping the
non-numeric characters from `"not a number"` leaves `""`, and `Number("")` is
`0` — which is finite, so it passed the guard. A lead whose budget could not be
parsed would have been filed as a budget of zero.

### Performance

Neural Pulse round trips dominate: roughly 1s concurrent, ~3.8s serialized.

| Path | Before | After |
|---|---|---|
| Ingest, new table | 27.5s | 15.6s |
| Ingest, existing table | — | 7.4s |
| `GET /api/state` | 7.7s | 2.6s cold, 0 calls held |

With live reasoning an ingest runs ~16s end to end: roughly 4s of model time and
~8s of Neural Pulse round trips. Lowering the model's thinking level cuts ~2s but
the schema decision *is* the product, so the quality is kept and the UI instead
names the phase that is actually running.

---

## Running it

Requires **Node.js 20.9+**.

```bash
git clone https://github.com/ZNLong2203/Formless.git
cd Formless
npm install
```

Create `.env.local`:

```bash
# Required — the Virtual Database. Get a key at https://pulse.evorozen.com
EVOROZEN_API_KEY=evo_live_...

# Reasoning provider. Gemini takes precedence when both are set. With neither,
# the app runs a deterministic extractor and labels itself as degraded in the UI.
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.8-flash

# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=claude-opus-5
```

Then:

```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npm run lint
npm test        # 29 tests, no network required
```

Paste a message, or use one of the three built-in samples, and press **Ingest**.
The first sample creates a table. The second reuses it and adds only what is
genuinely new. The third is a different kind of thing entirely — watch a second
table appear.

### API

```bash
curl -X POST localhost:3000/api/ingest \
  -H 'Content-Type: application/json' \
  -d '{"message":"Maria Chen, Belmont Dental, 3 clinics in Austin, $2400/month."}'

curl localhost:3000/api/state
```

---

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) ·
Tailwind CSS v4 · Vitest · Evorozen Neural Pulse · Google GenAI SDK ·
Anthropic SDK

## Licence

[MIT](LICENSE)
