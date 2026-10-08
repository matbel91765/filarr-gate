// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/dbTemplatesModel.ts @ e3502763 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * LES MODÈLES DE BASE, sans React ni i18n — « Par où commencer ? » d'une base
 * neuve, le menu « Modèles ▾ » et le mode « Un modèle » du panneau « Nouvelle
 * base ».
 *
 * Une base vierge ne sait rien de ce qu'on veut suivre : Nom et Statut, trois
 * lignes vides. Les modèles donnent d'emblée les colonnes TYPÉES et la vue qui
 * va avec (kanban des lectures par statut, graphique du budget par catégorie…),
 * ce qu'on mettrait dix minutes à monter à la main.
 *
 * Module PUR recopié tel quel par le mobile (contrat `inline-database-create`) :
 * les modèles sont de la DONNÉE, identique à l'octet sur toutes les surfaces ;
 * textes, identifiants et heure sont injectés (`CreationContext`). Les noms sont
 * traduits À LA CRÉATION (comme les propriétés d'une base neuve) : la base
 * appartient ensuite à l'utilisateur, elle ne change pas de langue avec l'app.
 */

import type { DbCalculation } from './columnCalculations';
import type {
  DbFilterOp,
  DbNumberFormat,
  DbProperty,
  DbSelectOption,
  DbSortDirection,
  DbView,
  DbViewType,
  InlineDbData,
  PropertyType,
} from './types';
import { layoutLabel, makeNamedView, makeRow, type Translate } from './dbCore';

/** Ce que les modules purs de création reçoivent de leur surface */
export interface CreationContext {
  translate: Translate;
  /** Identifiants neufs (propriétés, options, vues, filtres, lignes) */
  ids: () => string;
  /** L'heure de création des lignes */
  now: Date;
}

export type DbTemplateId =
  | 'tasks'
  | 'reading'
  | 'groceries'
  | 'budget'
  | 'contacts'
  | 'jobs'
  | 'habits'
  | 'trip'
  | 'watchlist'
  | 'feedback';

interface OptionSpec {
  key: string;
  fallback: string;
  color: string;
}

interface PropertySpec {
  /** Repère interne, pour que les vues désignent leurs colonnes */
  ref: string;
  key: string;
  fallback: string;
  type: PropertyType;
  options?: OptionSpec[];
  numberFormat?: DbNumberFormat;
  /**
   * Formule, écrite avec les NOMS des colonnes tels qu'ils sortent traduits à
   * la création (`prop("Résolu le")` en français, `prop("Resolved")` en anglais) :
   * une formule désigne ses colonnes par leur nom, pas par leur identifiant.
   */
  formula?: (nameOf: (ref: string) => string) => string;
  /** Option posée d'office sur une nouvelle ligne, par sa clé courte (`fbTriage`) */
  defaultOption?: string;
  /** Date posée d'office (`DbProperty.autoDate`) : la Sélection qui déclenche et ses options */
  autoDate?: { trigger: string; options: string[] };
}

/** Un filtre de vue : `option` désigne une option de la colonne par sa clé de modèle. */
interface FilterSpec {
  prop: string;
  op: DbFilterOp;
  option?: string;
}

interface ViewSpec {
  type: DbViewType;
  /** Nom propre de la vue (« Bugs ouverts ») ; absent : le nom de la disposition */
  name?: { key: string; fallback: string };
  groupBy?: string;
  tableGroupBy?: string;
  dateProperty?: string;
  /** `valueProp` absent : un graphique qui COMPTE les lignes par tranche */
  chart?: { groupBy: string; valueProp?: string };
  calculations?: Record<string, DbCalculation>;
  filters?: FilterSpec[];
  sorts?: Array<{ prop: string; direction: DbSortDirection }>;
  /** Colonnes masquées dans cette vue */
  hidden?: string[];
  form?: { titleKey: string; titleFallback: string; required?: string[] };
}

interface TemplateSpec {
  id: DbTemplateId;
  icon: string;
  nameKey: string;
  nameFallback: string;
  /** Source de l'éclair (remplir une ligne depuis un catalogue), s'il y en a une */
  source?: string;
  properties: PropertySpec[];
  views: ViewSpec[];
}

const opt = (key: string, fallback: string, color: string): OptionSpec => ({
  key: `notes.inlineDb.tpl.opt.${key}`,
  fallback,
  color,
});
const prop = (
  ref: string,
  fallback: string,
  type: PropertyType,
  extra: Partial<PropertySpec> = {}
): PropertySpec => ({ ref, key: `notes.inlineDb.tpl.prop.${ref}`, fallback, type, ...extra });

const TEMPLATES: TemplateSpec[] = [
  {
    // Le suivi le plus demandé : c'est lui que « /kanban » appelle d'un nom
    id: 'tasks',
    icon: '📋',
    nameKey: 'notes.inlineDb.tpl.tasks',
    nameFallback: 'Tasks',
    properties: [
      prop('task', 'Task', 'text'),
      prop('status', 'Status', 'select', {
        options: [
          opt('todo', 'To do', 'gray'),
          opt('doing', 'In progress', 'blue'),
          opt('review', 'In review', 'amber'),
          opt('done', 'Done', 'green'),
        ],
      }),
      prop('priority', 'Priority', 'select', {
        options: [
          opt('high', 'High', 'red'),
          opt('medium', 'Medium', 'amber'),
          opt('low', 'Low', 'gray'),
        ],
      }),
      prop('due', 'Due', 'date'),
      prop('owner', 'Owner', 'person'),
    ],
    views: [
      { type: 'board', groupBy: 'status' },
      { type: 'table' },
      { type: 'calendar', dateProperty: 'due' },
    ],
  },
  {
    id: 'reading',
    icon: '📚',
    nameKey: 'notes.inlineDb.tpl.reading',
    nameFallback: 'Reading list',
    source: 'books',
    properties: [
      prop('title', 'Title', 'text'),
      prop('author', 'Author', 'text'),
      prop('readStatus', 'Status', 'select', {
        options: [
          opt('toRead', 'To read', 'gray'),
          opt('reading', 'Reading', 'blue'),
          opt('read', 'Read', 'green'),
        ],
      }),
      prop('rating', 'Rating', 'rating'),
      prop('genre', 'Genre', 'multiSelect', {
        options: [
          opt('novel', 'Novel', 'purple'),
          opt('essay', 'Essay', 'teal'),
          opt('scifi', 'Sci-fi', 'indigo'),
          opt('comics', 'Comics', 'orange'),
        ],
      }),
      prop('finished', 'Finished on', 'date'),
    ],
    views: [{ type: 'board', groupBy: 'readStatus' }, { type: 'table' }],
  },
  {
    id: 'groceries',
    icon: '🛒',
    nameKey: 'notes.inlineDb.tpl.groceries',
    nameFallback: 'Groceries',
    properties: [
      prop('item', 'Item', 'text'),
      prop('aisle', 'Aisle', 'select', {
        options: [
          opt('produce', 'Fruit & veg', 'green'),
          opt('fresh', 'Fresh', 'sky'),
          opt('pantry', 'Pantry', 'amber'),
          opt('drinks', 'Drinks', 'cyan'),
          opt('household', 'Household', 'purple'),
        ],
      }),
      prop('qty', 'Quantity', 'text'),
      prop('bought', 'Bought', 'checkbox'),
    ],
    views: [{ type: 'table', tableGroupBy: 'aisle', calculations: { bought: 'percentChecked' } }],
  },
  {
    id: 'budget',
    icon: '💶',
    nameKey: 'notes.inlineDb.tpl.budget',
    nameFallback: 'Budget',
    properties: [
      prop('entry', 'Item', 'text'),
      prop('amount', 'Amount', 'number', { numberFormat: 'euro' }),
      prop('category', 'Category', 'select', {
        options: [
          opt('housing', 'Housing', 'blue'),
          opt('food', 'Food', 'green'),
          opt('transport', 'Transport', 'amber'),
          opt('leisure', 'Leisure', 'pink'),
          opt('subscriptions', 'Subscriptions', 'purple'),
          opt('health', 'Health', 'teal'),
        ],
      }),
      prop('kind', 'Type', 'select', {
        options: [opt('expense', 'Expense', 'red'), opt('income', 'Income', 'green')],
      }),
      prop('date', 'Date', 'date'),
    ],
    views: [
      { type: 'table', calculations: { amount: 'sum' } },
      { type: 'chart', chart: { groupBy: 'category', valueProp: 'amount' } },
    ],
  },
  {
    id: 'contacts',
    icon: '👥',
    nameKey: 'notes.inlineDb.tpl.contacts',
    nameFallback: 'Contacts',
    properties: [
      prop('name', 'Name', 'text'),
      prop('company', 'Company', 'text'),
      prop('email', 'Email', 'email'),
      prop('phone', 'Phone', 'phone'),
      prop('circle', 'Circle', 'select', {
        options: [
          opt('family', 'Family', 'rose'),
          opt('friends', 'Friends', 'amber'),
          opt('work', 'Work', 'blue'),
        ],
      }),
      prop('birthday', 'Birthday', 'date'),
    ],
    views: [{ type: 'table' }, { type: 'gallery' }],
  },
  {
    id: 'jobs',
    icon: '💼',
    nameKey: 'notes.inlineDb.tpl.jobs',
    nameFallback: 'Job applications',
    properties: [
      prop('role', 'Role', 'text'),
      prop('company', 'Company', 'text'),
      prop('stage', 'Stage', 'select', {
        options: [
          opt('toSend', 'To send', 'gray'),
          opt('sent', 'Sent', 'blue'),
          opt('interview', 'Interview', 'amber'),
          opt('offer', 'Offer', 'green'),
          opt('rejected', 'Rejected', 'red'),
        ],
      }),
      prop('date', 'Date', 'date'),
      prop('link', 'Link', 'url'),
      prop('salary', 'Salary', 'number', { numberFormat: 'euro' }),
    ],
    views: [{ type: 'board', groupBy: 'stage' }, { type: 'table' }],
  },
  {
    id: 'habits',
    icon: '✅',
    nameKey: 'notes.inlineDb.tpl.habits',
    nameFallback: 'Habit tracker',
    properties: [
      prop('day', 'Day', 'date'),
      prop('sport', 'Exercise', 'checkbox'),
      prop('reading', 'Reading', 'checkbox'),
      prop('sleep', 'Early night', 'checkbox'),
      prop('mood', 'Mood', 'rating'),
    ],
    views: [
      {
        type: 'table',
        calculations: {
          sport: 'percentChecked',
          reading: 'percentChecked',
          sleep: 'percentChecked',
        },
      },
      { type: 'calendar', dateProperty: 'day' },
    ],
  },
  {
    id: 'trip',
    icon: '🧳',
    nameKey: 'notes.inlineDb.tpl.trip',
    nameFallback: 'Trip plan',
    properties: [
      prop('step', 'Step', 'text'),
      prop('date', 'Date', 'date'),
      prop('kind', 'Type', 'select', {
        options: [
          opt('transport', 'Transport', 'sky'),
          opt('stay', 'Stay', 'purple'),
          opt('visit', 'Visit', 'green'),
          opt('meal', 'Meals', 'orange'),
        ],
      }),
      prop('price', 'Price', 'number', { numberFormat: 'euro' }),
      prop('booked', 'Booked', 'checkbox'),
      prop('link', 'Link', 'url'),
    ],
    views: [
      { type: 'table', calculations: { price: 'sum' } },
      { type: 'calendar', dateProperty: 'date' },
    ],
  },
  {
    id: 'watchlist',
    icon: '🎬',
    nameKey: 'notes.inlineDb.tpl.watchlist',
    nameFallback: 'Movies & series',
    source: 'movies',
    properties: [
      prop('title', 'Title', 'text'),
      prop('format', 'Type', 'select', {
        options: [
          opt('movie', 'Movie', 'indigo'),
          opt('series', 'Series', 'teal'),
          opt('documentary', 'Documentary', 'amber'),
        ],
      }),
      prop('watchStatus', 'Status', 'select', {
        options: [
          opt('toWatch', 'To watch', 'gray'),
          opt('watching', 'Watching', 'blue'),
          opt('watched', 'Watched', 'green'),
        ],
      }),
      prop('rating', 'Rating', 'rating'),
      prop('year', 'Year', 'number'),
    ],
    views: [{ type: 'gallery' }, { type: 'board', groupBy: 'watchStatus' }, { type: 'table' }],
  },
  {
    // Le suivi des retours, bugs et idées : ce qu'on signale, ce qu'on corrige,
    // quand, et dans quelle version. Un bug corrigé se dit par son STATUT
    // (« Résolu ») et sa date (« Résolu le ») ; le délai se calcule tout seul.
    id: 'feedback',
    icon: '🐞',
    nameKey: 'notes.inlineDb.tpl.feedback',
    nameFallback: 'Feedback & bugs',
    properties: [
      prop('fbTitle', 'Title', 'text'),
      prop('fbType', 'Type', 'select', {
        options: [
          opt('fbBug', 'Bug', 'red'),
          opt('fbImprovement', 'Improvement', 'blue'),
          opt('fbFeature', 'New feature', 'purple'),
          opt('fbQuestion', 'Question', 'amber'),
        ],
      }),
      prop('fbStatus', 'Status', 'select', {
        options: [
          opt('fbTriage', 'To triage', 'gray'),
          opt('fbTodo', 'To do', 'sky'),
          opt('fbDoing', 'In progress', 'blue'),
          opt('fbVerify', 'To verify', 'amber'),
          opt('fbResolved', 'Resolved', 'green'),
          opt('fbDropped', 'Dropped', 'rose'),
        ],
        // Une entrée saisie n'est pas encore jugée : elle naît « À trier »
        defaultOption: 'fbTriage',
      }),
      prop('fbPriority', 'Priority', 'select', {
        options: [
          opt('fbCritical', 'Critical', 'red'),
          opt('fbHigh', 'High', 'orange'),
          opt('fbMedium', 'Medium', 'amber'),
          opt('fbLow', 'Low', 'gray'),
        ],
      }),
      // Domaines GÉNÉRIQUES : chacun y range son propre produit. Une valeur
      // inconnue, à la saisie comme à l'import, devient une option de plus.
      prop('fbArea', 'Area', 'select', {
        options: [
          opt('fbAreaUi', 'Interface', 'pink'),
          opt('fbAreaPerf', 'Performance', 'orange'),
          opt('fbAreaData', 'Data', 'indigo'),
          opt('fbAreaAccount', 'Account', 'amber'),
          opt('fbAreaSecurity', 'Security', 'red'),
          opt('fbAreaOther', 'Other', 'gray'),
        ],
      }),
      prop('fbPlatform', 'Platform', 'multiSelect', {
        options: [
          opt('fbDesktop', 'Desktop', 'blue'),
          opt('fbWeb', 'Web', 'teal'),
          opt('fbMobile', 'Mobile', 'orange'),
        ],
      }),
      prop('fbReported', 'Reported', 'date'),
      // Se remplit quand le statut passe à « Résolu », s'efface s'il en sort
      prop('fbResolvedOn', 'Resolved on', 'date', {
        autoDate: { trigger: 'fbStatus', options: ['fbResolved'] },
      }),
      prop('fbVersion', 'Version', 'text'),
      prop('fbDelay', 'Days to resolve', 'formula', {
        // Le délai part de « Signalé le », à défaut du jour où la ligne est née.
        // Une entrée résolue AVANT d'être saisie (historique importé) n'a pas de
        // délai connu : vide, plutôt qu'un nombre négatif qui ne veut rien dire.
        formula: (n) => {
          const resolved = `prop("${n('fbResolvedOn')}")`;
          const reported = `prop("${n('fbReported')}")`;
          const sinceCreated = `datediff(${resolved}, prop("${n('fbCreated')}"))`;
          return (
            `if(isempty(${resolved}), "", ` +
            `if(not(isempty(${reported})), datediff(${resolved}, ${reported}), ` +
            `if(${sinceCreated} >= 0, ${sinceCreated}, "")))`
          );
        },
      }),
      prop('fbDescription', 'Description', 'text'),
      prop('fbFollowUp', 'Follow-up', 'text'),
      prop('fbLink', 'Link', 'url'),
      prop('fbCreated', 'Created', 'createdTime'),
    ],
    views: [
      { type: 'board', groupBy: 'fbStatus', hidden: ['fbDescription', 'fbFollowUp', 'fbCreated'] },
      {
        type: 'table',
        name: { key: 'notes.inlineDb.tpl.view.fbOpenBugs', fallback: 'Open bugs' },
        filters: [
          { prop: 'fbType', op: 'is', option: 'fbBug' },
          { prop: 'fbStatus', op: 'isNot', option: 'fbResolved' },
          { prop: 'fbStatus', op: 'isNot', option: 'fbDropped' },
        ],
        sorts: [{ prop: 'fbPriority', direction: 'asc' }],
        hidden: ['fbResolvedOn', 'fbVersion', 'fbDelay', 'fbCreated'],
      },
      {
        type: 'table',
        name: { key: 'notes.inlineDb.tpl.view.fbByArea', fallback: 'By area' },
        tableGroupBy: 'fbArea',
        hidden: ['fbCreated'],
      },
      {
        type: 'calendar',
        name: { key: 'notes.inlineDb.tpl.view.fbResolutions', fallback: 'Resolutions' },
        dateProperty: 'fbResolvedOn',
      },
      {
        type: 'chart',
        name: { key: 'notes.inlineDb.tpl.view.fbChart', fallback: 'By area (chart)' },
        chart: { groupBy: 'fbArea' },
      },
      {
        type: 'form',
        name: { key: 'notes.inlineDb.tpl.view.fbForm', fallback: 'New entry' },
        form: {
          titleKey: 'notes.inlineDb.tpl.form.fbTitle',
          titleFallback: 'Report feedback or a bug',
          required: ['fbTitle'],
        },
        hidden: ['fbDelay', 'fbCreated'],
      },
    ],
  },
];

export interface DbTemplateSummary {
  id: DbTemplateId;
  icon: string;
  name: string;
  /** Les colonnes, pour qu'on choisisse en connaissance de cause */
  columns: string;
  /** Les mêmes, avec leur type : l'aperçu du panneau de création les montre */
  properties: Array<{ name: string; type: PropertyType }>;
  /** Dispositions des vues du modèle, la première ouvre la base */
  views: DbViewType[];
  /** Une colonne de choix peut ranger un kanban ou trancher un graphique */
  hasSelect: boolean;
  /** Une date peut placer les lignes dans un calendrier ou une frise */
  hasDate: boolean;
}

/** Les modèles tels que le panneau les propose, noms traduits */
export function templateSummaries(translate: Translate): DbTemplateSummary[] {
  return TEMPLATES.map((tpl) => ({
    id: tpl.id,
    icon: tpl.icon,
    name: translate(tpl.nameKey, tpl.nameFallback),
    columns: tpl.properties.map((p) => translate(p.key, p.fallback)).join(' · '),
    properties: tpl.properties.map((p) => ({ name: translate(p.key, p.fallback), type: p.type })),
    views: tpl.views.map((v) => v.type),
    hasSelect: tpl.properties.some((p) => p.type === 'select'),
    hasDate: tpl.properties.some((p) => p.type === 'date'),
  }));
}

/**
 * Données d'une base tirée d'un modèle : colonnes typées, options colorées,
 * vues réglées, une ligne vide pour commencer à taper. `null` pour un
 * identifiant inconnu. Les identifiants sont tirés dans cet ordre : colonnes et
 * leurs options, puis chaque vue et ses filtres, puis la ligne de départ.
 */
export function templateData(
  id: DbTemplateId,
  ctx: CreationContext
): { data: InlineDbData; title: string; source?: string } | null {
  const tpl = TEMPLATES.find((x) => x.id === id);
  if (!tpl) return null;
  const tr = ctx.translate;

  const idByRef = new Map<string, string>();
  const nameByRef = new Map<string, string>();
  /** `<ref colonne>.<clé courte d'option>` → id d'option : ce que les filtres désignent */
  const optionIdByRef = new Map<string, string>();
  const properties: DbProperty[] = tpl.properties.map((spec) => {
    const propId = ctx.ids();
    idByRef.set(spec.ref, propId);
    const name = tr(spec.key, spec.fallback);
    nameByRef.set(spec.ref, name);
    const options: DbSelectOption[] | undefined = spec.options?.map((o) => {
      const optionId = ctx.ids();
      optionIdByRef.set(`${spec.ref}.${o.key.split('.').pop()}`, optionId);
      return { id: optionId, label: tr(o.key, o.fallback), color: o.color };
    });
    const defaultOptionId = spec.defaultOption
      ? optionIdByRef.get(`${spec.ref}.${spec.defaultOption}`)
      : undefined;
    return {
      id: propId,
      name,
      type: spec.type,
      ...(options ? { options } : {}),
      ...(defaultOptionId ? { defaultOptionId } : {}),
      ...(spec.numberFormat ? { numberFormat: spec.numberFormat } : {}),
    };
  });
  // Les formules après coup : elles nomment des colonnes qui peuvent venir après elles
  tpl.properties.forEach((spec, index) => {
    const property = properties[index]!;
    if (spec.formula) property.formula = spec.formula((r) => nameByRef.get(r) ?? r);
    const auto = spec.autoDate;
    if (auto) {
      const propertyId = idByRef.get(auto.trigger);
      const optionIds = auto.options
        .map((o) => optionIdByRef.get(`${auto.trigger}.${o}`))
        .filter((x): x is string => !!x);
      if (propertyId && optionIds.length > 0) {
        property.autoDate = { propertyId, optionIds };
      }
    }
  });
  const ref = (r: string | undefined) => (r ? idByRef.get(r) : undefined);

  const views: DbView[] = tpl.views.map((spec) => {
    const view: DbView = makeNamedView(
      spec.name ? tr(spec.name.key, spec.name.fallback) : layoutLabel(spec.type, tr),
      spec.type,
      ref(spec.groupBy),
      ctx.ids()
    );
    if (spec.filters) {
      view.filters = spec.filters.flatMap((f) => {
        const propertyId = ref(f.prop);
        const value = f.option ? optionIdByRef.get(`${f.prop}.${f.option}`) : undefined;
        if (!propertyId || (f.option && !value)) return [];
        return [{ id: ctx.ids(), propertyId, op: f.op, ...(value ? { value } : {}) }];
      });
    }
    if (spec.sorts) {
      view.sorts = spec.sorts.flatMap((s) => {
        const propertyId = ref(s.prop);
        return propertyId ? [{ propertyId, direction: s.direction }] : [];
      });
    }
    if (spec.hidden) {
      const hidden = spec.hidden.map((r) => ref(r)).filter((x): x is string => !!x);
      if (hidden.length > 0) view.hiddenPropertyIds = hidden;
    }
    if (spec.form) {
      const required = (spec.form.required ?? [])
        .map((r) => ref(r))
        .filter((x): x is string => !!x);
      view.form = {
        title: tr(spec.form.titleKey, spec.form.titleFallback),
        ...(required.length > 0 ? { requiredPropertyIds: required } : {}),
      };
    }
    const tableGroupBy = ref(spec.tableGroupBy);
    if (tableGroupBy) view.tableGroupBy = tableGroupBy;
    const dateProperty = ref(spec.dateProperty);
    if (dateProperty) view.dateProperty = dateProperty;
    if (spec.chart) {
      const groupBy = ref(spec.chart.groupBy);
      const valueProp = ref(spec.chart.valueProp);
      if (groupBy && valueProp) view.chart = { kind: 'bar', groupBy, measure: 'sum', valueProp };
      else if (groupBy && !spec.chart.valueProp)
        view.chart = { kind: 'bar', groupBy, measure: 'count' };
    }
    if (spec.calculations) {
      const calculations: Record<string, DbCalculation> = {};
      for (const [r, calc] of Object.entries(spec.calculations)) {
        const propId = ref(r);
        if (propId) calculations[propId] = calc;
      }
      view.calculations = calculations;
    }
    return view;
  });

  // La ligne de départ naît dans la PREMIÈRE colonne du kanban d'ouverture
  // (« À lire »), et non dans « Sans valeur » où personne ne la cherche
  const lead = views[0]!;
  const board = lead.type === 'board' ? lead.groupBy : undefined;
  const firstOption = properties.find((p) => p.id === board)?.options?.[0]?.id;
  const firstRow = makeRow(
    properties,
    board && firstOption ? { [board]: firstOption } : {},
    ctx.ids,
    ctx.now
  );
  return {
    data: { properties, rows: [firstRow], views, activeViewId: lead.id },
    title: tr(tpl.nameKey, tpl.nameFallback),
    ...(tpl.source ? { source: tpl.source } : {}),
  };
}
