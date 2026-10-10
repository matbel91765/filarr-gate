# How the two-way sync decides, and why it converges

The tutorial shows it at work ([D1](../tutorials/sync-d1.md)); this page explains the rule, what it guarantees and
what it does not. The rule is a pure function (`mergeCell`, `planPass` in `packages/core/src/engine/extsrc`), the same
code the Filarr apps run, replayed by the shared vectors `source-externe-1`.

## Three states per cell

For each synced cell, the gate compares:

- **S**, the source's value now, converted to Filarr's form;
- **F**, Filarr's register: its value and its **clock** (the hybrid logical clock of the last write that won);
- **O**, the **shadow**: the fingerprint of the last value both sides agreed on, and Filarr's clock at that moment.

"The source changed" means `fingerprint(S) ≠ O`. "Filarr changed" means `F.clock ≠ O.clock`. Comparing the clock, not
a date, is what keeps a device that comes back online with an old change from being lost: its write changed the
register's clock, so it counts as a change.

## The cases

| case | source changed | Filarr changed | values | both ways | inbound column (`in`) | outbound column (`out`) |
|---|---|---|---|---|---|---|
| A | no | no | | nothing | nothing | nothing |
| B | yes | no | | Filarr ← S | Filarr ← S | source ← F (the source's value is replaced, journal) |
| C | no | yes | | source ← F | Filarr ← S (the local value is replaced, journal) | source ← F |
| D | yes | yes | equal | nothing, the shadow moves on | nothing | nothing |
| E | yes | yes | different | **the policy** | Filarr ← S, journal | source ← F, journal |
| F | no shadow | | equal | the shadow is born | | |
| G | no shadow | | different | **the policy** | Filarr ← S, journal | source ← F, journal |

A first pass (no shadow) is a **reconciliation**: equal values make the shadow; different ones follow the policy you
chose. A safety stop protects a first pass with too many conflicts.

## The policies, and their limits

| policy | in a conflict | its limit |
|---|---|---|
| the source wins | Filarr ← S; Filarr's value to the journal | |
| Filarr wins | source ← F; the source's value to the journal | |
| the most recent wins | the later of the source's marker and Filarr's clock | the marker dates the ROW, not the cell; two machines' clocks |
| ask me | nothing written; the cell enters the queue | the two sides show different values until someone decides |

None is preselected: you choose, per column or for the definition, before the first pass. Any value that loses goes
to the journal, with "Restore", which writes it back in Filarr as an ordinary change (a case C at the next pass).

## The queue, precisely

An entry's id is computed from the definition, the row key, the column and the two fingerprints. So:

- detecting the same conflict again gives the same entry (nothing duplicates);
- a side that changes gives a new id: the old entry is replaced, and a decision taken on the old values is **stale**;
- decisions are applied in the order the server received them; the first valid one for an entry wins, the others are
  set aside and named in the journal;
- the runner never writes a cell (or a row, for a row conflict) that is in the queue until a valid decision, or a
  change of policy that says "settle them with the new rule", targets it.

## The order of a pass, and why replaying it is harmless

1. lease; definition and signature checked; decisions read from the mailbox;
2. Filarr read (the gate's copy, at a version N);
3. the source read: incrementally from the marker, or whole (every 24 hours, every 96 passes, or without a marker),
   plus a targeted read of each row changed in Filarr that the incremental read did not return;
4. the plan (pure); 5. the safety stops, **before any write**;
6. writes to the source **only if the value is still the one read** (where the connector can), then re-read: a value
   the source normalized (rounded, re-dated) is written back to Filarr in the same pass; a cell that does it twice in a
   row is **unstable** and stops going out;
7. ONE commit to Filarr; a register that changed during the pass is never overwritten (it becomes a case E next time);
8. shadow, queue and journal saved together; the state published (sealed for the members); decisions acknowledged.

A crash between 6 and 8 leaves the source written and the shadow old: next time both sides "changed" to the same value,
case D, nothing written twice. A crash between 7 and 8: the same.

## What travels through Filarr during a pass

Filarr only relays and stores sealed objects; the runner talks to these routes of the database's store, with its
access's proof (`runnerId` is `a:<accessId>`):

| route | what for |
|---|---|
| `POST /dbstore/<id>/ext-lease` `{ defId, runnerId, instance, ttlS }` | take or renew the lease; `409 extdb_lease_held` when another process (another `instance`) holds it. `DELETE /dbstore/<id>/ext-lease/<defId>?instance=…` gives it back at a clean stop |
| `GET /dbstore/<id>/ext-resolve/<runnerId>?after=<seq>` | the mailbox of decisions: `{ "decisions": [{ "seq": 41, "sealed": "…" }, …], "next": 41 }`, in the order the server received them; `next` is where to resume, `null` on the last page. The gate reads up to ten pages per pass, the rest at the next one |
| `DELETE /dbstore/<id>/ext-resolve/<runnerId>?upTo=<seq>` | acknowledge the decisions applied, only AFTER the shadow and the queue are saved |
| `PUT /dbstore/<id>/ext-status/<runnerId>`, `PUT /dbstore/<id>/ext-queue/<runnerId>` `{ rev, e, g, sealed }` | publish the state and the queue, compare-and-swap on `rev` |
| `POST /dbstore/<id>/commit` | the pass's one commit to the database |

Each decision is sealed by the member's app under a key derived from the database's key (`K_xs`), which every member
and the gate derive and Filarr does not: Filarr sees a sealed blob and its size.

## The invariants the vectors check

| | |
|---|---|
| I1, convergence | if nothing changes on either side and no decision arrives, the next pass writes nothing, and every synced cell outside the queue is equal on both sides |
| I2, idempotence | replaying an interrupted pass gives the same final state; replaying a decision already applied does nothing |
| I3, nothing lost silently | every value overwritten by the runner, on either side, is in the journal with its previous value |
| I4, determinism | two runners with the same inputs make the same plan |
| I5, one writer | the lease: one runner writes to the source per definition |
| I6, directions respected | an `in` column never sends anything to the source; an `out` column never writes Filarr (except the key and the echo) |
| I7, safety stops | no pass deletes or marks beyond the threshold without an explicit agreement for that pass |
| I8, the queue untouched | a cell in the queue is written on neither side until a valid decision targets it |
| I9, a decision targets a state | a decision applies only to the values it was taken on |

## What is not guaranteed

- In a conflict, one side loses (to the journal) or the cell waits; the choice is yours.
- "The most recent wins" compares clocks of two machines and dates the row.
- Airtable, Google Sheets and Notion cannot write "only if unchanged": a window of less than a second remains.
- While a conflict waits, the software that reads the source sees the source's value.
- Disappearances are seen only at a full read.
