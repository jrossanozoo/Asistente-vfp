import {
  CallArg,
  CallSite,
  ClassDecl,
  MemberDecl,
  NoteRef,
  Param,
  ParseDiagnostic,
  ParsedFile,
  Rng,
  VarDecl,
  Visibility,
} from '../model';
import { splitLines } from '../text/encoding';
import { buildLogicalLines, LogicalLine, toPosition } from '../text/logicalLines';
import { scanLines, ScannedLine } from '../text/scanner';
import { commentDocAbove, commentDocInClassHeader, extractNoteBlocks, isSeparatorLine, NoteBlock } from './noteParser';

export interface ParseOptions {
  /** Indexar solo encabezados (define class / function / procedure). */
  headersOnly?: boolean;
  /** Nombres de funciones/métodos (en minúsculas) cuyas llamadas se registran con sus argumentos. */
  callNames?: Iterable<string>;
  /** Usar comentarios clásicos como doc cuando no hay NOTE (por defecto true). */
  fallbackComments?: boolean;
}

export const DEFAULT_CALL_NAMES = ['createobject', 'newobject'];

const NON_CLASS_TYPES = new Set([
  'string', 'character', 'integer', 'number', 'numeric', 'logical', 'boolean', 'date', 'datetime', 'object',
  'variant', 'void', 'currency', 'double', 'float', 'memo', 'general', 'binary', 'blob', 'varbinary', 'array',
  'long', 'single', 'short', 'any',
]);

export function isPrimitiveType(t: string | undefined): boolean {
  return !t || NON_CLASS_TYPES.has(t.toLowerCase());
}

/** `word` es abreviatura válida (≥ min letras) de `keyword`. */
export function isKeyword(word: string, keyword: string, min = 4): boolean {
  const w = word.toLowerCase();
  return w.length >= Math.min(min, keyword.length) && keyword.startsWith(w);
}

export function unquote(s: string | undefined): string | undefined {
  if (!s) return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('[') && t.endsWith(']'))) {
    return t.substring(1, t.length - 1);
  }
  return t;
}

/** Divide por comas de primer nivel. Devuelve cada parte con su offset. */
export function splitTopLevel(masked: string, start = 0, end = masked.length): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let partStart = start;
  for (let i = start; i < end; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push({ start: partStart, end: i });
      partStart = i + 1;
    }
  }
  parts.push({ start: partStart, end });
  return parts;
}

/** Busca el `)` que cierra el `(` en `openIdx`. */
export function findClosingParen(masked: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const VAR_ITEM_RE = /^\s*@?([A-Za-z_]\w*)(?:\s*[[(][^\])]*[\])])?(?:\s+as\s+([\w.]+)(?:\s+(?:of|as)\s+("[^"]*"|'[^']*'|\S+))?)?/i;

interface VarItem {
  name: string;
  type?: string;
  lib?: string;
  nameOffset: number;
}

function parseVarList(ll: LogicalLine, start: number, end: number): VarItem[] {
  const items: VarItem[] = [];
  for (const part of splitTopLevel(ll.masked, start, end)) {
    const text = ll.code.substring(part.start, part.end);
    const m = VAR_ITEM_RE.exec(text);
    if (!m) continue;
    const lead = text.length - text.trimStart().length + (text.trimStart().startsWith('@') ? 1 : 0);
    items.push({ name: m[1], type: m[2], lib: unquote(m[3]), nameOffset: part.start + lead });
  }
  return items;
}

function rangeFrom(ll: LogicalLine, startOffset: number, endOffset: number): Rng {
  return { start: toPosition(ll, startOffset), end: toPosition(ll, endOffset) };
}

const HEADER_KEEP_RE = /^\s*(?:define\s+class\b|enddef|(?:(?:prot\w*|hidd\w*)\s+)?(?:func\w*|proc\w*)\s|endf|endp|#if|#endif)/i;

function headersOnlyLines(lines: string[]): string[] {
  const out: string[] = new Array(lines.length).fill('');
  let keepNext = false;
  for (let i = 0; i < lines.length; i++) {
    if (keepNext || HEADER_KEEP_RE.test(lines[i])) {
      out[i] = lines[i];
      keepNext = /;\s*$/.test(lines[i]);
    } else {
      keepNext = false;
    }
  }
  return out;
}

const DEFINE_RE = /^\s*define\s+class\s+([A-Za-z_]\w*)\s+as\s+([\w.]+)(?:\s+of\s+("[^"]*"|'[^']*'|\S+))?(\s+olepublic)?/di;
const METHOD_RE = /^\s*(?:(prot\w*|hidd\w*)\s+)?(func\w*|proc\w*)\s+([A-Za-z_][\w.]*)\s*(\(([^)]*)\))?(?:\s+as\s+([\w.]+)(?:\s+(?:of|as)\s+("[^"]*"|'[^']*'|\S+))?)?/di;
const ADD_OBJECT_RE = /^\s*add\s+object\s+(?:(prot\w*|hidd\w*)\s+)?([A-Za-z_]\w*)\s+as\s+([\w.]+)/di;
const ASSIGN_RE = /^\s*([A-Za-z_]\w*)(?:\s*\[[^\]]*\])?\s*=(?!=)\s*(.*)$/d;
const DIMENSION_RE = /^\s*(dime\w*|decl\w*)\s+([A-Za-z_]\w*)/di;
const VISIBILITY_LIST_RE = /^\s*(prot\w*|hidd\w*)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*$/i;
const LOCAL_RE = /^\s*(local|loca|publ\w*|priv\w*)\s+(?:array\s+)?/i;
const LPARAM_RE = /^\s*(lpar\w*|para\w*)\s+/i;
const CALL_RE = /([A-Za-z_]\w*)\s*\(/g;
const AS_RE = /\bas\s+([A-Za-z_]\w*)/gi;

function visibilityOf(word: string | undefined): Visibility {
  if (!word) return 'public';
  if (isKeyword(word, 'protected')) return 'protected';
  if (isKeyword(word, 'hidden')) return 'hidden';
  return 'public';
}

interface MemberState {
  member: MemberDecl;
  hasParenParams: boolean;
  sawStatement: boolean;
}

export function parsePrg(text: string, uri: string, options: ParseOptions = {}): ParsedFile {
  let lines = splitLines(text);
  if (options.headersOnly) lines = headersOnlyLines(lines);
  const scanned = scanLines(lines);
  const callNames = new Set([...DEFAULT_CALL_NAMES, ...(options.callNames ?? [])].map((s) => s.toLowerCase()));
  const fallback = options.fallbackComments !== false && !options.headersOnly;

  const { blocks, diagnostics: noteDiagnostics } = options.headersOnly
    ? { blocks: [] as NoteBlock[], diagnostics: [] as ParseDiagnostic[] }
    : extractNoteBlocks(scanned);
  const blocksByTarget = new Map<number, NoteBlock>();
  for (const b of blocks) if (b.targetLine !== undefined) blocksByTarget.set(b.targetLine, b);
  const attached = new Set<NoteBlock>();

  const classes: ClassDecl[] = [];
  const procedures: MemberDecl[] = [];
  const calls: CallSite[] = [];
  const referenced = new Set<string>();

  let currentClass: ClassDecl | undefined;
  let current: MemberState | undefined;
  let inIfFalse = false;

  const docFor = (line: number): MemberDecl['doc'] => {
    const block = blocksByTarget.get(line);
    if (block) {
      attached.add(block);
      return block.doc;
    }
    return fallback ? commentDocAbove(scanned, line) : undefined;
  };

  /** Fin de un bloque cerrado implícitamente por la declaración de `nextLine`. */
  const implicitEnd = (nextLine: number): number => {
    let end = nextLine - 1;
    const block = blocksByTarget.get(nextLine);
    if (block) end = Math.min(end, block.startLine - 1);
    while (end > 0 && (scanned[end].text.trim() === '' || isSeparatorLine(scanned[end].text))) end--;
    return end;
  };

  const closeMember = (endLine: number): void => {
    if (!current) return;
    const end = Math.max(endLine, current.member.range.start.line);
    current.member.range.end = { line: end, character: scanned[end]?.text.length ?? 0 };
    current = undefined;
  };

  const closeClass = (endLine: number): void => {
    if (!currentClass) return;
    const end = Math.max(endLine, currentClass.range.start.line);
    currentClass.range.end = { line: end, character: scanned[end]?.text.length ?? 0 };
    if (!currentClass.doc && fallback) {
      currentClass.doc = commentDocInClassHeader(scanned, currentClass.range.start.line, end);
    }
    currentClass = undefined;
    inIfFalse = false;
  };

  const lineRange = (ll: LogicalLine): Rng => ({
    start: { line: ll.startLine, character: 0 },
    end: { line: ll.endLine, character: scanned[ll.endLine].text.length },
  });

  const addVars = (ll: LogicalLine, items: VarItem[], kind: VarDecl['kind']): void => {
    if (!current) return;
    const locals = (current.member.locals ??= []);
    for (const it of items) {
      locals.push({
        name: it.name,
        type: it.type,
        lib: it.lib,
        kind,
        line: ll.startLine,
        range: rangeFrom(ll, it.nameOffset, it.nameOffset + it.name.length),
      });
    }
  };

  const collectCalls = (ll: LogicalLine): void => {
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(ll.masked))) {
      const name = m[1].toLowerCase();
      if (!callNames.has(name)) continue;
      const open = m.index + m[0].length - 1;
      const close = findClosingParen(ll.masked, open);
      const argsEnd = close < 0 ? ll.masked.length : close;
      const args: CallArg[] = [];
      if (ll.masked.substring(open + 1, argsEnd).trim() !== '') {
        for (const part of splitTopLevel(ll.masked, open + 1, argsEnd)) {
          const raw = ll.code.substring(part.start, part.end);
          const lead = raw.length - raw.trimStart().length;
          const s = part.start + lead;
          const e = part.start + raw.trimEnd().length;
          const str = ll.strings.find((st) => st.start === s && st.end === e);
          args.push({ text: raw.trim(), literal: str?.value, range: rangeFrom(ll, s, e) });
        }
      }
      let r = m.index - 1;
      while (r >= 0 && ll.masked[r] === ' ') r--;
      let receiver = '';
      if (r >= 0 && ll.masked[r] === '.') {
        let k = r - 1;
        while (k >= 0 && /[\w.]/.test(ll.masked[k])) k--;
        receiver = ll.code.substring(k + 1, r);
      }
      calls.push({
        callee: m[1],
        receiver,
        args,
        range: rangeFrom(ll, m.index, close < 0 ? ll.masked.length : close + 1),
        container: current
          ? { className: current.member.className, member: current.member.name }
          : currentClass
            ? { className: currentClass.name }
            : undefined,
      });
    }
  };

  const ensureProperty = (name: string, ll: LogicalLine, offset: number, visibility: Visibility): MemberDecl => {
    const cls = currentClass!;
    const existing = cls.members.find((mm) => mm.kind === 'property' && mm.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (visibility !== 'public') existing.visibility = visibility;
      return existing;
    }
    const nameRange = rangeFrom(ll, offset, offset + name.length);
    const prop: MemberDecl = {
      kind: 'property',
      name,
      className: cls.name,
      uri,
      nameRange,
      range: lineRange(ll),
      params: [],
      visibility,
      doc: docFor(ll.startLine),
    };
    cls.members.push(prop);
    return prop;
  };

  for (const ll of buildLogicalLines(scanned)) {
    const masked = ll.masked;
    const trimmed = masked.trim();
    if (trimmed === '') continue;

    AS_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = AS_RE.exec(masked))) if (!isPrimitiveType(am[1])) referenced.add(am[1]);

    // Directivas
    if (trimmed.startsWith('#')) {
      if (/^#if\s+\.f\.\s*$/i.test(trimmed)) inIfFalse = true;
      else if (/^#endif\b/i.test(trimmed)) inIfFalse = false;
      continue;
    }

    // DEFINE CLASS
    let m = DEFINE_RE.exec(masked);
    if (m) {
      closeMember(implicitEnd(ll.startLine));
      closeClass(implicitEnd(ll.startLine));
      const idx = (m as RegExpExecArray & { indices: [number, number][] }).indices;
      const cls: ClassDecl = {
        name: ll.code.substring(idx[1][0], idx[1][1]),
        parent: ll.code.substring(idx[2][0], idx[2][1]),
        uri,
        nameRange: rangeFrom(ll, idx[1][0], idx[1][1]),
        parentRange: rangeFrom(ll, idx[2][0], idx[2][1]),
        range: { start: { line: ll.startLine, character: 0 }, end: { line: ll.endLine, character: 0 } },
        olepublic: !!m[4],
        members: [],
        doc: undefined,
        fileType: 'prg',
      };
      if (idx[3]) {
        cls.parentLib = unquote(ll.code.substring(idx[3][0], idx[3][1]));
        cls.parentLibRange = rangeFrom(ll, idx[3][0], idx[3][1]);
      }
      const block = blocksByTarget.get(ll.startLine);
      if (block) {
        attached.add(block);
        cls.doc = block.doc;
      } else if (fallback) {
        cls.doc = commentDocAbove(scanned, ll.startLine);
      }
      classes.push(cls);
      currentClass = cls;
      continue;
    }

    if (/^enddef/i.test(trimmed)) {
      closeMember(implicitEnd(ll.startLine));
      closeClass(ll.endLine);
      continue;
    }

    // FUNCTION / PROCEDURE
    m = METHOD_RE.exec(masked);
    if (m) {
      const [, w1, w2] = m;
      const visOk = !w1 || isKeyword(w1, 'protected') || isKeyword(w1, 'hidden');
      const kw = isKeyword(w2, 'function') ? 'function' : isKeyword(w2, 'procedure') ? 'procedure' : undefined;
      if (visOk && kw) {
        closeMember(implicitEnd(ll.startLine));
        const idx = (m as RegExpExecArray & { indices: [number, number][] }).indices;
        const name = ll.code.substring(idx[3][0], idx[3][1]);
        const params: Param[] = [];
        const member: MemberDecl = {
          kind: currentClass ? 'method' : kw,
          name,
          className: currentClass?.name,
          uri,
          nameRange: rangeFrom(ll, idx[3][0], idx[3][1]),
          range: { start: { line: ll.startLine, character: 0 }, end: { line: ll.endLine, character: 0 } },
          params,
          keyword: kw,
          returnType: m[6],
          returnLib: idx[7] ? unquote(ll.code.substring(idx[7][0], idx[7][1])) : undefined,
          visibility: visibilityOf(w1),
          doc: docFor(ll.startLine),
          locals: [],
        };
        current = { member, hasParenParams: !!idx[4], sawStatement: false };
        if (idx[5]) {
          const items = parseVarList(ll, idx[5][0], idx[5][1]);
          for (const it of items) params.push({ name: it.name, type: it.type, lib: it.lib });
          addVars(ll, items, 'parameter');
        }
        if (currentClass) currentClass.members.push(member);
        else procedures.push(member);
        continue;
      }
    }

    if (/^(endf\w*|endp\w*)\b/i.test(trimmed)) {
      const word = trimmed.split(/\s+/)[0];
      if (isKeyword(word, 'endfunc') || isKeyword(word, 'endproc')) {
        closeMember(ll.endLine);
        continue;
      }
    }

    // LOCAL x AS T (también `local this as X` dentro de #if .f.)
    m = LOCAL_RE.exec(masked);
    if (m) {
      const word = m[1];
      const kind: VarDecl['kind'] = isKeyword(word, 'local') ? 'local' : isKeyword(word, 'public') ? 'public' : 'private';
      if (kind === 'local' || isKeyword(word, 'public') || isKeyword(word, 'private')) {
        const items = parseVarList(ll, m[0].length, masked.length);
        const self = items.find((it) => it.name.toLowerCase() === 'this' && it.type);
        if (self && currentClass && (inIfFalse || !current)) {
          currentClass.thisType = self.type;
        }
        if (current) {
          addVars(ll, items.filter((it) => it.name.toLowerCase() !== 'this'), kind);
          current.sawStatement = true;
        }
        collectCalls(ll);
        continue;
      }
    }

    if (current) {
      // LPARAMETERS / PARAMETERS como primera sentencia
      m = LPARAM_RE.exec(masked);
      if (m && (isKeyword(m[1], 'lparameters') || isKeyword(m[1], 'parameters'))) {
        const items = parseVarList(ll, m[0].length, masked.length);
        if (!current.hasParenParams && !current.sawStatement && current.member.params.length === 0) {
          for (const it of items) current.member.params.push({ name: it.name, type: it.type, lib: it.lib });
        }
        addVars(ll, items, 'parameter');
        current.sawStatement = true;
        continue;
      }
      current.sawStatement = true;
      collectCalls(ll);
      continue;
    }

    if (currentClass) {
      // Cuerpo de clase: propiedades
      m = ADD_OBJECT_RE.exec(masked);
      if (m) {
        const idx = (m as RegExpExecArray & { indices: [number, number][] }).indices;
        const name = ll.code.substring(idx[2][0], idx[2][1]);
        currentClass.members.push({
          kind: 'object',
          name,
          className: currentClass.name,
          uri,
          nameRange: rangeFrom(ll, idx[2][0], idx[2][1]),
          range: lineRange(ll),
          params: [],
          visibility: visibilityOf(m[1]),
          objectClass: m[3],
          doc: docFor(ll.startLine),
        });
        continue;
      }
      m = VISIBILITY_LIST_RE.exec(masked);
      if (m && (isKeyword(m[1], 'protected') || isKeyword(m[1], 'hidden'))) {
        const vis = visibilityOf(m[1]);
        const listStart = masked.indexOf(m[2]);
        for (const part of splitTopLevel(masked, listStart, listStart + m[2].length)) {
          const raw = ll.code.substring(part.start, part.end);
          const name = raw.trim();
          if (name) ensureProperty(name, ll, part.start + raw.indexOf(name), vis);
        }
        continue;
      }
      m = DIMENSION_RE.exec(masked);
      if (m && (isKeyword(m[1], 'dimension') || isKeyword(m[1], 'declare'))) {
        const idx = (m as RegExpExecArray & { indices: [number, number][] }).indices;
        ensureProperty(ll.code.substring(idx[2][0], idx[2][1]), ll, idx[2][0], 'public');
        continue;
      }
      m = ASSIGN_RE.exec(masked);
      if (m) {
        const idx = (m as RegExpExecArray & { indices: [number, number][] }).indices;
        const prop = ensureProperty(ll.code.substring(idx[1][0], idx[1][1]), ll, idx[1][0], 'public');
        prop.value = ll.code.substring(idx[2][0]).trim();
        continue;
      }
      collectCalls(ll);
      continue;
    }

    // Nivel de archivo
    collectCalls(ll);
  }

  const lastLine = Math.max(0, scanned.length - 1);
  closeMember(implicitEnd(scanned.length));
  closeClass(lastLine);

  // Tipos de propiedades por `X_Access() as T`
  for (const cls of classes) {
    for (const mm of cls.members) {
      const acc = /^(.+)_access$/i.exec(mm.name);
      if (mm.kind === 'method' && acc && mm.returnType && !isPrimitiveType(mm.returnType)) {
        const prop = cls.members.find((p) => p.kind === 'property' && p.name.toLowerCase() === acc[1].toLowerCase());
        if (prop && !prop.objectClass) prop.objectClass = mm.returnType;
      }
    }
  }

  // Diagnósticos de NOTE
  const allMembers = [...classes.flatMap((c) => c.members), ...procedures].filter(
    (mm) => mm.kind === 'method' || mm.kind === 'procedure' || mm.kind === 'function',
  );
  const notes: NoteRef[] = [];
  const diagnostics: ParseDiagnostic[] = [...noteDiagnostics];
  for (const b of blocks) {
    const isAttached = attached.has(b);
    const insideBody = allMembers.some((mm) => mm.range.start.line < b.startLine && b.startLine <= mm.range.end.line);
    notes.push({ range: b.doc.range!, doc: b.doc, attached: isAttached, insideBody, nonAscii: b.nonAscii });
    if (!isAttached) {
      diagnostics.push({
        code: 'D1',
        severity: 'warning',
        message:
          'NOTE huérfano: no lo sigue una declaración (function, procedure, define class o propiedad). Entre el NOTE y la declaración solo puede haber líneas en blanco, separadores *--- o etiquetas *-- @.',
        range: { start: b.doc.range!.start, end: { line: b.startLine, character: scanned[b.startLine].text.length } },
      });
    }
  }

  return {
    uri,
    classes,
    procedures,
    calls,
    notes,
    referencedClasses: [...referenced],
    diagnostics,
    headersOnly: options.headersOnly || undefined,
  };
}

export type { ScannedLine };
