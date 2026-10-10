# Sécurité et confiance : qui voit quoi

[Read in English](security-and-trust.md)

Filarr chiffre vos notes et vos bases de bout en bout : ses serveurs gardent des blocs qu'ils ne savent pas lire. Pour
servir une base sous forme d'API, quelque chose doit la déchiffrer. Cette page dit exactement ce qui la déchiffre dans
chaque mode, qui peut donc lire quoi, et ce qui est garanti par le chiffrement, ce qui se vérifie, et ce qui ne repose
que sur des engagements. Là où une limite existe, elle est écrite ici.

## Les trois modes

| | où tourne la boîte noire | qui tient le jeton | bases ouvertes déchiffrées par les serveurs de Filarr ? |
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

Pour les bases que vous lui **confiez**, et tant qu'elles restent confiées, un service de Filarr gère leur clé et fait
tourner la même Filarr Gate : ces bases ne sont plus chiffrées de bout en bout. Filarr n'emploiera qu'une expression :
une base « confiée à Filarr », une boîte « hébergée par Filarr ».

### Ce qui n'est plus chiffré de bout en bout

| quoi | déchiffré par | pourquoi |
|---|---|---|
| toutes les lignes et toutes les colonnes des bases confiées, qu'une vue les montre ou non | le service hébergé | il gère leurs clés et sert l'API depuis sa copie |
| ce qui s'y écrit tant qu'elles restent confiées (par vous, les membres, l'API) | le service hébergé | la génération en cours lui est scellée tant que la base reste confiée |
| les requêtes de vos logiciels et les réponses | le service hébergé | il sert l'API |
| les mêmes requêtes et réponses, **en transit** | le compte Cloudflare qui gère filarr.com, celui de l'API de Filarr, qui héberge aussi le service | l'adresse de la boîte, `<nom>.gate.filarr.com`, est un nom de sa zone : il termine lui-même le TLS |
| la clé d'une base externe branchée sur la boîte, et ses lignes | le service hébergé | la synchro planifiée y tourne |
| les fichiers que reçoit la boîte, au passage | le service hébergé | il les scelle pour votre boîte de dépôt après les avoir reçus |

L'API de Filarr, elle, ne traite comme chez vous que des blocs chiffrés, des clés scellées et des compteurs, et le
jeton scellé pour le service, qu'elle ne sait pas ouvrir (il est scellé pour la clé du service, que les applis portent
en elles).

Ce qui n'est pas concerné : les bases que vous n'avez pas confiées, vos notes, fichiers et coffres ; vos clés racines
(une clé de base en est tirée à sens unique) ; ce qui s'écrit après que vous avez repris la clé (la génération change,
la nouvelle clé n'est jamais scellée pour le service, et ces bases redeviennent chiffrées de bout en bout) ; le dossier
où sont rangés vos fichiers reçus (seuls vos appareils les rangent).

### Ce qui protège, classé par force

| force | protection | sa limite exacte |
|---|---|---|
| chiffrement | une base, pas le compte | la clé confiée ouvre une base, à une génération |
| chiffrement | reprendre la clé coupe l'avenir | ce que le service a traité AVANT n'est couvert que par les engagements |
| chiffrement | le jeton n'est jamais en clair dans la base de données de l'API ni dans ses sauvegardes | cela ne couvre pas le trafic en transit, ni le service lui-même, qui détient sa clé privée |
| aucune | le trafic d'une boîte hébergée, en transit | il n'est pas chiffré de bout en bout : le compte qui gère filarr.com termine le TLS et le déchiffre ; l'accord le dit |
| vérifiable | l'empreinte de code que le service annonce égale celle de la version publiée | cela vérifie ce que le service annonce ; les Workers n'offrent pas d'attestation à distance, cela ne prouve donc pas que le code qui tourne est celui-là. D'où la revue externe, le journal public des mises en service, et l'engagement |
| vérifiable | tout se trace | accord, versions du service, sommeil, reprise, reçu d'effacement, au journal de l'accès |
| vérifiable | cela se voit | quiconque voit une base confiée voit la marque, sur tous les appareils |
| engagement | isolement, aucune journalisation du contenu, copies dans l'UE, aucun autre usage | ce sont des engagements, pas une protection par le chiffrement : Cloudflare, l'hébergeur, fait tourner les machines où le service déchiffre les données ; une requête traverse le point de présence le plus proche de l'appelant, qui peut être hors de l'UE (seules les COPIES restent dans l'UE) ; le code et la configuration sont mis en service depuis le compte Cloudflare de Filarr : l'engagement, la chaîne de mise en service et la revue externe encadrent cela, pas une barrière technique |
| engagement | effacement | un reçu signé prouve que le service a exécuté l'ordre, pas qu'aucune copie n'existe ailleurs |

### L'isolement par script, dans le même compte

Le service est un script Worker à part, dans le même compte Cloudflare que l'API de Filarr, avec ses propres secrets et
ses propres Durable Objects ; le script de l'API n'a aucune liaison vers eux.

- **Ce que cela garantit** : le jeton n'est jamais en clair dans la base de données de l'API, ses sauvegardes, son
  historique ou un export ; une faille ou une compromission du CODE de l'API (un défaut dans une route, une dépendance
  empoisonnée) ne donne ni les secrets du service, ni son stockage, ni un jeton en clair.
- **Ce que cela ne couvre pas** : la mise en service elle-même, puisque le code du service et la configuration de la
  zone sont déployés depuis ce compte (c'est la chaîne de mise en service ci-dessous qui l'encadre, pas l'isolement) ;
  et le trafic en transit, que le compte déchiffre en terminant le TLS de la zone. Son certificat est légitimement le
  sien, cela ne se voit donc pas de l'extérieur : l'engagement et la chaîne de mise en service l'encadrent.

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
| les bases ouvertes restent chiffrées de bout en bout | oui | non, tant qu'elles sont confiées |
| le trafic de vos logiciels déchiffré par les serveurs de Filarr | non | oui, en transit |
| clés des bases externes | dans votre boîte noire | gérées par les serveurs de Filarr |
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
Aujourd'hui, ces bases sont chiffrées de bout en bout : seuls vos appareils en ont la clé.
Si vous les confiez à la boîte noire « {{box}} », hébergée par Filarr :
la clé de chaque base cochée sera gérée par un service isolé de Filarr, qui la déchiffre pour répondre à vos logiciels ;
tant qu'elles restent confiées, ces bases ne sont donc plus chiffrées de bout en bout : leurs lignes et leurs colonnes, y compris celles qu'aucune vue ne montre, et tout ce qui s'y écrira, sont déchiffrées par nos serveurs ;
les appels de vos logiciels et les réponses ne sont pas non plus chiffrés de bout en bout : ils passent par une adresse filarr.com, gérée par le même compte que l'API de Filarr ;
si vous y branchez une base externe, sa clé sera aussi gérée par nos serveurs ; les fichiers que reçoit la boîte passent eux aussi par nos serveurs sans chiffrement de bout en bout ;
vos autres bases, vos notes, vos fichiers et vos coffres ne sont pas concernés.
Filarr s'engage à ne pas journaliser ce contenu, à ne l'utiliser que pour servir votre API, à en garder les copies dans l'Union européenne et à effacer la clé et la copie quand vous la reprenez. Ce sont des engagements de Filarr, et non une protection par le chiffrement de bout en bout.
Vous pouvez reprendre la clé à tout moment. Les clés de ces bases changent alors, et ce qui s'écrira ensuite est de nouveau chiffré de bout en bout. Ce que la boîte a traité avant reste couvert par les engagements ci-dessus.
J'ai compris que les bases cochées ne seront plus chiffrées de bout en bout tant qu'elles sont confiées à Filarr.
```

## Signaler une faille

En privé, par « Report a vulnerability » de GitHub (l'onglet Security de ce dépôt) : voyez
[SECURITY.md](../SECURITY.md) (en anglais). Jamais dans une issue publique.
