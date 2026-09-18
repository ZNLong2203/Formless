# Decisions

Why the system is built the way it is. Each entry states the problem, the
decision, and what it costs — including the ones that turned out to be wrong.

---

## The schema is an output, not a precondition

**Problem.** Every CRM asks you to describe your business before you can record
it. The dental group with three clinics and the logistics firm with 42 trucks
get the same twelve fields, so whatever actually matters ends up pasted into a
free-text note where nothing can query it.

**Decision.** Invert the order. The message arrives first; the schema is derived
from it.

**Cost.** Everything downstream becomes harder — you cannot write a fixed query,
you cannot assume a column exists, and you inherit a sprawl problem that a fixed
schema does not have. The rest of this document is largely about paying that
bill.

---

## The catalogue lives inside Neural Pulse, as a journal

**Problem.** Neural Pulse registers tables into LivingDNA but exposes no
"describe schema" action. Something has to remember the shape.

**Decision.** Keep the catalogue in Neural Pulse itself, as an append-only
journal: one row per growth event, holding the columns added. Folding it in
timestamp order yields the live schema.

**Rejected:** a local cache, which would have made a second source of truth that
could disagree with the database, and would not survive a serverless cold start.

**Why a journal rather than a row per column.** Growing a table costs one write
instead of N, and duplicated rows fold away harmlessly — which matters because
the kernel duplicates rows under concurrent writes.

---

## Writes are serialized per table

**Problem.** Measured against the live API, five concurrent inserts into one
table persisted nine rows, with both duplicates and losses.

**Decision.** Queue every write behind the previous write to the same table.
Different tables still proceed in parallel, which a separate test confirmed is
safe.

**Cost.** Sequential writes are slower — roughly 3.8s each against 1s
concurrent. Ingest pays this three times. Correctness was not negotiable here;
a CRM that silently loses records is not a CRM.

**Limit.** The queue is per-process, so it makes one instance correct rather
than a fleet. Documented rather than hidden.

---

## Two model passes, not one

**Problem.** A schema that only ever grows ends up with forty columns that all
mean "budget", each populated once.

**Decision.** An architect proposes the shape; a reviewer challenges every
proposed column before it reaches the database, merging near-duplicates into
columns that already exist.

On a real run it caught both of these:

```
merge  warehouse_count → depot_count   semantically equivalent facility count
merge  renewal_date    → deadline      the renewal date is the operative deadline
```

Four columns for two facts, avoided.

**Cost.** About ten seconds per ingest. Mitigated by skipping the review when
the table is being created — every column is new by definition and there is
nothing to merge into — and by running it at a lower thinking level, because
judging whether two names mean the same thing is a classification, not design
work.

**Not a dependency.** If the review fails, the architect's proposal stands.

---

## The reasoning model never writes

**Decision.** The model proposes a table, columns and values. The server decides
what reaches the database: it filters columns that already exist, refuses to
merge into a column that does not exist, redirects a table name that collides
with internal bookkeeping, and coerces every value against its declared type.

**Why.** The model is the most capable and least predictable component in the
system. Giving it write access would make every schema-corruption bug a prompt
engineering problem.

---

## Identity is a cookie, not an account

**Problem.** Without scoping, one visitor's customer emails are visible to the
next person who opens the link.

**Decision.** A workspace id in an httpOnly cookie, and every read filtered by
it.

**Rejected:** a sign-up wall. The product's whole claim is that it works before
you configure anything; opening with a registration form contradicts that on the
first screen.

**Cost.** Workspaces are not portable across devices and cannot be shared. For a
product at this stage, that is the right trade; the upgrade path is an account
that adopts the cookie's workspace.

---

## Equality is pushed down, everything else is evaluated here

**Problem.** `select_data` matches on equality only. "Budget over 5000" has no
wire representation.

**Decision.** The planner emits typed conditions. Equality conditions go into
`where` where the datastore can use them; comparisons, substring matches,
sorting and limits are applied to the rows that come back.

**Why not evaluate everything client-side.** Equality is the one thing the
datastore can do cheaply, and pushing it down reduces what has to be fetched.

**Why not a query language.** Anything expressive enough to need parsing would
also need sandboxing. Typed conditions with a fixed operator set are evaluated
by a `switch`, not an interpreter, and are testable without a model.

---

## Degrade with dignity, and say so

**Problem.** The free tier allows 100 calls a month and there is no paid tier to
buy past it. A cold instance can find itself unable to read.

**Decision.** Serve the last payload this instance read; failing that, a
captured snapshot of state the live system actually produced, labelled **not
live** with the reason. Never blank the page, and never present the snapshot as
live data.

---

## Things that were wrong

**A parallel catalogue write per column.** Seven writes produced six rows, one
duplicated, two columns lost. Replaced by the journal.

**An activity table nothing rendered.** It cost a write per ingest and a read
per page view for a feature that was never built. Deleted.

**`Number("")` is `0`.** Coercing an unreadable figure stripped every
non-numeric character, leaving an empty string, which `Number` turns into zero —
finite, so it passed the guard. A lead whose budget could not be parsed would
have been filed as a budget of zero. Caught by the test suite on its first run.

**Three tabs.** Splitting send, ask and the database across tabs hid the only
thing worth seeing: raw text becoming structured data. Merged back into a
composer beside a workspace that visibly reacts.

**Four visual redesigns.** Dark, then cyanotype, then paper white, then warm
stone. The recurring complaint was "cluttered", and each time the cause was
density and duplication rather than colour — two stacked forms where one belongs,
one full-width row per column where a chip would do.
