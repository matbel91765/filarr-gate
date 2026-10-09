// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/dbCreationModel.ts @ e3502763 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * « Nouvelle base » — ce que le panneau de création décide, sans React ni i18n.
 *
 * Le panneau s'ouvre AVANT l'insertion (menu « / », bouton Base de la barre) :
 * on y choisit le nom, la première vue, les colonnes de départ, les colonnes du
 * kanban, ou bien un modèle, un import, un dossier du coffre. Tout ce qui décide
 * du CONTENU de la base vit ici, pour deux raisons :
 *
 *  · l'aperçu et la création lisent la MÊME fonction (`buildCreatedDb`) — un
 *    aperçu calculé à part finit toujours par montrer autre chose que ce qu'on
 *    obtient ;
 *  · rien de neuf n'entre dans le document : ce module ne compose que des
 *    champs déjà gelés (fiche `2026-09-24-bases-panneau-creation`).
 *
 * Module PUR recopié tel quel par le mobile (contrat `inline-database-create`) :
 * sa feuille n'a pas la mise en page du panneau, mais les mêmes réglages donnent
 * la même base. Textes, identifiants et heure sont injectés (`CreationContext`).
 * Le panneau du bureau ne garde que l'état et la mise en page ; figé de
 * l'extérieur par `dbCreatePanelCharacterization.vitest.ts`.
 */

import type { DbTemplateId, DbTemplateSummary } from './dbTemplatesModel';
import { templateData, type CreationContext } from './dbTemplatesModel';
import type { ImportRequestKind } from './importRequests';
import type {
  DbProperty,
  DbSelectOption,
  DbView,
  DbViewType,
  InlineDbData,
  PropertyType,
} from './types';
import { layoutLabel, makeNamedView, makeRow, type Translate } from './dbCore';

export type { CreationContext } from './dbTemplatesModel';

export type DbCreateMode = 'columns' | 'template' | 'import' | 'folder';

/** Colonnes qu'on peut cocher au départ (« Nom » est toujours là) */
export type StarterKey =
  | 'status'
  | 'date'
  | 'priority'
  | 'person'
  | 'tags'
  | 'number'
  | 'checkbox'
  | 'url';

/** Les deux colonnes de choix qui peuvent ranger un kanban neuf */
export type LaneGroup = 'status' | 'priority';

export interface LaneDraft {
  label: string;
  /** Nom de couleur de `DB_OPTION_COLORS` */
  color: string;
}

export interface DbCreateConfig {
  name: string;
  mode: DbCreateMode;
  layout: DbViewType;
  /**
   * La disposition a été DEMANDÉE (« /kanban », clic sur une tuile) : un
   * modèle choisi ensuite la garde s'il peut la porter, au lieu d'imposer sa
   * propre première vue.
   */
  layoutChosen: boolean;
  starters: StarterKey[];
  groupBy: LaneGroup;
  lanes: Record<LaneGroup, LaneDraft[]>;
  templateId: DbTemplateId;
  importKind: ImportRequestKind;
  folderId: string;
}

/** Ordre des tuiles : les quatre de tous les jours d'abord */
export const CREATE_LAYOUTS: readonly DbViewType[] = [
  'table',
  'board',
  'calendar',
  'gallery',
  'timeline',
  'chart',
  'form',
];

export const STARTER_KEYS: readonly StarterKey[] = [
  'status',
  'date',
  'priority',
  'person',
  'tags',
  'number',
  'checkbox',
  'url',
];

export const STARTER_TYPES: Record<StarterKey, PropertyType> = {
  status: 'select',
  date: 'date',
  priority: 'select',
  person: 'person',
  tags: 'multiSelect',
  number: 'number',
  checkbox: 'checkbox',
  url: 'url',
};

/** Au-delà, un kanban ne se lit plus d'un coup d'œil ; on en ajoute ensuite dans la base */
export const MAX_LANES = 8;

/** Nom donné à la colonne. Traduit À LA CRÉATION, comme les colonnes d'une base neuve. */
export function starterName(key: StarterKey, translate: Translate): string {
  switch (key) {
    case 'status':
      return translate('notes.inlineDb.defaultStatusProp', 'Status');
    case 'date':
      return translate('notes.inlineDb.defaultDateProp', 'Date');
    case 'priority':
      return translate('notes.inlineDb.create.col.priority', 'Priority');
    case 'person':
      return translate('notes.inlineDb.create.col.person', 'Owner');
    case 'tags':
      return translate('notes.inlineDb.create.col.tags', 'Tags');
    case 'number':
      return translate('notes.inlineDb.create.col.number', 'Number');
    case 'checkbox':
      return translate('notes.inlineDb.create.col.checkbox', 'Checkbox');
    case 'url':
      return translate('notes.inlineDb.create.col.url', 'Link');
  }
}

export function defaultLanes(translate: Translate): Record<LaneGroup, LaneDraft[]> {
  return {
    status: [
      { label: translate('notes.inlineDb.statusTodo', 'To do'), color: 'gray' },
      { label: translate('notes.inlineDb.statusDoing', 'In progress'), color: 'blue' },
      { label: translate('notes.inlineDb.statusDone', 'Done'), color: 'green' },
    ],
    priority: [
      { label: translate('notes.inlineDb.create.prio.high', 'High'), color: 'red' },
      { label: translate('notes.inlineDb.create.prio.medium', 'Medium'), color: 'amber' },
      { label: translate('notes.inlineDb.create.prio.low', 'Low'), color: 'gray' },
    ],
  };
}

export function initialCreateConfig(
  opts: { layout?: DbViewType; mode?: DbCreateMode; importKind?: ImportRequestKind },
  translate: Translate
): DbCreateConfig {
  return {
    name: '',
    mode: opts.mode ?? 'columns',
    layout: opts.layout ?? 'table',
    // « /kanban », « /calendrier »… : la disposition est une demande, pas un défaut
    layoutChosen: opts.layout !== undefined && opts.layout !== 'table',
    // La base d'avant le panneau : Nom et Statut
    starters: ['status'],
    groupBy: 'status',
    lanes: defaultLanes(translate),
    templateId: 'tasks',
    importKind: opts.importKind ?? 'note',
    folderId: '',
  };
}

/**
 * La colonne sans laquelle la première vue n'aurait rien à montrer : un kanban
 * range par une colonne de choix, un calendrier et une frise placent sur une
 * date, un graphique compte par statut. Elle reste cochée, et le panneau dit
 * pourquoi.
 */
export function requiredStarter(layout: DbViewType, groupBy: LaneGroup): StarterKey | null {
  if (layout === 'board') return groupBy;
  if (layout === 'calendar' || layout === 'timeline') return 'date';
  if (layout === 'chart') return 'status';
  return null;
}

/** Colonnes de départ réellement créées, dans l'ordre des tuiles */
export function effectiveStarters(
  config: Pick<DbCreateConfig, 'starters' | 'layout' | 'groupBy'>
): StarterKey[] {
  const required = requiredStarter(config.layout, config.groupBy);
  return STARTER_KEYS.filter((k) => k === required || config.starters.includes(k));
}

/** Couleur d'une colonne ajoutée : une teinte vive que le kanban n'a pas encore */
const LANE_COLORS = ['blue', 'green', 'amber', 'purple', 'teal', 'pink', 'orange', 'red'];
export function nextLaneColor(lanes: LaneDraft[]): string {
  const used = new Set(lanes.map((l) => l.color));
  return LANE_COLORS.find((c) => !used.has(c)) ?? 'gray';
}

/**
 * Colonnes du kanban telles qu'elles seront ÉCRITES : libellés resserrés,
 * vides et doublons (à la casse près) écartés, huit au plus. Rien ne reste ?
 * Les colonnes d'office — un kanban sans colonne ne range rien.
 */
export function cleanLanes(
  lanes: LaneDraft[],
  group: LaneGroup,
  translate: Translate
): LaneDraft[] {
  const seen = new Set<string>();
  const out: LaneDraft[] = [];
  for (const lane of lanes) {
    const label = lane.label.replace(/\s+/g, ' ').trim();
    const key = label.toLocaleLowerCase();
    if (label === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, color: lane.color || 'gray' });
    if (out.length === MAX_LANES) break;
  }
  return out.length > 0 ? out : defaultLanes(translate)[group];
}

/* ---- Les gestes du panneau ---- */

export const withName = (config: DbCreateConfig, name: string): DbCreateConfig => ({
  ...config,
  name,
});

/** Cocher ou décocher une colonne de départ ; celle qu'exige la première vue reste cochée */
export function toggleStarter(config: DbCreateConfig, key: StarterKey): DbCreateConfig {
  if (config.mode === 'columns' && requiredStarter(config.layout, config.groupBy) === key) {
    return config;
  }
  return {
    ...config,
    starters: config.starters.includes(key)
      ? config.starters.filter((k) => k !== key)
      : [...config.starters, key],
  };
}

/** La colonne de choix qui range le kanban neuf */
export const withGroupBy = (config: DbCreateConfig, groupBy: LaneGroup): DbCreateConfig => ({
  ...config,
  groupBy,
});

const withLanes = (
  config: DbCreateConfig,
  fn: (lanes: LaneDraft[]) => LaneDraft[]
): DbCreateConfig => ({
  ...config,
  lanes: { ...config.lanes, [config.groupBy]: fn(config.lanes[config.groupBy]) },
});

/** Renommer un couloir du kanban (le libellé est nettoyé à l'écriture, pas à la frappe) */
export const renameLane = (config: DbCreateConfig, index: number, label: string): DbCreateConfig =>
  withLanes(config, (ls) => ls.map((l, j) => (j === index ? { ...l, label } : l)));

/** Retirer un couloir ; le dernier reste */
export function removeLane(config: DbCreateConfig, index: number): DbCreateConfig {
  if (config.lanes[config.groupBy].length < 2) return config;
  return withLanes(config, (ls) => ls.filter((_, j) => j !== index));
}

/** Ajouter un couloir, d'une teinte que le kanban n'a pas encore ; refusé à `MAX_LANES` */
export function addLane(config: DbCreateConfig, translate: Translate): DbCreateConfig {
  if (config.lanes[config.groupBy].length >= MAX_LANES) return config;
  return withLanes(config, (ls) => [
    ...ls,
    { label: translate('notes.inlineDb.create.laneNew', 'New column'), color: nextLaneColor(ls) },
  ]);
}

export const withImportKind = (config: DbCreateConfig, importKind: ImportRequestKind) => ({
  ...config,
  importKind,
});

export const withFolder = (config: DbCreateConfig, folderId: string): DbCreateConfig => ({
  ...config,
  folderId,
});

/* ---- Dispositions ---- */

/** Pourquoi une tuile de disposition est grisée */
export type LayoutBlock = 'folderLayout' | 'noSelect' | 'noDate';

export function layoutBlock(
  config: Pick<DbCreateConfig, 'mode' | 'templateId'>,
  layout: DbViewType,
  templates: DbTemplateSummary[]
): LayoutBlock | null {
  // Les colonnes d'un dossier sont celles de ses fichiers : pas de statut à ranger, pas de date à placer
  if (config.mode === 'folder') {
    return layout === 'table' || layout === 'gallery' ? null : 'folderLayout';
  }
  if (config.mode !== 'template') return null;
  const tpl = templates.find((x) => x.id === config.templateId);
  if (!tpl || tpl.views.includes(layout)) return null;
  if ((layout === 'board' || layout === 'chart') && !tpl.hasSelect) return 'noSelect';
  if ((layout === 'calendar' || layout === 'timeline') && !tpl.hasDate) return 'noDate';
  return null;
}

/** Les raisons des tuiles grisées, une fois chacune, dans l'ordre des tuiles */
export function blockReasons(
  config: DbCreateConfig,
  templates: DbTemplateSummary[]
): LayoutBlock[] {
  const out: LayoutBlock[] = [];
  for (const layout of CREATE_LAYOUTS) {
    const block = layoutBlock(config, layout, templates);
    if (block && !out.includes(block)) out.push(block);
  }
  return out;
}

/** Ce que l'écran dit d'une tuile grisée */
export function blockText(block: LayoutBlock, translate: Translate): string {
  return block === 'folderLayout'
    ? translate('notes.inlineDb.create.block.folder', 'A folder shows as a table or a gallery.')
    : block === 'noSelect'
      ? translate(
          'notes.inlineDb.create.block.noSelect',
          'This template has no choice column to sort by.'
        )
      : translate(
          'notes.inlineDb.create.block.noDate',
          'This template has no date to place rows on.'
        );
}

export function withLayout(
  config: DbCreateConfig,
  layout: DbViewType,
  templates: DbTemplateSummary[]
): DbCreateConfig {
  if (layoutBlock(config, layout, templates)) return config;
  return { ...config, layout, layoutChosen: true };
}

export function withTemplate(
  config: DbCreateConfig,
  templateId: DbTemplateId,
  templates: DbTemplateSummary[]
): DbCreateConfig {
  const next: DbCreateConfig = { ...config, mode: 'template', templateId };
  const tpl = templates.find((x) => x.id === templateId);
  if (!tpl) return next;
  const keep = config.layoutChosen && layoutBlock(next, config.layout, templates) === null;
  return { ...next, layout: keep ? config.layout : (tpl.views[0] ?? 'table') };
}

export function withMode(
  config: DbCreateConfig,
  mode: DbCreateMode,
  templates: DbTemplateSummary[]
): DbCreateConfig {
  if (mode === 'template') return withTemplate(config, config.templateId, templates);
  const next: DbCreateConfig = { ...config, mode };
  if (layoutBlock(next, next.layout, templates)) return { ...next, layout: 'table' };
  return next;
}

/** Les façons de commencer : un dossier seulement s'il y en a à afficher */
export function availableModes(hasFolders: boolean): DbCreateMode[] {
  return hasFolders
    ? ['columns', 'template', 'import', 'folder']
    : ['columns', 'template', 'import'];
}

/**
 * Pourquoi une colonne de départ ne se décoche pas : la disposition qui l'exige
 * (`board`, `calendar`, `timeline`, `chart`), ou `null`.
 */
export function lockReason(config: DbCreateConfig): DbViewType | null {
  if (config.mode !== 'columns') return null;
  return requiredStarter(config.layout, config.groupBy) ? config.layout : null;
}

/** Ce que l'écran dit de la colonne verrouillée (vide s'il n'y en a pas) */
export function lockNote(config: DbCreateConfig, translate: Translate): string {
  const layout = lockReason(config);
  const required = requiredStarter(config.layout, config.groupBy);
  if (!layout || !required) return '';
  const name = starterName(required, translate);
  if (layout === 'board') {
    return translate(
      'notes.inlineDb.create.lock.board',
      'The board sorts its cards by “{{name}}”: this column stays.',
      { name }
    );
  }
  if (layout === 'calendar') {
    return translate(
      'notes.inlineDb.create.lock.calendar',
      'The calendar places each row on “{{name}}”: this column stays.',
      { name }
    );
  }
  if (layout === 'timeline') {
    return translate(
      'notes.inlineDb.create.lock.timeline',
      'The timeline places each row on “{{name}}”: this column stays.',
      { name }
    );
  }
  return translate(
    'notes.inlineDb.create.lock.chart',
    'The chart counts rows by “{{name}}”: this column stays.',
    { name }
  );
}

/* ---- Le modèle qui correspond au nom ---- */

/**
 * Mots qui désignent un modèle, sans accents, français puis anglais. Les plus
 * précis passent AVANT « Tâches », le plus général : « Budget du projet » est
 * un budget, « Suivi des candidatures » des candidatures.
 */
const SUGGEST: Array<[DbTemplateId, string[]]> = [
  ['jobs', ['candidature', 'emploi', 'job', 'recrutement', 'postul', 'carriere', 'career']],
  [
    'reading',
    ['lecture', 'livre', 'bouquin', 'a lire', 'bibliotheque', 'book', 'reading', 'library'],
  ],
  ['groceries', ['course', 'epicerie', 'supermarche', 'grocer', 'shopping']],
  [
    'budget',
    ['budget', 'depense', 'finance', 'argent', 'comptabilite', 'expense', 'money', 'spending'],
  ],
  ['contacts', ['contact', 'repertoire', 'annuaire', 'crm', 'people']],
  ['habits', ['habitude', 'routine', 'habit']],
  ['trip', ['voyage', 'vacance', 'sejour', 'itineraire', 'trip', 'travel', 'holiday']],
  ['watchlist', ['film', 'serie', 'cinema', 'movie', 'watchlist', 'tv show']],
  // Avant « Tâches » : « Bugs du projet » se suit comme des bugs, pas comme un projet
  [
    'feedback',
    [
      'bug',
      'feedback',
      'retours',
      'retour testeur',
      'retour client',
      'retour utilisateur',
      'signalement',
      'anomalie',
      'issue',
    ],
  ],
  [
    'tasks',
    [
      'tache',
      'a faire',
      'projet',
      'chantier',
      'todo',
      'to do',
      'task',
      'project',
      'sprint',
      'backlog',
    ],
  ],
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Un mot court ne vaut que tel quel ou au pluriel (« livre », « livres », mais
 * pas « livrer ») ; à partir de six lettres, il vaut comme début de mot
 * (« postul » → « postuler », « candidature » → « candidatures »).
 */
function wordMatches(word: string, key: string): boolean {
  if (word === key || word === `${key}s` || word === `${key}x`) return true;
  return key.length >= 6 && word.startsWith(key);
}

export function suggestTemplate(name: string): DbTemplateId | null {
  const text = normalize(name);
  if (text.length < 3) return null;
  const words = text.split(' ');
  const padded = ` ${text} `;
  for (const [id, keys] of SUGGEST) {
    for (const key of keys) {
      const hit = key.includes(' ')
        ? padded.includes(` ${key} `) || padded.includes(` ${key}s `)
        : words.some((w) => wordMatches(w, key));
      if (hit) return id;
    }
  }
  return null;
}

/** Le modèle à proposer sous le nom : aucun s'il est déjà celui qu'on a choisi */
export function suggestionFor(
  config: DbCreateConfig,
  templates: DbTemplateSummary[]
): DbTemplateSummary | null {
  const id = suggestTemplate(config.name);
  const suggestion = id ? (templates.find((x) => x.id === id) ?? null) : null;
  if (!suggestion) return null;
  return config.mode === 'template' && config.templateId === suggestion.id ? null : suggestion;
}

/* ---- Ce que le panneau crée ---- */

export interface CreatedDb {
  data: InlineDbData;
  /** Titre du bloc ('' : le bloc affiche « Base sans titre ») */
  title: string;
  /** Source de l'éclair d'un modèle (livres, films…) */
  source?: string;
  /** Import à ouvrir dans la base neuve (La Récolte) */
  startWith?: ImportRequestKind;
}

/** Vue « principale » : celle d'une base qui s'ouvre sur un tableau seul */
const mainView = (ctx: CreationContext, type: DbViewType, groupBy?: string): DbView =>
  makeNamedView(ctx.translate('notes.inlineDb.mainView', 'Main view'), type, groupBy, ctx.ids());

/** Vue nommée d'après sa disposition (« Kanban », « Tableau »…) */
const layoutView = (ctx: CreationContext, type: DbViewType, groupBy?: string): DbView =>
  makeNamedView(layoutLabel(type, ctx.translate), type, groupBy, ctx.ids());

/** Première vue d'une base neuve, réglée sur les colonnes qui la font marcher */
function leadView(
  layout: DbViewType,
  refs: { groupBy?: string; date?: string; chartGroup?: string },
  ctx: CreationContext
): DbView {
  // Un tableau seul reste la « Vue principale » d'une base d'avant le panneau
  if (layout === 'table') return mainView(ctx, 'table');
  const view = layoutView(ctx, layout, layout === 'board' ? refs.groupBy : undefined);
  if (layout === 'calendar' && refs.date) view.dateProperty = refs.date;
  if (layout === 'timeline' && refs.date) view.timeline = { startProperty: refs.date };
  if (layout === 'chart' && refs.chartGroup) {
    view.chart = { kind: 'bar', groupBy: refs.chartGroup, measure: 'count' };
  }
  return view;
}

/** Trois lignes vides, cellules d'office posées, pour commencer à taper */
const threeRows = (properties: DbProperty[], ctx: CreationContext) => [
  makeRow(properties, {}, ctx.ids, ctx.now),
  makeRow(properties, {}, ctx.ids, ctx.now),
  makeRow(properties, {}, ctx.ids, ctx.now),
];

/**
 * La base PAR DÉFAUT (contrat § 3). `layout` : la disposition demandée
 * (« Base · Kanban » du menu « / »). Elle devient la PREMIÈRE vue, suivie d'un
 * tableau pour tout voir ; un calendrier ou une frise naissent avec leur colonne
 * de date, sans laquelle ils n'auraient rien à placer.
 */
export function defaultDbData(layout: DbViewType, ctx: CreationContext): InlineDbData {
  const tr = ctx.translate;
  const nameProp: DbProperty = {
    id: ctx.ids(),
    name: tr('notes.inlineDb.defaultNameProp', 'Name'),
    type: 'text',
  };
  const statusOptions: DbSelectOption[] = [
    { id: ctx.ids(), label: tr('notes.inlineDb.statusTodo', 'To do'), color: 'gray' },
    { id: ctx.ids(), label: tr('notes.inlineDb.statusDoing', 'In progress'), color: 'blue' },
    { id: ctx.ids(), label: tr('notes.inlineDb.statusDone', 'Done'), color: 'green' },
  ];
  const statusProp: DbProperty = {
    id: ctx.ids(),
    name: tr('notes.inlineDb.defaultStatusProp', 'Status'),
    type: 'select',
    options: statusOptions,
    // Toute nouvelle ligne naît « À faire » (1re colonne du kanban)
    defaultOptionId: statusOptions[0]!.id,
  };
  const properties: DbProperty[] = [nameProp, statusProp];
  const dateNeeded = layout === 'calendar' || layout === 'timeline';
  const dateProp: DbProperty | null = dateNeeded
    ? { id: ctx.ids(), name: tr('notes.inlineDb.defaultDateProp', 'Date'), type: 'date' }
    : null;
  if (dateProp) properties.push(dateProp);
  const rows = threeRows(properties, ctx);

  // La base naît avec sa vue : seules les bases d'avant la fonctionnalité passent par la migration
  if (layout === 'table') {
    const table = mainView(ctx, 'table');
    return { properties, rows, views: [table], activeViewId: table.id };
  }
  const first = layoutView(ctx, layout, layout === 'board' ? statusProp.id : undefined);
  if (dateProp && layout === 'calendar') first.dateProperty = dateProp.id;
  if (dateProp && layout === 'timeline') first.timeline = { startProperty: dateProp.id };
  const table = layoutView(ctx, 'table');
  return { properties, rows, views: [first, table], activeViewId: first.id };
}

function fromColumns(config: DbCreateConfig, ctx: CreationContext): InlineDbData {
  const nameProp: DbProperty = {
    id: ctx.ids(),
    name: ctx.translate('notes.inlineDb.defaultNameProp', 'Name'),
    type: 'text',
  };
  const properties: DbProperty[] = [nameProp];
  const idOf: Partial<Record<StarterKey, string>> = {};
  const boardGroup = config.layout === 'board' ? config.groupBy : null;
  for (const key of effectiveStarters(config)) {
    const prop: DbProperty = {
      id: ctx.ids(),
      name: starterName(key, ctx.translate),
      type: STARTER_TYPES[key],
    };
    if (key === 'status' || key === 'priority') {
      const options = cleanLanes(config.lanes[key], key, ctx.translate).map((l) => ({
        id: ctx.ids(),
        label: l.label,
        color: l.color,
      }));
      prop.options = options;
      // Une ligne neuve naît dans la PREMIÈRE colonne : le statut toujours (comme
      // la base d'avant), la priorité seulement quand c'est elle qui range le kanban
      if (key === 'status' || boardGroup === 'priority') prop.defaultOptionId = options[0]!.id;
    } else if (key === 'tags') {
      prop.options = [];
    }
    idOf[key] = prop.id;
    properties.push(prop);
  }
  const first = leadView(
    config.layout,
    {
      groupBy: boardGroup ? idOf[boardGroup] : undefined,
      date: idOf.date,
      chartGroup: idOf.status,
    },
    ctx
  );
  // Toute autre première vue est suivie d'un tableau, pour tout voir (comme avant)
  const views = config.layout === 'table' ? [first] : [first, layoutView(ctx, 'table')];
  const rows = threeRows(properties, ctx);
  return { properties, rows, views, activeViewId: first.id };
}

/**
 * Met en tête la vue de la disposition demandée : celle du modèle s'il en a
 * une, sinon une vue neuve réglée sur sa première colonne de choix ou de date.
 * Une disposition que le modèle ne peut pas porter laisse les données telles
 * quelles (le panneau grise d'ailleurs la tuile).
 */
export function withLeadingLayout(
  data: InlineDbData,
  layout: DbViewType,
  ctx: CreationContext
): InlineDbData {
  const views = data.views ?? [];
  const existing = views.find((v) => v.type === layout);
  let lead: DbView;
  let rest: DbView[];
  if (existing) {
    lead = existing;
    rest = views.filter((v) => v !== existing);
  } else {
    const select = data.properties.find((p) => p.type === 'select');
    const date = data.properties.find((p) => p.type === 'date');
    if ((layout === 'board' || layout === 'chart') && !select) return data;
    if ((layout === 'calendar' || layout === 'timeline') && !date) return data;
    lead =
      layout === 'table'
        ? layoutView(ctx, 'table')
        : leadView(layout, { groupBy: select?.id, date: date?.id, chartGroup: select?.id }, ctx);
    rest = views;
  }
  // La ligne de départ naît dans la première colonne du kanban qui ouvre la
  // base, et non dans « Sans valeur » où personne ne la cherche
  let rows = data.rows;
  const groupId = lead.type === 'board' ? lead.groupBy : undefined;
  const firstOption = groupId
    ? data.properties.find((p) => p.id === groupId)?.options?.[0]?.id
    : undefined;
  if (groupId && firstOption) {
    rows = rows.map((r) =>
      r.cells[groupId] === undefined || r.cells[groupId] === null || r.cells[groupId] === ''
        ? { ...r, cells: { ...r.cells, [groupId]: firstOption } }
        : r
    );
  }
  return { ...data, rows, views: [lead, ...rest], activeViewId: lead.id };
}

/**
 * La base que le panneau insère — et que son aperçu montre. `null` quand la
 * configuration ne peut rien créer (aucun dossier choisi, modèle inconnu).
 */
export function buildCreatedDb(
  config: DbCreateConfig,
  ctx: CreationContext,
  opts: { folderName?: string } = {}
): CreatedDb | null {
  const name = config.name.replace(/\s+/g, ' ').trim();
  switch (config.mode) {
    case 'columns':
      return { data: fromColumns(config, ctx), title: name };
    case 'template': {
      const built = templateData(config.templateId, ctx);
      if (!built) return null;
      return {
        data: withLeadingLayout(built.data, config.layout, ctx),
        title: name || built.title,
        ...(built.source ? { source: built.source } : {}),
      };
    }
    case 'import':
      // Base d'office : l'import la REMPLACE entière tant qu'elle est vierge
      return { data: defaultDbData('table', ctx), title: name, startWith: config.importKind };
    case 'folder': {
      if (config.folderId === '') return null;
      const view =
        config.layout === 'gallery' ? layoutView(ctx, 'gallery') : mainView(ctx, 'table');
      return {
        data: {
          properties: [],
          rows: [],
          folderSource: config.folderId,
          views: [view],
          activeViewId: view.id,
        },
        title: name || (opts.folderName ?? ''),
      };
    }
  }
}

/** Le bouton qui crée : « Créer la base », « Créer et importer… », « Afficher le dossier » */
export function submitText(mode: DbCreateMode, translate: Translate): string {
  return mode === 'import'
    ? translate('notes.inlineDb.create.submitImport', 'Create and import…')
    : mode === 'folder'
      ? translate('notes.inlineDb.create.submitFolder', 'Show the folder')
      : translate('notes.inlineDb.create.submit', 'Create database');
}

/* ---- L'aperçu : lu sur les données qui seront insérées ---- */

export interface CreationPreview {
  /** Dispositions des onglets, la première ouvre la base */
  tabs: DbViewType[];
  columns: Array<{ id: string; name: string; type: PropertyType; options: string[] }>;
  /** Colonnes du kanban d'ouverture, dans l'ordre ; `null` si la base ne s'ouvre pas sur un kanban */
  lanes: LaneDraft[] | null;
  rows: number;
}

export function previewOf(data: InlineDbData): CreationPreview {
  const views = data.views ?? [];
  const lead = views[0];
  const group =
    lead?.type === 'board' ? data.properties.find((p) => p.id === lead.groupBy) : undefined;
  return {
    tabs: views.map((v) => v.type),
    columns: data.properties.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      options: (p.options ?? []).map((o) => o.label),
    })),
    lanes: group ? (group.options ?? []).map((o) => ({ label: o.label, color: o.color })) : null,
    rows: data.rows.length,
  };
}

/** Le titre de l'aperçu : celui de la base, sinon « Choisissez un dossier » ou « Base sans titre » */
export function previewTitle(
  created: CreatedDb | null,
  config: DbCreateConfig,
  folderName: string | undefined,
  translate: Translate
): string {
  if (created?.title) return created.title;
  return config.mode === 'folder' && !folderName
    ? translate('notes.inlineDb.create.pickFolder', 'Choose a folder')
    : translate('notes.inlineDb.titlePlaceholder', 'Untitled database');
}

/** La phrase sous l'aperçu, selon ce qui sera créé */
export function previewNote(
  config: DbCreateConfig,
  preview: CreationPreview | null,
  translate: Translate
): string {
  if (config.mode === 'import') {
    return translate(
      'notes.inlineDb.create.note.import',
      'Nothing is written before you confirm: the import shows what it understood first.'
    );
  }
  if (config.mode === 'folder') {
    return translate(
      'notes.inlineDb.create.note.folder',
      'One row per file. Renaming or tagging a row changes the file. Password-protected folders are not offered.'
    );
  }
  if (config.mode === 'template') {
    return translate(
      'notes.inlineDb.create.note.template',
      'One empty row to start. Ctrl+Z removes the whole database.'
    );
  }
  if (config.layout === 'board') {
    return translate(
      'notes.inlineDb.create.note.board',
      'New cards start in “{{name}}”. Dragging a card changes its column.',
      { name: preview?.lanes?.[0]?.label ?? '' }
    );
  }
  return translate(
    'notes.inlineDb.create.note.columns',
    'Three empty rows to start typing. Every column can be renamed or retyped later.'
  );
}

/* ---- Un modèle sur une base neuve (« Modèles ▾ » du bandeau « Commencer depuis ») ---- */

/**
 * Ce que devient une base neuve et vierge quand on lui applique un modèle
 * (contrat § 4) : ses données sont REMPLACÉES entières, son identité (`dbId`)
 * GARDÉE par l'appelant ; le titre du modèle n'est posé que si le bloc n'en a
 * pas ; sa source seulement si la surface la connaît ; la vue active devient la
 * première du modèle. `templateName` : ce que le bandeau d'annulation montre.
 */
export function templateOverDb(
  current: { title: string },
  built: { data: InlineDbData; title: string; source?: string },
  knowsSource: (id: string) => boolean
): {
  data: InlineDbData;
  attrs: { title?: string; source?: string };
  activeViewId: string;
  templateName: string;
} {
  const attrs: { title?: string; source?: string } = {};
  if (current.title.trim() === '') attrs.title = built.title;
  if (built.source && knowsSource(built.source)) attrs.source = built.source;
  return {
    data: built.data,
    attrs,
    activeViewId: built.data.activeViewId ?? '',
    templateName: built.title,
  };
}
