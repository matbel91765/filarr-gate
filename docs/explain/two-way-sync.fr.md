# Comment la synchro dans les deux sens décide, et pourquoi elle converge

[Read in English](two-way-sync.md)

Le tutoriel la montre à l'œuvre ([D1](../tutorials/sync-d1.fr.md)) ; cette page explique la règle, ce qu'elle garantit
et ce qu'elle ne garantit pas. La règle est une fonction pure (`mergeCell`, `planPass` dans
`packages/core/src/engine/extsrc`), le même code que font tourner les applis Filarr, rejoué par les vecteurs partagés
`source-externe-1`.

## Trois états par cellule

Pour chaque cellule synchronisée, la boîte noire compare :

- **S**, la valeur de la source maintenant, convertie à la forme de Filarr ;
- **F**, le registre de Filarr : sa valeur et son **horloge** (l'horloge logique hybride de la dernière écriture qui a
  gagné) ;
- **O**, la **référence** (le *shadow* du code) : l'empreinte de la dernière valeur sur laquelle les deux côtés étaient
  d'accord, et l'horloge de Filarr à ce moment-là.

« La source a changé » veut dire `empreinte(S) ≠ O`. « Filarr a changé » veut dire `F.horloge ≠ O.horloge`. Comparer
l'horloge, et pas une date, c'est ce qui évite de perdre la vieille modification d'un appareil qui revient en ligne :
son écriture a changé l'horloge du registre, elle compte donc comme un changement.

## Les cas

| cas | la source a changé | Filarr a changé | valeurs | dans les deux sens | colonne entrante (`in`) | colonne sortante (`out`) |
|---|---|---|---|---|---|---|
| A | non | non | | rien | rien | rien |
| B | oui | non | | Filarr ← S | Filarr ← S | source ← F (la valeur de la source est remplacée, journal) |
| C | non | oui | | source ← F | Filarr ← S (la valeur locale est remplacée, journal) | source ← F |
| D | oui | oui | égales | rien, la référence avance | rien | rien |
| E | oui | oui | différentes | **la politique** | Filarr ← S, journal | source ← F, journal |
| F | pas de référence | | égales | la référence naît | | |
| G | pas de référence | | différentes | **la politique** | Filarr ← S, journal | source ← F, journal |

Un premier passage (sans référence) est un **rapprochement** : les valeurs égales font la référence ; les différentes
suivent la politique que vous avez choisie. Un garde-fou protège un premier passage qui aurait trop de conflits.

## Les politiques, et leurs limites

| politique | en cas de conflit | sa limite |
|---|---|---|
| la source l'emporte | Filarr ← S ; la valeur de Filarr au journal | |
| Filarr l'emporte | source ← F ; la valeur de la source au journal | |
| la plus récente l'emporte | la plus tardive entre le repère de la source et l'horloge de Filarr | le repère date la LIGNE, pas la cellule ; les horloges de deux machines |
| me demander | rien n'est écrit ; la cellule entre dans la file | les deux côtés montrent des valeurs différentes jusqu'à ce que quelqu'un décide |

Aucune n'est cochée d'office : vous choisissez, par colonne ou pour la définition, avant le premier passage. Toute
valeur qui perd va au journal, avec « Rétablir », qui la réécrit dans Filarr comme une modification ordinaire (un cas C
au passage suivant).

## La file, précisément

L'identifiant d'une entrée est calculé à partir de la définition, de la clé de ligne, de la colonne et des deux
empreintes. Donc :

- détecter de nouveau le même conflit donne la même entrée (rien n'est dupliqué) ;
- un côté qui change donne un nouvel identifiant : l'ancienne entrée est remplacée, et une décision prise sur les
  anciennes valeurs est **périmée** ;
- les décisions s'appliquent dans l'ordre où le serveur les a reçues ; la première valide pour une entrée l'emporte,
  les autres sont mises de côté et nommées au journal ;
- l'exécutant n'écrit jamais une cellule (ou une ligne, pour un conflit de ligne) qui est dans la file, tant qu'une
  décision valide, ou un changement de politique qui dit « les trancher avec la nouvelle règle », ne la vise pas.

## L'ordre d'un passage, et pourquoi le rejouer est sans danger

1. bail ; définition et signature vérifiées ; décisions lues dans la boîte aux lettres ;
2. Filarr lu (la copie de la boîte noire, à une version N) ;
3. la source lue : par incréments depuis le repère, ou en entier (toutes les 24 heures, tous les 96 passages, ou sans
   repère), plus une lecture ciblée de chaque ligne changée dans Filarr que la lecture incrémentale n'a pas rendue ;
4. le plan (pur) ; 5. les garde-fous, **avant toute écriture** ;
6. les écritures dans la source **seulement si la valeur est encore celle qui a été lue** (quand le connecteur le
   permet), puis relecture : une valeur que la source a normalisée (arrondie, redatée) est réécrite dans Filarr dans le
   même passage ; une cellule qui le fait deux fois de suite est **instable** et n'est plus envoyée ;
7. UNE validation dans Filarr ; un registre qui a changé pendant le passage n'est jamais écrasé (il devient un cas E la
   fois suivante) ;
8. référence, file et journal enregistrés ensemble ; l'état publié (scellé pour les membres) ; les décisions
   acquittées.

Un arrêt brutal entre 6 et 8 laisse la source écrite et la référence ancienne : la fois suivante, les deux côtés « ont
changé » vers la même valeur, cas D, rien n'est écrit deux fois. Un arrêt entre 7 et 8 : de même.

## Ce qui passe par Filarr pendant un passage

Filarr ne fait que relayer et garder des objets scellés ; l'exécutant appelle ces routes du magasin de la base, avec la
preuve de son accès (`runnerId` vaut `a:<accessId>`) :

| route | pour quoi |
|---|---|
| `POST /dbstore/<id>/ext-lease` `{ defId, runnerId, instance, ttlS }` | prendre ou renouveler le bail ; `409 extdb_lease_held` quand un autre processus (une autre `instance`) le tient. `DELETE /dbstore/<id>/ext-lease/<defId>?instance=…` le rend lors d'un arrêt propre |
| `GET /dbstore/<id>/ext-resolve/<runnerId>?after=<seq>` | la boîte aux lettres des décisions : `{ "decisions": [{ "seq": 41, "sealed": "…" }, …], "next": 41 }`, dans l'ordre où le serveur les a reçues ; `next` dit où reprendre, `null` sur la dernière page. La boîte noire lit jusqu'à dix pages par passage, le reste au suivant |
| `DELETE /dbstore/<id>/ext-resolve/<runnerId>?upTo=<seq>` | acquitter les décisions appliquées, seulement APRÈS l'enregistrement de la référence et de la file |
| `PUT /dbstore/<id>/ext-status/<runnerId>`, `PUT /dbstore/<id>/ext-queue/<runnerId>` `{ rev, e, g, sealed }` | publier l'état et la file, par comparaison et échange sur `rev` |
| `POST /dbstore/<id>/commit` | l'unique validation du passage dans la base |

Chaque décision est scellée par l'appli du membre sous une clé tirée de la clé de la base (`K_xs`), que chaque membre et
la boîte noire savent tirer, et Filarr non : Filarr voit un objet scellé et sa taille.

## Les invariants que vérifient les vecteurs

| | |
|---|---|
| I1, convergence | si rien ne change d'un côté ni de l'autre et qu'aucune décision n'arrive, le passage suivant n'écrit rien, et chaque cellule synchronisée hors de la file est égale des deux côtés |
| I2, idempotence | rejouer un passage interrompu donne le même état final ; rejouer une décision déjà appliquée ne fait rien |
| I3, rien de perdu en silence | chaque valeur écrasée par l'exécutant, d'un côté ou de l'autre, est au journal avec sa valeur précédente |
| I4, déterminisme | deux exécutants avec les mêmes entrées font le même plan |
| I5, un seul rédacteur | le bail : pour chaque définition, un seul exécutant écrit dans la source |
| I6, sens respectés | une colonne `in` n'envoie jamais rien à la source ; une colonne `out` n'écrit jamais dans Filarr (sauf la clé et l'écho) |
| I7, garde-fous | aucun passage ne supprime ni ne marque au-delà du seuil sans un accord explicite pour ce passage |
| I8, la file intacte | une cellule de la file n'est écrite d'aucun côté tant qu'une décision valide ne la vise pas |
| I9, une décision vise un état | une décision ne s'applique qu'aux valeurs sur lesquelles elle a été prise |

## Ce qui n'est pas garanti

- En cas de conflit, un côté perd (au journal) ou la cellule attend ; le choix vous revient.
- « La plus récente l'emporte » compare les horloges de deux machines et date la ligne.
- Airtable, Google Sheets et Notion ne permettent pas d'écrire « seulement si inchangé » : il reste une fenêtre de moins
  d'une seconde.
- Pendant qu'un conflit attend, les logiciels qui lisent la source voient la valeur de la source.
- Les disparitions ne se voient qu'à une relecture complète.
