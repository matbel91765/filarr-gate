# Moving a gate: the settings package

When an access changes gates (a new server, from your gate to the hosted box and back), the new gate gets a **new
identity** (a new token for the same access), and the old gate hands it its settings in a **settings package**
(`gate-settings-1`), sealed so that only the new token can open it.

## What travels, what never does

| travels | never travels |
|---|---|
| the app keys, as fingerprints: a program keeps its `gk_…` key | the management password |
| the webhooks and their secrets: receivers keep verifying | the keys of external databases (on your own gate, a key never transits through Filarr) |
| the saved queries | a decrypted row |
| the state of the external syncs (their shadows, still encrypted under a key derived from each database's key) | |
| the file filter, CORS, the `write` setting | |

Fields the new gate does not know are kept, so a newer gate's settings survive an older one.

## Online

1. Filarr creates the new identity, pending (7 days); the old gate keeps serving.
2. The old gate learns it (live stream, wake-up, or `pendingExport` in its next read of the access), **checks that the
   new identity is bound to the access by the creator's signature** (with the creator's key it authenticated, never a
   key served by the server), seals its settings for the new public key, and drops them at Filarr.
3. The new gate, started with the new token, is in the link state `pending`: it can read only the access and its
   package, opens and applies it.
4. Filarr switches: the new identity becomes the access's, the old token is refused.

## As a file

```sh
filarr-gate export --for-token flr_live_<new token> --out gate-settings.json     # on the old gate
filarr-gate init --token flr_live_<new token> --import gate-settings.json         # on the new one
filarr-gate import gate-settings.json                                             # or later, on a gate already set up
```

The file is a sealed envelope (`kind: "filarr-gate/settings-sealed"`); `export` refuses another access's token
(`other_access`) and the gate's own (`same_token`); `import` refuses a package sealed for another token
(`package_unreadable`). Existing keys, webhooks and queries with the same id are replaced, the others added.

## After the move

Give the external database keys to the new gate (`filarr-gate sources key`), and change, in your software, the address
of the gate if it changed. The vectors `gate-settings-1` (a fixed sealed package and what it opens to) are replayed by the
test suite.
