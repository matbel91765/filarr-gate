# The contracts this version implements

Filarr's apps (desktop, web, mobile), its server and Filarr Gate share frozen contracts. The gate is a reader of some
and the origin of others. Where this documentation and a contract disagree, the contract wins, and the difference is a
bug to report.

| contract | what it fixes | the gate |
|---|---|---|
| `api-base-1`, revision 2 | the access token and its derivations, the generation of a database key (precision 3.9 of `db-store-1`), the sealed keys, the views manifest and the slugs, the routes a gate may call, the limits per plan, writes | reader |
| `api-base-1`, revision 3 | the creator's key authenticated by a tag, push wake-ups, the file scope, the routes of external syncs, the hosted box's marks, `pendingExport` for a migration without a stream | reader |
| `db-store-1` (3.9) | the encrypted store of a database: blocks, heads, last-writer-wins registers, commits | reader and writer (writes through the API) |
| `source-externe-1` | external databases in four directions: the definition and its signature, row identity, conversions, the merge of a cell and its four policies, the "ask me" queue, the pass, the shadow, the published state | **origin** of the pure core (`packages/core/src/engine/extsrc`), copied by the apps; runner |
| `gate-fichiers-1` | the file slot: the sealed deposit, the box signature, the filter, the statuses | **origin** of the pure core (`engine/gate/files.ts`); depositor |
| `gate-heberge-1` | the box hosted by Filarr; for the gate: the settings package `gate-settings-1`, wake-ups, the hosted service runs the same code | the settings package (both ways), wake-ups |
| `refus-et-etat-de-lappelant` | the codes and remedies of refusals | reader of the codes (open list: an unknown code falls back on a generic message) |

## Golden vectors

The test suite replays the vectors shared with Filarr (`test/vectors/`), byte for byte:

| file | written by | checks |
|---|---|---|
| `api-base-1.vectors.json` | Filarr | token, proof, sealed keys, manifest, slugs |
| `db-store-1.vectors.json` | Filarr | the store's keys per generation, blocks, heads |
| `boite-noire-v2-serveur.vectors.json` | Filarr's server | the revision 3 codes and remedies, `bumpDue`, the body of each wake-up |
| `gate-heberge-1.vectors.json` | Filarr and the gate | wake-ups (`A_notify`, header, window), the settings package |
| `source-externe-1.vectors.json` | **the gate** | identity, `mergeCell`, queue, `planPass`, definitions, seals |
| `gate-fichiers-1.vectors.json` | **the gate** | the fixed manifest, `boxSig`, the outcome, the filter |
| `gate-settings-1.vectors.json` | **the gate** | a fixed sealed package and what it opens to |

A vector the gate originates changes only with the apps' agreement first.

## The copied core

`packages/core` holds Filarr's portable core, copied verbatim from Filarr's repository (store cryptography, codec,
registers, view engine, SQL engine) and relicensed Apache-2.0 by its rights holder; `packages/core/src/PROVENANCE.json`
names the Filarr commit of each file. Filarr's own repositories keep their licenses.

More on how the parts fit: [../architecture.md](../architecture.md).
