# Ouvrir une base à une API

[Read in English](open-a-database.md)

**À la fin**, vous aurez dans Filarr un **accès** qui ouvre une ou plusieurs bases à vos logiciels, son **jeton** mis
de côté, et la boîte noire qui montre ces bases à des adresses stables comme `/v1/clients` et
`/v1/clients/clients-actifs`.

Cette partie se passe dans l'appli Filarr (bureau ou web). L'aide de Filarr décrit les mêmes écrans du côté de
l'appli : <https://filarr.com/docs/api-access>.

**Palier :** tous les paliers peuvent ouvrir une base à une API. Le palier fixe combien d'accès vous pouvez avoir,
combien de bases un accès ouvre, si l'écriture et les changements en direct sont compris (à partir de Solo) et si vous
pouvez limiter les adresses qui synchronisent (à partir de Pro). Filarr affiche vos limites sur le formulaire même, et
dans **Paramètres › Accès API**.

## Ce qu'est un accès

Un accès est une clé qui n'ouvre **que les bases que vous choisissez**, jamais votre compte, vos notes ni vos fichiers.
Vous le créez dans Filarr ; Filarr montre son jeton une seule fois et n'en garde qu'une empreinte. La boîte noire, que
vous faites tourner, tient le jeton : elle télécharge les blocs chiffrés de ces bases, les déchiffre avec des clés
tirées du jeton, et sert vos logiciels. Filarr continue de ne voir que des blocs chiffrés.

Chaque base garde sa propre clé : retirer une base d'un accès change la clé de cette base sans toucher aux autres.

## Avant de commencer

- Un compte Filarr connecté sur ce profil, l'appli déverrouillée.
- Une base dans une note. Vous devez en être le propriétaire ; pour une base de coffre, le propriétaire ou un
  administrateur du coffre.
- Toutes les bases ne s'ouvrent pas : une base adossée à un dossier (ses lignes sont des fichiers) ou rangée dans votre
  propre stockage (BYOS), non. Ouvrir une petite base la fait d'abord passer au stockage des grandes bases de Filarr,
  quel que soit son poids ; cela ne change rien pour vous.

## 1. Ouvrir le formulaire

Sur la base, cliquez sur **···** puis **Ouvrir à une API…**.

L'entrée est grisée, avec la raison, quand la note est en lecture seule, quand aucun compte n'est connecté, quand les
grandes bases sont coupées sur cet appareil, ou quand vous n'êtes pas propriétaire ou administrateur du coffre.

## 2. Le remplir

- **Nom de l'accès** : qui s'en servira (« ERP Atelier », « Site »). Il nomme la boîte noire dans Filarr et dans ses
  journaux.
- **Bases ouvertes** : la base d'où vous partez est cochée ; cochez-en d'autres pour les ouvrir avec le même jeton.
  Pour chacune, choisissez **Lecture** ou **Lecture et écriture**. (L'écriture demande aussi un palier qui comprend
  l'écriture par l'API ; sinon, le choix dit « pas dans votre palier ».)
- **Les slugs** : le nom de chaque base et de chaque vue dans l'API de la boîte noire, proposé d'après leur titre
  (minuscules, sans accents, des tirets) : `clients`, `clients-actifs`. **Ils ne se choisissent que maintenant.**
  Ensuite ils ne changent plus, même si vous renommez la base ou une vue dans Filarr : vos intégrations ne cassent pas.
  Une vue créée plus tard reçoit son slug quand elle est publiée.
- **Des bases liées restent fermées** : si une base a une relation vers une base que vous n'avez pas cochée, le
  formulaire la nomme. La boîte noire ne lit jamais une base qu'on ne lui a pas ouverte : ces relations rendront des
  identifiants de lignes bruts, et leurs agrégats seront vides. **L'ouvrir aussi** l'ajoute.
- **Expire** : dans 6 mois, dans 1 an, ou jamais. À l'échéance, Filarr refuse le jeton et la boîte noire efface sa
  copie.
- **Adresses autorisées à synchroniser** (à partir de Pro) : Filarr refuse le jeton depuis toute autre adresse IP.
  Écrivez des adresses ou des plages séparées par des virgules (`203.0.113.7, 10.0.4.0/24`) : l'adresse publique de la
  machine où tourne la boîte noire.

Le haut du formulaire montre votre palier et combien d'accès sont ouverts. Cliquez sur **Créer l'accès**.

## 3. Mettre le jeton de côté

Filarr montre le jeton **une seule fois** :

```text
flr_live_7Qm2kT…  (75 caractères)
```

Copiez-le là où la boîte noire le lira : votre gestionnaire de mots de passe, un secret de votre serveur ou de votre
compte Cloudflare. Filarr n'en garde qu'une empreinte : un jeton perdu ne peut pas être remontré, seulement remplacé.
Qui le détient lit les bases qu'il ouvre : traitez-le comme un mot de passe.

L'écran propose quatre façons de faire tourner la boîte noire (sur ce poste, Docker, dans votre code, Cloudflare).
Suivez le tutoriel qui correspond : [votre ordinateur](install-local.fr.md), [un serveur avec Docker](install-docker.fr.md),
[votre compte Cloudflare](install-cloudflare.fr.md), ou [la bibliothèque dans votre code](library.fr.md). Cliquez
ensuite sur **J'ai mis le jeton de côté**.

Si d'anciens blocs de la base utilisent une clé que cet appareil ne détient plus, l'écran prévient que la boîte noire
les signalera « clé manquante » jusqu'à ce qu'un appareil qui la détient ouvre Filarr.

## 4. Le donner à la boîte noire

```sh
filarr-gate init --token flr_live_…
filarr-gate
```

ou `FILARR_GATE_TOKEN=flr_live_…`, ou l'écran de mise en route de l'interface de gestion. Dès sa première synchro, la
boîte noire apparaît dans Filarr sous **Paramètres › Accès API**, avec sa version, son adresse et sa dernière visite.

## Vérifier que ça marche

Dans l'interface de la boîte noire, **Bases** liste chaque base avec son adresse, ses vues, ses champs et les clés
autorisées à la lire. Ou bien :

```sh
curl -s http://127.0.0.1:8443/openapi.json | head -c 400
```

`/openapi.json` est la description exacte de ce que sert cette boîte noire : chaque base, chaque champ avec son type,
chaque vue, prête pour Postman, n8n, Make ou un générateur de client.

## Ce que voit Filarr, ce que voit la boîte noire

- **Filarr** voit l'accès, l'empreinte de sa preuve, des clés scellées et des vues qu'il ne peut pas ouvrir, des
  compteurs, l'adresse IP et la version de la boîte noire. Jamais le jeton, une clé ni une ligne.
- **La boîte noire** voit toutes les lignes et toutes les colonnes des bases que vous avez ouvertes, pas seulement ce
  que montrent les vues. **Une vue est un confort, pas une frontière** : pour partager moins, ouvrez une base qui
  contient moins.
- Plus de détails : [sécurité et confiance](../security-and-trust.fr.md).

## Et ensuite

- [Créer des clés pour vos logiciels et appeler l'API](first-calls.fr.md).
- Gérer l'accès (le mettre en pause, remplacer le jeton, retirer une base, le révoquer) :
  [révoquer et réagir à une fuite](revoke.fr.md).

## Si ça ne marche pas

- « Pas encore disponible » : les accès API ne sont pas encore ouverts pour votre compte.
- « Seul le propriétaire ou un administrateur du coffre peut ouvrir ses bases » : demandez au propriétaire du coffre.
- La boîte noire dit `key_missing` pour une base : certains blocs utilisent une clé que cet appareil ne détenait pas ;
  ouvrez Filarr sur un appareil qui la détient, déverrouillé, et les clés sont rescellées.
- Plus de cas : [dépannage](../troubleshooting.fr.md).
