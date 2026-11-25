import { ClassDecl, MemberDecl, ParsedFile, Pos, Rng, VarDecl } from '../model';
import { ClassEntry, LayerInfo, MemberEntry, SymbolIndex } from '../index/symbolIndex';
import { findClosingParen, isPrimitiveType, splitTopLevel } from '../parser/prgParser';
import { splitLines } from '../text/encoding';
import { LogicalLine, logicalLineAt, toOffset, toPosition } from '../text/logicalLines';
import { scanLines, ScannedLine } from '../text/scanner';
import { baseNameNoExt } from '../uri';
import type { HostApi, ResolvedTarget, StringCallContext, TypeResult, VfpPlugin } from '../plugin';

export interface CursorContext {
  uri: string;
  lines: string[];
  scanned: ScannedLine[];
  parsed: ParsedFile;
  position: Pos;
  ll?: LogicalLine;
  /** Offset del cursor en la línea lógica (-1 si no es código). */
  offset: number;
  cls?: ClassEntry;
  member?: MemberDecl;
}

function contains(r: Rng, p: Pos): boolean {
  if (p.line < r.start.line || p.line > r.end.line) return false;
  if (p.line === r.start.line && p.character < r.start.character) return false;
  if (p.line === r.end.line && p.character > r.end.character) return false;
  return true;
}

export function buildCursorContext(
  uri: string,
  text: string,
  parsed: ParsedFile,
  position: Pos,
  index: SymbolIndex,
  fallbackLayer: LayerInfo,
): CursorContext {
  const lines = splitLines(text);
  const scanned = scanLines(lines);
  const ll = logicalLineAt(scanned, position.line);
  const offset = ll ? toOffset(ll, position.line, position.character) : -1;
  const line = position.line;
  const clsDecl: ClassDecl | undefined = parsed.classes.find((c) => c.range.start.line <= line && line <= c.range.end.line);
  let cls: ClassEntry | undefined;
  if (clsDecl) {
    cls = index.classEntries(clsDecl.name, { includeDownstream: true }).find((e) => e.decl.uri === uri) ?? {
      decl: clsDecl,
      layer: fallbackLayer,
    };
  }
  const candidates: MemberDecl[] = clsDecl ? clsDecl.members : parsed.procedures;
  const member = candidates.find(
    (m) => (m.kind === 'method' || m.kind === 'procedure' || m.kind === 'function') && m.range.start.line <= line && line <= m.range.end.line,
  );
  return { uri, lines, scanned, parsed, position, ll, offset, cls, member };
}

export function wordAt(text: string, character: number): { word: string; start: number; end: number } | undefined {
  let s = character;
  let e = character;
  while (s > 0 && /\w/.test(text[s - 1])) s--;
  while (e < text.length && /\w/.test(text[e])) e++;
  if (s === e) return undefined;
  return { word: text.substring(s, e), start: s, end: e };
}

export interface EnclosingCall {
  callee: string;
  calleeStart: number;
  openIdx: number;
  closeIdx: number;
  /** Índice del argumento donde está el offset. */
  argIndex: number;
  /** Cadena del receptor (vacía si no hay `.`). */
  chain?: string[];
  /** Hay un `.` antes del callee sin receptor (bloque WITH). */
  withDot: boolean;
}

function skipSpacesBack(s: string, i: number): number {
  while (i >= 0 && (s[i] === ' ' || s[i] === '\t')) i--;
  return i;
}

/**
 * Cadena de receptor que termina justo antes de `dotIdx` (el `.`).
 * `this.ObtenerColaborador().Lista` → ['this', 'ObtenerColaborador()'].
 * Devuelve [] si no hay nada antes del punto (WITH) y undefined si no se puede analizar.
 */
export function chainBefore(masked: string, dotIdx: number): string[] | undefined {
  const chain: string[] = [];
  let i = skipSpacesBack(masked, dotIdx - 1);
  for (;;) {
    let suffix = '';
    if (i >= 0 && (masked[i] === ')' || masked[i] === ']')) {
      const close = masked[i];
      const open = close === ')' ? '(' : '[';
      let depth = 0;
      let k = i;
      for (; k >= 0; k--) {
        if (masked[k] === close) depth++;
        else if (masked[k] === open) {
          depth--;
          if (depth === 0) break;
        }
      }
      if (k < 0) return undefined;
      suffix = close === ')' ? '()' : '[]';
      i = skipSpacesBack(masked, k - 1);
    }
    let s = i;
    while (s >= 0 && /\w/.test(masked[s])) s--;
    const name = masked.substring(s + 1, i + 1);
    if (!name) {
      if (chain.length === 0 && !suffix) return [];
      return undefined;
    }
    chain.unshift(name + suffix);
    i = skipSpacesBack(masked, s);
    if (i >= 0 && masked[i] === '.') {
      i = skipSpacesBack(masked, i - 1);
      continue;
    }
    break;
  }
  return chain;
}

/** Llamada `nombre(` abierta que contiene al offset. */
export function findEnclosingCall(ll: LogicalLine, offset: number): EnclosingCall | undefined {
  const m = ll.masked;
  let depth = 0;
  let commas = 0;
  for (let i = Math.min(offset, m.length) - 1; i >= 0; i--) {
    const ch = m[i];
    if (ch === ')' || ch === ']') depth++;
    else if (ch === '[') {
      if (depth === 0) return undefined; // dentro de un subíndice
      depth--;
    } else if (ch === '(') {
      if (depth > 0) {
        depth--;
        continue;
      }
      const end = skipSpacesBack(m, i - 1);
      let s = end;
      while (s >= 0 && /\w/.test(m[s])) s--;
      const callee = m.substring(s + 1, end + 1);
      if (!callee || /^\d/.test(callee)) {
        // Paréntesis de agrupación: seguir buscando hacia afuera.
        commas = 0;
        continue;
      }
      const before = skipSpacesBack(m, s);
      let chain: string[] | undefined;
      let withDot = false;
      if (before >= 0 && m[before] === '.') {
        chain = chainBefore(m, before);
        if (chain && chain.length === 0) withDot = true;
      }
      const close = findClosingParen(m, i);
      return {
        callee: ll.code.substring(s + 1, end + 1),
        calleeStart: s + 1,
        openIdx: i,
        closeIdx: close,
        argIndex: commas,
        chain: chain && chain.length ? chain : undefined,
        withDot,
      };
    } else if (ch === ',' && depth === 0) commas++;
  }
  return undefined;
}

function stripSuffix(seg: string): { name: string; call: boolean } {
  if (seg.endsWith('()')) return { name: seg.slice(0, -2), call: true };
  if (seg.endsWith('[]')) return { name: seg.slice(0, -2), call: false };
  return { name: seg, call: false };
}

const WITH_RE = /^\s*with\s+(.+)$/i;
const ENDWITH_RE = /^\s*endwith\b/i;

export class Resolver {
  constructor(
    private readonly index: SymbolIndex,
    private readonly plugins: () => VfpPlugin[],
    private readonly api: () => HostApi,
  ) {}

  /** Expresión del WITH que envuelve la línea del cursor (cadena). */
  withChain(ctx: CursorContext): string[] | undefined {
    if (!ctx.ll) return undefined;
    const stop = ctx.member ? ctx.member.range.start.line : 0;
    let depth = 0;
    for (let line = ctx.ll.startLine - 1; line >= stop; line--) {
      const s = ctx.scanned[line];
      if (s.isComment || s.isText) continue;
      const ll = logicalLineAt(ctx.scanned, line);
      if (!ll || ll.endLine !== line) continue;
      if (ENDWITH_RE.test(ll.masked)) depth++;
      else {
        const m = WITH_RE.exec(ll.masked);
        if (m) {
          if (depth === 0) {
            const exprStart = ll.masked.length - m[1].length;
            const expr = ll.masked.substring(exprStart).trimEnd();
            return chainBefore(expr + '.', expr.length);
          }
          depth--;
        }
      }
      line = ll.startLine;
    }
    return undefined;
  }

  private localVar(name: string, ctx: CursorContext): VarDecl | undefined {
    const lower = name.toLowerCase();
    const locals = ctx.member?.locals ?? [];
    // La última declaración antes del cursor gana.
    let found: VarDecl | undefined;
    for (const v of locals) {
      if (v.name.toLowerCase() === lower && v.line <= ctx.position.line) found = v;
    }
    return found ?? locals.find((v) => v.name.toLowerCase() === lower);
  }

  /** Tipo de una cadena de receptor. */
  resolveChainType(chain: string[], ctx: CursorContext): TypeResult | undefined {
    if (chain.length === 0) return undefined;
    const api = this.api();
    for (let k = chain.length; k >= 1; k--) {
      const prefix = chain.slice(0, k);
      for (const p of this.plugins()) {
        for (const tr of p.typeResolvers ?? []) {
          const r = tr.resolveChain(prefix, ctx, api);
          if (r && r.classNames.length) {
            const rest = this.stepRest(r, chain.slice(k), ctx);
            if (rest) return rest;
          }
        }
      }
      if (k === 1) {
        const first = this.firstSegmentType(chain[0], ctx);
        if (first) return this.stepRest(first, chain.slice(1), ctx);
      }
    }
    return undefined;
  }

  private firstSegmentType(seg: string, ctx: CursorContext): TypeResult | undefined {
    const { name } = stripSuffix(seg);
    const lower = name.toLowerCase();
    if (lower === 'this' || lower === 'thisform' || lower === 'thisformset') {
      if (!ctx.cls) return undefined;
      return { classNames: [ctx.cls.decl.name] };
    }
    const v = this.localVar(name, ctx);
    if (v?.type && !isPrimitiveType(v.type)) return { classNames: [v.type] };
    return undefined;
  }

  private stepRest(type: TypeResult, rest: string[], ctx: CursorContext): TypeResult | undefined {
    let current = type;
    for (const seg of rest) {
      const { name } = stripSuffix(seg);
      const next = this.memberType(current, name, ctx);
      if (!next) return undefined;
      current = next;
    }
    return current;
  }

  /** Tipo del miembro `name` de una clase (propiedad con tipo, objeto o retorno de método). */
  memberType(type: TypeResult, name: string, ctx: CursorContext): TypeResult | undefined {
    for (const cn of type.classNames) {
      const m = this.index.findMember(cn, name, { fromUri: ctx.uri });
      if (!m) continue;
      const t = m.decl.kind === 'method' ? m.decl.returnType : m.decl.objectClass;
      if (t && !isPrimitiveType(t)) return { classNames: [t], heuristic: type.heuristic };
      // Permite a los plugins inferir el tipo de propiedades (p.ej. asignaciones desde fábricas).
      return undefined;
    }
    return undefined;
  }

  /**
   * Tipo de una variable bajo el cursor (declarado `as Clase` o inferido por los plugins,
   * p.ej. `loX = _screen.zoo.CrearObjeto("X")`) y las clases indexadas que le corresponden.
   */
  private variableTarget(word: string, ctx: CursorContext): Pick<ResolvedTarget, 'classes' | 'multi' | 'receiverType'> | undefined {
    const type = this.resolveChainType([word], ctx);
    if (!type?.classNames.length) return undefined;
    const classes = this.classesOf(type, ctx);
    if (!classes.length) return undefined;
    return { classes, multi: classes.length > 1 || undefined, receiverType: type };
  }

  /** Clases indexadas de un tipo, sin repetir, en el orden de precedencia. */
  private classesOf(type: TypeResult, ctx: CursorContext): ClassEntry[] {
    const seen = new Set<string>();
    const classes: ClassEntry[] = [];
    for (const cn of type.classNames) {
      const c = this.index.getClass(cn, { fromUri: ctx.uri });
      if (!c || seen.has(c.decl.name.toLowerCase())) continue;
      seen.add(c.decl.name.toLowerCase());
      classes.push(c);
    }
    return classes;
  }

  /** Miembros candidatos por nombre cuando no se conoce el tipo del receptor. */
  fallbackByName(word: string, ctx: CursorContext, limit = 50): MemberEntry[] {
    let all = this.index.membersNamed(word).filter((m) => m.owner);
    const excluders = this.plugins().filter((p) => p.excludeHeuristic);
    if (excluders.length) {
      const api = this.api();
      const kept = all.filter((m) => !excluders.some((p) => p.excludeHeuristic!(m.decl.uri, api)));
      // Si el filtro deja la lista vacía, mejor mostrar algo que nada.
      if (kept.length) all = kept;
    }
    const hierarchy = new Set<string>();
    if (ctx.cls) for (const n of this.index.hierarchyNames(ctx.cls)) hierarchy.add(n.toLowerCase());
    const referenced = new Set(ctx.parsed.referencedClasses.map((s) => s.toLowerCase()));
    const score = (m: MemberEntry): number => {
      const owner = m.owner!.decl.name.toLowerCase();
      if (hierarchy.has(owner)) return 0;
      if (referenced.has(owner)) return 1;
      if (m.layer.role === 'downstream') return 3;
      return 2;
    };
    return [...all].sort((a, b) => score(a) - score(b) || a.layer.priority - b.layer.priority).slice(0, limit);
  }

  /** Resuelve `chain.word` (o `.word` en WITH) como miembro. */
  resolveMember(word: string, chain: string[] | undefined, ctx: CursorContext): Pick<ResolvedTarget, 'members' | 'heuristic' | 'receiverType'> {
    const type = chain ? this.resolveChainType(chain, ctx) : undefined;
    if (type) {
      for (const cn of type.classNames) {
        const m = this.index.findMember(cn, word, { fromUri: ctx.uri });
        if (m) return { members: [m], heuristic: type.heuristic, receiverType: type };
      }
    }
    const candidates = this.fallbackByName(word, ctx);
    return { members: candidates, heuristic: true, receiverType: type };
  }

  /** Target de una llamada (para signature help). */
  resolveCall(call: EnclosingCall, ctx: CursorContext): MemberEntry[] {
    const lower = call.callee.toLowerCase();
    if (lower === 'dodefault') {
      if (!ctx.cls || !ctx.member) return [];
      const parent = this.index.findInAncestors(ctx.cls, ctx.member.name);
      return parent ? [parent] : [];
    }
    if (call.chain || call.withDot) {
      const chain = call.chain ?? this.withChain(ctx);
      if (chain && chain.length === 1 && chain[0].toLowerCase() === 'm') return [];
      return this.resolveMember(call.callee, chain, ctx).members ?? [];
    }
    return this.index.procedures(call.callee, { fromUri: ctx.uri });
  }

  /** Qué hay bajo el cursor. */
  resolveAt(ctx: CursorContext): ResolvedTarget | undefined {
    const { position } = ctx;
    const lineText = ctx.lines[position.line] ?? '';
    const ll = ctx.ll;
    if (!ll || ctx.offset < 0) return undefined;

    // 1. String literal
    const str = ll.strings.find((s) => ctx.offset > s.start && ctx.offset < s.end);
    if (str) return this.resolveString(ctx, ll, str.start, str.value, str.end);

    const w = wordAt(lineText, position.character);
    if (!w) return undefined;
    const range: Rng = { start: { line: position.line, character: w.start }, end: { line: position.line, character: w.end } };
    const word = w.word;
    const lower = word.toLowerCase();
    const base: ResolvedTarget = { kind: 'none', word, range };

    // 2. Declaraciones del propio archivo
    for (const c of ctx.parsed.classes) {
      if (contains(c.nameRange, position)) {
        const entry = this.index.classEntries(c.name, { includeDownstream: true }).find((e) => e.decl.uri === ctx.uri) ?? ctx.cls;
        return { ...base, kind: 'class', classes: entry ? [entry] : [] };
      }
      if (c.parentRange && contains(c.parentRange, position)) {
        return { ...base, kind: 'class', classes: this.index.classEntries(c.parent!, { fromUri: ctx.uri }).slice(0, 1) };
      }
      for (const m of c.members) {
        if (contains(m.nameRange, position)) {
          const owner = this.index.classEntries(c.name, { includeDownstream: true }).find((e) => e.decl.uri === ctx.uri);
          return { ...base, kind: 'member', members: [{ decl: m, owner, layer: owner?.layer ?? ctx.cls!.layer }] };
        }
      }
    }
    for (const p of ctx.parsed.procedures) {
      if (contains(p.nameRange, position)) {
        const entry = this.index.procedures(p.name).find((e) => e.decl.uri === ctx.uri);
        return { ...base, kind: 'procedure', members: entry ? [entry] : [] };
      }
    }

    const logicalStart = toOffset(ll, position.line, w.start);
    const before = ll.masked.substring(0, logicalStart);

    // 3. OF lib.prg → archivo
    if (/\bof\s+[\w.\\:-]*$/i.test(before)) {
      let s = w.start;
      let e = w.end;
      while (s > 0 && /[\w.\\:-]/.test(lineText[s - 1])) s--;
      while (e < lineText.length && /[\w.\\:-]/.test(lineText[e])) e++;
      const token = lineText.substring(s, e);
      return { ...base, kind: 'file', files: this.index.filesNamed(baseNameNoExt(token)), multi: true };
    }

    // 4. AS Clase
    if (/\bas\s+$/i.test(before)) {
      return { ...base, kind: 'class', classes: this.index.classEntries(word, { fromUri: ctx.uri }).slice(0, 1) };
    }

    // 5. this / thisform
    if ((lower === 'this' || lower === 'thisform' || lower === 'thisformset') && ctx.cls) {
      return { ...base, kind: 'class', classes: [ctx.cls] };
    }

    // 6. dodefault
    if (lower === 'dodefault') {
      if (!ctx.cls || !ctx.member) return base;
      const parent = this.index.findInAncestors(ctx.cls, ctx.member.name);
      return { ...base, kind: 'member', members: parent ? [parent] : [] };
    }

    // 7. Acceso a miembro: algo.word
    const dot = skipSpacesBack(ll.masked, logicalStart - 1);
    if (dot >= 0 && ll.masked[dot] === '.') {
      let chain = chainBefore(ll.masked, dot);
      if (chain && chain.length === 0) chain = this.withChain(ctx);
      if (chain && chain.length === 1 && chain[0].toLowerCase() === 'm') {
        const v = this.localVar(word, ctx);
        const typed = this.variableTarget(word, ctx);
        return v || typed ? { ...base, kind: 'variable', variable: v, ...typed } : base;
      }
      const r = this.resolveMember(word, chain, ctx);
      // Propiedad con tipo deducido (`this.oX = CrearObjeto("X")`): además de la declaración, su clase.
      const m0 = r.members?.[0];
      if (chain && !r.heuristic && m0 && (m0.decl.kind === 'property' || m0.decl.kind === 'object')) {
        const t = this.resolveChainType([...chain, word], ctx);
        const classes = t && !t.heuristic ? this.classesOf(t, ctx) : [];
        if (classes.length) return { ...base, kind: 'member', ...r, classes };
      }
      return { ...base, kind: 'member', ...r };
    }

    // 8. Llamada a función/procedimiento
    const after = ll.masked.substring(toOffset(ll, position.line, w.end));
    const isCall = /^\s*\(/.test(after);
    if (isCall) {
      const procs = this.index.procedures(word, { fromUri: ctx.uri });
      if (procs.length) return { ...base, kind: 'procedure', members: procs.slice(0, 1) };
    }

    // 9. Variable local / parámetro (con su tipo declarado o inferido: fábricas, asignaciones)
    const v = this.localVar(word, ctx);
    const typed = lower === 'm' ? undefined : this.variableTarget(word, ctx);
    if (v || typed) return { ...base, kind: 'variable', variable: v, ...typed };

    // 10. Nombre de clase o procedimiento
    const classes = this.index.classEntries(word, { fromUri: ctx.uri });
    if (classes.length) return { ...base, kind: 'class', classes: classes.slice(0, 1) };
    const procs = this.index.procedures(word, { fromUri: ctx.uri });
    if (procs.length) return { ...base, kind: 'procedure', members: procs.slice(0, 1) };
    return base;
  }

  /**
   * Go to Type Definition: tipo de la expresión que termina en la palabra bajo el cursor
   * (`this.oX`, `loX`, `goServicios.Mensajes`, `goMensajes`, `_screen.zoo.app`, `this`, …).
   * Solo tipos deducidos: nunca cae en la búsqueda heurística por nombre.
   */
  typeAt(ctx: CursorContext): TypeResult | undefined {
    const { position } = ctx;
    const ll = ctx.ll;
    if (!ll || ctx.offset < 0) return undefined;

    // Literal de fábrica: la clase que resuelve.
    if (ll.strings.some((s) => ctx.offset > s.start && ctx.offset < s.end)) {
      const t = this.resolveAt(ctx);
      if (t?.kind !== 'class' || !t.classes?.length) return undefined;
      return { classNames: t.classes.map((c) => c.decl.name) };
    }

    const lineText = ctx.lines[position.line] ?? '';
    const w = wordAt(lineText, position.character);
    if (!w) return undefined;
    const logicalStart = toOffset(ll, position.line, w.start);
    const before = ll.masked.substring(0, logicalStart);
    if (/\bas\s+$/i.test(before)) return this.index.hasClass(w.word) ? { classNames: [w.word] } : undefined;

    const after = ll.masked.substring(toOffset(ll, position.line, w.end));
    const seg = /^\s*\(/.test(after) ? `${w.word}()` : w.word;
    let chain: string[] = [seg];
    const dot = skipSpacesBack(ll.masked, logicalStart - 1);
    if (dot >= 0 && ll.masked[dot] === '.') {
      let recv = chainBefore(ll.masked, dot);
      if (recv && recv.length === 0) recv = this.withChain(ctx);
      if (!recv) return undefined;
      if (!(recv.length === 1 && recv[0].toLowerCase() === 'm')) chain = [...recv, seg];
    }
    const type = this.resolveChainType(chain, ctx);
    if (!type || type.heuristic || !type.classNames.length) return undefined;
    return type;
  }

  /** String literal dentro de una llamada. */
  private resolveString(ctx: CursorContext, ll: LogicalLine, strStart: number, value: string, strEnd: number): ResolvedTarget | undefined {
    const range: Rng = { start: toPosition(ll, strStart + 1), end: toPosition(ll, strEnd - 1) };
    if (/\bof\s+$/i.test(ll.masked.substring(0, strStart))) {
      return { kind: 'file', word: value, range, files: this.index.filesNamed(baseNameNoExt(value)), multi: true };
    }
    const call = findEnclosingCall(ll, strStart);
    if (!call) return undefined;
    const closeIdx = call.closeIdx < 0 ? ll.masked.length : call.closeIdx;
    const literals = splitTopLevel(ll.masked, call.openIdx + 1, closeIdx).map((part) => {
      const raw = ll.masked.substring(part.start, part.end);
      const s = part.start + (raw.length - raw.trimStart().length);
      const e = part.start + raw.trimEnd().length;
      return ll.strings.find((st) => st.start === s && st.end === e)?.value;
    });
    const receiver = call.chain ? call.chain.join('.') : '';
    const sc: StringCallContext = { callee: call.callee, receiver, argIndex: call.argIndex, literal: value, literals, range };
    const api = this.api();
    for (const p of this.plugins()) {
      for (const sr of p.stringResolvers ?? []) {
        const r = sr.resolveString(sc, ctx, api);
        if (r) return r;
      }
    }
    const callee = call.callee.toLowerCase();
    const base: ResolvedTarget = { kind: 'none', word: value, range };
    if ((callee === 'createobject' || callee === 'newobject') && call.argIndex === 0) {
      if (value.includes('.')) return base; // clase COM/.NET
      return { ...base, kind: 'class', classes: this.index.classEntries(value, { fromUri: ctx.uri }).slice(0, 1) };
    }
    if (callee === 'newobject' && call.argIndex === 1) {
      return { ...base, kind: 'file', files: this.index.filesNamed(baseNameNoExt(value)), multi: true };
    }
    return undefined;
  }
}
