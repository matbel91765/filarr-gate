# Security and trust: who sees what

[Lire en français](security-and-trust.fr.md)

Filarr encrypts your notes and databases end to end: its servers store blocks they cannot read. To serve a database
as an API, something must decrypt it. This page says exactly what does, in each mode, who can therefore read what, and
what is guaranteed by encryption, what can be checked, and what rests on commitments only. Where a limit exists, it is
written here.

## The three modes

| | where the gate runs | who holds the token | Filarr can read the opened databases? |
|---|---|---|---|
| **In your code, on your machine** (library, Node, Docker) | your computer, your server | you | **no** |
| **On your Cloudflare account** | a Worker and a Durable Object of YOUR account | you (a Worker secret) | **no** (Cloudflare, as your host, is in the same position as for any Worker you run) |
| **Hosted by Filarr** (coming soon, paid option) | a service of Filarr | that service, sealed | **yes**, for the databases you entrust to it and while they stay entrusted |

## Who sees what, at home (the first two modes)

| party | sees | never sees |
|---|---|---|
| **Filarr's servers** | the access (its id, its public key, the fingerprint of its proof), the sealed keys and the sealed views (which they cannot open), counters (requests, downloaded bytes, commits), the gate's IP address and version | the token, the keys it derives, a database key, a row, a column name |
| **The gate, and whoever runs it** | every row and every column of the databases opened to the access, not only what the views show | a database that is not opened to it, your other notes, files, vaults, your account's keys |
| **Your software** | what its app key allows (a database, a view, a query, SQL, files) | the Filarr token |
| **A webhook receiver** | the rows (and fields) its webhook selects, signed | anything else |
| **An external database** (a sync) | the gate's IP address, the operations of the sync | Filarr's other data |
| **The members of a vault** | the definition of a sync (without key), its state and its journal, values it replaced included | the key of the external database |

**A view is a convenience, not a boundary.** The gate reads the whole database it is given; a view only shapes what an
endpoint returns. To share less, open a database that holds less.

## What protects what

**By encryption**

- **The token opens only the databases you chose.** It is `flr_live_<id>_<secret>`. From the secret, the gate derives
  (HKDF-SHA256) the proof it shows Filarr and a private key; Filarr stores only the fingerprint of the proof and the
  public key. A stolen request log at Filarr opens nothing.
- **One key per database and per generation.** Each database key is derived one way from your root key, for one
  database and one generation, and sealed to the access's public key. It cannot be turned back into your root key, nor
  into the next generation, nor into another database's key.
- **Revocation cuts the future.** Revoking an access (or removing a database from it) moves each database to a new
  generation whose key is never sealed to the old token: what is written afterwards is unreadable to it, even if
  encrypted blocks leaked some other way.
- **Nothing is accepted from the wrong place.** Every sealed key names its access, database and generation, and the
  gate refuses one found elsewhere. Every block is checked against the database head's fingerprints before it is
  decrypted; a server that goes back in time is refused.
- **Signed objects come from the creator, not from a server.** Deposit boxes, sync definitions and migration targets
  are accepted only when signed by the access creator's identity key, which the gate authenticates with a tag only the
  token can compute. A server that served its own key would be refused: files would not be sealed for it, a changed
  sync definition would not run.
- **Files are sealed before they leave.** The gate encrypts each file with a fresh key, sealed to your deposit box;
  Filarr stores what it cannot open, and learns neither the name nor the folder.

**By the gate's design**

- Decrypted rows live **in memory only**. On disk (state directory, files mode 0600 where the system allows): the
  token (unless given by the environment), the fingerprints of the app keys, the webhook secrets, the management
  password's hash (scrypt), the settings, the encrypted blocks exactly as Filarr stores them (unless `cache = memory`),
  the keys of external databases encrypted under a key derived from the token, the encrypted state of the syncs, and
  the local log (paths, codes, durations; no row content, no token, no key).
- **Never on disk**: a database key, a decrypted row, a webhook body (pending deliveries live in memory).
- **Never on the network**: the token or its secret.
- Your software never holds the token: each program has its own app key, stored as a fingerprint, limited to its
  endpoints, with a rate, allowed addresses and an expiry.
- Revocation wipes the copy, the keys and the block cache of a gate that hears it.
- The management UI asks for a password (ten characters at least), listens on `127.0.0.1` by default, refuses writes
  without its own header (a page of another site cannot forge it), and limits wrong passwords.

**What is not guaranteed, said plainly**

- **Whoever runs the gate, or knows its management password, reads the opened databases.** Protect the machine as you
  would the data.
- **A gate that was offline keeps its copy** until it reconnects and hears the revocation, or until someone erases it
  on its machine.
- **Replacing a token does not change the keys** (revoking does). See [revoke](tutorials/revoke.md).
- **Webhooks carry rows in clear** to your receiver: use HTTPS, and verify the signature.
- **Two-way syncs to Airtable, Google Sheets and Notion** cannot write "only if the value is still the one I read":
  the gate re-reads just before writing, and a window of less than a second remains in which a change made in the
  source at that instant could be overwritten (and kept in the journal). D1, PostgreSQL, MySQL and Supabase have no
  such window.
- **"The most recent wins"** compares the clocks of two machines, and dates the row, not the cell.
- **The Cloudflare variant**: Cloudflare, as the host of your Worker, runs your code and could technically reach its
  memory, as for any Worker.

## Hosted by Filarr

> Coming soon. This section describes the hosted box as the frozen contract `gate-heberge-1` defines it, so that you
> can judge it before it opens.

For the databases you **entrust** to it, and while they stay entrusted, a service of Filarr holds their key and runs
the same Filarr Gate. Filarr will use one expression only: a database "entrusted to Filarr", a box "hosted by Filarr".

### What Filarr can technically see

| what | who at Filarr | why |
|---|---|---|
| every row and every column of the entrusted databases, viewed or not | the hosted service | it holds their keys and serves the API from its copy |
| what is written to them while they stay entrusted (by you, the members, the API) | the hosted service | the current generation is sealed to it while the database stays entrusted |
| the requests of your software and the answers | the hosted service | it serves the API |
| the same requests and answers, **in transit** | the Cloudflare account that manages filarr.com, the one of Filarr's API, which also hosts the service | the box's address `<name>.gate.filarr.com` is a name of its zone: it terminates TLS itself |
| the key of an external database connected to the box, and its rows | the hosted service | the scheduled sync runs there |
| the files the box receives, in passing | the hosted service | it seals them for your deposit box after receiving them |
| encrypted blocks, sealed keys, counters | Filarr's API | as at home |
| the token, sealed for the service | Filarr's API, **without being able to open it** | sealed to the service's key, which the apps carry built in |

What it still cannot see: the databases you did not entrust, your notes, files and vaults; your root keys (a database
key is derived one way); what is written after you take the key back (the generation changes, and the new key is never
sealed to the service); the folder where your received files are filed (only your devices file them).

### What protects, ranked by strength

| strength | protection | its exact limit |
|---|---|---|
| encryption | one database, not the account | the entrusted key opens one database at one generation |
| encryption | taking the key back cuts the future | what the service read BEFORE is covered by commitments only |
| encryption | the token is never in clear in the API's database or its backups | it does NOT protect from the traffic in transit, nor from whoever holds the service's private key |
| none | the traffic of a hosted box, in transit | the account that manages filarr.com can see it; said in the consent |
| verifiable | the code fingerprint the service announces equals the published version's | **this checks what the service ANNOUNCES; no remote attestation exists on Workers: nobody can prove the code running is that code.** Hence the external review, the public log of releases, and the commitment |
| verifiable | everything is traced | consent, service versions, sleep, take-back, erasure receipt, in the access's log |
| verifiable | it shows | everyone who sees an entrusted database sees the mark, on every device |
| commitment | isolation, no logging of content, copies in the EU, no other use | Cloudflare, as host, can technically reach the memory of its machines; a request crosses the point of presence nearest to the caller, which may be outside the EU (only the COPIES stay in the EU); whoever administers Filarr's Cloudflare account could change the code or the configuration: the commitment, the release chain and the external review frame that, not a technical barrier |
| commitment | erasure | a signed receipt proves the service executed the order, not that no copy exists elsewhere |

### Isolation by script, in the same account

The service is a separate Worker script of the same Cloudflare account as Filarr's API, with its own secrets and its
own Durable Objects; the API's script has no binding to them.

- **What that guarantees**: the token is never in clear in the API's database, its backups, its history or an export;
  a flaw or a compromise of the API's CODE (a bug in a route, a poisoned dependency) gives neither the service's
  secrets, nor its storage, nor a token in clear.
- **What it does not guarantee**: protection from an administrator of the account, who could deploy code that reads
  the service's secrets, its storage or the traffic of the zone; and protection from the traffic in transit, visible to
  the account at all times. An interception by the account leaves no public trace (its certificate is legitimately its
  own).

### How a version goes into service

- Only through the integration chain, from a **signed tag** of this public repository; no deployment from a
  workstation.
- A **public log** of releases: version, tag, code fingerprint, publication date, date of entry into service.
- **Seven days** between publication and entry into service, so that anyone can read the code and rebuild its
  fingerprint first (the build is reproducible: see [release.md](release.md)).
- **One exception, the security fix**: a fix to a flaw that puts entrusted databases, their keys, tokens or isolation
  at risk, described in a security advisory of this repository, released by a tag `vX.Y.Z-security` signed by a key of
  the `security` role and naming the advisory. The log then says "security fix, seven-day delay lifted", with the
  advisory and its severity; each hosted access receives the event; the details of the flaw are published within 30
  days. Anything else waits seven days.

### Law

The copies stay in the European Union (Durable Objects in the EU jurisdiction); requests and answers cross, in
transit, the point of presence nearest to the caller. Filarr becomes your processor for the entrusted databases: a data
processing agreement comes with the option, Cloudflare listed as sub-processor.

### Compared with a box at home

| | at home | hosted |
|---|---|---|
| Filarr reads the opened databases | no | yes, while entrusted |
| your software's traffic seen by Filarr | no | yes, in transit |
| external database keys | in your gate | held by Filarr |
| something to install and keep running | yes | no |
| PostgreSQL and MySQL syncs | yes | no (HTTPS connectors only) |

### The consent text

What you accept when you entrust databases, word for word (version `hebergement-v1`). `{{box}}` becomes the box's
name. The layout (title, bullets, checkbox) may differ from one app to another; the words may not: each Filarr app is
tested against the SHA-256 fingerprint of this text that the contract fixes, and so is this page (`npm test`). If the
text changes, Filarr asks you to accept it again; without a new consent after 30 days, the database is removed from the
box.

<!-- consent: hebergement-v1 en -->
```text
Entrust these databases to the black box hosted by Filarr?
Until now, Filarr could not read these databases: only your devices had their key.
If you entrust them to the black box "{{box}}", hosted by Filarr:
the key of each checked database will be handed to an isolated Filarr service, which decrypts it to answer your software;
Filarr will therefore technically be able to read all their rows and all their columns, including those no view shows, and everything written to them while they remain entrusted;
this also holds in transit: the box's address is a filarr.com name, and the Filarr account that manages that name, the one that also serves Filarr's API, can technically see your software's calls and the responses;
if you connect an external database to it, Filarr will also hold its key and see its rows; if the box receives files, Filarr will see them in passing;
your other databases, your notes, your files and your vaults will remain unreadable to Filarr.
Filarr commits to not logging this content, to using it only to serve your API, to keeping its copies in the European Union and to erasing the key and the copy when you take it back. These are commitments, not protection by encryption.
You can take the key back at any time. The keys of these databases then change: the hosted box will no longer be able to read anything written afterwards. What it read before remains covered only by the commitments above.
I understand that Filarr will be able to read the checked databases while they are entrusted to it.
```

## Report a vulnerability

Privately, through GitHub's "Report a vulnerability" (the Security tab of this repository): see
[SECURITY.md](../SECURITY.md). Never in a public issue.
