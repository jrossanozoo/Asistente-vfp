import { ClassDecl, DocInfo, MemberDecl, ParsedFile, VFP_BASE_CLASSES } from '../model';
import { baseNameNoExt, uriToPath } from '../uri';

/** Capa de origen de los símbolos (workspace, repos hermanos, consumidores, índices externos…). */
export interface LayerInfo {
  id: string;
  /** Texto para la procedencia en el hover. */
  label: string;
  /** Menor = preferida al resolver duplicados. */
  priority: number;
  /** `downstream`: solo para implementaciones/jerarquía, nunca para resolver tipos. */
  role: 'source' | 'downstream';
  /** Calidad de la información (por ejemplo "fuente", "símbolos v2.5", "stub"). */
  quality?: string;
}

export interface FileEntry {
  uri: string;
  parsed: ParsedFile;
  layer: LayerInfo;
  /**
   * Nombre con el que se busca el archivo en `OF lib.prg` / `newobject(…, "lib")`.
   * undefined: el nombre del archivo del URI. null: no se registra (índices sintéticos).
   */
  lookupName?: string | null;
}

export interface ClassEntry {
  decl: ClassDecl;
  layer: LayerInfo;
  /** Archivo del índice que aportó la declaración (puede diferir de decl.uri). */
  fileUri?: string;
}

export interface MemberEntry {
  decl: MemberDecl;
  owner?: ClassEntry;
  layer: LayerInfo;
  fileUri?: string;
}

export interface ResolveOptions {
  includeDownstream?: boolean;
  /** URI desde la que se resuelve (prefiere el mismo archivo). */
  fromUri?: string;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function removeWhere<T>(map: Map<string, T[]>, pred: (v: T) => boolean): void {
  for (const [k, list] of map) {
    const filtered = list.filter((v) => !pred(v));
    if (filtered.length === 0) map.delete(k);
    else if (filtered.length !== list.length) map.set(k, filtered);
  }
}

const FILETYPE_ORDER: Record<string, number> = { prg: 0, vcx: 1 };

export class SymbolIndex {
  private files = new Map<string, FileEntry>();
  private classes = new Map<string, ClassEntry[]>();
  private procs = new Map<string, MemberEntry[]>();
  private members = new Map<string, MemberEntry[]>();
  private children = new Map<string, ClassEntry[]>();
  private filesByBase = new Map<string, string[]>();
  private loaderMisses = new Set<string>();
  /**
   * Carga perezosa de una clase que no está en el índice (por ejemplo, generados por nombre de archivo).
   * Devuelve el archivo a agregar, o undefined.
   */
  classLoader?: (name: string) => FileEntry | undefined;
  /**
   * Archivos de test (los define el plugin). Sus clases van al final y, resolviendo desde un archivo que no es de
   * test, se descartan: la aplicación no depende de los tests.
   */
  isTestUri?: (uri: string) => boolean;
  /** Se incrementa con cada cambio (para caches derivadas). */
  version = 0;

  get fileCount(): number {
    return this.files.size;
  }

  allFiles(): IterableIterator<FileEntry> {
    return this.files.values();
  }

  getFile(uri: string): FileEntry | undefined {
    return this.files.get(uri);
  }

  upsert(entry: FileEntry): void {
    if (this.files.has(entry.uri)) this.remove(entry.uri, false);
    this.files.set(entry.uri, entry);
    if (entry.lookupName !== null) {
      const name = entry.lookupName ?? uriToPath(entry.uri);
      push(this.filesByBase, baseNameNoExt(name).toLowerCase(), entry.uri);
    }
    const fileUri = entry.uri;
    for (const decl of entry.parsed.classes) {
      const ce: ClassEntry = { decl, layer: entry.layer, fileUri };
      push(this.classes, decl.name.toLowerCase(), ce);
      if (decl.parent) push(this.children, decl.parent.toLowerCase(), ce);
      for (const m of decl.members) push(this.members, m.name.toLowerCase(), { decl: m, owner: ce, layer: entry.layer, fileUri });
    }
    for (const p of entry.parsed.procedures) push(this.procs, p.name.toLowerCase(), { decl: p, layer: entry.layer, fileUri });
    this.version++;
  }

  remove(uri: string, bump = true): void {
    if (!this.files.delete(uri)) return;
    const byUri = (v: { fileUri?: string; decl: { uri: string } }): boolean => (v.fileUri ?? v.decl.uri) === uri;
    removeWhere(this.classes, byUri);
    removeWhere(this.children, byUri);
    removeWhere(this.members, byUri);
    removeWhere(this.procs, byUri);
    removeWhere(this.filesByBase, (u: string) => u === uri);
    if (bump) this.version++;
  }

  clear(): void {
    this.files.clear();
    this.classes.clear();
    this.procs.clear();
    this.members.clear();
    this.children.clear();
    this.filesByBase.clear();
    this.loaderMisses.clear();
    this.version++;
  }

  private sortEntries<T extends { layer: LayerInfo; decl: { uri: string } }>(
    list: T[],
    opts: ResolveOptions,
    fileType?: (t: T) => string | undefined,
    namesake?: (t: T) => boolean,
  ): T[] {
    return [...list].sort((a, b) => {
      if (opts.fromUri) {
        const sa = a.decl.uri === opts.fromUri ? 0 : 1;
        const sb = b.decl.uri === opts.fromUri ? 0 : 1;
        if (sa !== sb) return sa - sb;
      }
      const ra = a.layer.role === 'downstream' ? 1 : 0;
      const rb = b.layer.role === 'downstream' ? 1 : 0;
      if (ra !== rb) return ra - rb;
      if (this.isTestUri) {
        const ta = this.isTestUri(a.decl.uri) ? 1 : 0;
        const tb = this.isTestUri(b.decl.uri) ? 1 : 0;
        if (ta !== tb) return ta - tb;
      }
      if (namesake) {
        const na = namesake(a) ? 0 : 1;
        const nb = namesake(b) ? 0 : 1;
        if (na !== nb) return na - nb;
      }
      if (a.layer.priority !== b.layer.priority) return a.layer.priority - b.layer.priority;
      if (fileType) {
        const fa = FILETYPE_ORDER[fileType(a) ?? 'prg'] ?? 2;
        const fb = FILETYPE_ORDER[fileType(b) ?? 'prg'] ?? 2;
        if (fa !== fb) return fa - fb;
      }
      return 0;
    });
  }

  /** Todas las declaraciones de una clase, la preferida primero. */
  classEntries(name: string, opts: ResolveOptions = {}): ClassEntry[] {
    const key = name.toLowerCase();
    let list = this.classes.get(key);
    if (!list && this.classLoader && !this.loaderMisses.has(key)) {
      const loaded = this.classLoader(name);
      if (loaded) this.upsert(loaded);
      else this.loaderMisses.add(key);
      list = this.classes.get(key);
    }
    list ??= [];
    // Regla del archivo homónimo: `define class Mensajes` en mensajes.prg gana a otras clases Mensajes.
    const namesake = (e: ClassEntry): boolean =>
      e.decl.fileType !== 'vcx' && baseNameNoExt(uriToPath(e.fileUri ?? e.decl.uri)).toLowerCase() === key;
    let sorted = this.sortEntries(list, opts, (e) => e.decl.fileType, namesake);
    const isTest = this.isTestUri;
    if (isTest && opts.fromUri && !isTest(opts.fromUri)) sorted = sorted.filter((e) => !isTest(e.decl.uri));
    if (opts.includeDownstream) return sorted;
    const source = sorted.filter((e) => e.layer.role !== 'downstream');
    return source.length ? source : sorted;
  }

  getClass(name: string, opts: ResolveOptions = {}): ClassEntry | undefined {
    return this.classEntries(name, opts)[0];
  }

  hasClass(name: string): boolean {
    return this.classes.has(name.toLowerCase()) || this.classEntries(name).length > 0;
  }

  /** Cadena de ancestros (sin incluir la clase). Se corta en clases base de VFP o desconocidas. */
  ancestors(entry: ClassEntry): ClassEntry[] {
    const chain: ClassEntry[] = [];
    const seen = new Set<string>([entry.decl.name.toLowerCase()]);
    let current: ClassEntry | undefined = entry;
    while (current?.decl.parent && chain.length < 64) {
      const parentName = current.decl.parent.toLowerCase();
      if (seen.has(parentName) || VFP_BASE_CLASSES.has(parentName)) break;
      seen.add(parentName);
      const parent = this.getClass(current.decl.parent, { fromUri: current.decl.uri });
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  /** Nombres de la jerarquía, incluida la base nativa de VFP si se llega a ella. */
  hierarchyNames(entry: ClassEntry): string[] {
    const chain = [entry, ...this.ancestors(entry)];
    const names = chain.map((c) => c.decl.name);
    const last = chain[chain.length - 1].decl;
    if (last.parent && !this.hasClass(last.parent)) names.push(last.parent);
    return names;
  }

  /** Busca un miembro en la clase y sus ancestros. */
  findMember(className: string, memberName: string, opts: ResolveOptions = {}): MemberEntry | undefined {
    const entry = this.getClass(className, opts);
    if (!entry) return undefined;
    const lowerName = memberName.toLowerCase();
    for (const c of [entry, ...this.ancestors(entry)]) {
      const m = c.decl.members.find((mm) => mm.name.toLowerCase() === lowerName);
      if (m) return { decl: m, owner: c, layer: c.layer };
    }
    return undefined;
  }

  /** Miembro en el ancestro más cercano (para `dodefault`). */
  findInAncestors(entry: ClassEntry, memberName: string): MemberEntry | undefined {
    const lowerName = memberName.toLowerCase();
    for (const c of this.ancestors(entry)) {
      const m = c.decl.members.find((mm) => mm.name.toLowerCase() === lowerName);
      if (m) return { decl: m, owner: c, layer: c.layer };
    }
    return undefined;
  }

  /** Todos los miembros visibles de una clase (el más cercano gana). */
  allMembers(className: string, opts: ResolveOptions = {}): MemberEntry[] {
    const entry = this.getClass(className, opts);
    if (!entry) return [];
    const result = new Map<string, MemberEntry>();
    for (const c of [entry, ...this.ancestors(entry)]) {
      for (const m of c.decl.members) {
        const key = m.name.toLowerCase();
        if (!result.has(key)) result.set(key, { decl: m, owner: c, layer: c.layer });
      }
    }
    return [...result.values()];
  }

  /** Subclases (directas o transitivas), incluidas las de repos consumidores. */
  descendants(className: string, transitive = true): ClassEntry[] {
    const result: ClassEntry[] = [];
    const seen = new Set<string>([className.toLowerCase()]);
    const queue = [className.toLowerCase()];
    while (queue.length) {
      const name = queue.shift()!;
      for (const child of this.children.get(name) ?? []) {
        const key = child.decl.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(child);
        if (transitive) queue.push(key);
      }
    }
    return result;
  }

  /** Overrides de un método en las subclases. */
  overrides(className: string, memberName: string): MemberEntry[] {
    const lowerName = memberName.toLowerCase();
    const result: MemberEntry[] = [];
    for (const d of this.descendants(className)) {
      const m = d.decl.members.find((mm) => mm.name.toLowerCase() === lowerName);
      if (m) result.push({ decl: m, owner: d, layer: d.layer });
    }
    return result;
  }

  procedures(name: string, opts: ResolveOptions = {}): MemberEntry[] {
    return this.sortEntries(this.procs.get(name.toLowerCase()) ?? [], opts);
  }

  membersNamed(name: string): MemberEntry[] {
    return this.members.get(name.toLowerCase()) ?? [];
  }

  filesNamed(baseName: string): string[] {
    return this.filesByBase.get(baseNameNoExt(baseName).toLowerCase()) ?? [];
  }

  classNames(): string[] {
    return [...this.classes.values()].map((l) => l[0].decl.name);
  }

  /**
   * Doc efectiva de un miembro: la propia si es NOTE; si no, la del ancestro más cercano con NOTE;
   * si no hay, la propia de respaldo (comentarios).
   */
  effectiveDoc(member: MemberEntry): { doc?: DocInfo; inheritedFrom?: string } {
    if (member.decl.doc && member.decl.doc.source !== 'comment') return { doc: member.decl.doc };
    if (member.owner) {
      const lowerName = member.decl.name.toLowerCase();
      for (const c of this.ancestors(member.owner)) {
        const m = c.decl.members.find((mm) => mm.name.toLowerCase() === lowerName);
        if (m?.doc && m.doc.source !== 'comment') return { doc: m.doc, inheritedFrom: c.decl.name };
      }
    }
    return { doc: member.decl.doc };
  }

  /** Búsqueda de símbolos por subcadena (Ctrl+T). */
  search(query: string, limit = 500): (ClassEntry | MemberEntry)[] {
    const q = query.toLowerCase();
    const result: (ClassEntry | MemberEntry)[] = [];
    const match = (name: string): boolean => (q === '' ? true : name.toLowerCase().includes(q));
    for (const list of this.classes.values()) {
      for (const c of list) {
        if (match(c.decl.name)) result.push(c);
        if (result.length >= limit) return result;
      }
    }
    for (const list of this.procs.values()) {
      for (const p of list) {
        if (match(p.decl.name)) result.push(p);
        if (result.length >= limit) return result;
      }
    }
    if (q.length >= 2) {
      for (const list of this.members.values()) {
        for (const m of list) {
          if (m.decl.kind !== 'property' && match(m.decl.name)) result.push(m);
          if (result.length >= limit) return result;
        }
      }
    }
    return result;
  }
}
