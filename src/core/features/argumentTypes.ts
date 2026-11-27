import { ClassDecl, MemberDecl, ParseDiagnostic, ParsedFile, VarDecl, VFP_BASE_CLASSES } from '../model';
import { ClassEntry, LayerInfo, SymbolIndex } from '../index/symbolIndex';
import { isPrimitiveType, memberLocals, splitTopLevel } from '../parser/prgParser';
import { LogicalLine, logicalLineAt, toPosition } from '../text/logicalLines';
import { buildCursorContext, CursorContext, findEnclosingCall, Resolver } from './resolve';

/** Código del diagnóstico (para filtrarlo o desactivarlo). */
export const ARG_TYPE_MISMATCH = 'argTypeMismatch';

/** Familia de tipos: dentro de una familia no se reporta. */
type TypeGroup = 'numeric' | 'text' | 'date' | 'logical' | 'object';

const GROUPS: Record<string, TypeGroup> = {
  number: 'numeric',
  numeric: 'numeric',
  int: 'numeric',
  integer: 'numeric',
  long: 'numeric',
  short: 'numeric',
  single: 'numeric',
  double: 'numeric',
  float: 'numeric',
  decimal: 'numeric',
  currency: 'numeric',
  money: 'numeric',
  character: 'text',
  char: 'text',
  string: 'text',
  memo: 'text',
  varchar: 'text',
  date: 'date',
  datetime: 'date',
  logical: 'logical',
  boolean: 'logical',
  bool: 'logical',
  object: 'object',
};

/**
 * Familia de un tipo declarado. undefined = acepta cualquier cosa o no se sabe (`Variant`, `Any`, sin `AS`,
 * `Array`, binarios). Un nombre de clase es `object` (no se valida la jerarquía). Con `isClass`, un nombre que no
 * es primitivo ni una clase conocida (`stirng`, `as as String`) tampoco se sabe.
 */
export function typeGroup(type: string | undefined, isClass?: (name: string) => boolean): TypeGroup | undefined {
  if (!type) return undefined;
  const t = type.trim().toLowerCase();
  if (t in GROUPS) return GROUPS[t];
  if (isPrimitiveType(t)) return undefined;
  if (isClass && !isClass(type.trim())) return undefined;
  return 'object';
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const HEX_RE = /^0x[0-9a-f]+$/i;
const LOGICAL_RE = /^\.(t|f|y|n)\.$/i;
const NULL_RE = /^(\.null\.|null)$/i;
const DATE_RE = /^\{\s*\^?\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s*\}$/;
const DATETIME_RE = /^\{\s*\^?\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[\sT,]+\d{1,2}(:\d{1,2}){0,2}\s*([ap]m?)?\s*\}$/i;
const EMPTY_DATE_RE = /^\{\s*(\/\s*\/|:)?\s*\}$/;
const VAR_RE = /^(?:m\.)?([A-Za-z_]\w*)$/i;

/** Tipo de un argumento, solo si es inequívoco. `null` = `.NULL.` (vale para cualquier parámetro). */
function argumentType(
  text: string,
  isWholeString: boolean,
  locals: () => VarDecl[],
  line: number,
  isClass: (name: string) => boolean,
): { group: TypeGroup; label: string } | null | undefined {
  if (isWholeString) return { group: 'text', label: 'Character' };
  if (NULL_RE.test(text)) return null;
  if (NUMBER_RE.test(text) || HEX_RE.test(text)) return { group: 'numeric', label: 'Numeric' };
  if (LOGICAL_RE.test(text)) return { group: 'logical', label: 'Logical' };
  if (DATETIME_RE.test(text)) return { group: 'date', label: 'DateTime' };
  if (DATE_RE.test(text) || EMPTY_DATE_RE.test(text)) return { group: 'date', label: 'Date' };
  const v = VAR_RE.exec(text);
  if (v) {
    const lower = v[1].toLowerCase();
    let found: VarDecl | undefined;
    for (const d of locals()) if (d.name.toLowerCase() === lower && d.line <= line) found = d;
    const group = typeGroup(found?.type, isClass);
    return group ? { group, label: found!.type! } : undefined;
  }
  return undefined;
}

const CALL_RE = /([A-Za-z_]\w*)\s*\(/g;

/**
 * H5: argumentos cuyo tipo no coincide con el `AS` del parámetro. Solo literales y variables con `AS` del método,
 * y solo cuando la llamada resuelve a un único método o función sin heurística.
 */
export function argumentTypeDiagnostics(
  uri: string,
  text: string,
  parsed: ParsedFile,
  index: SymbolIndex,
  resolver: Resolver,
  layer: LayerInfo,
): ParseDiagnostic[] {
  const out: ParseDiagnostic[] = [];
  const base = buildCursorContext(uri, text, parsed, { line: 0, character: 0 }, index, layer);
  const localsCache = new Map<MemberDecl, VarDecl[]>();
  const localsOf = (m: MemberDecl | undefined): VarDecl[] => {
    if (!m) return [];
    let v = localsCache.get(m);
    if (!v) {
      v = m.locals ?? memberLocals(base.lines, m);
      localsCache.set(m, v);
    }
    return v;
  };
  const isClass = (name: string): boolean => VFP_BASE_CLASSES.has(name.toLowerCase()) || index.hasClass(name);
  // La clase del archivo, una vez por declaración.
  const clsCache = new Map<ClassDecl, ClassEntry>();
  const contextAt = (ll: LogicalLine, offset: number): CursorContext => {
    const position = toPosition(ll, offset);
    const line = position.line;
    const clsDecl = parsed.classes.find((c) => c.range.start.line <= line && line <= c.range.end.line);
    let cls: ClassEntry | undefined;
    if (clsDecl) {
      cls = clsCache.get(clsDecl);
      if (!cls) {
        cls = index.classEntries(clsDecl.name, { includeDownstream: true }).find((e) => e.decl.uri === uri) ?? { decl: clsDecl, layer };
        clsCache.set(clsDecl, cls);
      }
    }
    const pool = clsDecl ? clsDecl.members : parsed.procedures;
    const member = pool.find((m) => (m.kind === 'method' || m.kind === 'procedure' || m.kind === 'function') && m.range.start.line <= line && line <= m.range.end.line);
    return { ...base, position, ll, offset, cls, member };
  };
  for (let line = 0; line < base.scanned.length; line++) {
    const ll = logicalLineAt(base.scanned, line);
    if (!ll) continue;
    line = ll.endLine;
    checkLine(ll, contextAt, resolver, localsOf, isClass, out);
  }
  return out;
}

function checkLine(
  ll: LogicalLine,
  contextAt: (ll: LogicalLine, offset: number) => CursorContext,
  resolver: Resolver,
  localsOf: (m: MemberDecl | undefined) => VarDecl[],
  isClass: (name: string) => boolean,
  out: ParseDiagnostic[],
): void {
  const masked = ll.masked;
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const call = findEnclosingCall(ll, open + 1);
    if (!call || call.openIdx !== open) continue;
    const close = call.closeIdx < 0 ? masked.length : call.closeIdx;
    const ctx = contextAt(ll, call.calleeStart);
    // Primero los argumentos: si ninguno tiene un tipo inequívoco no hace falta resolver la llamada (lo caro).
    const args = splitTopLevel(masked, open + 1, close).map((part) => {
      const raw = ll.code.substring(part.start, part.end);
      const text = raw.trim();
      const start = part.start + (raw.length - raw.trimStart().length);
      const end = start + text.length;
      if (!text) return undefined;
      const whole = ll.strings.some((s) => s.start === start && s.end === end);
      const type = argumentType(text, whole, () => localsOf(ctx.member), ctx.position.line, isClass);
      return type ? { start, end, type } : undefined;
    });
    if (!args.some((a) => a)) continue;
    const candidates = resolver.resolveCall(call, ctx);
    if (candidates.length !== 1) continue;
    if (call.chain && !resolver.resolveChainType(call.chain, ctx)) continue;
    const params = candidates[0].decl.params;
    args.forEach((arg, i) => {
      const param = params[i];
      if (!arg || !param) return;
      const expected = typeGroup(param.type, isClass);
      if (!expected || arg.type.group === expected) return;
      out.push({
        range: { start: toPosition(ll, arg.start), end: toPosition(ll, arg.end) },
        severity: 'warning',
        code: ARG_TYPE_MISMATCH,
        message: `Tipo incorrecto: se esperaba ${param.type} y se recibió ${arg.type.label} (parámetro ${param.name} de ${candidates[0].decl.name}).`,
      });
    });
  }
}
