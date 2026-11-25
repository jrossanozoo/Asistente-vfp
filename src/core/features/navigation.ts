import {
  DocumentSymbol,
  Location,
  SymbolInformation,
  SymbolKind,
  TypeHierarchyItem,
} from 'vscode-languageserver-types';
import { ClassDecl, MemberDecl, ParsedFile, Rng } from '../model';
import { ClassEntry, MemberEntry, SymbolIndex } from '../index/symbolIndex';
import type { ResolvedTarget, TypeResult } from '../plugin';
import type { CursorContext, Resolver } from './resolve';

const ZERO: Rng = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

export function memberKind(m: MemberDecl): SymbolKind {
  switch (m.kind) {
    case 'property':
      return SymbolKind.Property;
    case 'object':
      return SymbolKind.Field;
    case 'method':
      return /^init$/i.test(m.name) ? SymbolKind.Constructor : SymbolKind.Method;
    default:
      return SymbolKind.Function;
  }
}

function safeRange(range: Rng, selection: Rng): Rng {
  // DocumentSymbol exige que range contenga a selectionRange.
  const start = range.start.line < selection.start.line || (range.start.line === selection.start.line && range.start.character <= selection.start.character)
    ? range.start
    : selection.start;
  const end = range.end.line > selection.end.line || (range.end.line === selection.end.line && range.end.character >= selection.end.character)
    ? range.end
    : selection.end;
  return { start, end };
}

/** Outline del documento. */
export function documentSymbols(parsed: ParsedFile): DocumentSymbol[] {
  const memberSymbol = (m: MemberDecl): DocumentSymbol => ({
    name: m.name,
    detail: m.kind === 'property' ? (m.value ?? '') : m.visibility !== 'public' ? m.visibility : '',
    kind: memberKind(m),
    range: safeRange(m.range, m.nameRange),
    selectionRange: m.nameRange,
    tags: m.doc?.deprecated ? [1] : undefined,
  });
  const result: DocumentSymbol[] = parsed.classes.map((c: ClassDecl) => ({
    name: c.name,
    detail: c.parent ? `as ${c.parent}` : '',
    kind: SymbolKind.Class,
    range: safeRange(c.range, c.nameRange),
    selectionRange: c.nameRange,
    tags: c.doc?.deprecated ? [1] : undefined,
    children: c.members.map(memberSymbol),
  }));
  for (const p of parsed.procedures) result.push(memberSymbol(p));
  return result.sort((a, b) => a.range.start.line - b.range.start.line);
}

/** Ctrl+T */
export function workspaceSymbols(index: SymbolIndex, query: string): SymbolInformation[] {
  return index.search(query).map((e) => {
    if (!('kind' in e.decl)) {
      const c = e as ClassEntry;
      return {
        name: c.decl.name,
        kind: SymbolKind.Class,
        location: Location.create(c.decl.uri, c.decl.nameRange),
        containerName: c.layer.label,
      };
    }
    const m = e as MemberEntry;
    return {
      name: m.decl.name,
      kind: memberKind(m.decl),
      location: Location.create(m.decl.uri, m.decl.nameRange),
      containerName: m.decl.className ?? m.layer.label,
    };
  });
}

function loc(uri: string, range: Rng | undefined): Location {
  return Location.create(uri, range ?? ZERO);
}

/** F12 */
export function definitionLocations(target: ResolvedTarget | undefined): Location[] {
  if (!target) return [];
  switch (target.kind) {
    case 'class': {
      const list = target.classes ?? [];
      return (target.multi ? list : list.slice(0, 1)).map((c) => loc(c.decl.uri, c.decl.nameRange));
    }
    case 'member':
    case 'procedure': {
      // Propiedad con tipo deducido: como una variable, F12 va a la(s) clase(s) del tipo.
      // La declaración queda en Go to Declaration (declarationLocations).
      if (target.classes?.length && !target.heuristic) return target.classes.map((c) => loc(c.decl.uri, c.decl.nameRange));
      const list = target.members ?? [];
      return (target.multi || target.heuristic ? list : list.slice(0, 1)).map((m) => loc(m.decl.uri, m.decl.nameRange));
    }
    case 'file':
      return (target.files ?? []).map((u) => loc(u, ZERO));
    default:
      return [];
  }
}

/**
 * F12 incluyendo variables locales (necesita el URI del documento).
 * Una variable de tipo objeto conocido (declarado o inferido) navega a su clase;
 * si no, a su declaración.
 */
export function definitionWithLocals(target: ResolvedTarget | undefined, ctx: CursorContext): Location[] {
  if (target?.kind === 'variable') {
    const classes = target.classes ?? [];
    const decl = target.variable ? [loc(ctx.uri, target.variable.range)] : [];
    if (classes.length) {
      const cls = (target.multi ? classes : classes.slice(0, 1)).map((c) => loc(c.decl.uri, c.decl.nameRange));
      // Una global (`public goX`) declarada aquí: primero la declaración, después la clase.
      return target.variable?.kind === 'public' ? [...decl, ...cls] : cls;
    }
    return decl;
  }
  return definitionLocations(target);
}

/**
 * Go to Declaration: dónde se declara el símbolo, aunque tenga un tipo deducido
 * (la propiedad `oX = null`, la variable `local loX`), en lugar de su clase.
 */
export function declarationLocations(target: ResolvedTarget | undefined, ctx: CursorContext): Location[] {
  if (!target) return [];
  if (target.kind === 'variable') return target.variable ? [loc(ctx.uri, target.variable.range)] : definitionWithLocals(target, ctx);
  if (target.kind === 'member') return definitionLocations({ ...target, classes: undefined });
  return definitionLocations(target);
}

/** Go to Type Definition: las clases del tipo deducido, en orden de precedencia. */
export function typeDefinitionLocations(index: SymbolIndex, type: TypeResult | undefined, ctx: CursorContext): Location[] {
  if (!type) return [];
  const seen = new Set<string>();
  const result: Location[] = [];
  for (const cn of type.classNames) {
    const c = index.getClass(cn, { fromUri: ctx.uri });
    if (!c) continue;
    const key = `${c.decl.uri}#${c.decl.nameRange.start.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(loc(c.decl.uri, c.decl.nameRange));
  }
  return result;
}

/** Ctrl+F12: subclases de una clase u overrides de un método. */
export function implementationLocations(index: SymbolIndex, target: ResolvedTarget | undefined): Location[] {
  if (!target) return [];
  if (target.kind === 'class' || target.kind === 'variable') {
    const result: Location[] = [];
    for (const c of target.classes ?? []) {
      for (const d of index.descendants(c.decl.name)) result.push(loc(d.decl.uri, d.decl.nameRange));
    }
    return result;
  }
  if (target.kind === 'member') {
    const seen = new Set<string>();
    const result: Location[] = [];
    for (const m of target.members ?? []) {
      if (!m.owner) continue;
      for (const o of index.overrides(m.owner.decl.name, m.decl.name)) {
        const key = `${o.decl.uri}#${o.decl.nameRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(loc(o.decl.uri, o.decl.nameRange));
      }
    }
    return result;
  }
  return [];
}

export function typeHierarchyItem(c: ClassEntry): TypeHierarchyItem {
  return {
    name: c.decl.name,
    kind: SymbolKind.Class,
    detail: c.decl.parent ? `as ${c.decl.parent} · ${c.layer.label}` : c.layer.label,
    uri: c.decl.uri,
    range: safeRange(c.decl.range, c.decl.nameRange),
    selectionRange: c.decl.nameRange,
    data: { name: c.decl.name, uri: c.decl.uri },
  };
}

export function prepareTypeHierarchy(resolver: Resolver, ctx: CursorContext): TypeHierarchyItem[] {
  const target = resolver.resolveAt(ctx);
  if (target?.kind === 'class' && target.classes?.length) return [typeHierarchyItem(target.classes[0])];
  if (ctx.cls) return [typeHierarchyItem(ctx.cls)];
  return [];
}

function entryFromItem(index: SymbolIndex, item: TypeHierarchyItem): ClassEntry | undefined {
  const data = item.data as { name: string; uri: string } | undefined;
  const name = data?.name ?? item.name;
  const all = index.classEntries(name, { includeDownstream: true });
  return all.find((e) => e.decl.uri === (data?.uri ?? item.uri)) ?? all[0];
}

export function supertypes(index: SymbolIndex, item: TypeHierarchyItem): TypeHierarchyItem[] {
  const entry = entryFromItem(index, item);
  if (!entry?.decl.parent) return [];
  const parent = index.getClass(entry.decl.parent, { fromUri: entry.decl.uri });
  return parent ? [typeHierarchyItem(parent)] : [];
}

export function subtypes(index: SymbolIndex, item: TypeHierarchyItem): TypeHierarchyItem[] {
  return index.descendants(item.name, false).map(typeHierarchyItem);
}
