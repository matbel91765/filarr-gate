# Sécurité et confiance : qui voit quoi

[Read in English](security-and-trust.md)

Filarr chiffre vos notes et vos bases de bout en bout : ses serveurs gardent des blocs qu'ils ne savent pas lire. Pour
servir une base sous forme d'API, quelque chose doit la déchiffrer. Cette page dit exactement ce qui la déchiffre dans
chaque mode, qui peut donc lire quoi, et ce qui est garanti par le chiffrement, ce qui se vérifie, et ce qui ne repose
que sur des engagements. Là où une limite existe, elle est écrite ici.

## Les trois modes

| | où tourne la boîte noire | qui tient le jeton | Filarr peut-il lire les bases ouvertes ? |
|---|---|---|---|
| **Dans votre code, sur votre machine** (bibliothèque, Node, Docker) | votre ordinateur, votre serveur | vous | **non** |
| **Sur votre compte Cloudflare** | un Worker et un Durable Object de VOTRE compte | vous (un secret du Worker) | **non** (Cloudflare, votre hébergeur, est dans la même position que pour n'importe quel Worker que vous faites tourner) |
| **Hébergée par Filarr** (bientôt, option payante) | un service de Filarr | ce service, scellé | **oui**, pour les bases que vous lui confiez et tant qu'elles restent confiées |

## Qui voit quoi, chez vous (les deux premiers modes)

| qui | voit | ne voit jamais |
|---|---|---|
| **Les serveurs de Filarr** | l'accès (son identifiant, sa clé publique, l'empreinte de sa preuve), les clés scellées et les vues scellées (qu'ils ne savent pas ouvrir), des compteurs (requêtes, octets téléchargés, validations), l'adresse IP et la version de la boîte noire | le jeton, les clés qui en sont tirées, une clé de base, une ligne, un nom de colonne |
| **La boîte noire, et qui la fait tourner** | toutes les lignes et toutes les colonnes des bases ouvertes à l'accès, pas seulement ce que montrent les vues | une base qui ne lui est pas ouverte, vos autres notes, fichiers et coffres, les clés de votre compte |
| **Vos logiciels** | ce que leur clé d'application permet (une base, une vue, une requête, le SQL, les fichiers) | le jeton Filarr |
| **Un récepteur de webhook** | les lignes (et les champs) que son webhook sélectionne, signées | tout le reste |
| **Une base externe** (une synchro) | l'adresse IP de la boîte noire, les opérations de la synchro | les autres données de Filarr |
| **Les membres d'un coffre** | la définition d'une synchro (sans clé), son état et son journal, valeurs remplacées comprises | la clé de la base externe |

**Une vue est un confort, pas une frontière.** La boîte noire lit la base entière qu'on lui donne ; une vue ne fait que
façonner ce que rend un point d'accès. Pour partager moins, ouvrez une base qui contient moins.

## Ce qui protège quoi

**Par le chiffrement**

- **Le jeton n'ouvre que les bases que vous avez choisies.** Il s'écrit `flr_live_<id>_<secret>`. Du secret, la boîte
  noire tire (HKDF-SHA256) la preuve qu'elle présente à Filarr et une clé privée ; Filarr ne garde que l'empreinte de
  la preuve et la clé publique. Un journal de requêtes volé chez Filarr n'ouvre rien.
- **Une clé par base et par génération.** Chaque clé de base est tirée à sens unique de votre clé racine, pour une base
  et une génération, et scellée pour la clé publique de l'accès. On ne peut en déduire ni votre clé racine, ni la clé de
  la génération suivante, ni celle d'une autre base.
- **La révocation coupe l'avenir.** Révoquer un accès (ou lui retirer une base) fait passer chaque base à une nouvelle
  génération dont la clé n'est jamais scellée pour l'ancien jeton : ce qui s'écrit ensuite lui est illisible, même si
  des blocs chiffrés fuitaient par un autre chemin.
- **Rien n'est accepté au mauvais endroit.** Chaque clé scellée nomme son accès, sa base et sa génération, et la boîte
  noire refuse celle qu'elle trouverait ailleurs. Chaque bloc est vérifié au regard des empreintes de la tête de la base
  avant d'être déchiffré ; un serveur qui remonte le temps est refusé.
- **Les objets signés viennent du créateur, pas d'un serveur.** Les boîtes de dépôt, les définitions de synchro et les
  cibles de migration ne sont acceptées que signées par la clé d'identité du créateur de l'accès, que la boîte noire
  authentifie par une étiquette que seul le jeton permet de calculer. Un serveur qui servirait sa propre clé serait
  refusé : aucun fichier ne serait scellé pour lui, une définition de synchro modifiée ne tournerait pas.
- **Les fichiers sont scellés avant de partir.** La boîte noire chiffre chaque fichier avec une clé neuve, scellée pour
  votre boîte de dépôt ; Filarr garde ce qu'il ne sait pas ouvrir, et n'apprend ni le nom ni le dossier.

**Par la conception de la boîte noire**

- Les lignes déchiffrées vivent **en mémoire seulement**. Sur le disque (répertoire d'état, fichiers en mode 0600 là où
  le système le permet) : le jeton (sauf s'il est donné par l'environnement), les empreintes des clés d'application,
  les secrets des webhooks, l'empreinte du mot de passe de gestion (scrypt), les réglages, les blocs chiffrés tels que
  Filarr les garde (sauf avec `cache = memory`), les clés des bases externes chiffrées sous une clé tirée du jeton,
  l'état chiffré des synchros, et le journal local (chemins, codes, durées ; aucun contenu de ligne, aucun jeton,
  aucune clé).
- **Jamais sur le disque** : une clé de base, une ligne déchiffrée, un corps de webhook (les livraisons en attente
  vivent en mémoire).
- **Jamais sur le réseau** : le jeton ni son secret.
- Vos logiciels ne tiennent jamais le jeton : chaque programme a sa propre clé d'application, gardée en empreinte,
  limitée à ses points d'accès, avec un débit, des adresses autorisées et une échéance.
- La révocation efface la copie, les clés et le cache de blocs d'une boîte noire qui l'apprend.
- L'interface de gestion demande un mot de passe (dix caractères au moins), écoute sur `127.0.0.1` d'office, refuse les
  écritures sans son propre en-tête (une page d'un autre site ne peut pas le forger), et limite les tentatives de mot de
  passe erronées.

**Ce qui n'est pas garanti, dit clairement**

- **Qui fait tourner la boîte noire, ou connaît son mot de passe de gestion, lit les bases ouvertes.** Protégez la
  machine comme vous protégeriez les données.
- **Une boîte noire qui était hors ligne garde sa copie** jusqu'à ce qu'elle se reconnecte et apprenne la révocation,
  ou jusqu'à ce qu'on l'efface sur sa machine.
- **Remplacer un jeton ne change pas les clés** (révoquer, si). Voyez [révoquer](tutorials/revoke.fr.md).
- **Les webhooks portent des lignes en clair** jusqu'à votre récepteur : employez HTTPS, et vérifiez la signature.
- **Les synchros dans les deux sens vers Airtable, Google Sheets et Notion** ne permettent pas d'écrire « seulement si
  la valeur est encore celle que j'ai lue » : la boîte noire relit juste avant d'écrire, et il reste une fenêtre de
  moins d'une seconde où un changement fait dans la source à cet instant pourrait être écrasé (et gardé au journal). D1,
  PostgreSQL, MySQL et Supabase n'ont pas cette fenêtre.
- **« La plus récente l'emporte »** compare les horloges de deux machines, et date la ligne, pas la cellule.
- **La variante Cloudflare** : Cloudflare, en hébergeur de votre Worker, exécute votre code et pourrait techniquement
  atteindre sa mémoire, comme pour n'importe quel Worker.

## Hébergée par Filarr

> Bientôt. Cette section décrit la boîte hébergée telle que la définit le contrat gelé `gate-heberge-1`, pour que vous
> puissiez la juger avant qu'elle ouvre.

Pour les bases que vous lui **confiez**, et tant qu'elles restent confiées, un service de Filarr tient leur clé et fait
tourner la même Filarr Gate. Filarr n'emploiera qu'une expression : une base « confiée à Filarr », une boîte « hébergée
par Filarr ».

### Ce que Filarr peut techniquement voir

| quoi | qui chez Filarr | pourquoi |
|---|---|---|
| toutes les lignes et toutes les colonnes des bases confiées, qu'une vue les montre ou non | le service hébergé | il tient leurs clés et sert l'API depuis sa copie |
| ce qui s'y écrit tant qu'elles restent confiées (par vous, les membres, l'API) | le service hébergé | la génération en cours lui est scellée tant que la base reste confiée |
| les requêtes de vos logiciels et les réponses | le service hébergé | il sert l'API |
| les mêmes requêtes et réponses, **en transit** | le compte Cloudflare qui gère filarr.com, celui de l'API de Filarr, qui héberge aussi le service | l'adresse de la boîte, `<nom>.gate.filarr.com`, est un nom de sa zone : il termine lui-même le TLS |
| la clé d'une base externe branchée sur la boîte, et ses lignes | le service hébergé | la synchro planifiée y tourne |
| les fichiers que reçoit la boîte, au passage | le service hébergé | il les scelle pour votre boîte de dépôt après les avoir reçus |
| des blocs chiffrés, des clés scellées, des compteurs | l'API de Filarr | comme chez vous |
| le jeton, scellé pour le service | l'API de Filarr, **sans pouvoir l'ouvrir** | scellé pour la clé du service, que les applis portent en elles |

Ce qu'il ne peut toujours pas voir : les bases que vous n'avez pas confiées, vos notes, fichiers et coffres ; vos clés
racines (une clé de base en est tirée à sens unique) ; ce qui s'écrit après que vous avez repris la clé (la génération
change, et la nouvelle clé n'est jamais scellée pour le service) ; le dossier où sont rangés vos fichiers reçus (seuls
vos appareils les rangent).

### Ce qui protège, classé par force

| force | protection | sa limite exacte |
|---|---|---|
| chiffrement | une base, pas le compte | la clé confiée ouvre une base, à une génération |
| chiffrement | reprendre la clé coupe l'avenir | ce que le service a lu AVANT n'est couvert que par les engagements |
| chiffrement | le jeton n'est jamais en clair dans la base de données de l'API ni dans ses sauvegardes | cela ne protège PAS du trafic en transit, ni de qui tient la clé privée du service |
| aucune | le trafic d'une boîte hébergée, en transit | le compte qui gère filarr.com peut le voir ; l'accord le dit |
| vérifiable | l'empreinte de code que le service annonce égale celle de la version publiée | **cela vérifie ce que le service ANNONCE ; aucune attestation à distance n'existe sur les Workers : personne ne peut prouver que le code qui tourne est celui-là.** D'où la revue externe, le journal public des mises en service, et l'engagement |
| vérifiable | tout se trace | accord, versions du service, sommeil, reprise, reçu d'effacement, au journal de l'accès |
| vérifiable | cela se voit | quiconque voit une base confiée voit la marque, sur tous les appareils |
| engagement | isolement, aucune journalisation du contenu, copies dans l'UE, aucun autre usage | Cloudflare, l'hébergeur, peut techniquement atteindre la mémoire de ses machines ; une requête traverse le point de présence le plus proche de l'appelant, qui peut être hors de l'UE (seules les COPIES restent dans l'UE) ; qui administre le compte Cloudflare de Filarr pourrait changer le code ou la configuration : l'engagement, la chaîne de mise en service et la revue externe encadrent cela, pas une barrière technique |
| engagement | effacement | un reçu signé prouve que le service a exécuté l'ordre, pas qu'aucune copie n'existe ailleurs |

### L'isolement par script, dans le même compte

Le service est un script Worker à part, dans le même compte Cloudflare que l'API de Filarr, avec ses propres secrets et
ses propres Durable Objects ; le script de l'API n'a aucune liaison vers eux.

- **Ce que cela garantit** : le jeton n'est jamais en clair dans la base de données de l'API, ses sauvegardes, son
  historique ou un export ; une faille ou une compromission du CODE de l'API (un défaut dans une route, une dépendance
  empoisonnée) ne donne ni les secrets du service, ni son stockage, ni un jeton en clair.
- **Ce que cela ne garantit pas** : la protection contre un administrateur du compte, qui pourrait déployer un code qui
  lit les secrets du service, son stockage ou le trafic de la zone ; et la protection contre le trafic en transit,
  visible du compte à tout moment. Une interception par le compte ne laisse aucune trace publique (son certificat est
  légitimement le sien).

### Comment une version entre en service

- Uniquement par la chaîne d'intégration, depuis une **étiquette signée** de ce dépôt public ; aucun déploiement depuis
  un poste de travail.
- Un **journal public** des mises en service : version, étiquette, empreinte du code, date de publication, date de mise
  en service.
- **Sept jours** entre la publication et la mise en service, pour que chacun puisse d'abord lire le code et reconstruire
  son empreinte (la construction est reproductible : voyez [release.fr.md](release.fr.md)).
- **Une exception, le correctif de sécurité** : la correction d'une faille qui met en jeu les bases confiées, leurs
  clés, les jetons ou l'isolement, décrite dans un avis de sécurité de ce dépôt, publiée par une étiquette
  `vX.Y.Z-security` signée par une clé du rôle `security` et qui nomme l'avis. Le journal dit alors « correctif de
  sécurité, délai de sept jours levé », avec l'avis et sa gravité ; chaque accès hébergé reçoit l'événement ; le détail
  de la faille est publié dans les 30 jours. Tout le reste attend sept jours.

### Le droit

Les copies restent dans l'Union européenne (Durable Objects dans la juridiction UE) ; les requêtes et les réponses
traversent, en transit, le point de présence le plus proche de l'appelant. Filarr devient votre sous-traitant pour les
bases confiées : un accord de traitement des données accompagne l'option, avec Cloudflare comme sous-traitant
ultérieur.

### Comparée à une boîte noire chez vous

| | chez vous | hébergée |
|---|---|---|
| Filarr lit les bases ouvertes | non | oui, tant qu'elles sont confiées |
| le trafic de vos logiciels vu par Filarr | non | oui, en transit |
| clés des bases externes | dans votre boîte noire | tenues par Filarr |
| quelque chose à installer et à garder en marche | oui | non |
| synchros PostgreSQL et MySQL | oui | non (connecteurs HTTPS seulement) |

### Le texte de l'accord

Voici, mot pour mot, ce que vous acceptez en confiant des bases (version `hebergement-v1`). `{{box}}` y devient le nom
de la boîte. La mise en forme (titre, puces, case à cocher) peut varier d'une appli à l'autre ; les mots, non : chaque
appli Filarr est vérifiée au regard de l'empreinte SHA-256 de ce texte, fixée par le contrat, et cette page aussi (`npm
test`). Si le texte change, Filarr vous redemande votre accord ; sans nouvel accord au bout de 30 jours, la base est
retirée de la boîte.

<!-- consent: hebergement-v1 fr -->
```text
Confier ces bases à la boîte noire hébergée par Filarr ?
Jusqu'ici, Filarr ne pouvait pas lire ces bases : seuls vos appareils en avaient la clé.
Si vous les confiez à la boîte noire « {{box}} », hébergée par Filarr :
la clé de chaque base cochée sera remise à un service de Filarr, isolé, qui la déchiffre pour répondre à vos logiciels ;
Filarr pourra donc techniquement lire toutes leurs lignes et toutes leurs colonnes, y compris celles qu'aucune vue ne montre, ainsi que tout ce qui s'y écrira tant qu'elles restent confiées ;
cela vaut aussi en transit : l'adresse de la boîte est un nom de filarr.com, et le compte de Filarr qui gère ce nom, celui qui sert aussi l'API de Filarr, peut techniquement voir les appels de vos logiciels et les réponses ;
si vous y branchez une base externe, Filarr tiendra aussi sa clé et verra ses lignes ; si la boîte reçoit des fichiers, Filarr les verra au passage ;
vos autres bases, vos notes, vos fichiers et vos coffres resteront illisibles pour Filarr.
Filarr s'engage à ne pas journaliser ce contenu, à ne l'utiliser que pour servir votre API, à en garder les copies dans l'Union européenne et à effacer la clé et la copie quand vous la reprenez. Ce sont des engagements, pas une protection par le chiffrement.
Vous pouvez reprendre la clé à tout moment. Les clés de ces bases changent alors : la boîte hébergée ne pourra plus rien lire de ce qui s'écrira ensuite. Ce qu'elle a lu avant reste couvert par les seuls engagements ci-dessus.
J'ai compris que Filarr pourra lire les bases cochées tant qu'elles lui sont confiées.
```

## Signaler une faille

En privé, par « Report a vulnerability » de GitHub (l'onglet Security de ce dépôt) : voyez
[SECURITY.md](../SECURITY.md) (en anglais). Jamais dans une issue publique.
