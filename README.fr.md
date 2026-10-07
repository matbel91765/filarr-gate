# Filarr Gate

**Servir une base Filarr comme une API, sans que Filarr voie jamais vos données.**

[Read in English](README.md)

> **État : en conception.** Rien ne tourne encore ici. Le protocole se fige d'abord avec les applications Filarr ;
> le code suit. Suivez le dépôt pour voir avancer.

Filarr chiffre vos notes et vos bases de bout en bout : ses serveurs gardent des blocs qu'ils ne savent pas lire.
Pas de « clé d'API chez l'éditeur », donc. Filarr Gate prend le chemin inverse : une petite **boîte noire que vous
faites tourner vous-même** (sur votre PC, dans Docker, sur votre propre compte Cloudflare, ou comme bibliothèque).
Elle tient la clé des seules bases que vous lui ouvrez, en garde une copie déchiffrée en mémoire, et sert vos
logiciels sur place.

```
 Filarr ──(blocs chiffrés)──▶ serveurs Filarr ──(blocs chiffrés)──▶ Filarr Gate ──(JSON en clair)──▶ ERP, BI, site, agent IA
                                ne voient rien                       chez vous
```

## Ce qu'elle fera

- **Une vue, un point d'accès.** Chaque vue d'une base devient un point d'accès REST (filtres, tri, colonnes), avec
  un schéma OpenAPI tiré des types des colonnes.
- **SQL en lecture.** Jointures et regroupements sur les bases ouvertes, avec le moteur de requêtes de Filarr.
- **Webhooks signés.** Une ligne change dans Filarr : la boîte noire la déchiffre et appelle votre adresse, signée
  en HMAC-SHA256, avec reprises.
- **Clés des applications.** Vos logiciels n'ont jamais le jeton Filarr : chacun reçoit sa clé, limitée par point
  d'accès et par droit, avec débit maximal et adresses autorisées.
- **Écriture** (juste après la v1) : créer et modifier des lignes depuis vos logiciels, validées par Filarr comme
  n'importe quel appareil.
- **Une interface de gestion complète** : tableau de bord, bases et points d'accès, explorateur SQL, clés, webhooks,
  journal, limites, réglages.
- Serveur MCP pour les assistants IA, métriques Prometheus, traces OpenTelemetry.

## Pourquoi c'est rapide

Les lectures ne quittent jamais votre réseau : la boîte noire répond depuis sa copie en mémoire (moins d'une
milliseconde pour une vue courante). Seuls les changements voyagent, en petits blocs chiffrés immuables (environ
32 Kio), faciles à mettre en cache.

## La sécurité, en bref

- Un jeton d'accès n'ouvre **que les bases choisies**, jamais le compte, les notes ni les fichiers.
- Filarr garde l'empreinte de la preuve du jeton et la clé publique de l'accès. Il ne voit jamais le jeton, les
  clés des bases ni une seule ligne.
- Révoquer un accès coupe tout de suite au serveur, et les clés des bases passent à une nouvelle génération : un
  jeton révoqué ne lit rien de ce qui s'écrit ensuite.
- Une boîte noire lit les bases entières : une vue est un confort, pas une frontière cryptographique. La machine
  qui la fait tourner se protège comme toute machine qui détient les données.

Détails : [docs/architecture.md](docs/architecture.md).

## Paliers et limites

Filarr Gate fonctionne à tous les paliers Filarr, Free compris. Filarr ne compte que ce qui passe par ses serveurs
(requêtes de synchro, volume descendu, écritures) ; les lectures servies par votre boîte noire ne sont jamais
comptées. Les limites par palier seront publiées par l'API Filarr elle-même et affichées dans l'application.

## Licence

Pas encore choisie. Tant qu'aucun fichier de licence n'est ajouté, tous droits réservés.

## Sécurité

Signalez une faille en privé : voir [SECURITY.md](SECURITY.md).
