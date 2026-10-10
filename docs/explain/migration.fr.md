# Déménager une boîte noire : le paquet de réglages

[Read in English](migration.md)

Quand un accès change de boîte noire (un nouveau serveur, de votre boîte noire à la boîte hébergée et retour), la
nouvelle boîte noire reçoit une **identité neuve** (un nouveau jeton pour le même accès), et l'ancienne lui remet ses
réglages dans un **paquet de réglages** (`gate-settings-1`), scellé pour que seul le nouveau jeton puisse l'ouvrir.

## Ce qui voyage, ce qui ne voyage jamais

| voyage | ne voyage jamais |
|---|---|
| les clés d'application, en empreintes : un programme garde sa clé `gk_…` | le mot de passe de gestion |
| les webhooks et leurs secrets : les récepteurs continuent de vérifier | les clés des bases externes (sur votre propre boîte noire, une clé ne transite jamais par Filarr) |
| les requêtes enregistrées | une ligne déchiffrée |
| l'état des synchros externes (leurs références, toujours chiffrées sous une clé tirée de la clé de chaque base) | |
| le filtre de fichiers, le CORS, le réglage `write` | |

Les champs que la nouvelle boîte noire ne connaît pas sont gardés : les réglages d'une boîte noire plus récente
survivent ainsi à une plus ancienne.

## En ligne

1. Filarr crée l'identité neuve, en attente (7 jours) ; l'ancienne boîte noire continue de servir.
2. L'ancienne boîte noire l'apprend (flux en direct, réveil, ou `pendingExport` à sa prochaine lecture de l'accès),
   **vérifie que l'identité neuve est liée à l'accès par la signature du créateur** (avec la clé du créateur qu'elle a
   authentifiée, jamais une clé servie par le serveur), scelle ses réglages pour la nouvelle clé publique, et les dépose
   chez Filarr.
3. La nouvelle boîte noire, démarrée avec le nouveau jeton, est dans l'état de liaison `pending` : elle ne peut lire que
   l'accès et son paquet, qu'elle ouvre et applique.
4. Filarr bascule : l'identité neuve devient celle de l'accès, l'ancien jeton est refusé.

## Par fichier

```sh
filarr-gate export --for-token flr_live_<nouveau jeton> --out gate-settings.json     # sur l'ancienne boîte noire
filarr-gate init --token flr_live_<nouveau jeton> --import gate-settings.json         # sur la nouvelle
filarr-gate import gate-settings.json                                                 # ou plus tard, sur une boîte noire déjà en place
```

Le fichier est une enveloppe scellée (`kind: "filarr-gate/settings-sealed"`) ; `export` refuse le jeton d'un autre
accès (`other_access`) et celui de la boîte noire elle-même (`same_token`) ; `import` refuse un paquet scellé pour un
autre jeton (`package_unreadable`). Les clés, webhooks et requêtes existants de même identifiant sont remplacés, les
autres ajoutés.

## Après le déménagement

Donnez les clés des bases externes à la nouvelle boîte noire (`filarr-gate sources key`), et changez, dans vos
logiciels, l'adresse de la boîte noire si elle a changé. Les vecteurs `gate-settings-1` (un paquet scellé fixe et ce
qu'il donne une fois ouvert) sont rejoués par la suite d'essais.
