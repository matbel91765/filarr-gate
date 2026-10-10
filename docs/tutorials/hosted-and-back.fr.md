# Passer à la boîte hébergée, puis revenir chez vous

[Read in English](hosted-and-back.md)

> **Bientôt.** La boîte hébergée par Filarr n'est pas encore ouverte : elle ouvrira, compte par compte, après une revue
> de sécurité externe, et cette page la décrit telle que la fixe le contrat gelé `gate-heberge-1`. Ce qui marche déjà
> aujourd'hui, c'est la moitié du déménagement qui revient à la boîte noire : le paquet de réglages (`gate-settings-1`)
> qui porte vos clés d'application, vos webhooks et vos requêtes enregistrées d'une boîte noire à la suivante, en ligne
> ou par fichier, exécuté par la suite d'essais.

**À la fin**, vous saurez ce que change « hébergée par Filarr », comment lui confier des bases, comment reprendre la clé
pour revenir à une boîte noire à vous avec les mêmes clés d'application et les mêmes webhooks, et ce que le reçu
d'effacement prouve et ne prouve pas.

**Palier :** une option payante à partir de Pro (une boîte incluse par organisation Teams ou Enterprise). Le prix est
sur la page des offres de Filarr et dans **Paramètres › Accès API**.

## Ce qui change, dit simplement

Avec une boîte noire à vous, vos bases restent chiffrées de bout en bout. Avec la boîte hébergée, **pour les bases que
vous lui confiez et tant qu'elles le restent**, un service de Filarr gère leur clé et fait tourner pour vous la même
Filarr Gate : ces bases ne sont donc plus chiffrées de bout en bout.

- **toutes les lignes et toutes les colonnes** de ces bases, y compris ce qu'aucune vue ne montre, et ce qui s'y écrit
  entre-temps, sont déchiffrées par les serveurs de Filarr ;
- les appels de vos logiciels et les réponses ne sont pas non plus chiffrés de bout en bout : ils passent par
  `https://<nom>.gate.filarr.com`, un nom de filarr.com, géré par le même compte Cloudflare que l'API de Filarr ;
- si vous y branchez une base externe, sa clé est aussi gérée par les serveurs de Filarr ; les fichiers que reçoit la
  boîte passent eux aussi par les serveurs de Filarr sans chiffrement de bout en bout.

Vos autres bases, vos notes, vos fichiers et vos coffres ne sont pas concernés. Filarr s'engage à ne pas journaliser ce
contenu, à ne l'utiliser que pour servir votre API, à en garder les copies dans l'Union européenne, et à effacer la clé
et la copie quand vous la reprenez : **ce sont des engagements de Filarr, et non une protection par le chiffrement de
bout en bout**. Reprendre la clé change les clés de ces bases : ce qui s'écrit ensuite est de nouveau chiffré de bout en
bout ; ce que la boîte a traité avant reste couvert par les seuls engagements. Le modèle complet :
[sécurité et confiance](../security-and-trust.fr.md#hébergée-par-filarr).

## Confier des bases (dans Filarr)

Quand vous ouvrez une base à une API, « Où tourne la boîte noire ? » propose **chez moi** (d'office) ou **chez
Filarr**. Chez Filarr :

1. cochez chaque base à confier (aucune n'est cochée pour vous) ;
2. lisez l'accord et cochez « J'ai compris que les bases cochées ne seront plus chiffrées de bout en bout tant qu'elles
   sont confiées à Filarr. » (le texte est versionné : s'il change, Filarr vous redemande votre accord) ;
3. prouvez de nouveau que c'est vous (mot de passe et code de double authentification, ou une clé d'accès) ;
4. **Confier 1 base à Filarr**.

Votre appareil tire le jeton et le scelle pour la clé du service hébergé, que les applis portent en elles : personne ne
voit le jeton, pas même vous. Il vous montre, une seule fois, l'adresse de la boîte
(`https://site-vitrine-7qm2.gate.filarr.com`) et une première clé d'application (`gk_…`). La boîte hébergée n'a pas
d'interface de gestion : ses clés d'application, ses webhooks, ses requêtes enregistrées et son filtre de fichiers se
règlent dans **Paramètres › Accès API**.

Toute personne qui peut voir une base confiée la voit marquée « API hébergée par Filarr · pas chiffrée de bout en
bout », sur tous les appareils ; les membres d'un coffre apprennent qui l'a confiée. Seuls le propriétaire ou les
administrateurs du coffre peuvent confier ou reprendre une base de ce coffre.

En sommeil : si le paiement échoue ou si le palier descend sous Pro, la boîte dort 30 jours (elle répond `503
gate_asleep` ; la clé est gardée), se réveille dès le paiement reçu, et est effacée avec un reçu au bout des 30 jours.

## Revenir chez vous

Cinq étapes, sans arrêter vos logiciels :

1. **Installez une boîte noire** là où vous la voulez ([ordinateur](install-local.fr.md),
   [Docker](install-docker.fr.md), [Cloudflare](install-cloudflare.fr.md)). Ne lui donnez pas encore de jeton.
2. **Préparez**, dans Filarr (**Paramètres › Accès API**, l'accès hébergé, **Reprendre chez moi**) : votre appareil tire
   une identité neuve pour l'accès et montre son jeton une fois. Elle reste sept jours en attente (« identité en attente
   ») ; la boîte hébergée continue de servir en attendant. La boîte hébergée vérifie que l'identité neuve est signée par
   vous, scelle ses réglages pour elle, et les dépose chez Filarr.
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
par Filarr. Elles ont été gérées par les serveurs de Filarr : changez-les chez leur fournisseur, puis donnez les
nouvelles à votre boîte noire (`filarr-gate sources key`).

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
  "requestedAt": "…", "erasedAt": "…", "version": "0.3.0", "codeHash": "sha256:…" }
```

signé par la clé du service hébergé, gardé 5 ans au journal de l'accès, montré par les applis avec la génération d'après
le déménagement (« génération 4 → 5 »). **Il prouve que le service a exécuté l'ordre ; il ne peut pas prouver qu'aucune
copie n'existe ailleurs.** Ce qui s'écrit désormais dans ces bases est de nouveau chiffré de bout en bout,
avec des clés que l'ancienne boîte n'a jamais eues : cela, c'est garanti par le chiffrement.

## Et ensuite

- [Sécurité et confiance](../security-and-trust.fr.md) : qui voit quoi dans chaque mode, et comment vérifier le code
  du service hébergé.
- [Révoquer un accès](revoke.fr.md), hébergé ou non.
- Dans l'aide de Filarr : [la boîte noire hébergée](https://filarr.com/docs/gate-hosted),
  [ce qui n'est plus chiffré de bout en bout](https://filarr.com/docs/gate-hosted-trust) et
  [une base de coffre confiée à Filarr](https://filarr.com/docs/gate-sharing-vaults).
