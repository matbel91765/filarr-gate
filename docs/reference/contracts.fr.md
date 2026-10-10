# Les contrats que suit cette version

[Read in English](contracts.md)

Les applis de Filarr (bureau, web, mobile), son serveur et Filarr Gate partagent des contrats gelés. La boîte noire est
lectrice de certains et à l'origine d'autres. Là où cette documentation et un contrat divergent, le contrat l'emporte,
et l'écart est un défaut à signaler.

| contrat | ce qu'il fixe | la boîte noire |
|---|---|---|
| `api-base-1`, révision 2 | le jeton de l'accès et ses dérivations, la génération d'une clé de base (précision 3.9 de `db-store-1`), les clés scellées, le manifeste des vues et les slugs, les routes qu'une boîte noire peut appeler, les limites par palier, l'écriture | lectrice |
| `api-base-1`, révision 3 | la clé du créateur authentifiée par une étiquette, les réveils poussés, la portée fichiers, les routes des synchros externes, les marques de la boîte hébergée, `pendingExport` pour une migration sans flux | lectrice |
| `db-store-1` (3.9) | le magasin chiffré d'une base : blocs, têtes, registres « le dernier rédacteur l'emporte », validations | lectrice et rédactrice (l'écriture par l'API) |
| `source-externe-1` | les bases externes dans quatre sens : la définition et sa signature, l'identité des lignes, les conversions, la fusion d'une cellule et ses quatre politiques, la file « me demander », le passage, la référence, l'état publié | **origine** du cœur pur (`packages/core/src/engine/extsrc`), recopié par les applis ; exécutant |
| `gate-fichiers-1` | la fente à fichiers : le dépôt scellé, la signature de la boîte, le filtre, les états | **origine** du cœur pur (`engine/gate/files.ts`) ; déposant |
| `gate-heberge-1` | la boîte hébergée par Filarr ; pour la boîte noire : le paquet de réglages `gate-settings-1`, les réveils, le service hébergé fait tourner le même code | le paquet de réglages (dans les deux sens), les réveils |
| `refus-et-etat-de-lappelant` | les codes et les remèdes des refus | lectrice des codes (liste ouverte : un code inconnu se rabat sur un message générique) |

## Les vecteurs de référence

La suite d'essais rejoue les vecteurs partagés avec Filarr (`test/vectors/`), octet pour octet :

| fichier | écrit par | vérifie |
|---|---|---|
| `api-base-1.vectors.json` | Filarr | jeton, preuve, clés scellées, manifeste, slugs |
| `db-store-1.vectors.json` | Filarr | les clés du magasin par génération, les blocs, les têtes |
| `boite-noire-v2-serveur.vectors.json` | le serveur de Filarr | les codes et remèdes de la révision 3, `bumpDue`, le corps de chaque réveil |
| `gate-heberge-1.vectors.json` | Filarr et la boîte noire | les réveils (`A_notify`, en-tête, fenêtre), le paquet de réglages, le texte d'accord et son empreinte |
| `source-externe-1.vectors.json` | **la boîte noire** | identité, `mergeCell`, file, `planPass`, définitions, scellés |
| `gate-fichiers-1.vectors.json` | **la boîte noire** | le manifeste fixe, `boxSig`, le résultat, le filtre |
| `gate-settings-1.vectors.json` | **la boîte noire** | un paquet scellé fixe et ce qu'il donne une fois ouvert |

Un vecteur dont la boîte noire est l'origine ne change qu'avec l'accord préalable des applis.

## Le cœur recopié

`packages/core` contient le cœur portable de Filarr, recopié tel quel du dépôt de Filarr (chiffrement des magasins,
codec, registres, moteur de vues, moteur SQL) et relicencié sous Apache-2.0 par son ayant droit ;
`packages/core/src/PROVENANCE.json` nomme le commit de Filarr de chaque fichier. Les dépôts propres de Filarr gardent
leurs licences.

Comment les parties s'assemblent : [../architecture.fr.md](../architecture.fr.md).
