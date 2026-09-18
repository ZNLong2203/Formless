# Formless

**The CRM that builds its own database.**

Forward an email. Formless reads it, decides what the record *is*, and grows the
database to fit — creating tables and columns that did not exist a second
earlier. There is no schema to design, no field mapping, no "custom field" admin
screen. The schema is an output of your data, not a precondition for it.

Built for **Evorozen Apex: NextGen AI Buildathon** on the **Evorozen Neural Pulse**
LivingDNA virtual database.

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
the message carries something genuinely new. That feedback loop is what keeps the
database from sprawling into hundreds of near-duplicate fields.

---

## How the Evorozen Neural Pulse API is used

Neural Pulse is the **only** datastore. There is no Postgres, no Supabase table,
no local file, no in-memory store of record. Every byte of application state —
business records, the schema catalogue, and the activity feed — lives in the
Virtual Database and is read back out of it.

| Concern | Action used | Where |
|---|---|---|
| Register / widen a table in LivingDNA | `create_schema` | [`src/lib/registry.ts`](src/lib/registry.ts) |
| Write a record | `insert_data` | [`src/lib/neural.ts`](src/lib/neural.ts) |
| Read records, schema journal, activity | `select_data` | [`src/lib/neural.ts`](src/lib/neural.ts) |

`update_data` and `delete_data` are implemented in the client for completeness.

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

**2. The `chat` action is currently unavailable.**

Every call returns `All LLM providers failed. Last error: huggingface: internal
error`, across repeated attempts. Neural Pulse's deterministic data plane
(`create_schema`, `insert_data`, `select_data`) is solid; its bundled LLM is not.

Formless therefore runs reasoning on **Claude (`claude-opus-5`)** with structured
outputs, and keeps **all** logic, memory and data in Neural Pulse. Nothing in the
demo depends on an endpoint that is down. If a reasoning key is absent the app
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
                  cached read path
    extract.ts    Reasoning layer — structured extraction against the live
                  schema, with a deterministic fallback
  app/
    api/ingest    POST — extract → grow → store, narrated for the UI
    api/state     GET  — the current shape and contents of the database
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

### Performance

Neural Pulse round trips dominate: roughly 1s concurrent, ~3.8s serialized.

| Path | Before | After |
|---|---|---|
| Ingest, new table | 27.5s | 15.6s |
| Ingest, existing table | — | 7.4s |
| `GET /api/state` | 7.7s | 2.6s warm |

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

# Optional — reasoning. Without it the app runs a deterministic extractor
# and says so in the UI.
ANTHROPIC_API_KEY=sk-ant-...
```

Then:

```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npm run lint
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
Tailwind CSS v4 · Evorozen Neural Pulse · Anthropic SDK

## Licence

MIT
