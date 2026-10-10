# Limites

[Read in English](limits.md)

Aucun chiffre de palier n'est écrit dans cette documentation : les paliers et leurs limites vivent chez Filarr, y
changent, et s'y lisent. Cette page dit **ce qui** est compté, **où** lire les chiffres, et **comment se comporte** la
boîte noire à chaque limite.

## Où lire les chiffres

- **La page des offres de Filarr**, et **Paramètres › Accès API** dans l'appli Filarr (avec la consommation du mois et
  les alertes à 80 % et à 100 %).
- L'écran **Consommation et limites** de la boîte noire : il lit la table des paliers chez Filarr
  (`GET /public/api-limits`, publique, gardée en cache une heure) et les compteurs de chaque réponse
  (`X-Filarr-Quota: sync=<n>/<max>; bytes=<n>/<max>; writes=<n>/<max>` et `RateLimit-*`).
- `filarr-gate doctor` (une ligne par compteur) et les métriques `filarr_gate_quota_used` et `filarr_gate_quota_max`.

```sh
curl -s https://api.filarr.com/public/api-limits
```

## Ce que compte Filarr

Seulement ce qui passe par Filarr. **Les lectures servies par la boîte noire depuis sa copie ne sont jamais comptées,
jamais limitées par Filarr.**

| compté | par | |
|---|---|---|
| requêtes de synchro | compte, mois | chaque requête qu'une boîte noire envoie à Filarr |
| volume téléchargé | compte, mois | les octets des blocs et des têtes |
| écritures | compte, jour (UTC) | chaque validation acceptée, quel que soit le nombre de lignes qu'elle porte |
| débit des requêtes | accès, minute | |
| fichiers déposés, leur volume | compte, mois (UTC) | Pro et plus |
| appels hébergés | boîte hébergée, mois | la boîte hébergée seulement (bientôt) |

Le palier fixe aussi : combien d'accès, combien de bases par accès, l'écriture ou non, les changements en direct ou la
relève, la conservation du journal de l'accès chez Filarr, les adresses autorisées, les fichiers, les synchros
externes planifiées, l'option hébergée.

## Comment se comporte la boîte noire

La boîte noire continue de servir sa dernière copie, quelle que soit la limite atteinte : vos logiciels continuent de
lire.

| Filarr répond | la boîte noire |
|---|---|
| `429 api_rate` | suspend tout échange avec Filarr jusqu'à `Retry-After` ; liaison `limited` |
| `429 api_poll_interval` (Free) | retient cette base jusqu'à `Retry-After` ; elle ne relève jamais plus vite que le palier ni que `poll_seconds` |
| `429 api_quota_sync` | retient cette base (têtes et changements au plus toutes les 900 secondes) ; le flux en direct se ferme et la boîte noire relève toutes les 900 secondes jusqu'au mois suivant |
| `429 api_quota_bytes` | cesse de télécharger des blocs jusqu'au 1er du mois (UTC) ; continue de servir ce qu'elle a |
| `429 api_quota_writes` | refuse l'écriture à votre logiciel avec `429` et `Retry-After` (jusqu'à 00:00 UTC) |
| `429 api_quota_files`, `api_quota_file_bytes` | refuse le dépôt avec `429` et `Retry-After` (jusqu'au 1er, UTC) |
| un flux refusé pour le palier (`api_tier_stream`) | relève à la place |
| un message `quota` (80 %, 100 %) | le note au journal, l'affiche, et déclenche les webhooks `gate.quota` |

## Les limites de la boîte noire elle-même

Celles-ci sont les siennes, pas celles d'un palier :

| | |
|---|---|
| le débit d'une clé d'application | réglé par clé (la valeur par défaut s'affiche dans le formulaire de la clé) |
| la relève sans flux | jamais sous 300 secondes |
| lignes par requête de création | 500 (une validation) |
| lignes par page | 1000 |
| SQL | 64 Kio de requête, 10 000 lignes rendues |
| un fichier | jamais au-dessus de 100 Mio, moins si Filarr ou `files_max_bytes` le disent |
| une synchro externe | 100 000 lignes par définition, deux passages à la fois |

## Écrire moins, compter moins

Une validation compte pour une, quelle que soit sa taille : créez les lignes par lots (une requête avec un tableau), et
laissez une synchro écrire son passage en une validation (c'est ce qu'elle fait). Surveillez les compteurs de la boîte
noire avec Prometheus, et les alertes dans Filarr.
