// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/sql/run.ts @ 3e9d65cd — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Exécution du SQL maison sur les tables d'un catalogue — sémantique de
 * SQLite, qui sert d'oracle aux tests (`node:sqlite`) : logique à trois valeurs,
 * affinités de colonnes dans les comparaisons, entiers et réels distincts,
 * NULL en tête d'un ORDER BY croissant, LIKE insensible à la casse ASCII.
 */

import {
  affinityOfDeclared,
  compareSql,
  storeAs,
  fromBool,
  groupKey,
  isTrue,
  logicalOf,
  numericAffinity,
  numericType,
  textAffinity,
  toNumeric,
  toText,
  type Affinity,
  type SqlValue,
} from './values';
import {
  parseSelect,
  parseStatement,
  type DeleteStatement,
  type Expr,
  type InsertStatement,
  type SelectStatement,
  type Statement,
  type UpdateStatement,
} from './parser';
import { sqlMessageText, type SqlMessageCode, type SqlMessageParams } from './messages';

export interface SqlColumn {
  name: string;
  affinity: Affinity;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  rows: SqlValue[][];
}

/** Tables par nom, sans distinction de casse. */
export type SqlCatalog = Map<string, SqlTable>;

/** D'où vient une colonne de résultat : une colonne NUE d'une table de la requête. */
export interface SqlColumnSource {
  /** Nom de la table au catalogue (pas son alias). */
  table: string;
  column: string;
}

export interface SqlResult {
  columns: string[];
  rows: SqlValue[][];
  /**
   * Provenance de chaque colonne : la table et la colonne d'origine quand le
   * résultat la reprend telle quelle (`*`, `t.col`, `col`), `null` pour une
   * expression ou un agrégat. Sert au graphe des résultats (identifiants de
   * lignes reconnus par leur table, pas devinés à leur valeur).
   */
  sources?: Array<SqlColumnSource | null>;
}

export class SqlError extends Error {
  constructor(
    readonly code: SqlMessageCode,
    readonly params: SqlMessageParams = {}
  ) {
    super(sqlMessageText(code, params));
    this.name = 'SqlError';
  }
}

export function catalogOf(tables: SqlTable[]): SqlCatalog {
  return new Map(tables.map((t) => [t.name.toLowerCase(), t]));
}

// ==================== Contexte d'évaluation ====================

interface Ctx {
  row: SqlValue[];
  /** Les lignes du groupe, en requête agrégée. */
  group: SqlValue[][] | null;
  /** Le contexte de la requête englobante (sous-requête), sinon `null`. */
  outer: Ctx | null;
}

type Eval = (ctx: Ctx) => SqlValue;

interface Compiled {
  run: Eval;
  /** Affinité au sens des comparaisons : une colonne ou un CAST en ont une. */
  affinity: Affinity | null;
}

const AGGREGATES = new Set(['COUNT', 'SUM', 'TOTAL', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT']);

function isAggregateCall(e: Expr): boolean {
  if (e.k !== 'call') return false;
  if (!AGGREGATES.has(e.name)) return false;
  // min()/max() à plusieurs arguments sont des fonctions scalaires
  if ((e.name === 'MIN' || e.name === 'MAX') && e.args.length > 1) return false;
  return true;
}

function containsAggregate(e: Expr | null): boolean {
  if (!e) return false;
  if (isAggregateCall(e)) return true;
  switch (e.k) {
    case 'unary':
      return containsAggregate(e.e);
    case 'bin':
    case 'is':
      return containsAggregate(e.a) || containsAggregate(e.b);
    case 'like':
      return containsAggregate(e.e) || containsAggregate(e.pattern);
    case 'in':
      return containsAggregate(e.e) || e.list.some(containsAggregate);
    case 'between':
      return containsAggregate(e.e) || containsAggregate(e.lo) || containsAggregate(e.hi);
    case 'call':
      return e.args.some(containsAggregate);
    case 'case':
      return (
        containsAggregate(e.base) ||
        e.whens.some(([w, t]) => containsAggregate(w) || containsAggregate(t)) ||
        containsAggregate(e.otherwise)
      );
    case 'cast':
      return containsAggregate(e.e);
    default:
      return false;
  }
}

// ==================== Opérations ====================

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function intResult(v: bigint): bigint | number {
  // Dépassement des entiers 64 bits : SQLite passe en réel
  return v < I64_MIN || v > I64_MAX ? Number(v) : v;
}

function arithmetic(op: string, a: SqlValue, b: SqlValue): SqlValue {
  if (a === null || b === null) return null;
  const x = toNumeric(a) as bigint | number;
  const y = toNumeric(b) as bigint | number;
  if (op === '%') {
    // `%` ramène ses deux opérandes à des entiers
    const xi = typeof x === 'bigint' ? x : BigInt(Math.trunc(x));
    const yi = typeof y === 'bigint' ? y : BigInt(Math.trunc(y));
    if (yi === 0n) return null;
    const r = xi % yi;
    return typeof x === 'number' || typeof y === 'number' ? Number(r) : r;
  }
  if (typeof x === 'bigint' && typeof y === 'bigint') {
    switch (op) {
      case '+':
        return intResult(x + y);
      case '-':
        return intResult(x - y);
      case '*':
        return intResult(x * y);
      case '/':
        return y === 0n ? null : intResult(x / y);
      default:
        return null;
    }
  }
  const fx = Number(x);
  const fy = Number(y);
  let r: number;
  switch (op) {
    case '+':
      r = fx + fy;
      break;
    case '-':
      r = fx - fy;
      break;
    case '*':
      r = fx * fy;
      break;
    case '/':
      if (fy === 0) return null;
      r = fx / fy;
      break;
    default:
      return null;
  }
  // Un résultat indéterminé (infini × 0, infini − infini) est NULL dans SQLite
  return Number.isNaN(r) ? null : r;
}

/** L'affinité appliquée aux DEUX opérandes d'une comparaison (règles de SQLite). */
function comparisonAffinity(a: Affinity | null, b: Affinity | null): Affinity | null {
  const numeric = (x: Affinity | null) => x === 'INTEGER' || x === 'REAL' || x === 'NUMERIC';
  if (a !== null && b !== null) return numeric(a) || numeric(b) ? 'NUMERIC' : 'BLOB';
  return a ?? b;
}

function applyAffinity(v: SqlValue, affinity: Affinity | null): SqlValue {
  if (affinity === 'INTEGER' || affinity === 'REAL' || affinity === 'NUMERIC')
    return numericAffinity(v);
  if (affinity === 'TEXT') return textAffinity(v);
  return v;
}

function compareWith(a: SqlValue, b: SqlValue, affinity: Affinity | null): number | null {
  if (a === null || b === null) return null;
  return compareSql(applyAffinity(a, affinity), applyAffinity(b, affinity));
}

/** LIKE de SQLite : `%` et `_`, casse ignorée pour l'ASCII seulement. */
function likeMatch(text: string, pattern: string): boolean {
  const t = Array.from(text);
  const p = Array.from(pattern);
  const fold = (c: string) => (c.length === 1 && c >= 'A' && c <= 'Z' ? c.toLowerCase() : c);
  // Programmation dynamique sur (position du motif, position du texte)
  let prev = new Uint8Array(t.length + 1);
  prev[0] = 1;
  for (let i = 0; i < p.length; i += 1) {
    const cur = new Uint8Array(t.length + 1);
    const pc = p[i];
    if (pc === '%') {
      let any = 0;
      for (let j = 0; j <= t.length; j += 1) {
        any |= prev[j]!;
        cur[j] = any;
      }
    } else {
      for (let j = 1; j <= t.length; j += 1) {
        if (prev[j - 1] && (pc === '_' || fold(pc!) === fold(t[j - 1]!))) cur[j] = 1;
      }
    }
    prev = cur;
  }
  return prev[t.length] === 1;
}

const foldAscii = (s: string, upper: boolean) =>
  upper
    ? s.replace(/[a-z]+/g, (m) => m.toUpperCase())
    : s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

function castTo(v: SqlValue, type: string): SqlValue {
  if (v === null) return null;
  const affinity = affinityOfDeclared(type);
  switch (affinity) {
    case 'TEXT':
      return toText(v);
    case 'INTEGER': {
      const n = toNumeric(v) as bigint | number;
      return typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    }
    case 'REAL':
      return Number(toNumeric(v));
    case 'NUMERIC': {
      const n = numericAffinity(typeof v === 'string' ? v : (toText(v) as string));
      if (typeof n === 'string') return toNumeric(n);
      return n;
    }
    default:
      return v;
  }
}

// ==================== Compilation des expressions ====================

interface ScopeTable {
  /** Nom de la table au catalogue. */
  table: string;
  /** Noms (minuscules) qui la désignent devant une colonne : son alias, sinon son nom. */
  names: Set<string>;
  /** Position de sa première colonne dans la ligne jointe. */
  offset: number;
  columns: SqlColumn[];
  /** `USING` : ses colonnes communes avec la gauche (une fois seulement, et jamais ambiguës). */
  using?: Set<number>;
}

interface Scope {
  tables: ScopeTable[];
  /** La portée de la requête englobante (sous-requête corrélée), sinon `null`. */
  outer: Scope | null;
  catalog: SqlCatalog;
  /** Mis à vrai quand une colonne d'une requête englobante est lue. */
  correlated?: { value: boolean };
}

/**
 * Une colonne : dans les tables de la requête, puis dans celles des requêtes
 * englobantes (sous-requête corrélée). `depth` dit combien de niveaux remonter.
 */
function resolveColumn(
  scope: Scope,
  name: string,
  table?: string
): { depth: number; index: number; affinity: Affinity } {
  const lower = name.toLowerCase();
  const wanted = table?.toLowerCase();
  const passed: Scope[] = [];
  let depth = 0;
  for (let s: Scope | null = scope; s; s = s.outer, depth += 1) {
    const hits: Array<{ index: number; affinity: Affinity; using: boolean }> = [];
    let tableSeen = false;
    for (const t of s.tables) {
      if (wanted !== undefined && !t.names.has(wanted)) continue;
      tableSeen = true;
      const i = t.columns.findIndex((c) => c.name.toLowerCase() === lower);
      if (i >= 0)
        hits.push({
          index: t.offset + i,
          affinity: t.columns[i]!.affinity,
          using: !!t.using?.has(i),
        });
    }
    if (hits.length > 0) {
      // Une colonne commune d'un USING n'est pas ambiguë : c'est celle de gauche
      const real = hits.filter((h, k) => k === 0 || !h.using);
      if (real.length > 1) throw new SqlError('ambiguousColumn', { name });
      for (const p of passed) if (p.correlated) p.correlated.value = true;
      return { depth, index: hits[0]!.index, affinity: hits[0]!.affinity };
    }
    // Une colonne NOMMÉE par sa table (t.col) se lie à la table de ce niveau : absente,
    // c'est une erreur. Sans préfixe, elle se cherche dans la requête englobante,
    // comme dans SQLite (sous-requête corrélée)
    if (tableSeen && wanted !== undefined)
      throw new SqlError('unknownColumn', { name: `${table}.${name}` });
    passed.push(s);
  }
  if (wanted !== undefined) throw new SqlError('unknownTable', { name: String(table) });
  throw new SqlError('unknownColumn', { name });
}

function compile(e: Expr, scope: Scope): Compiled {
  switch (e.k) {
    case 'lit': {
      const v = e.v;
      return { run: () => v, affinity: null };
    }
    case 'col': {
      // Une colonne dépliée d'un `*` connaît déjà sa place dans la ligne jointe
      const slot = (e as { slot?: number }).slot;
      if (slot !== undefined) {
        const t = scope.tables.find((x) => slot >= x.offset && slot < x.offset + x.columns.length)!;
        return {
          run: (ctx) => ctx.row[slot] ?? null,
          affinity: t.columns[slot - t.offset]!.affinity,
        };
      }
      const r = resolveColumn(scope, e.name, e.table);
      if (r.depth === 0) return { run: (ctx) => ctx.row[r.index] ?? null, affinity: r.affinity };
      return {
        run: (ctx) => {
          let c: Ctx | null = ctx;
          for (let d = 0; d < r.depth && c; d += 1) c = c.outer;
          return c?.row[r.index] ?? null;
        },
        affinity: r.affinity,
      };
    }
    case 'unary': {
      const inner = compile(e.e, scope);
      if (e.op === 'NOT') {
        return {
          run: (ctx) => {
            const l = logicalOf(inner.run(ctx));
            return fromBool(l === null ? null : !l);
          },
          affinity: null,
        };
      }
      if (e.op === '+') return { run: inner.run, affinity: null };
      return {
        run: (ctx) => {
          const v = inner.run(ctx);
          if (v === null) return null;
          const n = toNumeric(v) as bigint | number;
          return typeof n === 'bigint' ? intResult(-n) : -n;
        },
        affinity: null,
      };
    }
    case 'bin': {
      const a = compile(e.a, scope);
      const b = compile(e.b, scope);
      switch (e.op) {
        case 'AND':
          return {
            run: (ctx) => {
              const x = logicalOf(a.run(ctx));
              if (x === false) return 0n;
              const y = logicalOf(b.run(ctx));
              if (y === false) return 0n;
              return x === null || y === null ? null : 1n;
            },
            affinity: null,
          };
        case 'OR':
          return {
            run: (ctx) => {
              const x = logicalOf(a.run(ctx));
              if (x === true) return 1n;
              const y = logicalOf(b.run(ctx));
              if (y === true) return 1n;
              return x === null || y === null ? null : 0n;
            },
            affinity: null,
          };
        case '||':
          return {
            run: (ctx) => {
              const x = toText(a.run(ctx));
              const y = toText(b.run(ctx));
              return x === null || y === null ? null : x + y;
            },
            affinity: null,
          };
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
          return { run: (ctx) => arithmetic(e.op, a.run(ctx), b.run(ctx)), affinity: null };
        default: {
          const affinity = comparisonAffinity(a.affinity, b.affinity);
          const test = (c: number): boolean => {
            switch (e.op) {
              case '=':
                return c === 0;
              case '!=':
                return c !== 0;
              case '<':
                return c < 0;
              case '<=':
                return c <= 0;
              case '>':
                return c > 0;
              case '>=':
                return c >= 0;
              default:
                throw new SqlError('unknownOperator', { op: e.op });
            }
          };
          return {
            run: (ctx) => {
              const c = compareWith(a.run(ctx), b.run(ctx), affinity);
              return c === null ? null : fromBool(test(c));
            },
            affinity: null,
          };
        }
      }
    }
    case 'is': {
      const a = compile(e.a, scope);
      const b = compile(e.b, scope);
      const affinity = comparisonAffinity(a.affinity, b.affinity);
      return {
        run: (ctx) => {
          const x = a.run(ctx);
          const y = b.run(ctx);
          let same: boolean;
          if (x === null || y === null) same = x === null && y === null;
          else same = compareWith(x, y, affinity) === 0;
          return fromBool(e.not ? !same : same);
        },
        affinity: null,
      };
    }
    case 'like': {
      const a = compile(e.e, scope);
      const p = compile(e.pattern, scope);
      return {
        run: (ctx) => {
          const text = toText(a.run(ctx));
          const pattern = toText(p.run(ctx));
          if (text === null || pattern === null) return null;
          const m = likeMatch(text, pattern);
          return fromBool(e.not ? !m : m);
        },
        affinity: null,
      };
    }
    case 'in': {
      const a = compile(e.e, scope);
      const list = e.list.map((x) => compile(x, scope));
      return {
        run: (ctx) => {
          const x = a.run(ctx);
          if (x === null) return list.length === 0 ? fromBool(e.not) : null;
          let sawNull = false;
          for (const item of list) {
            const y = item.run(ctx);
            if (y === null) {
              sawNull = true;
              continue;
            }
            // L'affinité de la colonne de gauche s'applique aux valeurs de la liste
            const affinity = comparisonAffinity(a.affinity, item.affinity) ?? a.affinity;
            if (compareWith(x, y, affinity) === 0) return fromBool(!e.not);
          }
          return sawNull ? null : fromBool(e.not);
        },
        affinity: null,
      };
    }
    case 'between': {
      const a = compile(e.e, scope);
      const lo = compile(e.lo, scope);
      const hi = compile(e.hi, scope);
      const affLo = comparisonAffinity(a.affinity, lo.affinity);
      const affHi = comparisonAffinity(a.affinity, hi.affinity);
      return {
        run: (ctx) => {
          const x = a.run(ctx);
          const c1 = compareWith(x, lo.run(ctx), affLo);
          const c2 = compareWith(x, hi.run(ctx), affHi);
          const l1 = c1 === null ? null : c1 >= 0;
          const l2 = c2 === null ? null : c2 <= 0;
          let r: boolean | null;
          if (l1 === false || l2 === false) r = false;
          else if (l1 === null || l2 === null) r = null;
          else r = true;
          return fromBool(r === null ? null : e.not ? !r : r);
        },
        affinity: null,
      };
    }
    case 'case': {
      const base = e.base ? compile(e.base, scope) : null;
      const whens = e.whens.map(([w, t]) => [compile(w, scope), compile(t, scope)] as const);
      const otherwise = e.otherwise ? compile(e.otherwise, scope) : null;
      return {
        run: (ctx) => {
          const b = base ? base.run(ctx) : null;
          for (const [w, t] of whens) {
            if (base) {
              const c = compareWith(b, w.run(ctx), comparisonAffinity(base.affinity, w.affinity));
              if (c === 0) return t.run(ctx);
            } else if (isTrue(w.run(ctx))) {
              return t.run(ctx);
            }
          }
          return otherwise ? otherwise.run(ctx) : null;
        },
        affinity: null,
      };
    }
    case 'cast': {
      const inner = compile(e.e, scope);
      return { run: (ctx) => castTo(inner.run(ctx), e.type), affinity: affinityOfDeclared(e.type) };
    }
    case 'call':
      return isAggregateCall(e) ? compileAggregate(e, scope) : compileFunction(e, scope);
    case 'subquery': {
      const sub = subquery(e.select, scope);
      if (sub.width !== 1) {
        throw new SqlError('subqueryWidth', { width: sub.width });
      }
      return { run: (ctx) => sub.rows(ctx)[0]?.[0] ?? null, affinity: sub.firstAffinity };
    }
    case 'exists': {
      const sub = subquery(e.select, scope);
      return { run: (ctx) => fromBool(sub.rows(ctx).length > 0), affinity: null };
    }
    case 'insub': {
      const a = compile(e.e, scope);
      const sub = subquery(e.select, scope);
      if (sub.width !== 1) {
        throw new SqlError('inSubqueryWidth', { width: sub.width });
      }
      const affinity = comparisonAffinity(a.affinity, sub.firstAffinity) ?? a.affinity;
      return {
        run: (ctx) => {
          const values = sub.rows(ctx);
          if (values.length === 0) return fromBool(e.not);
          const x = a.run(ctx);
          if (x === null) return null;
          let sawNull = false;
          for (const [y] of values) {
            if (y === null) {
              sawNull = true;
              continue;
            }
            if (compareWith(x, y!, affinity) === 0) return fromBool(!e.not);
          }
          return sawNull ? null : fromBool(e.not);
        },
        affinity: null,
      };
    }
    default:
      throw new SqlError('unsupportedExpr');
  }
}

/**
 * Une sous-requête, préparée UNE fois. Non corrélée, son résultat se calcule une
 * fois et se garde ; corrélée, elle se rejoue pour chaque ligne englobante.
 */
function subquery(
  select: SelectStatement,
  scope: Scope
): { width: number; firstAffinity: Affinity | null; rows: (ctx: Ctx) => SqlValue[][] } {
  const prepared = prepareSelect(scope.catalog, select, scope);
  let cached: SqlValue[][] | null = null;
  return {
    width: prepared.width,
    firstAffinity: prepared.firstAffinity,
    rows: (ctx) => {
      if (!prepared.correlated) {
        if (!cached) cached = prepared.run(ctx).rows;
        return cached;
      }
      return prepared.run(ctx).rows;
    },
  };
}

function compileFunction(e: Extract<Expr, { k: 'call' }>, scope: Scope): Compiled {
  const args = e.args.map((a) => compile(a, scope));
  const arity = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw new SqlError('arity', { name: e.name });
  };
  const one = (fn: (v: SqlValue) => SqlValue): Compiled => {
    arity(1);
    return { run: (ctx) => fn(args[0]!.run(ctx)), affinity: null };
  };
  switch (e.name) {
    case 'LOWER':
    case 'UPPER':
      return one((v) => {
        const s = toText(v);
        return s === null ? null : foldAscii(s, e.name === 'UPPER');
      });
    case 'LENGTH':
      return one((v) => {
        const s = toText(v);
        return s === null ? null : BigInt(Array.from(s).length);
      });
    case 'ABS':
      return one((v) => {
        if (v === null) return null;
        if (typeof v === 'bigint') return v < 0n ? intResult(-v) : v;
        // Un texte, même « 3 », se lit en réel (`sqlite3_value_double`)
        return Math.abs(Number(toNumeric(v)));
      });
    case 'TYPEOF':
      return one((v) =>
        v === null
          ? 'null'
          : typeof v === 'bigint'
            ? 'integer'
            : typeof v === 'number'
              ? 'real'
              : 'text'
      );
    case 'ROUND': {
      arity(1, 2);
      return {
        run: (ctx) => {
          const v = args[0]!.run(ctx);
          if (v === null) return null;
          const digits = args[1] ? Number(toNumeric(args[1].run(ctx) ?? 0n)) : 0;
          const x = Number(toNumeric(v));
          const f = 10 ** Math.max(0, Math.trunc(digits));
          // Arrondi au plus loin de zéro, comme SQLite
          return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
        },
        affinity: null,
      };
    }
    case 'COALESCE':
    case 'IFNULL': {
      if (e.name === 'IFNULL') arity(2);
      else if (args.length < 2) throw new SqlError('coalesceArity');
      return {
        run: (ctx) => {
          for (const a of args) {
            const v = a.run(ctx);
            if (v !== null) return v;
          }
          return null;
        },
        affinity: null,
      };
    }
    case 'NULLIF':
      arity(2);
      return {
        run: (ctx) => {
          const x = args[0]!.run(ctx);
          const y = args[1]!.run(ctx);
          return x !== null && y !== null && compareSql(x, y) === 0 ? null : x;
        },
        affinity: null,
      };
    case 'MIN':
    case 'MAX':
      return {
        run: (ctx) => {
          let best: SqlValue = null;
          for (let i = 0; i < args.length; i += 1) {
            const v = args[i]!.run(ctx);
            if (v === null) return null;
            if (i === 0) best = v;
            else {
              const c = compareSql(v, best);
              if (e.name === 'MIN' ? c < 0 : c > 0) best = v;
            }
          }
          return best;
        },
        affinity: null,
      };
    case 'TRIM':
    case 'LTRIM':
    case 'RTRIM':
      return one((v) => {
        const s = toText(v);
        if (s === null) return null;
        if (e.name === 'LTRIM') return s.replace(/^ +/, '');
        if (e.name === 'RTRIM') return s.replace(/ +$/, '');
        return s.replace(/^ +| +$/g, '');
      });
    case 'REPLACE':
      arity(3);
      return {
        run: (ctx) => {
          const s = toText(args[0]!.run(ctx));
          const from = toText(args[1]!.run(ctx));
          const to = toText(args[2]!.run(ctx));
          if (s === null || from === null || to === null) return null;
          return from === '' ? s : s.split(from).join(to);
        },
        affinity: null,
      };
    case 'INSTR':
      arity(2);
      return {
        run: (ctx) => {
          const s = toText(args[0]!.run(ctx));
          const sub = toText(args[1]!.run(ctx));
          if (s === null || sub === null) return null;
          const at = s.indexOf(sub);
          return at < 0 ? 0n : BigInt(Array.from(s.slice(0, at)).length + 1);
        },
        affinity: null,
      };
    default:
      throw new SqlError('unknownFunction', { name: e.name });
  }
}

function compileAggregate(e: Extract<Expr, { k: 'call' }>, scope: Scope): Compiled {
  const arg = e.args[0] ? compile(e.args[0], scope) : null;
  const values = (ctx: Ctx): SqlValue[] => {
    const group = ctx.group;
    if (!group) throw new SqlError('aggregateOutsideGroup', { name: e.name });
    const out: SqlValue[] = [];
    const seen = new Set<string>();
    for (const row of group) {
      const v = arg ? arg.run({ row, group: null, outer: ctx.outer }) : null;
      if (v === null) continue;
      if (e.distinct) {
        const key = groupKey(v);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(v);
    }
    return out;
  };
  switch (e.name) {
    case 'COUNT':
      if (e.star) return { run: (ctx) => BigInt((ctx.group ?? []).length), affinity: null };
      return { run: (ctx) => BigInt(values(ctx).length), affinity: null };
    case 'SUM':
    case 'TOTAL':
    case 'AVG':
      return {
        run: (ctx) => {
          const vs = values(ctx);
          if (vs.length === 0) return e.name === 'TOTAL' ? 0 : null;
          let exact = 0n;
          let approx = 0;
          let isApprox = e.name !== 'SUM';
          for (const v of vs) {
            // Sans chercher l'entier : « 7.0 » compte comme un réel
            const n = numericType(v);
            if (!isApprox && typeof n === 'bigint') exact += n;
            else {
              if (!isApprox) {
                approx = Number(exact);
                isApprox = true;
              }
              approx += Number(typeof n === 'string' ? toNumeric(n) : n);
            }
          }
          if (e.name === 'AVG') return approx / vs.length;
          if (e.name === 'TOTAL') return approx;
          return isApprox ? approx : intResult(exact);
        },
        affinity: null,
      };
    case 'MIN':
    case 'MAX':
      return {
        run: (ctx) => {
          let best: SqlValue = null;
          for (const v of values(ctx)) {
            if (best === null) best = v;
            else {
              const c = compareSql(v, best);
              if (e.name === 'MIN' ? c < 0 : c > 0) best = v;
            }
          }
          return best;
        },
        affinity: null,
      };
    case 'GROUP_CONCAT': {
      const sep = e.args[1] ? compile(e.args[1], scope) : null;
      return {
        run: (ctx) => {
          const vs = values(ctx);
          if (vs.length === 0) return null;
          const s = sep ? (toText(sep.run({ row: [], group: null, outer: ctx.outer })) ?? '') : ',';
          return vs.map((v) => toText(v) as string).join(s);
        },
        affinity: null,
      };
    }
    default:
      throw new SqlError('unknownAggregate', { name: e.name });
  }
}

// ==================== Exécution d'un SELECT ====================

function limitOf(e: Expr | null, scope: Scope): number | null {
  if (!e) return null;
  const v = compile(e, scope).run({ row: [], group: null, outer: null });
  const n = Number(toNumeric(v ?? 0n));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Au-delà, une jointure s'arrête : elle figerait l'écran (et la mémoire) pour rien. */
export const MAX_JOIN_ROWS = 2_000_000;

/** Les noms qui désignent une table dans la requête : son alias s'il en a un (règle de SQLite), sinon son nom. */
function namesOf(table: SqlTable, alias?: string): Set<string> {
  return new Set([alias !== undefined ? alias.toLowerCase() : table.name.toLowerCase()]);
}

/** Un conjoint `colonne = colonne` d'une jointure, l'une à gauche, l'autre dans la table jointe. */
interface HashTerm {
  left: Compiled;
  rightIndex: number;
  affinity: Affinity | null;
}

interface JoinPlan {
  kind: 'inner' | 'left' | 'cross';
  table: SqlTable;
  /** Conjoints d'égalité : la jointure passe par une table de hachage. */
  hash: HashTerm[];
  /** Le reste de la condition, évalué sur la ligne jointe. */
  residual: Compiled | null;
}

/** Les conjoints d'un ET de premier niveau. */
function conjuncts(e: Expr): Expr[] {
  return e.k === 'bin' && e.op === 'AND' ? [...conjuncts(e.a), ...conjuncts(e.b)] : [e];
}

/** Une colonne résolue dans la portée courante (profondeur 0), sans lever ; `null` sinon. */
function localColumn(scope: Scope, e: Expr): { index: number; affinity: Affinity } | null {
  if (e.k !== 'col') return null;
  try {
    const r = resolveColumn({ ...scope, outer: null, correlated: undefined }, e.name, e.table);
    return r.depth === 0 ? { index: r.index, affinity: r.affinity } : null;
  } catch {
    return null;
  }
}

/** La clé de hachage d'une suite de valeurs comparées sous leurs affinités ; `null` si l'une est NULL. */
function hashKeyOf(values: SqlValue[], affinities: Array<Affinity | null>): string | null {
  let key = '';
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === null) return null;
    key += `${groupKey(applyAffinity(v!, affinities[i]!))}\u0000`;
  }
  return key;
}

/** Une requête préparée : compilée une fois, exécutée pour chaque ligne englobante (sous-requête). */
interface PreparedSelect {
  width: number;
  /** Affinité de la première colonne de résultat (sous-requête scalaire, IN). */
  firstAffinity: Affinity | null;
  /** Lit une colonne d'une requête englobante : son résultat change d'une ligne à l'autre. */
  correlated: boolean;
  run(outerCtx: Ctx | null): SqlResult;
}

function prepareSelect(
  catalog: SqlCatalog,
  stmt: SelectStatement,
  outer: Scope | null
): PreparedSelect {
  const refs = [stmt.from, ...stmt.joins];
  const tables = refs.map((ref) => {
    const table = catalog.get(ref.table.toLowerCase());
    if (!table) throw new SqlError('unknownTable', { name: ref.table });
    return table;
  });
  const correlated = { value: false };
  const scopeTables: ScopeTable[] = [];
  const scope: Scope = { tables: scopeTables, outer, catalog, correlated };

  // Les tables, l'une après l'autre : la condition d'une jointure voit les tables qui la précèdent
  const joins: JoinPlan[] = [];
  let width = 0;
  refs.forEach((ref, k) => {
    const table = tables[k]!;
    const entry: ScopeTable = {
      table: table!.name,
      names: namesOf(table!, ref.alias),
      offset: width,
      columns: table!.columns,
    };
    if (k === 0) {
      scopeTables.push(entry);
      width += table!.columns.length;
      return;
    }
    const join = stmt.joins[k - 1];
    const leftScope: Scope = { ...scope, tables: [...scopeTables] };
    scopeTables.push(entry);
    const hash: HashTerm[] = [];
    const rest: Expr[] = [];
    if (join!.using) {
      const merged = new Set<number>();
      for (const name of join!.using) {
        const left = resolveColumn({ ...leftScope, outer: null, correlated: undefined }, name);
        const ri = table!.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        if (ri < 0) throw new SqlError('unknownUsingColumn', { name });
        merged.add(ri);
        hash.push({
          left: { run: (ctx) => ctx.row[left.index] ?? null, affinity: left.affinity },
          rightIndex: ri,
          affinity: comparisonAffinity(left.affinity, table!.columns[ri]!.affinity),
        });
      }
      entry.using = merged;
    }
    if (join!.on) {
      for (const term of conjuncts(join!.on)) {
        if (term.k === 'bin' && term.op === '=') {
          const a = localColumn(scope, term.a);
          const b = localColumn(scope, term.b);
          const isRight = (c: { index: number } | null) => c !== null && c.index >= width;
          const isLeft = (c: { index: number } | null) => c !== null && c.index < width;
          if ((isLeft(a) && isRight(b)) || (isRight(a) && isLeft(b))) {
            const [l, r] = isLeft(a) ? [a!, b!] : [b!, a!];
            hash.push({
              left: { run: (ctx) => ctx.row[l.index] ?? null, affinity: l.affinity },
              rightIndex: r.index - width,
              affinity: comparisonAffinity(l.affinity, r.affinity),
            });
            continue;
          }
        }
        rest.push(term);
      }
    }
    const residual =
      rest.length === 0
        ? null
        : compile(
            rest.reduce((a, b) => ({ k: 'bin', op: 'AND', a, b }) as Expr),
            scope
          );
    joins.push({ kind: join!.kind, table, hash, residual });
    width += table!.columns.length;
  });

  // Colonnes de résultat (étoiles dépliées), avec leur provenance quand elles
  // reprennent une colonne telle quelle
  const outputs: Array<{ name: string; expr: Expr; source: SqlColumnSource | null }> = [];
  const sourceOf = (e: Expr): SqlColumnSource | null => {
    if (e.k !== 'col') return null;
    try {
      const r = resolveColumn(scope, e.name, e.table);
      if (r.depth !== 0) return null;
      const st = scopeTables.find(
        (x) => r.index >= x.offset && r.index < x.offset + x.columns.length
      );
      return st ? { table: st.table, column: st.columns[r.index - st.offset]!.name } : null;
    } catch {
      return null;
    }
  };
  for (const c of stmt.columns) {
    if (c.expr === null) {
      const wanted = c.starTable?.toLowerCase();
      if (wanted !== undefined && !scopeTables.some((t) => t.names.has(wanted))) {
        throw new SqlError('unknownTable', { name: String(c.starTable) });
      }
      for (const t of scopeTables) {
        if (wanted !== undefined && !t.names.has(wanted)) continue;
        t.columns.forEach((col, i) => {
          // USING : la colonne commune ne paraît qu'une fois dans `*`
          if (wanted === undefined && t.using?.has(i)) return;
          outputs.push({
            name: col.name,
            expr: { k: 'col', name: col.name, slot: t.offset + i } as Expr,
            source: { table: t.table, column: col.name },
          });
        });
      }
    } else {
      const source = sourceOf(c.expr);
      // Sans alias, une colonne reprise telle quelle porte son nom DÉCLARÉ (comme
      // SQLite : `c."nom"` → `nom`) ; une expression, son texte
      const bare = c.expr.k === 'col' ? (source?.column ?? c.expr.name) : c.text;
      outputs.push({ name: c.alias ?? bare, expr: c.expr, source });
    }
  }
  const compiledOutputs = outputs.map((o) => compile(o.expr, scope));
  const where = stmt.where ? compile(stmt.where, scope) : null;

  const aggregated =
    stmt.groupBy.length > 0 ||
    outputs.some((o) => containsAggregate(o.expr)) ||
    containsAggregate(stmt.having) ||
    stmt.orderBy.some((t) => containsAggregate(t.expr));
  const keys = aggregated ? stmt.groupBy.map((g) => compile(g, scope)) : [];
  const having = aggregated && stmt.having ? compile(stmt.having, scope) : null;

  const aliases = new Map<string, number>();
  outputs.forEach((o, i) => {
    const lower = o.name.toLowerCase();
    if (!aliases.has(lower)) aliases.set(lower, i);
  });
  const terms = stmt.orderBy.map((t) => {
    // ORDER BY 2 : la deuxième colonne de résultat
    if (t.expr.k === 'lit' && typeof t.expr.v === 'bigint') {
      const k = Number(t.expr.v);
      if (k < 1 || k > outputs.length) throw new SqlError('orderByRange', { k });
      return { ...t, key: (p: { values: SqlValue[] }) => p.values[k - 1] };
    }
    // ORDER BY alias : une colonne de résultat nommée
    if (t.expr.k === 'col' && t.expr.table === undefined) {
      const name = t.expr.name;
      const at = aliases.get(name.toLowerCase());
      const isColumn = localColumn(scope, t.expr) !== null;
      if (
        at !== undefined &&
        (!isColumn || outputs[at]!.name.toLowerCase() === name.toLowerCase())
      ) {
        return { ...t, key: (p: { values: SqlValue[] }) => p.values[at] };
      }
    }
    const compiled = compile(t.expr, scope);
    return { ...t, key: (p: { ctx: Ctx }) => compiled.run(p.ctx) };
  });
  const limitExpr = stmt.limit;
  const offsetExpr = stmt.offset;

  const run = (outerCtx: Ctx | null): SqlResult => {
    // FROM et jointures
    let rows: SqlValue[][] = tables[0]!.rows;
    for (const plan of joins) {
      const right = plan.table.rows;
      const nullRight: SqlValue[] = new Array(plan.table.columns.length).fill(null);
      const out: SqlValue[][] = [];
      const push = (row: SqlValue[]) => {
        out.push(row);
        if (out.length > MAX_JOIN_ROWS) {
          throw new SqlError('joinTooLarge', { max: MAX_JOIN_ROWS });
        }
      };
      const keep = (row: SqlValue[]) =>
        !plan.residual || isTrue(plan.residual.run({ row, group: null, outer: outerCtx }));
      if (plan.hash.length > 0) {
        const map = new Map<string, SqlValue[][]>();
        const affinities = plan.hash.map((h) => h.affinity);
        for (const r of right) {
          const key = hashKeyOf(
            plan.hash.map((h) => r[h.rightIndex] ?? null),
            affinities
          );
          if (key === null) continue;
          const list = map.get(key);
          if (list) list.push(r);
          else map.set(key, [r]);
        }
        for (const l of rows) {
          const ctx: Ctx = { row: l, group: null, outer: outerCtx };
          const key = hashKeyOf(
            plan.hash.map((h) => h.left.run(ctx)),
            affinities
          );
          let matched = false;
          for (const r of key === null ? [] : (map.get(key) ?? [])) {
            const joined = l.concat(r);
            if (keep(joined)) {
              push(joined);
              matched = true;
            }
          }
          if (plan.kind === 'left' && !matched) push(l.concat(nullRight));
        }
      } else {
        for (const l of rows) {
          let matched = false;
          for (const r of right) {
            const joined = l.concat(r);
            if (keep(joined)) {
              push(joined);
              matched = true;
            }
          }
          if (plan.kind === 'left' && !matched) push(l.concat(nullRight));
        }
      }
      rows = out;
    }

    if (where)
      rows = rows.filter((row) => isTrue(where.run({ row, group: null, outer: outerCtx })));

    // Chaque ligne de résultat garde son contexte, pour l'ORDER BY sur expression
    let produced: Array<{ values: SqlValue[]; ctx: Ctx }>;
    if (aggregated) {
      const groups = new Map<string, { key: SqlValue[]; rows: SqlValue[][] }>();
      for (const row of rows) {
        const key = keys.map((k) => k.run({ row, group: null, outer: outerCtx }));
        const id = key.map(groupKey).join('\u0000');
        let g = groups.get(id);
        if (!g) {
          g = { key, rows: [] };
          groups.set(id, g);
        }
        g.rows.push(row);
      }
      let list = [...groups.values()];
      // Sans GROUP BY, une seule ligne, même sur une entrée vide
      if (stmt.groupBy.length === 0 && list.length === 0) list = [{ key: [], rows: [] }];
      // Les groupes sortent dans l'ordre de leurs clés, comme le trieur de SQLite
      list.sort((a, b) => {
        for (let i = 0; i < a.key.length; i += 1) {
          const c = compareSql(a.key[i]!, b.key[i]!);
          if (c !== 0) return c;
        }
        return 0;
      });
      produced = [];
      for (const g of list) {
        // Une colonne nue lit la DERNIÈRE ligne du groupe
        const ctx: Ctx = { row: g.rows[g.rows.length - 1] ?? [], group: g.rows, outer: outerCtx };
        if (having && !isTrue(having.run(ctx))) continue;
        produced.push({ values: compiledOutputs.map((c) => c.run(ctx)), ctx });
      }
    } else {
      produced = rows.map((row) => {
        const ctx: Ctx = { row, group: null, outer: outerCtx };
        return { values: compiledOutputs.map((c) => c.run(ctx)), ctx };
      });
    }

    if (stmt.distinct) {
      const seen = new Set<string>();
      produced = produced.filter((p) => {
        const key = p.values.map(groupKey).join('\u0000');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    if (terms.length > 0) {
      const keyed = produced.map((p, index) => ({
        p,
        index,
        keys: terms.map((t) => t.key(p as never)),
      }));
      keyed.sort((a, b) => {
        for (let i = 0; i < terms.length; i += 1) {
          const x = a.keys[i];
          const y = b.keys[i];
          const t = terms[i];
          if (x === null || y === null) {
            if (x === null && y === null) continue;
            const nullsFirst = t!.nulls === null ? !t!.desc : t!.nulls === 'first';
            return (x === null) === nullsFirst ? -1 : 1;
          }
          const c = compareSql(x!, y!);
          if (c !== 0) return t!.desc ? -c : c;
        }
        return a.index - b.index;
      });
      produced = keyed.map((k) => k.p);
    }

    const limit = limitOf(limitExpr, scope);
    const offset = Math.max(0, limitOf(offsetExpr, scope) ?? 0);
    let out = produced.map((p) => p.values);
    if (offset > 0) out = out.slice(offset);
    if (limit !== null && limit >= 0) out = out.slice(0, limit);
    return {
      columns: outputs.map((o) => o.name),
      rows: out,
      sources: outputs.map((o) => o.source),
    };
  };

  return {
    width: outputs.length,
    firstAffinity: compiledOutputs[0]?.affinity ?? null,
    get correlated() {
      return correlated.value;
    },
    run,
  };
}

/** Exécute un SELECT (texte ou déjà analysé) sur le catalogue. */
export function runSelect(catalog: SqlCatalog, query: string | SelectStatement): SqlResult {
  const stmt = typeof query === 'string' ? parseSelect(query) : query;
  return prepareSelect(catalog, stmt, null).run(null);
}

// ==================== INSERT, UPDATE, DELETE : le plan ====================

/**
 * Ce que ferait un ordre qui modifie, SANS rien modifier : l'aperçu qu'on montre
 * avant d'appliquer, et ce que l'appelant traduit en écritures des bases. Les
 * valeurs sont rangées sous l'affinité de leur colonne, comme SQLite les stockerait.
 */
export interface DmlPlan {
  kind: 'insert' | 'update' | 'delete';
  table: SqlTable;
  /** Lignes ajoutées : une valeur par colonne de la table. */
  inserted: SqlValue[][];
  /** Lignes modifiées : leur indice dans `table.rows`, avant et après. */
  updated: Array<{ index: number; before: SqlValue[]; after: SqlValue[] }>;
  /** Lignes supprimées : leur indice et leur contenu. */
  deleted: Array<{ index: number; row: SqlValue[] }>;
}

function singleTableScope(catalog: SqlCatalog, table: SqlTable, alias?: string): Scope {
  return {
    tables: [
      { table: table.name, names: namesOf(table, alias), offset: 0, columns: table.columns },
    ],
    outer: null,
    catalog,
    correlated: { value: false },
  };
}

function columnOf(table: SqlTable, name: string): number {
  const i = table.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  if (i < 0) throw new SqlError('unknownColumn', { name });
  return i;
}

/** Le plan d'un INSERT, d'un UPDATE ou d'un DELETE (rien n'est écrit). */
export function planStatement(
  catalog: SqlCatalog,
  stmt: InsertStatement | UpdateStatement | DeleteStatement
): DmlPlan {
  const table = catalog.get(stmt.table.toLowerCase());
  if (!table) throw new SqlError('unknownTable', { name: stmt.table });
  const plan: DmlPlan = { kind: stmt.kind, table, inserted: [], updated: [], deleted: [] };

  if (stmt.kind === 'delete') {
    const scope = singleTableScope(catalog, table, stmt.alias);
    const where = stmt.where ? compile(stmt.where, scope) : null;
    table.rows.forEach((row, index) => {
      if (!where || isTrue(where.run({ row, group: null, outer: null })))
        plan.deleted.push({ index, row });
    });
    return plan;
  }

  if (stmt.kind === 'update') {
    const scope = singleTableScope(catalog, table, stmt.alias);
    const where = stmt.where ? compile(stmt.where, scope) : null;
    const sets = stmt.set.map((s) => ({
      index: columnOf(table, s.column),
      expr: compile(s.expr, scope),
    }));
    table.rows.forEach((row, index) => {
      const ctx: Ctx = { row, group: null, outer: null };
      if (where && !isTrue(where.run(ctx))) return;
      // Toutes les affectations lisent la ligne D'AVANT (sémantique de SQLite)
      const after = row.slice();
      for (const s of sets)
        after[s.index] = storeAs(s.expr.run(ctx), table.columns[s.index]!.affinity);
      plan.updated.push({ index, before: row, after });
    });
    return plan;
  }

  // INSERT
  const targets = stmt.columns
    ? stmt.columns.map((c) => columnOf(table, c))
    : table.columns.map((_, i) => i);
  const toRow = (values: SqlValue[]): SqlValue[] => {
    if (values.length !== targets.length) {
      throw new SqlError('valueCount', { values: values.length, columns: targets.length });
    }
    const row: SqlValue[] = new Array(table.columns.length).fill(null);
    targets.forEach((ci, k) => {
      row[ci] = storeAs(values[k]!, table.columns[ci]!.affinity);
    });
    return row;
  };
  if (stmt.select) {
    for (const values of prepareSelect(catalog, stmt.select, null).run(null).rows) {
      plan.inserted.push(toRow(values));
    }
  } else {
    const empty: Scope = { tables: [], outer: null, catalog, correlated: { value: false } };
    for (const tuple of stmt.values ?? []) {
      const ctx: Ctx = { row: [], group: null, outer: null };
      plan.inserted.push(toRow(tuple.map((e) => compile(e, empty).run(ctx))));
    }
  }
  return plan;
}

/** Exécute un SELECT, ou rend le plan d'un ordre qui modifie (texte ou déjà analysé). */
export function runStatement(
  catalog: SqlCatalog,
  query: string | Statement
): { kind: 'select'; result: SqlResult } | { kind: 'dml'; plan: DmlPlan } {
  const stmt = typeof query === 'string' ? parseStatement(query) : query;
  if (stmt.kind === 'select') return { kind: 'select', result: runSelect(catalog, stmt) };
  return { kind: 'dml', plan: planStatement(catalog, stmt) };
}
