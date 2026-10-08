// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/types.ts @ e3502763 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Inline Database — Filarr Notes
 *
 * Contrat de données partagé du bloc base de données inline.
 * Modèle auto-contenu façon Notion v1 : schéma + lignes sérialisés
 * en JSON dans les attrs du nœud TipTap (précédent : calendarBlock).
 */

import i18n from './shims/i18nConfig';
// Module PUR, sans import du dossier : aucun cycle possible
import { formatDisplayDate, resolveLocale } from './cellFormats';
// Type SEUL (effacé à la compilation) : aucun cycle d'imports à l'exécution
import type { DbLinkContext } from './relations';

import * as profileStorage from './shims/profileStorage';
import { cachedSecret } from './shims/keychainCache';
// Le cœur pur (sans i18n ni stockage) vit dans `dbCore` ; réexporté ici pour les appelants
import {
  defaultCells,
  layoutLabel,
  makeNamedView,
  makeRow,
  newId,
  nextOptionColor,
  relationIds,
  serializeDbData,
  type Translate,
} from './dbCore';
export { defaultCells, makeNamedView, newId, nextOptionColor, relationIds, serializeDbData };
// La base par défaut du panneau de création : module pur commun (contrat `inline-database-create`)
import { defaultDbData } from './dbCreationModel';
import { isCalculation } from './columnCalculations';
import type { DbCalculation } from './columnCalculations';
export type PropertyType =
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'checkbox'
  | 'date'
  | 'url'
  | 'email'
  | 'phone'
  | 'rating'
  | 'progress'
  | 'note'
  | 'createdTime'
  | 'updatedTime'
  | 'relation'
  | 'rollup'
  | 'formula'
  | 'person'
  | 'vaultFile';

const VALID_TYPES: readonly PropertyType[] = [
  'text',
  'number',
  'select',
  'multiSelect',
  'checkbox',
  'date',
  'url',
  'email',
  'phone',
  'rating',
  'progress',
  'note',
  'vaultFile',
  'createdTime',
  'updatedTime',
  'relation',
  'rollup',
  'formula',
  'person',
];

/** Agrégats d'une propriété rollup — calculés à l'affichage, jamais stockés */
export type DbAggregate =
  | 'count'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'checked'
  | 'percentChecked'
  | 'notEmpty'
  | 'list';

export const DB_AGGREGATES: readonly DbAggregate[] = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'checked',
  'percentChecked',
  'notEmpty',
  'list',
];

/** Le seul agrégat qui ne vise aucune propriété de la base cible */
export function aggregateNeedsTarget(aggregate: DbAggregate): boolean {
  return aggregate !== 'count';
}

/**
 * SENS d'une propriété relation. `out` (défaut, jamais écrit) : les liens sont
 * choisis à la main et stockés dans la cellule. `in` : RÉTROLIENS — la colonne
 * ne stocke rien et liste les lignes d'en face qui pointent ici (cf. l'en-tête
 * de `relations.ts` pour le pourquoi de ce choix).
 */
export type DbRelationDirection = 'out' | 'in';

export interface DbSelectOption {
  id: string;
  label: string;
  /** Nom d'une couleur de DB_OPTION_COLORS (résolue en token via optionColorValue) */
  color: string;
  /**
   * Force de l'aplat (voir `DbOptionIntensity`). ABSENT = `medium`, l'intensité
   * qu'avaient toutes les options avant que ce champ existe : une base écrite
   * par un client qui l'ignore garde exactement son allure.
   *
   * Le champ est CONSERVÉ TEL QUEL à la relecture, même si sa valeur est
   * inconnue. Un client plus ancien qui le validerait pour le jeter effacerait à
   * chaque aller-retour le choix fait sur un autre appareil — la divergence
   * silencieuse habituelle. C'est le RENDU qui retombe sur `medium`, pas le
   * stockage.
   */
  intensity?: DbOptionIntensity;
}

/**
 * CE QU'UNE CELLULE « FICHIER DU COFFRE » RANGE.
 *
 * Trois champs, et chacun a une raison d'etre :
 *
 *  · `fileId` — l'identite. C'est lui qui suit le fichier quand on le renomme.
 *  · `folderId` — sans lui on ne sait pas RELIRE le fichier : la lecture
 *    dechiffree se fait par (dossier, nom), pas par identifiant seul.
 *  · `name` — l'affichage. La table doit se peindre SANS toucher au coffre :
 *    une ligne ne peut pas attendre un dechiffrement pour montrer son texte.
 *    C'est une copie, donc elle peut vieillir — la vue prefere le nom courant
 *    quand l'index le connait, et retombe sur celle-ci sinon (fichier efface,
 *    dossier pas encore charge).
 *
 * Aucun contenu, aucune empreinte : la cellule DESIGNE un fichier, elle n'en
 * garde pas de copie. C'est toute la difference avec une piece jointe.
 */
export interface DbVaultFileRef {
  fileId: string;
  folderId: string;
  name: string;
}

/**
 * Lecture DOUCE d'une cellule « fichier du coffre ».
 *
 * Meme regle que le reste du module : une valeur d'une forme inattendue est
 * VIDE, jamais une exception. Une base ecrite par un client plus recent peut
 * poser des champs qu'on ignore — on ne lit que les trois qu'on connait, et on
 * n'exige pas que les autres n'existent pas.
 */
export function vaultFileRef(value: unknown): DbVaultFileRef | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.fileId !== 'string' || v.fileId === '') return null;
  if (typeof v.folderId !== 'string' || v.folderId === '') return null;
  return { fileId: v.fileId, folderId: v.folderId, name: typeof v.name === 'string' ? v.name : '' };
}

export interface DbProperty {
  id: string;
  name: string;
  type: PropertyType;
  /**
   * ⚠ LE TYPE ÉCRIT PAR UN CLIENT PLUS RÉCENT, MIS DE CÔTÉ POUR LUI ÊTRE RENDU.
   *
   * La relecture remplaçait un type inconnu par « text ». Elle ne se contentait
   * pas de mal afficher la colonne : elle la RÉÉCRIVAIT en texte et la
   * republiait, détruisant sa configuration pour tout le monde — y compris pour
   * l'appareil qui la connaissait. Une seule ouverture sur un client en retard
   * suffisait.
   *
   * Le remède est une affaire de SÉRIALISATION, pas d'application : l'interface
   * continue de voir « text » et se peint sans rien savoir, tandis que
   * `serializeDbData` remet la valeur d'origine dans `type` au moment d'écrire.
   * Le champ ne sort donc JAMAIS dans le document — il n'existe qu'en mémoire.
   *
   * Corollaire à ne pas oublier : quand quelqu'un CHOISIT un type dans
   * l'interface, cette mémoire doit être effacée, sinon son choix serait défait
   * à l'écriture suivante.
   */
  unknownType?: string;
  options?: DbSelectOption[];
  /**
   * select/multiSelect uniquement : option posée d'office sur toute nouvelle
   * ligne (multiSelect → seule dans le tableau). Un seul défaut par propriété.
   * Toléré au parse même s'il ne pointe sur rien : c'est l'application qui vérifie.
   */
  defaultOptionId?: string;
  /**
   * relation uniquement : identité (`dbId`) de la base visée — la base SOURCE
   * quand la relation est un rétrolien. Conservée telle quelle même quand la
   * base est introuvable — une note pas encore chargée n'est pas une base
   * supprimée, et effacer la cible perdrait le lien.
   */
  targetDbId?: string;
  /** relation : sens de lecture (absent = `out`, le sens historique) */
  direction?: DbRelationDirection;
  /**
   * relation `in` : propriété relation de la base SOURCE dont on lit l'envers.
   * Champ distinct de `viaPropertyId` (qui désigne une propriété de CETTE base
   * et que `sanitizeSchema` efface hors des agrégats) : les deux ne vivent pas
   * dans le même monde et les confondre viderait la colonne à chaque commit.
   */
  sourcePropertyId?: string;
  /**
   * relation `out` : un seul lien à la fois — le choix suivant REMPLACE le
   * précédent au lieu de s'y ajouter. N'efface jamais rien tout seul : une
   * cellule qui portait déjà plusieurs liens les garde (cf. `trimToSingleLinks`).
   */
  single?: boolean;
  /** rollup : propriété relation de CETTE base par laquelle passer */
  viaPropertyId?: string;
  /** rollup : propriété à agréger DANS la base visée par la relation */
  targetPropertyId?: string;
  /** rollup : opération d'agrégation (défaut `count` si absente) */
  aggregate?: DbAggregate;
  /**
   * formula : l'expression, telle que l'utilisateur l'a écrite.
   *
   * La VALEUR, elle, n'est jamais stockée dans les cellules : elle est dérivée
   * à l'affichage. Une valeur figée survivrait au changement de la formule et
   * afficherait un chiffre périmé que rien ne signale.
   */
  formula?: string;
  /**
   * number : format d'AFFICHAGE (contrat `inline-database-number-format.md`).
   * La cellule reste un nombre ; seul le rendu change (« 12,50 € », « 40 % »).
   *
   * Typé `string` et non `DbNumberFormat` : une valeur inconnue, écrite par un
   * client plus récent, est CONSERVÉE telle quelle — c'est le rendu qui retombe
   * sur le nombre simple (`knownNumberFormat`), jamais le stockage qui la jette.
   */
  numberFormat?: string;
  /**
   * date : date posée d'office (contrat `inline-database-auto-date.md`). Le jour
   * local quand la Sélection `propertyId` PREND une des `optionIds` par un geste,
   * si la date est vide ; effacée quand elle les QUITTE. Jamais à l'import ni à
   * la synchronisation (cf. `autoDate.ts`).
   */
  autoDate?: DbAutoDate;
}

/** Règle d'une date posée d'office (cf. `DbProperty.autoDate`). */
export interface DbAutoDate {
  /** La colonne qui déclenche : une Sélection de la même base */
  propertyId: string;
  /** Les options de cette colonne qui posent la date */
  optionIds: string[];
}

/**
 * Relit une règle de date posée d'office en RECOPIANT l'objet puis en corrigeant
 * ses deux clés : une sous-clé ajoutée par un client plus récent traverse
 * (contrat, § 4). Sans déclencheur lisible, la règle tombe.
 */
export function parseAutoDate(raw: unknown): DbAutoDate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (typeof source.propertyId !== 'string' || source.propertyId === '') return undefined;
  const optionIds = Array.isArray(source.optionIds)
    ? source.optionIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  return { ...source, propertyId: source.propertyId, optionIds } as DbAutoDate;
}

/**
 * Couleur d'une option NOUVELLE : la première teinte vive que la colonne n'a
 * pas encore. Le tourniquet sur `DB_OPTION_COLORS` commençait par gris puis
 * brun — deux teintes qui se lisent « désactivé » ou « vide » — alors que les
 * bases d'office naissent en gris, bleu, vert.
 */
/** Formats d'affichage d'une colonne nombre (absent = nombre simple). */
export type DbNumberFormat = 'euro' | 'dollar' | 'pound' | 'percent';

export const DB_NUMBER_FORMATS: readonly DbNumberFormat[] = ['euro', 'dollar', 'pound', 'percent'];

/** Le format connu d'une colonne, ou `null` (absent, ou écrit par un client plus récent). */
export function knownNumberFormat(value: unknown): DbNumberFormat | null {
  return typeof value === 'string' && (DB_NUMBER_FORMATS as readonly string[]).includes(value)
    ? (value as DbNumberFormat)
    : null;
}

export interface DbRow {
  id: string;
  /**
   * Clé = property id. text/url/email/phone→string, number→number,
   * checkbox→boolean, date→'YYYY-MM-DD', select→optionId,
   * multiSelect→optionId[], rating→0-5, progress→0-100, note→noteId,
   * relation→identifiants de LIGNES de la base visée (string[]).
   * rollup : AUCUNE entrée — la valeur est calculée à l'affichage.
   */
  cells: Record<string, unknown>;
  /** ISO — posé à la création de la ligne (types createdTime) */
  createdAt?: string;
  /** ISO — posé à chaque modification des cells (types updatedTime) */
  updatedAt?: string;
  /**
   * SOUS-ELEMENT : identifiant de la ligne parente.
   *
   * Un parent absent (filtre, supprime, cycle) ne fait jamais disparaitre
   * l'enfant : il remonte a la racine — voir `rowTree.ts`.
   */
  parentId?: string;
  /**
   * LA LIGNE EST UNE PAGE : identifiant de la note ordinaire qui lui sert de
   * corps (contrat gelé 2026-09-19, `inline-database-row-page.md` §1). La note
   * n'a aucun champ nouveau ; c'est ce bloc qui la désigne. Une note supprimée
   * laisse l'identifiant EN PLACE (« page supprimée »), jamais nettoyé.
   */
  pageNoteId?: string;
}

// ==================== Vues enregistrées, filtres, tris ====================

// Réglages du plateau : définis avec la logique qui les consomme (`boardLayout`),
// et seulement RÉFÉRENCÉS ici. Les redéclarer donnerait deux formes de la même
// chose, qui divergeraient au premier ajout de réglage.
export type { BoardSettings } from './boardLayout';
import type { BoardSettings } from './boardLayout';

export type DbViewType =
  | 'table'
  | 'board'
  | 'calendar'
  | 'gallery'
  | 'chart'
  | 'timeline'
  | 'form'
  | 'query';

export const DB_VIEW_TYPES: readonly DbViewType[] = [
  'table',
  'board',
  'calendar',
  'gallery',
  'chart',
  'timeline',
  'form',
  'query',
];

/**
 * La vue « Requête » (contrat `inline-database-query-view.md`) : un SELECT du SQL
 * maison sur les bases de l'espace. Les RÉSULTATS ne s'écrivent jamais.
 */
export interface DbQueryConfig {
  /** La requête, seule source de vérité ; au plus `QUERY_SQL_MAX` caractères. */
  sql: string;
  /** L'état de l'assistant sans code qui l'a écrite ; gardé tel quel, retiré si le SQL est retouché à la main. */
  builder?: Record<string, unknown>;
  /**
   * Comment montrer le résultat d'un SELECT (contrat, § 1 bis) : `graph`, sinon
   * en tableau. Une valeur inconnue est GARDÉE telle quelle (un client plus récent
   * l'a écrite) et se lit comme un tableau.
   */
  display?: string;
  /** Options du graphe : `neighbors` (les lignes reliées au résultat) ; le reste est gardé tel quel. */
  graph?: Record<string, unknown>;
}

/** Plafond du SQL d'une vue « Requête » (contrat : 64 Kio). */
export const QUERY_SQL_MAX = 64 * 1024;

/**
 * Échelle des graduations d'une frise. Elle vit ICI, et non dans
 * `timelineLayout`, pour que la dépendance reste à sens unique : le moteur de
 * disposition lit le format, le format n'a jamais à charger le moteur.
 */
export type DbTimelineScale = 'day' | 'week' | 'month';

export const DB_TIMELINE_SCALES: readonly DbTimelineScale[] = ['day', 'week', 'month'];

/**
 * Ce qu'une frise met en barres.
 *
 * `endProperty` est FACULTATIVE — sans elle chaque ligne fait un jalon d'un
 * jour, ce qui est une frise légitime et non une frise incomplète.
 * `dependencyProperty` désigne une relation de la base vers ELLE-MÊME : une
 * dépendance vers une autre base n'a pas de barre à relier.
 * `scale` absente : l'échelle se déduit de la longueur de la fenêtre.
 */
export interface DbTimelineConfig {
  startProperty?: string;
  endProperty?: string;
  dependencyProperty?: string;
  scale?: DbTimelineScale;
}

/**
 * Réglages d'un formulaire de saisie.
 *
 * `requiredPropertyIds` ne s'applique QU'AUX colonnes réellement demandées :
 * une exigence portée par une colonne masquée, calculée ou supprimée
 * fabriquerait un formulaire impossible à envoyer et dont rien n'expliquerait
 * le refus (cf. `formLayout.missingRequired`). Le réglage survit donc à la
 * colonne sans jamais bloquer — le retirer à sa disparition ferait perdre
 * l'exigence si la colonne revenait.
 */
export interface DbFormConfig {
  title?: string;
  description?: string;
  submitLabel?: string;
  requiredPropertyIds?: string[];
  /** Ouvre la fiche de la ligne créée : c'est là qu'on finit ce que le formulaire ne demande pas. */
  openAfterSubmit?: boolean;
}

export type DbChartKind = 'bar' | 'line' | 'donut';

export const DB_CHART_KINDS: readonly DbChartKind[] = ['bar', 'line', 'donut'];

/**
 * Les mesures qu'un graphique sait dessiner. Volontairement plus étroit que
 * `DbAggregate` : on ne trace ni une liste de valeurs ni un pourcentage de cases
 * cochées, et proposer ce qu'on ne peut pas rendre est une promesse en l'air.
 */
export type DbChartMeasure = 'count' | 'sum' | 'avg' | 'min' | 'max';

export const DB_CHART_MEASURES: readonly DbChartMeasure[] = ['count', 'sum', 'avg', 'min', 'max'];

export interface DbChartConfig {
  kind: DbChartKind;
  /** Propriété qui fait les tranches. */
  groupBy?: string;
  measure: DbChartMeasure;
  /** La propriété mesurée — requise sauf pour `count`. */
  valueProp?: string;
}

/**
 * Opérateurs de filtre, groupés par famille de type (cf. FAMILY_OPS dans
 * viewEngine). Un même mot ne sert jamais deux familles avec deux sens :
 * `contains` vaut sous-chaîne pour le texte et appartenance pour le
 * multi-sélection, ce qui est le même geste mental.
 */
export type DbFilterOp =
  // texte / url / email / téléphone
  | 'contains'
  | 'notContains'
  | 'equals'
  // nombre / progression / évaluation
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  // sélection
  | 'is'
  | 'isNot'
  // case à cocher
  | 'isChecked'
  | 'isUnchecked'
  // date / créé / modifié
  | 'before'
  | 'after'
  | 'on'
  // toutes familles (sauf case à cocher)
  | 'isEmpty'
  | 'isNotEmpty';

const VALID_OPS: readonly DbFilterOp[] = [
  'contains',
  'notContains',
  'equals',
  'eq',
  'neq',
  'gt',
  'lt',
  'gte',
  'lte',
  'is',
  'isNot',
  'isChecked',
  'isUnchecked',
  'before',
  'after',
  'on',
  'isEmpty',
  'isNotEmpty',
];

export interface DbFilter {
  id: string;
  propertyId: string;
  op: DbFilterOp;
  /**
   * Terme de comparaison : texte, nombre, `YYYY-MM-DD`, ou id d'option pour
   * select/multiSelect. Absent pour les opérateurs qui n'en veulent pas
   * (vide, cochée…) — et toléré absent sur les autres : un filtre incomplet
   * est INERTE (il ne masque rien) plutôt que destructeur.
   */
  value?: string | number | boolean;
}

/**
 * Groupe de filtres (Notion : « filter group ») — UN niveau, pas de groupe
 * dans un groupe. Ses filtres se combinent par `match` ; le groupe entier
 * compte pour une clause de premier niveau (cf. `DbView.filterMatch`).
 */
export interface DbFilterGroup {
  id: string;
  match: 'all' | 'any';
  filters: DbFilter[];
}

export type DbSortDirection = 'asc' | 'desc';

export interface DbSort {
  propertyId: string;
  direction: DbSortDirection;
}

export interface DbView {
  id: string;
  name: string;
  type: DbViewType;
  /** Clauses de premier niveau (chaque filtre en est une, chaque groupe aussi). */
  filters: DbFilter[];
  /**
   * Combinaison des clauses de premier niveau : `all` (ET, valeur d'office et
   * comportement d'avant) ou `any` (OU). Un lecteur ancien applique ET et
   * ignore les groupes : il montre au pire MOINS de lignes.
   */
  filterMatch?: 'all' | 'any';
  /** Groupes de filtres, chacun une clause de premier niveau. Un groupe vide est inerte. */
  filterGroups?: DbFilterGroup[];
  /** Multi-niveaux, appliqués dans l'ordre du tableau */
  sorts: DbSort[];
  /** Vue board : propriété select qui fait les colonnes (par vue) */
  groupBy?: string;
  /**
   * Vue TABLEAU : colonne qui regroupe les rangées sous des en-têtes repliables
   * (select, multi-choix, case, personne, date par mois, texte). Distinct du
   * `groupBy` du kanban : les deux vivent dans des vues différentes.
   */
  tableGroupBy?: string;
  /** Vue « Requête » seulement : la requête et l'état de son assistant. */
  query?: DbQueryConfig;
  /** Clés des groupes repliés (`optionId`, `true`/`false`, `YYYY-MM`, texte, `__empty__`). */
  collapsedGroups?: string[];
  /**
   * Vue graphiques : ce qu'on trace. Réglage DE VUE, comme les largeurs de
   * colonne — la même base peut porter une vue « par statut » et une vue « par
   * client » sans que l'une décide pour l'autre.
   */
  chart?: DbChartConfig;
  /**
   * Largeur en pixels de chaque colonne, par identifiant de propriété. Réglage
   * DE VUE : la même colonne peut être large ici et étroite dans la vue d'à
   * côté. Une propriété absente de la table prend la largeur d'office de son
   * type (`defaultColumnWidth`), ce qui laisse une base neuve lisible sans
   * qu'on ait rien réglé.
   */
  columnWidths?: Record<string, number>;
  /**
   * Proprietes MASQUEES dans cette vue.
   *
   * Reglage DE VUE, comme les largeurs : la meme base peut montrer douze
   * colonnes dans sa vue « tout » et trois dans sa vue « suivi ». Masquer n'est
   * jamais supprimer — la donnee reste dans la ligne, et reapparait des qu'on
   * ra-affiche la colonne.
   */
  hiddenPropertyIds?: string[];
  /**
   * Ordre d'affichage des proprietes DANS CETTE VUE.
   *
   * Les identifiants absents de cette liste s'affichent apres, dans l'ordre du
   * schema : une colonne ajoutee plus tard apparait donc a la fin plutot que de
   * disparaitre — une liste d'ordre incomplete ne doit jamais masquer quoi que
   * ce soit.
   */
  propertyOrder?: string[];
  /**
   * Calcul affiche en pied de chaque colonne (Somme, Moyenne, % coches...).
   *
   * Reglage DE VUE : la vue « tout » peut compter les lignes pendant que la vue
   * « ce trimestre » somme un montant. Cle = identifiant de propriete.
   */
  calculations?: Record<string, DbCalculation>;
  /**
   * Vue calendrier : propriete de type date qui range les lignes dans le mois.
   *
   * Absente, la vue prend la PREMIERE colonne de type date : un calendrier qui
   * n'affiche rien parce qu'on ne lui a pas designe sa colonne est un
   * calendrier casse.
   */
  dateProperty?: string;
  /**
   * Vue kanban : plafonds d'en-cours, second axe, résumé de colonne, taille des
   * cartes. Réglage DE VUE — la même base peut se piloter « par statut, plafonné »
   * ici et se répartir « par personne » dans la vue d'à côté.
   */
  board?: BoardSettings;
  /**
   * Vue frise : ce qui fait les barres, et par quelle relation se lisent les
   * dépendances. Réglage DE VUE, comme le reste — la même base peut se lire
   * « par date de livraison » ici et « par date de début » à côté.
   */
  timeline?: DbTimelineConfig;
  /** Vue formulaire : titre, consigne, colonnes exigées. Réglage DE VUE. */
  form?: DbFormConfig;
  /**
   * MÉMOIRE DE TRAVAIL — jamais publiée (cf. `serializeDbData`).
   *
   * Le type de vue lu, quand nous ne savions pas le peindre. `type` vaut alors
   * `'table'` pour que l'interface ait quelque chose à dessiner, et c'est
   * CELUI-CI qui repart dans le document. Sans ça, ouvrir la note sur un client
   * en retard suffisait à réécrire la vue de l'autre en tableau — pour tout le
   * monde, et sans un mot.
   */
  unknownType?: string;
  /**
   * MÉMOIRE DE TRAVAIL — jamais publiée telle quelle.
   *
   * Les champs de la vue que nous ne savons pas lire. Ils repartent au document
   * à l'écriture, SOUS les champs que nous connaissons — quelqu'un a pu renommer
   * ou filtrer la vue entre-temps, et c'est nous qui avons raison là-dessus.
   *
   * Sur TOUTE vue, y compris d'un type connu : c'est la règle gelée avec le
   * mobile. Reconstruire une vue champ par champ ne perd pas que le type
   * inconnu — ça perd tout réglage qu'un client plus récent aurait ajouté.
   *
   * Les objets de réglage imbriqués (`board`, `chart`, `timeline`, `form`)
   * passent par `avecInconnus` eux aussi ; `columnWidths` et `calculations`
   * sont des tables par identifiant de colonne, dont chaque entrée valide est
   * gardée. Une clé inconnue à CES niveaux-là ne se perd donc plus.
   */
  unknownFields?: Record<string, unknown>;
}

/**
 * Bornes d'une largeur de colonne. Elles vivent ici parce que le parse les
 * applique : une valeur hors bornes venue d'un document abîmé est ramenée dans
 * le cadre plutôt que jetée — la colonne reste utilisable.
 */
export const DB_COL_MIN_WIDTH = 72;
export const DB_COL_MAX_WIDTH = 900;

export function clampColumnWidth(px: number): number {
  if (!Number.isFinite(px)) return DB_COL_MIN_WIDTH;
  return Math.round(Math.max(DB_COL_MIN_WIDTH, Math.min(DB_COL_MAX_WIDTH, px)));
}

/**
 * Modele de ligne : des cellules pre-remplies, nommees.
 *
 * Appartient a la BASE et non a une vue : « Bogue critique » ou « Point
 * hebdomadaire » decrit ce qu'on cree, pas la facon de le regarder.
 */
export interface DbRowTemplate {
  id: string;
  name: string;
  /** Cle = identifiant de propriete, comme dans `DbRow.cells`. */
  cells: Record<string, unknown>;
}

export interface InlineDbData {
  properties: DbProperty[];
  rows: DbRow[];
  /**
   * BASE ADOSSÉE À UN DOSSIER DU COFFRE — identifiant du dossier rattaché.
   *
   * Absent ou vide = base ordinaire. Posé, les LIGNES SONT LES FICHIERS du
   * dossier : elles se dérivent à l'affichage (`folderDatabase.ts`) et ne sont
   * JAMAIS persistées — `serializeDbData` écrit `rows: []`. Deux vérités
   * divergeraient au premier renommage fait ailleurs, et la note grossirait du
   * poids d'un dossier entier alors qu'elle est rechiffrée et remontée ENTIÈRE
   * à chaque modification.
   */
  folderSource?: string;
  /** Modeles de ligne proposes par le bouton « Nouvelle ligne ». */
  rowTemplates?: DbRowTemplate[];
  /**
   * Absent sur les bases d'avant les vues : `ensureViews` en fabrique alors
   * une depuis les attrs `view`/`groupBy` du nœud (migration sans perte).
   */
  views?: DbView[];
  activeViewId?: string;
}

/** Interface DÉFINITIVE des vues Table/Board (les agents suivants remplacent le corps, pas la signature) */
export interface DatabaseViewProps {
  /** Données COMPLÈTES : toute mutation part d'ici (jamais de visibleRows) */
  data: InlineDbData;
  /**
   * Lignes que la vue active laisse voir (filtrées puis triées). Sert au RENDU
   * seul : une ligne masquée reste dans `data.rows` et n'est jamais supprimée.
   */
  visibleRows: DbRow[];
  groupBy: string;
  /** Cellules à poser d'office sur une nouvelle ligne pour qu'elle soit visible ici */
  rowDefaults: Record<string, unknown>;
  onChange: (next: InlineDbData) => void;
  onGroupByChange: (propertyId: string) => void;
  /** Connecteur choisi au niveau du bloc ('' = aucun) — pilote le bouton ⚡ */
  source?: string;
  /**
   * Résolution des bases visées par les relations (index des notes du coffre).
   * Optionnel : sans lui, relations et agrégats s'affichent « indisponibles »
   * plutôt que vides — jamais une valeur perdue, jamais un plantage.
   */
  linkCtx?: DbLinkContext;
  /** Bases proposées comme cible d'une relation (celle-ci comprise) */
  dbCatalog?: DbCatalogEntry[];
  /**
   * Vue REGARDÉE, telle que le bloc l'a résolue (l'onglet choisi sur cet
   * appareil prime sur celui qu'enregistre le document). C'est elle que la
   * table corrige pour ranger ses largeurs de colonnes : la déduire de
   * `data.activeViewId` viserait la mauvaise vue tant qu'aucune écriture n'a eu
   * lieu. Optionnelle : sans elle, repli sur l'onglet enregistré.
   */
  activeView?: DbView;
  /**
   * Plusieurs lignes collées dans une cellule de texte : le bloc ouvre l'import
   * (une ligne collée = une ligne de la base). Absent : le collage reste celui
   * d'un champ d'une ligne (les retours à la ligne sont aplatis par le navigateur).
   */
  onPasteLines?: (text: string) => void;
}

/** Une base qu'une relation peut viser, telle que l'éditeur de propriété la propose */
export interface DbCatalogEntry {
  dbId: string;
  /** Titre du bloc, sinon celui de la note qui le porte */
  label: string;
  /** Schéma de la cible : le sélecteur d'agrégat y choisit la propriété à agréger */
  properties: DbProperty[];
  /** Vrai pour la base courante (une relation vers soi-même est légitime) */
  self?: boolean;
  /**
   * Note qui porte la base. Deux bases peuvent s'appeler pareil : sans le nom
   * de leur note, la liste des cibles ne se départage pas.
   */
  noteId?: string;
  noteTitle?: string;
}

// ==================== Palette ====================

/**
 * Couleurs d'options select/multiSelect — tokens thème (tiennent en dark ET
 * papier/terracotta).
 *
 * ── LES DIX-SEPT TEINTES DU SYSTÈME, PAS DIX ────────────────────────────────
 *
 * Cette liste n'en exposait que dix alors que `--color-folder-*` en définit
 * dix-huit. Sept teintes étaient donc invisibles ici sans qu'aucune raison ne le
 * justifie : ni le stockage (une option range un IDENTIFIANT, pas une valeur),
 * ni le rendu (une seule variable CSS), ni la lecture (un identifiant inconnu
 * retombe sur le gris). Elles sont rangées dans l'ordre du spectre, les deux
 * teintes neutres en tête, pour que la palette se lise comme une roue et non
 * comme un historique d'ajouts.
 *
 * ⚠ LE NOM DES JETONS MENT UN PEU : `--color-folder-*` ne sert AUJOURD'HUI qu'à
 * cette palette. Le sélecteur de couleur de dossier range une valeur brute sur
 * le dossier et ne lit aucun de ces jetons. Les renommer serait juste ; en
 * attendant, ajouter une teinte ici ne touche rien d'autre dans le produit.
 *
 * L'ordre ne décide plus de la couleur d'une option créée à la main : c'est
 * `nextOptionColor` (le tourniquet sur cette liste donnait gris puis brun aux
 * deux premières). Les options existantes rangent leur identifiant : réordonner
 * cette liste ne repeint rien nulle part.
 */
export const DB_OPTION_COLORS: { id: string; value: string }[] = [
  { id: 'gray', value: 'var(--color-neutral-400)' },
  { id: 'brown', value: 'var(--color-folder-brown)' },
  { id: 'red', value: 'var(--color-folder-red)' },
  { id: 'orange', value: 'var(--color-folder-orange)' },
  { id: 'amber', value: 'var(--color-folder-amber)' },
  { id: 'yellow', value: 'var(--color-folder-yellow)' },
  { id: 'lime', value: 'var(--color-folder-lime)' },
  { id: 'green', value: 'var(--color-folder-green)' },
  { id: 'emerald', value: 'var(--color-folder-emerald)' },
  { id: 'teal', value: 'var(--color-folder-teal)' },
  { id: 'cyan', value: 'var(--color-folder-cyan)' },
  { id: 'sky', value: 'var(--color-folder-sky)' },
  { id: 'blue', value: 'var(--color-folder-blue)' },
  { id: 'indigo', value: 'var(--color-folder-indigo)' },
  { id: 'violet', value: 'var(--color-folder-violet)' },
  { id: 'purple', value: 'var(--color-folder-purple)' },
  { id: 'fuchsia', value: 'var(--color-folder-fuchsia)' },
  { id: 'pink', value: 'var(--color-folder-pink)' },
  { id: 'rose', value: 'var(--color-folder-rose)' },
];

export function optionColorValue(color: string): string {
  const found = DB_OPTION_COLORS.find((c) => c.id === color);
  return found ? found.value : DB_OPTION_COLORS[0].value;
}

/**
 * Intensité d'une étiquette — la SECONDE dimension de la palette.
 *
 * Dix-huit teintes en une seule intensité, c'est dix-huit aplats ; les mêmes en
 * trois intensités en font cinquante-quatre, sans ajouter une seule couleur au
 * système. C'est ce qui permet de distinguer deux familles d'options du même
 * bleu — un statut discret et un statut qui doit sauter aux yeux.
 *
 * ⚠ LE TEXTE GARDE SA COULEUR AUX TROIS INTENSITÉS, et c'est délibéré. Passer
 * en texte clair sur fond plein réclamerait un calcul de contraste par teinte ET
 * par thème (l'application en a plus de deux, dont un fond papier). Une
 * proportion d'aplat qui monte à 60 % se lit comme « soutenu » tout en gardant
 * un contraste garanti par le thème lui-même — plutôt qu'une couleur de texte
 * qui aurait l'air juste sur le thème où on l'a réglée.
 */
export type DbOptionIntensity = 'soft' | 'medium' | 'strong';

/** L'ordre d'affichage du réglage, du plus discret au plus soutenu. */
export const DB_OPTION_INTENSITIES: readonly DbOptionIntensity[] = ['soft', 'medium', 'strong'];

const INTENSITY_MIX: Record<DbOptionIntensity, string> = {
  soft: '12%',
  medium: '22%',
  strong: '60%',
};

/**
 * La proportion d'aplat, en pourcentage, prête pour `color-mix`.
 *
 * ⚠ TABLE FERMÉE, JAMAIS D'INTERPOLATION. La valeur vient d'un document que
 * n'importe quel appareil a pu écrire : la faire entrer telle quelle dans une
 * règle CSS serait laisser une note décider d'une déclaration. Une valeur
 * inconnue — client plus récent, donnée abîmée — retombe sur l'intensité
 * moyenne, celle d'avant l'existence de ce champ.
 */
export function optionIntensityMix(intensity: unknown): string {
  /*
    ⚠ LA RECHERCHE SE FAIT DANS LA LISTE, PAS AVEC `in`.

    `intensity in INTENSITY_MIX` remonte la CHAÎNE DE PROTOTYPES : `constructor`,
    `toString` et `__proto__` y répondent vrai, et la valeur rendue devenait
    alors `function Object() { [native code] }` — c'est-à-dire un document qui
    fait entrer n'importe quoi dans une déclaration CSS. Attrapé par la garde
    avant d'exister ailleurs que dans ce fichier.
  */
  const connue = DB_OPTION_INTENSITIES.find((i) => i === intensity);
  return INTENSITY_MIX[connue ?? 'medium'];
}

// ==================== Libellés des types de propriété ====================

/**
 * Nom lisible de chaque type de colonne. Table PARTAGÉE : l'éditeur de
 * propriété et l'en-tête de la table y lisent le même mot, et le balayage i18n
 * n'a qu'un endroit à vérifier. Toute nouvelle valeur de `PropertyType` doit
 * apparaître ici — le typage `Record<PropertyType, …>` le fait échouer à la
 * compilation si on l'oublie.
 */
export const PROPERTY_TYPE_LABELS: Record<PropertyType, { key: string; fallback: string }> = {
  text: { key: 'notes.inlineDb.typeText', fallback: 'Text' },
  number: { key: 'notes.inlineDb.typeNumber', fallback: 'Number' },
  select: { key: 'notes.inlineDb.typeSelect', fallback: 'Select' },
  multiSelect: { key: 'notes.inlineDb.typeMultiSelect', fallback: 'Multi-select' },
  checkbox: { key: 'notes.inlineDb.typeCheckbox', fallback: 'Checkbox' },
  date: { key: 'notes.inlineDb.typeDate', fallback: 'Date' },
  url: { key: 'notes.inlineDb.typeUrl', fallback: 'URL' },
  email: { key: 'notes.inlineDb.typeEmail', fallback: 'Email' },
  phone: { key: 'notes.inlineDb.typePhone', fallback: 'Phone' },
  rating: { key: 'notes.inlineDb.typeRating', fallback: 'Rating' },
  progress: { key: 'notes.inlineDb.typeProgress', fallback: 'Progress' },
  note: { key: 'notes.inlineDb.typeNote', fallback: 'Note' },
  relation: { key: 'notes.inlineDb.typeRelation', fallback: 'Relation' },
  rollup: { key: 'notes.inlineDb.typeRollup', fallback: 'Rollup' },
  createdTime: { key: 'notes.inlineDb.typeCreatedTime', fallback: 'Created time' },
  updatedTime: { key: 'notes.inlineDb.typeUpdatedTime', fallback: 'Last edited time' },
  formula: { key: 'notes.inlineDb.typeFormula', fallback: 'Formula' },
  person: { key: 'notes.inlineDb.typePerson', fallback: 'Person' },
  vaultFile: { key: 'notes.inlineDb.typeVaultFile', fallback: 'Vault file' },
};

/**
 * Libellé traduit d'un type. Lu à CHAQUE rendu (et non mémoïsé au module) :
 * les vues se re-rendent au changement de langue, le mot suit.
 */
export function propertyTypeLabel(type: PropertyType): string {
  const entry = PROPERTY_TYPE_LABELS[type];
  return entry ? i18n.t(entry.key, { defaultValue: entry.fallback }) : '';
}

// ==================== Connecteurs (source du bloc) ====================

/**
 * Libellés i18n des sources de la liste blanche partagée — le sélecteur du
 * header et l'infobulle du ⚡ lisent la même table (aucun texte en dur).
 */
export const CONNECTOR_SOURCE_LABELS: Record<string, { key: string; fallback: string }> = {
  books: { key: 'notes.inlineDb.sourceBooks', fallback: 'Books' },
  anime: { key: 'notes.inlineDb.sourceAnime', fallback: 'Anime' },
  tv: { key: 'notes.inlineDb.sourceTv', fallback: 'TV shows' },
  movies: { key: 'notes.inlineDb.sourceMovies', fallback: 'Movies' },
};

// ==================== Clé TMDB (source Films) ====================

/**
 * Clé d'API TMDB, saisie par l'utilisateur dans Paramètres → Intégrations.
 * Elle vit dans le TROUSSEAU du profil (chiffré sous la FEK ; synchronisé pour
 * un profil relié à un compte Pro, Teams ou Enterprise — contrat
 * passerelle-phase-1 § 1) ; à défaut, à l'ancienne place, sur cet appareil
 * (localStorage), d'où elle migre au premier chargement du trousseau. Elle ne
 * voyage que comme paramètre de l'appel amont TMDB : en direct depuis le
 * processus principal en desktop, via le proxy de la liste blanche en web.
 * Les autres sources (livres, animes, séries) n'ont besoin d'aucune clé.
 */
const TMDB_KEY_STORAGE = 'filarr-tmdb-api-key';

/** Page où obtenir une clé gratuite (affichée quand elle manque). */
export const TMDB_API_KEY_URL = 'https://www.themoviedb.org/settings/api';

/** La clé à utiliser : celle du trousseau d'abord, l'ancienne place ensuite. */
export function getTmdbApiKey(): string {
  return cachedSecret('tmdb')?.trim() || getLegacyTmdbApiKey();
}

/** L'ancienne place seulement (sur cet appareil) : ce que la migration vers le trousseau lit. */
export function getLegacyTmdbApiKey(): string {
  try {
    return profileStorage.getItemWithLegacyFallback(TMDB_KEY_STORAGE)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function setTmdbApiKey(value: string): void {
  try {
    const v = value.trim();
    if (v) profileStorage.setItem(TMDB_KEY_STORAGE, v);
    else profileStorage.removeItem(TMDB_KEY_STORAGE);
  } catch {
    /* localStorage indisponible : la source Films restera sans clé */
  }
}

// ==================== Onglet de vue regardé (préférence LOCALE) ====================

/**
 * Quel onglet de vue on regarde est une préférence d'AFFICHAGE, pas un contenu :
 * elle vit sur cet appareil (localStorage, jamais synchronisée), comme la clé
 * TMDB ci-dessus. Le document, lui, ne l'enregistre qu'au passage d'une
 * écriture réelle — voir InlineDatabaseNodeView.
 */
const ACTIVE_VIEW_PREFIX = 'filarr-inline-db-view:';

/**
 * Clé locale d'un bloc, dérivée de l'id de sa PREMIÈRE vue : ces ids sont
 * générés une fois et ne bougent plus. Les faire porter l'identité évite
 * d'écrire un attr d'identité dans le document — précisément l'écriture que
 * cette préférence locale cherche à supprimer.
 */
export function viewPrefKey(views: DbView[] | undefined): string {
  const first = views?.[0];
  return first ? `${ACTIVE_VIEW_PREFIX}${first.id}` : '';
}

export function readActiveViewPref(key: string): string | null {
  if (!key) return null;
  try {
    return profileStorage.getItemWithLegacyFallback(key);
  } catch {
    return null;
  }
}

export function writeActiveViewPref(key: string, viewId: string): void {
  if (!key) return;
  try {
    profileStorage.setItem(key, viewId);
  } catch {
    /* localStorage indisponible : l'onglet ne sera pas retenu d'une session à l'autre */
  }
}

/**
 * Langue transmise aux connecteurs : bornée au motif partagé de la liste
 * blanche (`fr-FR`, `en-US`…), donc jamais la locale OS brute.
 */
export function connectorLang(): string {
  return (i18n.language || '').toLowerCase().startsWith('fr') ? 'fr-FR' : 'en-US';
}

// ==================== Helpers purs ====================

// ==================== Identité stable d'une base (dbId) ====================

/**
 * IDENTITÉ D'UNE BASE — dérivée d'abord, frappée ensuite.
 *
 * Une relation vise une base, il lui faut donc un identifiant. Les bases nées
 * avant les relations n'en portent aucun : plutôt que de réécrire toutes les
 * notes qui en contiennent une (un simple aperçu salirait la note et la ferait
 * remonter au nuage), l'identité est DÉRIVÉE de la première graine des données,
 * à la lecture, par une fonction pure — l'index et le bloc lui-même calculent
 * donc la même valeur sans s'être parlé.
 *
 * Graines, dans l'ordre : l'id de la 1re vue (posé une fois à la création et
 * jamais régénéré — c'est déjà la clé locale de `viewPrefKey`), puis la 1re
 * propriété, puis la 1re ligne. Le préfixe `db@` les distingue d'un identifiant
 * frappé.
 *
 * CE QUE LA DÉRIVATION GARANTIT — et ce qu'elle ne garantit pas :
 *  - une base née AVEC ses vues (tout ce qui est créé depuis) a une graine
 *    définitive : l'id de sa 1re vue ne bouge plus, ni au tri, ni au filtre, ni
 *    à la suppression de colonnes ;
 *  - une base d'AVANT les vues, elle, se dérive de sa 1re propriété (ou de sa
 *    1re ligne) : supprimer cette colonne, ou la déplacer, CHANGE son identité
 *    tant que l'attribut n'a pas été frappé. C'est justement pourquoi le
 *    premier vrai commit fige la valeur dans l'attribut du nœud (cf. `commit`
 *    dans InlineDatabaseNodeView) : après lui, plus rien ne la fait bouger.
 *    La fenêtre à risque est donc courte — de l'ouverture d'une note ancienne
 *    à sa première écriture — mais elle existe : une relation créée pendant
 *    cette fenêtre vers une base ancienne qu'on remanie AVANT de l'avoir
 *    commitée pointera dans le vide (« base indisponible », liens conservés).
 *
 * Frapper l'attribut ne change rien à la valeur lue (c'est la même), donc
 * aucune relation déjà créée ne se casse au passage ; et un client qui
 * ignorerait l'attribut (schéma TipTap plus ancien, qui jette les attrs
 * inconnus) laisse l'identité se re-dériver à l'identique.
 */
export function deriveDbId(data: InlineDbData): string {
  const view = data.views?.[0]?.id;
  if (typeof view === 'string' && view !== '') return `db@v:${view}`;
  const prop = data.properties[0]?.id;
  if (typeof prop === 'string' && prop !== '') return `db@p:${prop}`;
  const row = data.rows[0]?.id;
  if (typeof row === 'string' && row !== '') return `db@r:${row}`;
  // Coquille vide : aucune graine, donc aucune identité — rien à viser non plus
  return '';
}

/**
 * Identité retenue pour un bloc : l'attribut s'il en porte un, sinon la valeur
 * dérivée. À appeler sur les données BRUTES (avant `ensureViews`, qui
 * fabriquerait une vue au vol et donc une graine différente à chaque rendu).
 */
export function resolveDbId(attrDbId: unknown, data: InlineDbData): string {
  const attr = typeof attrDbId === 'string' ? attrDbId.trim() : '';
  return attr !== '' ? attr : deriveDbId(data);
}

/**
 * Cellules d'office d'une nouvelle ligne : une par propriété select/multiSelect
 * dont le defaultOptionId pointe sur une option qui existe encore.
 */
/**
 * Point unique de création de ligne : createdAt posé ici (jamais au montage).
 * `overrides` a le dernier mot sur les défauts du schéma (le board impose la
 * colonne où l'on clique) ; une valeur `undefined` y signifie « laisse vide ».
 */
export function newRow(properties: DbProperty[], overrides: Record<string, unknown> = {}): DbRow {
  return makeRow(properties, overrides, newId, new Date());
}

/** Les textes du cœur pur passent par i18n sur le bureau et le web */
export const i18nTranslate: Translate = (key, fallback, vars) =>
  i18n.t(key, { defaultValue: fallback, ...(vars ?? {}) });

/** Contexte des modules purs de création : i18n, identifiants tirés, heure du moment */
export function desktopCreationContext(): { translate: Translate; ids: () => string; now: Date } {
  return { translate: i18nTranslate, ids: newId, now: new Date() };
}

/** Point unique d'horodatage : à appeler sur toute ligne dont les cells changent */
export function touchRow(row: DbRow): DbRow {
  return { ...row, updatedAt: new Date().toISOString() };
}

/** Date+heure locale compacte des colonnes createdTime/updatedTime (vue ET export) */
export function formatDbTimestamp(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // Langue de l'app, pas la locale OS
  return d.toLocaleString(i18n.language || undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Date d'une cellule (`YYYY-MM-DD`) mise en forme dans la LANGUE DE L'APP.
 * Point unique : la cellule de la table, la pastille d'une relation, l'agrégat
 * « liste des valeurs » et la carte du board doivent lire la même chose — un
 * ISO brut à côté d'une date habillée se remarque tout de suite.
 */
export function formatDbDate(iso: string | undefined): string {
  if (!iso) return '';
  return formatDisplayDate(iso, resolveLocale(i18n.language));
}

/**
 * Vue neuve : nom i18n figé à la création (comme les propriétés par défaut),
 * aucun filtre ni tri. `groupBy` n'est porté que par les vues board.
 */
export function makeDefaultView(type: DbViewType = 'table', groupBy?: string): DbView {
  return makeNamedView(
    i18n.t('notes.inlineDb.mainView', { defaultValue: 'Main view' }),
    type,
    groupBy
  );
}

/* ---- Parse tolérant des vues : une entrée douteuse est jetée, jamais lancée ---- */

function parseFilters(raw: unknown): DbFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: DbFilter[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const { id, propertyId, op, value } = f as Record<string, unknown>;
    if (typeof id !== 'string' || typeof propertyId !== 'string') continue;
    if (typeof op !== 'string' || !(VALID_OPS as readonly string[]).includes(op)) continue;
    const keepValue =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    out.push({
      id,
      propertyId,
      op: op as DbFilterOp,
      ...(keepValue ? { value: value as string | number | boolean } : {}),
    });
  }
  return out;
}

/**
 * Groupes de filtres. Un groupe sans identifiant est écarté ; un `match`
 * inconnu retombe sur `all` (le plus restrictif : jamais plus de lignes que
 * l'auteur n'en voulait) ; un groupe vide est gardé — il est inerte, et le
 * retirer ferait perdre le cadre qu'on venait d'ouvrir.
 */
function parseFilterGroups(raw: unknown): DbFilterGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DbFilterGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const { id, match, filters } = g as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') continue;
    out.push({ id, match: match === 'any' ? 'any' : 'all', filters: parseFilters(filters) });
  }
  return out.length > 0 ? out : undefined;
}

function parseSorts(raw: unknown): DbSort[] {
  if (!Array.isArray(raw)) return [];
  const out: DbSort[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const { propertyId, direction } = s as Record<string, unknown>;
    if (typeof propertyId !== 'string') continue;
    if (direction !== 'asc' && direction !== 'desc') continue;
    out.push({ propertyId, direction });
  }
  return out;
}

/**
 * Largeurs de colonnes d'une vue. Une entrée illisible est ignorée (la colonne
 * reprend la largeur d'office de son type), une valeur hors bornes est ramenée
 * dans le cadre : jamais une colonne de 3 px qu'on ne saurait plus rattraper.
 */
function parseColumnWidths(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [propId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (propId === '' || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[propId] = clampColumnWidth(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Calculs de pied de colonne ; les valeurs inconnues sont ecartees. */
function parseCalculations(raw: unknown): Record<string, DbCalculation> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, DbCalculation> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== '' && isCalculation(value) && value !== 'none') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Liste d'identifiants, dedoublonnee ; `undefined` quand il n'y a rien a garder. */
function parseIdList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Réglages du plateau kanban.
 *
 * TOUT champ doit être lu ICI. Un réglage qu'on ajoute à `BoardSettings` sans
 * l'ajouter à ce parse existe en mémoire et disparaît au premier aller-retour
 * du document : la case se recoche toute seule, et on cherche le bug côté vue.
 */
/**
 * Recopie, sous les champs qu'on vient de valider, ceux d'un objet de réglages
 * QUE NOUS NE SAVONS PAS LIRE.
 *
 * ── POURQUOI, ET QUI L'A TROUVÉ ─────────────────────────────────────────────
 *
 * La conservation des champs inconnus s'arrêtait au premier niveau : un type de
 * vue inconnu survivait, mais un champ ajouté DANS `chart`, `timeline`, `form`
 * ou `board` par une surface plus récente était effacé à la relecture, puis
 * republié sans lui.
 *
 * `filarr-mobile-b1` a montré que la limite n'était PAS symétrique, contrairement
 * à ce que je lui avais écrit : chez lui `timeline` traverse intact parce qu'il
 * ne le déconstruit pas du tout. La limite ne mord que sur les objets qu'on
 * DÉCONSTRUIT — et c'est nous qui déconstruisons ceux-là. Un champ qu'il
 * ajouterait dans `timeline`, c'est NOUS qui l'effacions.
 *
 * ── LE PIÈGE, SIGNALÉ PAR LUI AUSSI ─────────────────────────────────────────
 *
 * `valide` ne porte QUE des champs validés, et `extras` QUE des clés absentes
 * de `connus`. Un champ connu mais informe (`scale: 42`) n'est donc dans ni l'un
 * ni l'autre : il est écarté pour de bon. Recopier l'objet BRUT puis corriger
 * l'aurait laissé passer dès qu'une validation se contente d'omettre la clé.
 */
/**
 * Champs d'une COLONNE que nous savons lire. `unknownType` y figure alors qu'il
 * n'existe qu'en mémoire : c'est ce qui empêche un document abîmé qui le
 * porterait déjà de le faire ressortir par la recopie — notre détail
 * d'implémentation ne doit jamais devenir un morceau de contrat.
 */
const CHAMPS_COLONNE = [
  'id',
  'name',
  'type',
  'unknownType',
  'options',
  'defaultOptionId',
  'targetDbId',
  'direction',
  'sourcePropertyId',
  'single',
  'viaPropertyId',
  'targetPropertyId',
  'aggregate',
  'formula',
  'numberFormat',
  'autoDate',
];

/** Champs d'une LIGNE que nous savons lire. */
const CHAMPS_LIGNE = ['id', 'cells', 'createdAt', 'updatedAt', 'parentId', 'pageNoteId'];

/**
 * Champs de la RACINE d'une base. Quatrième et dernier étage de la même règle :
 * l'objet racine était reconstruit comme les vues, les colonnes et les lignes,
 * donc tout ce qui n'est pas dans cette liste tombait.
 */
const CHAMPS_RACINE = [
  'properties',
  'rows',
  'rowTemplates',
  'views',
  'activeViewId',
  'folderSource',
];

function avecInconnus<T extends object>(raw: unknown, valide: T, connus: readonly string[]): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return valide;
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!connus.includes(k)) extras[k] = v;
  }
  return Object.keys(extras).length === 0 ? valide : ({ ...extras, ...valide } as T);
}

const CHAMPS_BOARD = [
  'swimlaneBy',
  'summaryBy',
  'wipLimits',
  'collapsed',
  'hideEmpty',
  'colorCards',
  'cardSize',
];

function parseBoardSettings(raw: unknown): BoardSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { swimlaneBy, summaryBy, wipLimits, collapsed, hideEmpty, colorCards, cardSize } =
    raw as Record<string, unknown>;

  const limits: Record<string, number> = {};
  if (wipLimits && typeof wipLimits === 'object' && !Array.isArray(wipLimits)) {
    for (const [key, value] of Object.entries(wipLimits as Record<string, unknown>)) {
      // Un plafond ≤ 0 n'est pas un plafond, c'est une colonne interdite : on
      // l'écarte plutôt que d'afficher une colonne en dépassement permanent.
      if (key !== '' && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        limits[key] = Math.round(value);
      }
    }
  }

  const out: BoardSettings = {
    ...(typeof swimlaneBy === 'string' && swimlaneBy !== '' ? { swimlaneBy } : {}),
    ...(typeof summaryBy === 'string' && summaryBy !== '' ? { summaryBy } : {}),
    ...(Object.keys(limits).length > 0 ? { wipLimits: limits } : {}),
    ...(parseIdList(collapsed) ? { collapsed: parseIdList(collapsed) } : {}),
    ...(hideEmpty === true ? { hideEmpty: true } : {}),
    ...(colorCards === true ? { colorCards: true } : {}),
    ...(cardSize === 'compact' || cardSize === 'tall' ? { cardSize } : {}),
  };
  // Objet vide = comme une absence : pas de `board: {}` qui alourdirait chaque
  // vue enregistrée sans rien dire. La fusion passe AVANT ce test : un objet
  // qui ne porterait QUE des champs inconnus n'est pas vide, il est illisible —
  // et il doit traverser.
  const fusion = avecInconnus(raw, out, CHAMPS_BOARD);
  return Object.keys(fusion).length > 0 ? fusion : undefined;
}

/**
 * Ce que trace une vue graphique.
 *
 * Tolérant par principe : une configuration abîmée retombe sur ses valeurs
 * d'office (barres, comptage) plutôt que de faire disparaître la vue. Un
 * graphique qui revient vide se refait ; une vue qui s'évapore, non.
 */
function parseChartConfig(raw: unknown): DbChartConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { kind, groupBy, measure, valueProp } = raw as Record<string, unknown>;
  return avecInconnus(
    raw,
    {
      kind: DB_CHART_KINDS.find((k) => k === kind) ?? 'bar',
      measure: DB_CHART_MEASURES.find((m) => m === measure) ?? 'count',
      ...(typeof groupBy === 'string' && groupBy !== '' ? { groupBy } : {}),
      ...(typeof valueProp === 'string' && valueProp !== '' ? { valueProp } : {}),
    },
    ['kind', 'groupBy', 'measure', 'valueProp']
  );
}

/**
 * Ce qu'une frise met en barres.
 *
 * Même tolérance que pour les graphiques : une configuration abîmée ne fait pas
 * disparaître la vue, elle la rend simplement muette — et la vue le DIT à
 * l'écran plutôt que d'afficher un cadre vide. Une propriété désignée mais
 * absente du schéma est laissée telle quelle : c'est le moteur de disposition
 * qui juge, parce qu'une colonne supprimée puis rétablie ne doit pas coûter le
 * réglage au passage.
 */
function parseTimelineConfig(raw: unknown): DbTimelineConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { startProperty, endProperty, dependencyProperty, scale } = raw as Record<string, unknown>;
  const texte = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const out: DbTimelineConfig = {
    ...(texte(startProperty) ? { startProperty: texte(startProperty) } : {}),
    ...(texte(endProperty) ? { endProperty: texte(endProperty) } : {}),
    ...(texte(dependencyProperty) ? { dependencyProperty: texte(dependencyProperty) } : {}),
    ...(DB_TIMELINE_SCALES.find((s) => s === scale) ? { scale: scale as DbTimelineScale } : {}),
  };
  const fusion = avecInconnus(raw, out, [
    'startProperty',
    'endProperty',
    'dependencyProperty',
    'scale',
  ]);
  return Object.keys(fusion).length > 0 ? fusion : undefined;
}

/**
 * Réglages d'un formulaire.
 *
 * Les identifiants exigés sont conservés TELS QUELS, sans vérifier qu'ils
 * pointent sur une colonne : une colonne supprimée puis rétablie ne doit pas
 * coûter son exigence au passage, et c'est `missingRequired` qui refuse de
 * bloquer sur une colonne absente.
 */
function parseFormConfig(raw: unknown): DbFormConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { title, description, submitLabel, requiredPropertyIds, openAfterSubmit } = raw as Record<
    string,
    unknown
  >;
  const texte = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const out: DbFormConfig = {
    ...(texte(title) ? { title: texte(title) } : {}),
    ...(texte(description) ? { description: texte(description) } : {}),
    ...(texte(submitLabel) ? { submitLabel: texte(submitLabel) } : {}),
    ...(parseIdList(requiredPropertyIds)
      ? { requiredPropertyIds: parseIdList(requiredPropertyIds) }
      : {}),
    ...(openAfterSubmit === true ? { openAfterSubmit: true } : {}),
  };
  const fusion = avecInconnus(raw, out, [
    'title',
    'description',
    'submitLabel',
    'requiredPropertyIds',
    'openAfterSubmit',
  ]);
  return Object.keys(fusion).length > 0 ? fusion : undefined;
}

/** Les champs que nous savons lire : tout le reste d'une vue INCONNUE est mis de côté. */
const CHAMPS_DE_VUE_CONNUS = new Set([
  'id',
  'name',
  'type',
  'filters',
  'sorts',
  'groupBy',
  'chart',
  'timeline',
  'form',
  'columnWidths',
  'hiddenPropertyIds',
  'propertyOrder',
  'calculations',
  'dateProperty',
  'board',
  'filterMatch',
  'filterGroups',
  'tableGroupBy',
  'collapsedGroups',
  'query',
]);

function parseViews(raw: unknown): DbView[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DbView[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const {
      id,
      name,
      type,
      filters,
      sorts,
      groupBy,
      chart,
      timeline,
      form,
      columnWidths,
      hiddenPropertyIds,
      propertyOrder,
      calculations,
      dateProperty,
      board,
      filterMatch,
      filterGroups,
      tableGroupBy,
      collapsedGroups,
      query,
    } = v as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    const widths = parseColumnWidths(columnWidths);
    // Liste CLOSE, jamais une suite de comparaisons à la main : c'est en
    // oubliant d'y ajouter « chart » qu'on a effacé la vue graphique le
    // lendemain de sa livraison.
    const connu = DB_VIEW_TYPES.find((t) => t === type);
    // Un type absent n'est pas un type inconnu : il n'y a rien à préserver, et
    // poser la mémoire ici écrirait `type: undefined` dans le document.
    const inconnu = !connu && typeof type === 'string' && type !== '' ? type : undefined;
    // Sur TOUTE vue, pas seulement celles d'un type inconnu : c'est la règle
    // gelée avec le mobile — une relecture RECOPIE puis corrige, elle ne
    // reconstruit pas. Reconstruire champ par champ perd tout ce qu'un client
    // plus récent aurait ajouté, même sur une vue dont le type nous est connu.
    const extras = restePourVueInconnue(v as Record<string, unknown>);
    out.push({
      id,
      name,
      type: connu ?? 'table',
      ...(inconnu ? { unknownType: inconnu } : {}),
      ...(extras ? { unknownFields: extras } : {}),
      filters: parseFilters(filters),
      // `all` = absent : écrire la valeur d'office alourdirait chaque vue sans rien dire.
      ...(filterMatch === 'any' ? { filterMatch: 'any' as const } : {}),
      ...(parseFilterGroups(filterGroups) ? { filterGroups: parseFilterGroups(filterGroups) } : {}),
      sorts: parseSorts(sorts),
      ...(typeof groupBy === 'string' && groupBy !== '' ? { groupBy } : {}),
      ...(typeof tableGroupBy === 'string' && tableGroupBy !== '' ? { tableGroupBy } : {}),
      ...(parseIdList(collapsedGroups) ? { collapsedGroups: parseIdList(collapsedGroups) } : {}),
      ...(parseChartConfig(chart) ? { chart: parseChartConfig(chart) } : {}),
      ...(parseTimelineConfig(timeline) ? { timeline: parseTimelineConfig(timeline) } : {}),
      ...(parseFormConfig(form) ? { form: parseFormConfig(form) } : {}),
      ...(widths ? { columnWidths: widths } : {}),
      ...(parseIdList(hiddenPropertyIds)
        ? { hiddenPropertyIds: parseIdList(hiddenPropertyIds) }
        : {}),
      ...(parseIdList(propertyOrder) ? { propertyOrder: parseIdList(propertyOrder) } : {}),
      ...(parseCalculations(calculations) ? { calculations: parseCalculations(calculations) } : {}),
      ...(typeof dateProperty === 'string' && dateProperty !== '' ? { dateProperty } : {}),
      ...(parseBoardSettings(board) ? { board: parseBoardSettings(board) } : {}),
      ...(parseQueryConfig(query) ? { query: parseQueryConfig(query) } : {}),
    });
  }
  // Tableau vide (ou tout jeté) = comme une absence : la migration reprend la main
  return out.length > 0 ? out : undefined;
}

/** La requête d'une vue « Requête » : un SQL (borné) et, s'il y en a un, l'état de l'assistant. */
function parseQueryConfig(raw: unknown): DbQueryConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { sql, builder, display, graph } = raw as Record<string, unknown>;
  if (typeof sql !== 'string' || sql.length > QUERY_SQL_MAX) return undefined;
  const plain = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  return {
    sql,
    ...(plain(builder) ? { builder } : {}),
    ...(typeof display === 'string' && display !== '' ? { display } : {}),
    ...(plain(graph) ? { graph } : {}),
  };
}

/** Les champs d'une vue que nous ne savons pas lire — gardés tels quels pour l'écriture. */
function restePourVueInconnue(v: Record<string, unknown>): Record<string, unknown> | undefined {
  const reste: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!CHAMPS_DE_VUE_CONNUS.has(k)) reste[k] = val;
  }
  return Object.keys(reste).length > 0 ? reste : undefined;
}

/** Modeles de ligne ; une entree sans nom ou sans cellules est ecartee. */
function parseRowTemplates(raw: unknown): DbRowTemplate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DbRowTemplate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, cells } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || name.trim() === '') continue;
    out.push({
      id,
      name,
      cells: cells && typeof cells === 'object' ? (cells as Record<string, unknown>) : {},
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Parse tolérant : toute entrée invalide retombe sur une base vide */
/**
 * RENVOI OU FORMAT PLUS RÉCENT — contrat `db-store-1`, § 1 (précision 3.4).
 *
 * Un bloc dont `data.v` est un nombre ≥ 2 n'est PAS une base en ligne : ses
 * lignes vivent dans un magasin (`{ v: 2, store }`), ou dans une forme qu'un
 * client plus ancien ne connaît pas (un futur `v: 3`). Le lu comme une base
 * VIDE, le premier geste le réécrirait avec `properties: []` et `rows: […]` —
 * le renvoi perdu, le magasin orphelin. Un tel bloc s'affiche donc comme
 * « Cette base demande une version plus récente », et RIEN ne réécrit son
 * `data` : ni un geste, ni une tâche de fond (dates d'office, écritures
 * croisées des relations, imports). `parseDbData` garde `v` et `store` intacts
 * (clés de racine inconnues), et une copie ne refrappe que le `dbId` des attrs.
 */
export function isNewerDbFormat(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const v = (data as { v?: unknown }).v;
  return typeof v === 'number' && v >= 2;
}

/** La même question sur le JSON brut de l'attribut `data`. */
export function isNewerDbFormatJson(json: unknown): boolean {
  if (typeof json !== 'string' || json === '') return false;
  try {
    return isNewerDbFormat(JSON.parse(json));
  } catch {
    return false;
  }
}

export function parseDbData(json: string): InlineDbData {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return { properties: [], rows: [] };
    const views = parseViews(parsed.views);
    const properties = Array.isArray(parsed.properties)
      ? parsed.properties
          .filter(
            (p: unknown): p is DbProperty =>
              !!p &&
              typeof p === 'object' &&
              typeof (p as DbProperty).id === 'string' &&
              typeof (p as DbProperty).name === 'string' &&
              typeof (p as DbProperty).type === 'string'
          )
          // Type inconnu → « text » POUR L'AFFICHAGE, l'original mis de côté
          // (voir `unknownType`) ; options non conformes filtrées.
          .map((p: DbProperty): DbProperty => {
            const connu = (VALID_TYPES as readonly string[]).includes(p.type);
            // La recopie des champs INCONNUS enveloppe la reconstruction : sans
            // elle, on n'appliquait que la moitié « type » de la règle gelée
            // avec le mobile, et tout champ ajouté par un client plus récent
            // disparaissait. Trouvé par le témoin partagé, pas par nous.
            return avecInconnus(
              p,
              {
                id: p.id,
                name: p.name,
                type: connu ? p.type : 'text',
                ...(connu ? {} : { unknownType: p.type }),
                options: Array.isArray(p.options)
                  ? p.options.filter(
                      (o) =>
                        !!o &&
                        typeof o.id === 'string' &&
                        typeof o.label === 'string' &&
                        typeof o.color === 'string'
                    )
                  : undefined,
                defaultOptionId:
                  typeof p.defaultOptionId === 'string' ? p.defaultOptionId : undefined,
                // Cible et agrégat sont tolérés même s'ils ne pointent sur rien :
                // une base visée peut n'être pas encore chargée, et rien ne
                // justifierait de perdre la configuration en la lisant
                targetDbId: typeof p.targetDbId === 'string' ? p.targetDbId : undefined,
                // Sens inconnu (client plus récent, donnée abîmée) → sens sortant :
                // le pire des cas montre une cellule vide et modifiable, jamais
                // une colonne qui prétend calculer quelque chose
                direction: p.direction === 'in' ? 'in' : undefined,
                sourcePropertyId:
                  typeof p.sourcePropertyId === 'string' ? p.sourcePropertyId : undefined,
                single: p.single === true ? true : undefined,
                viaPropertyId: typeof p.viaPropertyId === 'string' ? p.viaPropertyId : undefined,
                targetPropertyId:
                  typeof p.targetPropertyId === 'string' ? p.targetPropertyId : undefined,
                aggregate: (DB_AGGREGATES as readonly string[]).includes(p.aggregate as string)
                  ? (p.aggregate as DbAggregate)
                  : undefined,
                // L'EXPRESSION d'une formule. Elle était déclarée sur le type et
                // absente d'ici : la colonne gardait son type et perdait ce
                // qu'elle calcule, à chaque aller-retour du document.
                formula: typeof p.formula === 'string' ? p.formula : undefined,
                // Toute chaîne est gardée, connue ou non (cf. `numberFormat`)
                numberFormat:
                  typeof p.numberFormat === 'string' && p.numberFormat !== ''
                    ? p.numberFormat
                    : undefined,
                // Gardée même inerte (colonne qui n'est pas une Date, déclencheur
                // introuvable) : c'est l'application qui juge, jamais la lecture
                autoDate: parseAutoDate(p.autoDate),
              },
              CHAMPS_COLONNE
            );
          })
      : [];
    const rows = Array.isArray(parsed.rows)
      ? parsed.rows
          .filter(
            (r: unknown): r is DbRow =>
              !!r && typeof r === 'object' && typeof (r as DbRow).id === 'string'
          )
          // Même règle que pour les colonnes : les lignes étaient reconstruites
          // champ par champ, donc elles perdaient exactement la même chose. Le
          // témoin partagé ne le couvrait pas — c'est le raisonnement qui l'a
          // trouvé, une fois la cause connue.
          .map((r: DbRow) =>
            avecInconnus(
              r,
              {
                id: r.id,
                cells: r.cells && typeof r.cells === 'object' ? r.cells : {},
                createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
                updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
                // Un parent qui ne designe rien est tolere ici : `buildRowTree`
                // remonte la ligne a la racine plutot que de la perdre.
                parentId:
                  typeof r.parentId === 'string' && r.parentId !== '' ? r.parentId : undefined,
                pageNoteId:
                  typeof r.pageNoteId === 'string' && r.pageNoteId !== ''
                    ? r.pageNoteId
                    : undefined,
              },
              CHAMPS_LIGNE
            )
          )
      : [];
    const rowTemplates = parseRowTemplates(parsed.rowTemplates);
    // `properties` et `rows` passent APRÈS la recopie et ne sont jamais
    // facultatifs : tout le reste du code les lit sans les vérifier.
    return avecInconnus(
      parsed,
      {
        properties,
        rows,
        ...(rowTemplates ? { rowTemplates } : {}),
        ...(views ? { views } : {}),
        ...(typeof parsed.activeViewId === 'string' ? { activeViewId: parsed.activeViewId } : {}),
        ...(typeof parsed.folderSource === 'string' && parsed.folderSource !== ''
          ? { folderSource: parsed.folderSource }
          : {}),
      },
      CHAMPS_RACINE
    );
  } catch {
    return { properties: [], rows: [] };
  }
}

/** Nom d'une vue d'après sa disposition (« Kanban », « Calendrier »…). */
export function layoutName(type: DbViewType): string {
  return layoutLabel(type, i18nTranslate);
}

/**
 * Base neuve. `view` : la disposition demandée (« Base · Kanban » du menu « / »).
 * Elle devient la PREMIÈRE vue, suivie d'un tableau pour tout voir ; un
 * calendrier ou une frise naissent avec leur colonne de date, sans laquelle ils
 * n'auraient rien à placer.
 */
export function makeDefaultData(view: DbViewType = 'table'): InlineDbData {
  return defaultDbData(view, desktopCreationContext());
}
