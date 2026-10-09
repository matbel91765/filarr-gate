// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/sql/messages.ts @ e6d45c20 — relicencié Apache-2.0 par le titulaire des droits.
/**
 * LES MESSAGES DU MOTEUR SQL : un code, des paramètres, et le texte français
 * qui sert de repli et aux journaux.
 *
 * Le moteur est pur (aucune dépendance à i18next, il tourne aussi hors de
 * l'interface) : il dit QUOI par un code, et l'interface le traduit sous
 * `notes.inlineDb.query.err.<code>` avec les mêmes paramètres. Un texte en dur
 * dans le moteur s'afficherait en français à un utilisateur anglophone.
 */

export const SQL_MESSAGES = {
  // Syntaxe
  unclosedIdentifier: 'Identifiant non refermé',
  unclosedText: 'Texte non refermé',
  unexpectedChar: 'Caractère inattendu « {{char}} »',
  expected: '« {{token}} » attendu',
  nameExpected: 'Nom de colonne ou de table attendu',
  endExpected: 'Fin de requête attendue',
  joinUnsupported: 'Jointure non prise en charge (NATURAL, RIGHT, FULL)',
  notWhat: 'IN, LIKE ou BETWEEN attendu après NOT',
  exprExpected: 'Expression attendue',
  whenExpected: 'WHEN attendu',
  // Exécution
  ambiguousColumn: 'Colonne ambiguë : {{name}}',
  unknownColumn: 'Colonne inconnue : {{name}}',
  unknownTable: 'Table inconnue : {{name}}',
  unknownOperator: 'Opérateur inconnu : {{op}}',
  subqueryWidth: 'La sous-requête rend {{width}} colonnes : une seule est attendue',
  inSubqueryWidth: 'La sous-requête de IN rend {{width}} colonnes : une seule est attendue',
  unsupportedExpr: 'Expression non prise en charge',
  arity: "Mauvais nombre d'arguments pour {{name}}",
  coalesceArity: 'COALESCE demande au moins deux arguments',
  unknownFunction: 'Fonction inconnue : {{name}}',
  aggregateOutsideGroup: "{{name}}() hors d'un groupe",
  unknownAggregate: 'Agrégat inconnu : {{name}}',
  unknownUsingColumn: 'Colonne inconnue dans USING : {{name}}',
  orderByRange: 'ORDER BY {{k}} hors des colonnes',
  joinTooLarge: 'La jointure produit trop de lignes (plus de {{max}})',
  valueCount: '{{values}} valeurs pour {{columns}} colonnes',
  // Traduction d'un INSERT, UPDATE ou DELETE en écritures de bases
  unknownModelTable: 'Table inconnue du modèle : {{name}}',
  backlinkTable:
    "« {{name}} » vient d'un rétrolien : ses liens se calculent. Modifiez la relation d'origine.",
  linkNeedsIds: 'Un lien a besoin des deux identifiants (texte)',
  rowNotFound: 'Ligne introuvable « {{id}} » ({{db}})',
  linkedRowNotFound: 'Ligne liée introuvable « {{id}} » ({{db}})',
  dbNotFound: 'Base introuvable : {{name}}',
  columnWithoutProperty: 'Colonne sans propriété : {{name}}',
  notRowIdInColumn: "« {{value}} » n'est pas un identifiant de ligne (colonne « {{column}} »)",
  notRowId: "« {{value}} » n'est pas un identifiant de ligne",
  idImmutable: "On ne change pas l'identifiant d'une ligne (« {{id}} »)",
  idTaken: "L'identifiant « {{id}} » est déjà pris",
  folderDb:
    '« {{db}} » reflète un dossier : ses lignes suivent les fichiers, une requête ne les modifie pas',
  computedColumn: "« {{column}} » est calculée : elle ne s'écrit pas",
  notNumber: "« {{value}} » n'est pas un nombre (colonne « {{column}} »)",
  notBoolean: "« {{value}} » n'est ni 0 ni 1 (case « {{column}} »)",
  unknownOption: 'Option inconnue « {{label}} » (colonne « {{column}} »)',
  notDate: "« {{value}} » n'est pas une date (colonne « {{column}} »)",
  relationColumn: '« {{column}} » est une relation : passez par sa clé ou sa table de liens',
} as const;

export type SqlMessageCode = keyof typeof SQL_MESSAGES;
export type SqlMessageParams = Readonly<Record<string, string | number>>;

export interface SqlMessage {
  code: SqlMessageCode;
  params: SqlMessageParams;
  /** Le texte français, paramètres posés. */
  text: string;
}

export function sqlMessageText(code: SqlMessageCode, params: SqlMessageParams = {}): string {
  return SQL_MESSAGES[code].replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
    k in params ? String(params[k]) : ''
  );
}

export function sqlMessage(code: SqlMessageCode, params: SqlMessageParams = {}): SqlMessage {
  return { code, params, text: sqlMessageText(code, params) };
}
