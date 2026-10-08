// Recopié de filarg src/renderer/components/notes/extensions/inlineDatabase/engine/sql/parser.ts @ 3e9d65cd — relicencié Apache-2.0 par le titulaire des droits.
/**
 * Analyse du SQL maison : le sous-ensemble utile à une base Filarr.
 *
 *   SELECT [DISTINCT] colonnes FROM table [AS alias]
 *     [[INNER] JOIN | LEFT [OUTER] JOIN | CROSS JOIN | , table [AS alias] [ON … | USING (…)]]…
 *     [WHERE …] [GROUP BY …] [HAVING …] [ORDER BY … [ASC|DESC] [NULLS FIRST|LAST]]
 *     [LIMIT n [OFFSET m]]
 *   INSERT INTO table [(colonnes)] VALUES (…), (…) | SELECT …
 *   UPDATE table [AS alias] SET colonne = … [, …] [WHERE …]
 *   DELETE FROM table [AS alias] [WHERE …]
 *
 * Sous-requêtes : `(SELECT …)` scalaire, `EXISTS (SELECT …)`, `x [NOT] IN (SELECT …)`,
 * corrélées ou non (une colonne d'une requête englobante se lit par son nom).
 *
 * Expressions : littéraux, colonnes (`nom`, `"nom"`, `table.nom`), + − * / %,
 * `||`, comparaisons, AND OR NOT, IS [NOT] NULL, IS [NOT], [NOT] IN (…),
 * [NOT] LIKE, [NOT] BETWEEN, CASE, CAST, fonctions et agrégats.
 *
 * Les priorités sont celles de SQLite : `||` ; `* / %` ; `+ -` ; `< <= > >=` ;
 * `= == != <> IS IN LIKE BETWEEN` ; NOT ; AND ; OR.
 */

import type { SqlValue } from './values';
import { sqlMessageText, type SqlMessageCode, type SqlMessageParams } from './messages';

export type Expr =
  | { k: 'lit'; v: SqlValue }
  | { k: 'col'; name: string; table?: string }
  | { k: 'unary'; op: '-' | '+' | 'NOT'; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'is'; a: Expr; b: Expr; not: boolean }
  | { k: 'like'; e: Expr; pattern: Expr; not: boolean }
  | { k: 'in'; e: Expr; list: Expr[]; not: boolean }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean }
  | { k: 'call'; name: string; args: Expr[]; star: boolean; distinct: boolean }
  | { k: 'case'; base: Expr | null; whens: Array<[Expr, Expr]>; otherwise: Expr | null }
  | { k: 'cast'; e: Expr; type: string }
  | { k: 'subquery'; select: SelectStatement }
  | { k: 'exists'; select: SelectStatement }
  | { k: 'insub'; e: Expr; select: SelectStatement; not: boolean };

export interface ResultColumn {
  expr: Expr | null;
  /** `*` (ou `table.*`) quand `expr` est nul. */
  starTable?: string;
  alias?: string;
  /** Le texte d'origine, pour nommer la colonne de résultat. */
  text: string;
}

export interface OrderTerm {
  expr: Expr;
  desc: boolean;
  nulls: 'first' | 'last' | null;
}

export interface TableRef {
  table: string;
  alias?: string;
}

export type JoinKind = 'inner' | 'left' | 'cross';

export interface JoinClause extends TableRef {
  kind: JoinKind;
  on: Expr | null;
  /** `USING (a, b)` : les colonnes communes (une fois seulement dans `*`). */
  using: string[] | null;
}

export interface SelectStatement {
  distinct: boolean;
  columns: ResultColumn[];
  from: TableRef;
  /** Les tables jointes, dans l'ordre (une virgule est une jointure croisée). */
  joins: JoinClause[];
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
  orderBy: OrderTerm[];
  limit: Expr | null;
  offset: Expr | null;
}

export interface InsertStatement {
  kind: 'insert';
  table: string;
  columns: string[] | null;
  values: Expr[][] | null;
  select: SelectStatement | null;
}

export interface UpdateStatement {
  kind: 'update';
  table: string;
  alias?: string;
  set: Array<{ column: string; expr: Expr }>;
  where: Expr | null;
}

export interface DeleteStatement {
  kind: 'delete';
  table: string;
  alias?: string;
  where: Expr | null;
}

export type Statement =
  | ({ kind: 'select' } & SelectStatement)
  | InsertStatement
  | UpdateStatement
  | DeleteStatement;

export class SqlSyntaxError extends Error {
  constructor(
    readonly code: SqlMessageCode,
    readonly position: number,
    readonly params: SqlMessageParams = {}
  ) {
    super(sqlMessageText(code, params));
    this.name = 'SqlSyntaxError';
  }
}

// ==================== Lexique ====================

type TokenKind = 'id' | 'qid' | 'num' | 'str' | 'op' | 'end';

interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
  /** Mot clé en majuscules pour un identifiant nu. */
  upper?: string;
}

const OPS = [
  '<=',
  '>=',
  '<>',
  '!=',
  '==',
  '||',
  '<',
  '>',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  ',',
  '.',
  ';',
];

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c!)) {
      i += 1;
      continue;
    }
    // Commentaires : -- jusqu'à la fin de ligne, /* … */
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    const start = i;
    if (/[A-Za-z_À-￿]/.test(c!)) {
      while (i < sql.length && /[A-Za-z0-9_À-￿]/.test(sql[i]!)) i += 1;
      const text = sql.slice(start, i);
      tokens.push({ kind: 'id', text, pos: start, upper: text.toUpperCase() });
      continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let text = '';
      i += 1;
      for (;;) {
        if (i >= sql.length) throw new SqlSyntaxError('unclosedIdentifier', start);
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) {
            text += close;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        text += sql[i];
        i += 1;
      }
      tokens.push({ kind: 'qid', text, pos: start });
      continue;
    }
    if (c === "'") {
      let text = '';
      i += 1;
      for (;;) {
        if (i >= sql.length) throw new SqlSyntaxError('unclosedText', start);
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            text += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        text += sql[i];
        i += 1;
      }
      tokens.push({ kind: 'str', text, pos: start });
      continue;
    }
    if (/[0-9]/.test(c!) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      while (i < sql.length && /[0-9]/.test(sql[i]!)) i += 1;
      if (sql[i] === '.') {
        i += 1;
        while (i < sql.length && /[0-9]/.test(sql[i]!)) i += 1;
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        const save = i;
        i += 1;
        if (sql[i] === '+' || sql[i] === '-') i += 1;
        if (/[0-9]/.test(sql[i] ?? '')) {
          while (i < sql.length && /[0-9]/.test(sql[i]!)) i += 1;
        } else {
          i = save;
        }
      }
      tokens.push({ kind: 'num', text: sql.slice(start, i), pos: start });
      continue;
    }
    const op = OPS.find((o) => sql.startsWith(o, i));
    if (!op) throw new SqlSyntaxError('unexpectedChar', i, { char: c! });
    tokens.push({ kind: 'op', text: op, pos: i });
    i += op.length;
  }
  tokens.push({ kind: 'end', text: '', pos: sql.length });
  return tokens;
}

// ==================== Syntaxe ====================

const RESERVED = new Set([
  'SELECT',
  'DISTINCT',
  'ALL',
  'FROM',
  'WHERE',
  'GROUP',
  'BY',
  'HAVING',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IS',
  'IN',
  'LIKE',
  'BETWEEN',
  'NULL',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'ASC',
  'DESC',
  'NULLS',
  'CAST',
  'TRUE',
  'FALSE',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'CROSS',
  'NATURAL',
  'ON',
  'USING',
  'EXISTS',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
]);

class Parser {
  private i = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly sql: string
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'end') this.i += 1;
    return t;
  }

  private isWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'id' && t.upper === word;
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t.kind === 'op' && t.text === op;
  }

  private acceptWord(word: string): boolean {
    if (this.isWord(word)) {
      this.i += 1;
      return true;
    }
    return false;
  }

  private acceptOp(op: string): boolean {
    if (this.isOp(op)) {
      this.i += 1;
      return true;
    }
    return false;
  }

  private expectWord(word: string): void {
    if (!this.acceptWord(word))
      throw new SqlSyntaxError('expected', this.peek().pos, { token: word });
  }

  private expectOp(op: string): void {
    if (!this.acceptOp(op)) throw new SqlSyntaxError('expected', this.peek().pos, { token: op });
  }

  private identifier(): string {
    const t = this.peek();
    if (t.kind === 'qid') {
      this.i += 1;
      return t.text;
    }
    if (t.kind === 'id' && !RESERVED.has(t.upper as string)) {
      this.i += 1;
      return t.text;
    }
    throw new SqlSyntaxError('nameExpected', t.pos);
  }

  /** Une requête entière : un SELECT, puis la fin (un `;` toléré). */
  parseSelect(): SelectStatement {
    const select = this.selectBody();
    this.end();
    return select;
  }

  /** Une instruction : SELECT, INSERT, UPDATE ou DELETE. */
  parseStatement(): Statement {
    let out: Statement;
    if (this.isWord('INSERT')) out = this.insertBody();
    else if (this.isWord('UPDATE')) out = this.updateBody();
    else if (this.isWord('DELETE')) out = this.deleteBody();
    else out = { kind: 'select', ...this.selectBody() };
    this.end();
    return out;
  }

  private end(): void {
    this.acceptOp(';');
    if (this.peek().kind !== 'end') throw new SqlSyntaxError('endExpected', this.peek().pos);
  }

  private tableRef(): TableRef {
    const table = this.identifier();
    let alias: string | undefined;
    if (this.acceptWord('AS')) alias = this.identifier();
    else if (
      this.peek().kind === 'qid' ||
      (this.peek().kind === 'id' && !RESERVED.has(this.peek().upper as string))
    ) {
      alias = this.identifier();
    }
    return alias === undefined ? { table } : { table, alias };
  }

  /** Les jointures qui suivent la première table de FROM. */
  private joins(): JoinClause[] {
    const out: JoinClause[] = [];
    for (;;) {
      let kind: JoinKind | null = null;
      if (this.acceptOp(',')) kind = 'cross';
      else if (this.isWord('NATURAL') || this.isWord('RIGHT') || this.isWord('FULL')) {
        throw new SqlSyntaxError('joinUnsupported', this.peek().pos);
      } else if (this.acceptWord('CROSS')) {
        this.expectWord('JOIN');
        kind = 'cross';
      } else if (this.acceptWord('LEFT')) {
        this.acceptWord('OUTER');
        this.expectWord('JOIN');
        kind = 'left';
      } else if (this.acceptWord('INNER')) {
        this.expectWord('JOIN');
        kind = 'inner';
      } else if (this.acceptWord('JOIN')) kind = 'inner';
      if (kind === null) return out;
      const ref = this.tableRef();
      let on: Expr | null = null;
      let using: string[] | null = null;
      if (this.acceptWord('ON')) on = this.expr();
      else if (this.acceptWord('USING')) {
        this.expectOp('(');
        using = [];
        do using.push(this.identifier());
        while (this.acceptOp(','));
        this.expectOp(')');
      }
      // Une jointure avec condition n'est plus « croisée » (la virgule et CROSS n'en ont pas)
      out.push({ ...ref, kind: kind === 'cross' && (on || using) ? 'inner' : kind, on, using });
    }
  }

  private selectBody(): SelectStatement {
    this.expectWord('SELECT');
    let distinct = false;
    if (this.acceptWord('DISTINCT')) distinct = true;
    else this.acceptWord('ALL');
    const columns: ResultColumn[] = [];
    do {
      columns.push(this.resultColumn());
    } while (this.acceptOp(','));
    this.expectWord('FROM');
    const from = this.tableRef();
    const joins = this.joins();
    const where = this.acceptWord('WHERE') ? this.expr() : null;
    const groupBy: Expr[] = [];
    if (this.acceptWord('GROUP')) {
      this.expectWord('BY');
      do groupBy.push(this.expr());
      while (this.acceptOp(','));
    }
    const having = this.acceptWord('HAVING') ? this.expr() : null;
    const orderBy: OrderTerm[] = [];
    if (this.acceptWord('ORDER')) {
      this.expectWord('BY');
      do {
        const expr = this.expr();
        let desc = false;
        if (this.acceptWord('DESC')) desc = true;
        else this.acceptWord('ASC');
        let nulls: 'first' | 'last' | null = null;
        if (this.acceptWord('NULLS')) {
          if (this.acceptWord('FIRST')) nulls = 'first';
          else {
            this.expectWord('LAST');
            nulls = 'last';
          }
        }
        orderBy.push({ expr, desc, nulls });
      } while (this.acceptOp(','));
    }
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    if (this.acceptWord('LIMIT')) {
      limit = this.expr();
      if (this.acceptWord('OFFSET')) offset = this.expr();
      else if (this.acceptOp(',')) {
        // LIMIT m, n = OFFSET m LIMIT n (forme de SQLite)
        offset = limit;
        limit = this.expr();
      }
    }
    return {
      distinct,
      columns,
      from,
      joins,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
    };
  }

  private resultColumn(): ResultColumn {
    const startTok = this.peek();
    if (this.acceptOp('*')) return { expr: null, text: '*' };
    // table.*
    if (
      (startTok.kind === 'id' || startTok.kind === 'qid') &&
      this.peek(1).text === '.' &&
      this.peek(2).text === '*'
    ) {
      const table = this.identifier();
      this.expectOp('.');
      this.expectOp('*');
      return { expr: null, starTable: table, text: `${table}.*` };
    }
    const expr = this.expr();
    const endPos = this.peek().pos;
    let alias: string | undefined;
    if (this.acceptWord('AS')) alias = this.identifier();
    else if (
      this.peek().kind === 'qid' ||
      (this.peek().kind === 'id' && !RESERVED.has(this.peek().upper as string))
    ) {
      alias = this.identifier();
    }
    return { expr, alias, text: this.sql.slice(startTok.pos, endPos).trim() };
  }

  // Priorités : OR < AND < NOT < égalité < comparaison < + − < * / % < || < unaire
  expr(): Expr {
    return this.orExpr();
  }

  private orExpr(): Expr {
    let a = this.andExpr();
    while (this.acceptWord('OR')) a = { k: 'bin', op: 'OR', a, b: this.andExpr() };
    return a;
  }

  private andExpr(): Expr {
    let a = this.notExpr();
    while (this.acceptWord('AND')) a = { k: 'bin', op: 'AND', a, b: this.notExpr() };
    return a;
  }

  private notExpr(): Expr {
    if (this.acceptWord('NOT')) return { k: 'unary', op: 'NOT', e: this.notExpr() };
    return this.equality();
  }

  private equality(): Expr {
    let a = this.comparison();
    for (;;) {
      if (this.isOp('=') || this.isOp('==') || this.isOp('!=') || this.isOp('<>')) {
        const op = this.next().text;
        a = { k: 'bin', op: op === '==' ? '=' : op === '<>' ? '!=' : op, a, b: this.comparison() };
        continue;
      }
      if (this.isWord('IS')) {
        this.next();
        const not = this.acceptWord('NOT');
        a = { k: 'is', a, b: this.comparison(), not };
        continue;
      }
      const not =
        this.isWord('NOT') &&
        (this.isWord('IN', 1) || this.isWord('LIKE', 1) || this.isWord('BETWEEN', 1));
      if (not) this.next();
      if (this.acceptWord('IN')) {
        this.expectOp('(');
        if (this.isWord('SELECT')) {
          const select = this.selectBody();
          this.expectOp(')');
          a = { k: 'insub', e: a, select, not };
          continue;
        }
        const list: Expr[] = [];
        if (!this.isOp(')')) {
          do list.push(this.expr());
          while (this.acceptOp(','));
        }
        this.expectOp(')');
        a = { k: 'in', e: a, list, not };
        continue;
      }
      if (this.acceptWord('LIKE')) {
        a = { k: 'like', e: a, pattern: this.comparison(), not };
        continue;
      }
      if (this.acceptWord('BETWEEN')) {
        const lo = this.comparison();
        this.expectWord('AND');
        const hi = this.comparison();
        a = { k: 'between', e: a, lo, hi, not };
        continue;
      }
      if (not) throw new SqlSyntaxError('notWhat', this.peek().pos);
      return a;
    }
  }

  private comparison(): Expr {
    let a = this.additive();
    while (this.isOp('<') || this.isOp('<=') || this.isOp('>') || this.isOp('>=')) {
      const op = this.next().text;
      a = { k: 'bin', op, a, b: this.additive() };
    }
    return a;
  }

  private additive(): Expr {
    let a = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().text;
      a = { k: 'bin', op, a, b: this.multiplicative() };
    }
    return a;
  }

  private multiplicative(): Expr {
    let a = this.concat();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().text;
      a = { k: 'bin', op, a, b: this.concat() };
    }
    return a;
  }

  private concat(): Expr {
    let a = this.unary();
    while (this.acceptOp('||')) a = { k: 'bin', op: '||', a, b: this.unary() };
    return a;
  }

  private unary(): Expr {
    if (this.acceptOp('-')) return { k: 'unary', op: '-', e: this.unary() };
    if (this.acceptOp('+')) return { k: 'unary', op: '+', e: this.unary() };
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    if (t.kind === 'num') {
      this.next();
      const isInt = /^\d+$/.test(t.text);
      if (isInt) {
        const big = BigInt(t.text);
        return { k: 'lit', v: big < 2n ** 63n ? big : Number(t.text) };
      }
      return { k: 'lit', v: Number(t.text) };
    }
    if (t.kind === 'str') {
      this.next();
      return { k: 'lit', v: t.text };
    }
    if (this.acceptOp('(')) {
      if (this.isWord('SELECT')) {
        const select = this.selectBody();
        this.expectOp(')');
        return { k: 'subquery', select };
      }
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.kind === 'id' && t.upper === 'EXISTS') {
      this.next();
      this.expectOp('(');
      const select = this.selectBody();
      this.expectOp(')');
      return { k: 'exists', select };
    }
    if (t.kind === 'id') {
      if (t.upper === 'NULL') {
        this.next();
        return { k: 'lit', v: null };
      }
      if (t.upper === 'TRUE' || t.upper === 'FALSE') {
        this.next();
        return { k: 'lit', v: t.upper === 'TRUE' ? 1n : 0n };
      }
      if (t.upper === 'CASE') return this.caseExpr();
      if (t.upper === 'CAST') {
        this.next();
        this.expectOp('(');
        const e = this.expr();
        this.expectWord('AS');
        const words: string[] = [];
        while (this.peek().kind === 'id') words.push(this.next().text);
        if (this.acceptOp('(')) {
          while (!this.isOp(')') && this.peek().kind !== 'end') this.next();
          this.expectOp(')');
        }
        this.expectOp(')');
        return { k: 'cast', e, type: words.join(' ') };
      }
    }
    if ((t.kind === 'id' || t.kind === 'qid') && this.peek(1).text === '(' && t.kind === 'id') {
      const name = this.next().text.toUpperCase();
      this.expectOp('(');
      if (this.acceptOp('*')) {
        this.expectOp(')');
        return { k: 'call', name, args: [], star: true, distinct: false };
      }
      const distinct = this.acceptWord('DISTINCT');
      const args: Expr[] = [];
      if (!this.isOp(')')) {
        do args.push(this.expr());
        while (this.acceptOp(','));
      }
      this.expectOp(')');
      return { k: 'call', name, args, star: false, distinct };
    }
    if (t.kind === 'id' || t.kind === 'qid') {
      const first = this.identifier();
      if (this.acceptOp('.')) return { k: 'col', table: first, name: this.identifier() };
      return { k: 'col', name: first };
    }
    throw new SqlSyntaxError('exprExpected', t.pos);
  }

  private insertBody(): InsertStatement {
    this.expectWord('INSERT');
    this.expectWord('INTO');
    const table = this.identifier();
    let columns: string[] | null = null;
    if (this.acceptOp('(')) {
      columns = [];
      do columns.push(this.identifier());
      while (this.acceptOp(','));
      this.expectOp(')');
    }
    if (this.isWord('SELECT')) {
      return { kind: 'insert', table, columns, values: null, select: this.selectBody() };
    }
    this.expectWord('VALUES');
    const values: Expr[][] = [];
    do {
      this.expectOp('(');
      const row: Expr[] = [];
      do row.push(this.expr());
      while (this.acceptOp(','));
      this.expectOp(')');
      values.push(row);
    } while (this.acceptOp(','));
    return { kind: 'insert', table, columns, values, select: null };
  }

  private updateBody(): UpdateStatement {
    this.expectWord('UPDATE');
    const ref = this.tableRef();
    this.expectWord('SET');
    const set: Array<{ column: string; expr: Expr }> = [];
    do {
      const column = this.identifier();
      this.expectOp('=');
      set.push({ column, expr: this.expr() });
    } while (this.acceptOp(','));
    const where = this.acceptWord('WHERE') ? this.expr() : null;
    return { kind: 'update', ...ref, set, where };
  }

  private deleteBody(): DeleteStatement {
    this.expectWord('DELETE');
    this.expectWord('FROM');
    const ref = this.tableRef();
    const where = this.acceptWord('WHERE') ? this.expr() : null;
    return { kind: 'delete', ...ref, where };
  }

  private caseExpr(): Expr {
    this.expectWord('CASE');
    const base = this.isWord('WHEN') ? null : this.expr();
    const whens: Array<[Expr, Expr]> = [];
    while (this.acceptWord('WHEN')) {
      const cond = this.expr();
      this.expectWord('THEN');
      whens.push([cond, this.expr()]);
    }
    if (whens.length === 0) throw new SqlSyntaxError('whenExpected', this.peek().pos);
    const otherwise = this.acceptWord('ELSE') ? this.expr() : null;
    this.expectWord('END');
    return { k: 'case', base, whens, otherwise };
  }
}

/** Analyse un SELECT ; lève `SqlSyntaxError` (avec la position) sinon. */
export function parseSelect(sql: string): SelectStatement {
  return new Parser(tokenize(sql), sql).parseSelect();
}

/** Analyse une instruction (SELECT, INSERT, UPDATE, DELETE) ; lève `SqlSyntaxError` sinon. */
export function parseStatement(sql: string): Statement {
  return new Parser(tokenize(sql), sql).parseStatement();
}
