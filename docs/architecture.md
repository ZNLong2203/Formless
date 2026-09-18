# Architecture

Formless takes an unstructured message and files it as a structured record,
creating whatever columns that record turns out to need. This document
describes how, module by module.

For how the Evorozen Neural Pulse API is used and what was measured about it,
see [neural-pulse.md](neural-pulse.md). For why things are the way they are,
see [decisions.md](decisions.md).

---

## The shape of the system

```
                        ┌──────────────────────────────┐
  a message ───────────►│  /api/ingest                 │
                        │                              │
                        │  1 architect  proposes shape │──► reasoning model
                        │  2 reviewer   challenges it  │──► reasoning model
                        │  3 registry   grows schema   │──► Neural Pulse
                        │  4 write      insert/update  │──► Neural Pulse
                        └──────────────────────────────┘

                        ┌──────────────────────────────┐
  a question ──────────►│  /api/ask                    │
                        │                              │
                        │  1 planner    question→plan  │──► reasoning model
                        │  2 select     equality only  │──► Neural Pulse
                        │  3 evaluate   the rest here  │
                        └──────────────────────────────┘

                        ┌──────────────────────────────┐
  a page load ─────────►│  /api/state                  │──► Neural Pulse
                        └──────────────────────────────┘
```

Two things are true of every path:

- **Neural Pulse is the only datastore.** No Postgres, no Supabase table, no
  local file, no in-memory store of record. Business records, the schema
  catalogue, and workspace scoping all live in the Virtual Database.
- **The reasoning model never writes.** It proposes; the server decides what
  reaches the database.

---

## Modules

| File | Responsibility |
|---|---|
| [`src/lib/neural.ts`](../src/lib/neural.ts) | Neural Pulse client. Typed actions, bounded retry, trace-id propagation, per-table write serialization. |
| [`src/lib/registry.ts`](../src/lib/registry.ts) | The schema catalogue. Append-only journal, folding, growth planning, per-workspace cache. |
| [`src/lib/extract.ts`](../src/lib/extract.ts) | Reasoning. The architect that proposes a shape, the reviewer that challenges it, value coercion, and a deterministic fallback. |
| [`src/lib/query.ts`](../src/lib/query.ts) | Questions. Planning against the live catalogue, and evaluating the parts the datastore cannot. |
| [`src/lib/workspace.ts`](../src/lib/workspace.ts) | Cookie-scoped identity, so one visitor's rows stay theirs. |
| [`src/lib/snapshot.ts`](../src/lib/snapshot.ts) | The captured drawing, served as an example or on a fault. |
| [`src/app/api/*`](../src/app/api) | Route handlers. Orchestration only; no business logic lives here. |
| [`src/app/page.tsx`](../src/app/page.tsx) | The console. Composer on the left, database on the right. |

Pure logic is deliberately separated from anything that touches the network, so
it can be tested without one. `foldJournal`, `planGrowth`, `applyVerdicts`,
`coerceValue`, `pushDown`, `matches` and `applyPlan` are all pure functions, and
they carry most of the correctness risk in the system.

---

## The data model

There is no fixed schema, which raises an awkward question: how do you read back
the shape of a database that designs itself?

Neural Pulse registers tables into LivingDNA but exposes no "describe schema"
action. Formless therefore keeps its catalogue **inside Neural Pulse**, as an
append-only journal:

```
formless_schema_journal
  workspace_id   which visitor this belongs to
  table_name     the table that grew
  columns_json   the columns added, with their types and rationale
  created_at     when
```

Folding the journal in timestamp order produces the live schema. Two properties
fall out of that choice, and both matter:

- growing a table costs **one** write rather than one per column;
- a duplicated journal row is **harmless**, because folding dedupes by column
  name — which matters given what the kernel does under concurrent writes (see
  [neural-pulse.md](neural-pulse.md)).

Every business table carries four structural columns before any extracted
field: `id`, `workspace_id`, `source_message`, `ingested_at`. Provenance is kept
so any record can be traced back to the text it came from.

---

## Flow: filing a message

```
POST /api/ingest  { message }

 1  resolve workspace          cookie, or mint one          0 calls
 2  load this workspace's      select_data on the journal   0–1 calls
    schema                     (cached 10s; skipped for a
                               workspace minted this request)

 3  ARCHITECT                  the message + the live       model
                               schema in, a proposal out

 4  REVIEWER                   challenges each proposed     model
                               column; skipped when the     (skipped for
                               table is being created       a new table)

 5  grow the schema            create_schema with the       1 call
                               full widened column set

 5b look for the same entity   select_data on the identity  0–1 calls
    (runs alongside 5)         column — a read, so it is
                               not held behind the write
                               queue

 6  write                      insert_data, or update_data  1 call
                               when 5b found a match

 7  journal the growth         insert_data on the journal   1 call
    (runs alongside 6)         — a different table, so
                               concurrency is safe here
```

**3–5 Neural Pulse calls per ingest**, and roughly 20 seconds end to end, most
of it model time.

The response narrates every step — what table, what columns were created, what
the reviewer refused and why — so the interface can show the database changing
shape rather than merely reporting success.

---

## Flow: asking a question

```
POST /api/ask  { question }

 1  load the live schema       cached from the journal      0–1 calls
 2  PLANNER                    question + schema in,        model
                               a query plan out
 3  select                     equality conditions are      1 call
                               pushed into `where`
 4  evaluate                   everything else applied      0 calls
                               to the returned rows
```

Step 3 and 4 exist because `select_data` matches on equality only — there is no
`>` or `contains` on the wire. Equality goes to the datastore where it is cheap;
comparisons, substring matches, sorting and limits are applied here. The result
is that "which leads have a budget over 5000?" costs exactly one call.

A question the schema cannot answer is refused, with a reason, rather than
guessed at.

---

## Workspaces

Each visitor gets their own database, identified by a cookie rather than an
account. A product whose claim is that it works before you configure anything
should not open with a registration wall.

- Every read is filtered by `workspace_id`; one visitor never sees another's
  rows.
- Only ids of the shape `ws_[0-9a-f]{32}` are accepted, so a hand-edited cookie
  cannot be used to probe.
- A workspace minted by the current request is known to be empty, so the read
  that would prove it empty is skipped.
- A visitor whose workspace is still empty is shown a captured example rather
  than a blank page, labelled so it is never mistaken for their own data.

---

## Failure behaviour

| Failure | What happens |
|---|---|
| Datastore unreachable or out of quota | The last payload this instance read is served; failing that, a captured snapshot, labelled "not live" with the reason. The page never blanks. |
| The reviewer fails | The architect's proposal stands. The brake is an improvement, not a dependency. |
| The journal write fails | The record is still filed. The two writes are independent, and only the record failing is fatal. |
| No reasoning key configured | A deterministic extractor runs and the interface says so. Schema growth is still demonstrable end to end. |
| A single table fails to read | The other tables still render. One young table cannot blank the whole view. |

Errors carry the kernel's `trace_id` wherever the datastore provided one, so a
failure points at the exact module in the Neural Pulse pipeline rather than a
generic 500.

---

## Tests

```bash
npm test
```

57 tests, none touching the network, concentrated on the places where
correctness actually proved fragile: the write queue, the journal fold, the
review verdicts, query evaluation, workspace identity, and value coercion.

The suite earned its place on its first run by catching a real bug — an
unreadable figure was being filed as `0`, because stripping the non-numeric
characters left `""` and `Number("")` is `0`, which is finite and passed the
guard. A lead whose budget could not be parsed would have been recorded as a
budget of zero.

---

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript (strict) ·
Tailwind CSS v4 · Vitest · Evorozen Neural Pulse · Google GenAI SDK ·
Anthropic SDK
