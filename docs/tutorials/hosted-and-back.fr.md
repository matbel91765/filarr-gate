# Passer à la boîte hébergée, puis revenir chez vous

[Read in English](hosted-and-back.md)

> **Bientôt.** La boîte hébergée par Filarr n'est pas encore ouverte : elle ouvre après une revue de sécurité externe,
> compte par compte, et cette page la décrit telle que la fixe le contrat gelé `gate-heberge-1`. Ce qui marche déjà
> aujourd'hui, c'est la moitié du déménagement qui revient à la boîte noire : le paquet de réglages (`gate-settings-1`)
> qui porte vos clés d'application, vos webhooks et vos requêtes enregistrées d'une boîte noire à la suivante, en ligne
> ou par fichier, exécuté par la suite d'essais.

**À la fin**, vous saurez ce que change « hébergée par Filarr », comment lui confier des bases, comment reprendre la
clé vers une boîte noire à vous avec les mêmes clés d'application et les mêmes webhooks, et ce que le reçu
d'effacement prouve et ne prouve pas.

**Palier :** une option payante à partir de Pro (une boîte incluse par organisation Teams ou Enterprise). Le prix est
sur la page des offres de Filarr et dans **Paramètres › Accès API**.

## Ce qui change, dit simplement

Avec une boîte noire à vous, Filarr ne lit jamais vos bases. Avec la boîte hébergée, **pour les bases que vous lui
confiez et tant qu'elles le restent**, un service de Filarr tient leur clé et fait tourner pour vous la même Filarr
Gate :

- il peut techniquement lire **toutes les lignes et toutes les colonnes** de ces bases, y compris ce qu'aucune vue ne
  montre, et ce qui s'y écrit entre-temps ;
- les appels de vos logiciels et les réponses passent par `https://<nom>.gate.filarr.com`, un nom de filarr.com : le
  compte Cloudflare qui gère filarr.com, celui qui sert aussi l'API de Filarr, peut techniquement les voir **en
  transit** ;
- si vous y branchez une base externe, Filarr tient sa clé et voit ses lignes ; si la boîte reçoit des fichiers, Filarr
  les voit au passage.

Vos autres bases, vos notes, vos fichiers et vos coffres restent illisibles pour Filarr. Filarr s'engage à ne pas
journaliser ce contenu, à ne l'utiliser que pour servir votre API, à en garder les copies dans l'Union européenne, et à
effacer la clé et la copie quand vous la reprenez : **ce sont des engagements, pas une protection par le
chiffrement**. Reprendre la clé change les clés de ces bases : la boîte ne peut plus lire ce qui s'écrit ensuite ; ce
qu'elle a lu avant reste couvert par les seuls engagements. Le modèle complet :
[sécurité et confiance](../security-and-trust.fr.md#hébergée-par-filarr).

## Confier des bases (dans Filarr)

Quand vous ouvrez une base à une API, « Où tourne la boîte noire ? » propose **chez moi** (d'office) ou **chez
Filarr**. Chez Filarr :

1. cochez chaque base à confier (aucune n'est cochée pour vous) ;
2. lisez l'accord et cochez « J'ai compris que Filarr pourra lire les bases cochées tant qu'elles lui sont confiées. »
   (le texte est versionné : un changement de texte vous redemande votre accord) ;
3. prouvez de nouveau que c'est vous (mot de passe et code de double authentification, ou une clé d'accès) ;
4. **Confier 1 base à Filarr**.

Votre appareil tire le jeton et le scelle pour la clé du service hébergé, que les applis portent en elles : personne ne
voit le jeton, pas même vous. Il vous montre, une seule fois, l'adresse de la boîte
(`https://site-vitrine-7qm2.gate.filarr.com`) et une première clé d'application (`gk_…`). La boîte hébergée n'a pas
d'interface de gestion : ses clés d'application, ses webhooks, ses requêtes enregistrées et son filtre de fichiers se
règlent dans **Paramètres › Accès API**.

Toute personne qui peut voir une base confiée la voit marquée « API hébergée par Filarr · Filarr peut lire cette
base », sur tous les appareils ; les membres d'un coffre apprennent qui l'a confiée. Seuls le propriétaire ou les
administrateurs du coffre peuvent confier ou reprendre une base de ce coffre.

En sommeil : si le paiement échoue ou si le palier descend sous Pro, la boîte dort 30 jours (elle répond
`503 gate_asleep` ; la clé est gardée), se réveille une fois payée, et est effacée avec un reçu au bout des 30 jours.

## Revenir chez vous

Cinq étapes, sans arrêter vos logiciels :

1. **Installez une boîte noire** là où vous la voulez ([ordinateur](install-local.fr.md), [Docker](install-docker.fr.md),
   [Cloudflare](install-cloudflare.fr.md)). Ne lui donnez pas encore de jeton.
2. **Préparez**, dans Filarr (**Paramètres › Accès API**, l'accès hébergé, **Reprendre chez moi**) : votre appareil
   tire une identité neuve pour l'accès et montre son jeton une fois. Elle attend sept jours, comme « identité en
   attente » ; la boîte hébergée continue de servir en attendant. La boîte hébergée vérifie que l'identité neuve est
   signée par vous, scelle ses réglages pour elle, et les dépose chez Filarr.
3. **Démarrez votre boîte noire avec le nouveau jeton** :

   ```sh
   filarr-gate init --token flr_live_<le nouveau jeton>
   filarr-gate
   ```

   Elle démarre dans l'état de liaison `pending` : elle ne peut lire que l'accès et son paquet de réglages, qu'elle
   ouvre et applique (les mêmes clés d'application, les mêmes webhooks, les mêmes requêtes enregistrées). L'écran
   **Journal** montre `réglages importés` avec le nombre de clés, de webhooks et de requêtes.
4. **Changez l'adresse** dans vos logiciels, de `https://<nom>.gate.filarr.com` à celle de votre boîte noire. Vos clés
   d'application sont les mêmes : seule l'adresse change. (Filarr peut rediriger l'ancienne adresse vers la nouvelle
   pendant 30 jours, mais la plupart des clients HTTP retirent l'en-tête `Authorization` quand ils suivent une
   redirection vers un autre hôte : changez l'adresse quand même.)
5. **Basculez**, dans Filarr : « Effacer et changer les clés ». L'identité neuve devient celle de l'accès, l'ancien
   jeton est refusé, le service hébergé efface la clé, la copie et l'état de la boîte, et signe un reçu ; votre
   appareil fait passer chaque base à une nouvelle génération de clés.

Les clés des bases externes ne sont **pas** dans le paquet : sur votre propre boîte noire, une clé ne transite jamais
par Filarr. Filarr les a tenues : changez-les chez leur fournisseur, puis donnez les nouvelles à votre boîte noire
(`filarr-gate sources key`).

### Le même déménagement, par fichier

Sans le chemin en ligne (hors ligne, ou entre deux boîtes noires à vous), l'ancienne boîte noire scelle ses réglages
pour le nouveau jeton, et la nouvelle les applique :

```sh
filarr-gate export --for-token flr_live_<le nouveau jeton> --out gate-settings.json     # sur l'ancienne boîte noire
filarr-gate init --token flr_live_<le nouveau jeton> --import gate-settings.json         # sur la nouvelle
```

Le paquet contient les empreintes des clés d'application (un programme garde sa clé `gk_…`), les webhooks et leurs
secrets (les récepteurs continuent de vérifier), les requêtes enregistrées, l'état chiffré des synchros, le filtre de
fichiers, le CORS et le réglage `write`. Jamais le mot de passe de gestion, jamais une clé de base externe. Il est
scellé pour le nouveau jeton seulement ; une autre boîte noire ne peut pas l'ouvrir. Plus de détails :
[explain/migration.fr.md](../explain/migration.fr.md).

## Le reçu d'effacement

```json
{ "v": 1, "kind": "filarr-gate-host/erasure", "keyId": "h1", "accessId": "…", "hostName": "site-vitrine-7qm2",
  "reason": "migrated", "stores": [{ "storeId": "…", "g": 4 }], "erased": ["token", "dbKeys", "copy", "state", "extdbKeys"],
  "requestedAt": "…", "erasedAt": "…", "version": "0.2.0", "codeHash": "sha256:…" }
```

signé par la clé du service hébergé, gardé 5 ans au journal de l'accès, montré par les applis avec la génération d'après
le déménagement (« génération 4 → 5 »). **Il prouve que le service a exécuté l'ordre ; il ne peut pas prouver qu'aucune
copie n'existe ailleurs.** Ce qui s'écrit désormais dans ces bases est illisible pour l'ancienne boîte : cela, c'est
garanti par le chiffrement.

## Et ensuite

- [Sécurité et confiance](../security-and-trust.fr.md) : qui voit quoi dans chaque mode, et comment vérifier le code
  du service hébergé.
- [Révoquer un accès](revoke.fr.md), hébergé ou non.
- Dans l'aide de Filarr : [la boîte noire hébergée](https://filarr.com/docs/gate-hosted),
  [ce que Filarr peut voir](https://filarr.com/docs/gate-hosted-trust) et
  [une base de coffre confiée à Filarr](https://filarr.com/docs/gate-sharing-vaults).
