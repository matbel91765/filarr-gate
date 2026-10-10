# Révoquer un accès, et réagir à une fuite

[Read in English](revoke.md)

**À la fin**, vous saurez lequel des cinq gestes employer (révoquer une clé d'application, mettre en pause, remplacer
le jeton, retirer une base, révoquer l'accès), ce que protège chacun, ce que garde une boîte noire qui était hors ligne,
et comment vérifier dans les journaux que cela a marché.

**Palier :** tous les paliers.

## Deux sortes de clés, deux endroits

| | où elle vit | qui la révoque | ce qu'elle protège |
|---|---|---|---|
| une **clé d'application** `gk_…` | la boîte noire (une par programme) | l'administrateur de la boîte noire, tout de suite | l'API de la boîte noire : ce qu'un programme peut appeler |
| le **jeton** `flr_live_…` | la boîte noire seulement (Filarr en garde une empreinte) | vous, dans Filarr | les bases elles-mêmes |

## La clé d'application d'un programme a fuité

Révoquez-la sur la boîte noire ; elle cesse de répondre à la requête suivante. Le jeton, les autres clés et Filarr ne
sont pas touchés.

```sh
filarr-gate keys list
filarr-gate keys revoke gk_erp_3k        # son identifiant, ou le début de son préfixe
filarr-gate keys create --name ERP       # une nouvelle, affichée une fois
```

(ou **Clés des applications › Révoquer** dans l'interface de gestion). Une clé avec une échéance (`--days 90`, ou
« Expire » dans l'interface) et des adresses autorisées limite d'emblée les dégâts que peut faire une fuite.

## Les gestes sur le jeton, dans Filarr

Tous dans **Paramètres › Accès API**, sur l'accès :

| geste | ce qui se passe tout de suite | ce qu'il protège |
|---|---|---|
| **Mettre en pause** | Filarr refuse le jeton ; la boîte noire garde sa copie, continue de la servir, et reprend quand vous cliquez sur **Rouvrir** | une pause, le temps de vérifier quelque chose |
| **Remplacer le jeton** | un nouveau jeton, montré une fois ; l'ancien est refusé tout de suite ; la boîte noire efface sa copie et ses clés (`revoked`, « Jeton remplacé dans Filarr : collez le nouveau jeton ») | un jeton auquel vous ne faites plus confiance, pour un accès que vous gardez |
| **Retirer** une base | cette base quitte l'accès ; **ses clés changent** (génération suivante) ; les autres bases ne sont pas touchées | une base qu'on ne partage plus |
| **Révoquer** | le jeton est refusé tout de suite ; la boîte noire efface sa copie ; **les clés de toutes les bases de l'accès changent** | un jeton qui a fuité, une machine à laquelle vous ne faites plus confiance |

Pourquoi « les clés changent » compte : la clé d'une base est tirée pour une **génération**. Le jeton détenait les
clés de la génération en cours. Après une révocation (ou un retrait), l'appli Filarr fait passer la base à la
génération suivante et ne rescelle les nouvelles clés que pour les autres accès : ce qui s'écrit ensuite est illisible
avec l'ancien jeton, même si quelqu'un s'est procuré les blocs chiffrés par un autre chemin. **Remplacer le jeton ne
change pas les clés** : le serveur refuse l'ancien jeton, mais les clés qu'il détenait restent valides pour ce qui est
déjà écrit et pour ce qui viendra. Si le jeton a fuité, révoquez, et créez un nouvel accès.

Quand les clés changent, c'est l'appareil qui a fait le geste qui fait le travail : il lui faut le coffre ouvert et le
serveur joignable. Sinon, Filarr dit « Les clés de ces bases changeront dès que leur coffre sera ouvert et le serveur
joignable. », et un de vos appareils s'en charge à sa prochaine ouverture.

## Ce que garde une boîte noire

- **Une boîte noire en ligne** s'arrête en moins d'une seconde (le flux en direct le lui dit), efface de la mémoire les
  clés et les lignes déchiffrées, et supprime son cache de blocs chiffrés.
- **Une boîte noire qui était hors ligne** l'apprend à son prochain contact avec Filarr et fait de même. D'ici là, elle
  ne peut servir que la copie qu'elle avait déjà : **ce qu'elle a déjà copié reste sur sa machine** jusqu'à ce qu'elle
  se reconnecte ou qu'on l'efface. Si la machine n'est plus digne de confiance, effacez-la sur place :
  **Réglages › Oublier cette machine** dans l'interface de gestion (copie, clés dérivées, jeton, clés d'application,
  webhooks, journal), ou supprimez le répertoire d'état.
- **Vos clés d'application et vos webhooks survivent à un remplacement de jeton** sur une boîte noire que vous gardez :
  donnez-lui le nouveau jeton (**Réglages › Remplacer le jeton** dans son interface, ou `FILARR_GATE_TOKEN` et un
  redémarrage) et ils remarchent. Les clés des bases externes sont chiffrées sous une clé tirée du jeton : donnez-les de
  nouveau.

## Remplacer un jeton sans longue coupure

1. Dans Filarr, **Remplacer le jeton** ; copiez le nouveau.
2. Aussitôt, sur la boîte noire : **Réglages › Remplacer le jeton** dans son interface (ou mettez à jour
   `FILARR_GATE_TOKEN` et redémarrez ; sur Cloudflare, `npx wrangler secret put FILARR_GATE_TOKEN`).
3. La boîte noire retélécharge la copie (son cache chiffré a été supprimé) ; vos logiciels reçoivent des `503` pendant
   ces quelques secondes.

## Vérifier que cela a marché

- Dans Filarr, le journal de l'accès (« Ce que Filarr a vu ») montre « révoqué » ou « jeton remplacé », puis
  « clés changées · <base> (génération g) » pour chaque base, et chaque présentation ultérieure de l'ancien jeton comme
  « jeton refusé ».
- Sur la boîte noire, `filarr-gate doctor` montre la liaison `revoked` ; `/health` répond `"link":"revoked"` ; l'écran
  **Journal** montre quand elle a effacé.

```sh
curl -s http://127.0.0.1:8443/health
```

```json
{"status":"degraded","link":"revoked","version":"…","bases":[]}
```

## La machine elle-même a été compromise

Révoquez l'accès dans Filarr (les clés changent), puis créez un nouvel accès pour une machine saine. Changez, à leur
source, tout ce que tenait l'ancienne boîte noire : les clés des bases externes (jeton D1, mot de passe PostgreSQL…),
les secrets des webhooks (vos récepteurs doivent cesser de faire confiance aux anciens), et les clés d'application
(créez-en de nouvelles ; les empreintes des anciennes étaient sur cette machine).

## Et ensuite

- [Sécurité et confiance](../security-and-trust.fr.md) : ce que voit chacun, et ce que la révocation garantit
  exactement.
