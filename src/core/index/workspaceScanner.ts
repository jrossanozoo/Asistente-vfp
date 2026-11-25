import fg from 'fast-glob';
import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import { ParsedFile } from '../model';
import { parsePrg } from '../parser/prgParser';
import type { RootSpec } from '../plugin';
import { readPrg } from '../text/encoding';
import { normalizePath, pathToUri } from '../uri';
import { FileEntry, LayerInfo, SymbolIndex } from './symbolIndex';

export interface ScanOptions {
  exclude: string[];
  headersOnly: string[];
  maxFileSizeKB: number;
  callNames: string[];
  fallbackComments: boolean;
  /** Pista por archivo de los plugins (por ejemplo, encabezados para generados). */
  parseHint?: (filePath: string) => { headersOnly?: boolean; skip?: boolean } | undefined;
  cache?: ParseCache;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  concurrency?: number;
}

interface CacheEntry {
  m: number;
  s: number;
  h: boolean;
  /** Modelo listo para usar (después de `get` o `set`). */
  p?: ParsedFile;
  /** Forma compacta tal como se leyó del disco (hasta el primer `get`). */
  r?: unknown;
  /** Uri del archivo (la forma compacta la reemplaza por un marcador). */
  u?: string;
}

interface ShardFile {
  version: number;
  key: string;
  entries: Record<string, { m: number; s: number; h: boolean; u: string; p: unknown }>;
}

const CACHE_VERSION = 4;
/** Cantidad de archivos de cache: cada uno queda lejos del límite de largo de string de V8. */
const SHARDS = 32;

// Forma compacta: los rangos {start:{line,character},end:{…}} pasan a "\u0001l,c,l,c" y la uri del
// propio archivo a "\u0002". Un string que ya empiece con alguno de esos caracteres se escapa con "\u0003".
const RANGE = '\u0001';
const SELF_URI = '\u0002';
const ESCAPE = '\u0003';

function isRange(o: Record<string, unknown>): boolean {
  const s = o.start as Record<string, unknown> | undefined;
  const e = o.end as Record<string, unknown> | undefined;
  return (
    !!s &&
    !!e &&
    typeof s.line === 'number' &&
    typeof s.character === 'number' &&
    typeof e.line === 'number' &&
    typeof e.character === 'number' &&
    Object.keys(o).length === 2 &&
    Object.keys(s).length === 2 &&
    Object.keys(e).length === 2
  );
}

/** Copia compacta de un valor del modelo (no modifica el original). */
export function packParsed(v: unknown, uri: string): unknown {
  if (typeof v === 'string') {
    if (v === uri) return SELF_URI;
    const c = v.charCodeAt(0);
    return c >= 1 && c <= 3 ? ESCAPE + v : v;
  }
  if (Array.isArray(v)) return v.map((x) => packParsed(x, uri));
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (isRange(o)) {
      const r = o as unknown as { start: { line: number; character: number }; end: { line: number; character: number } };
      return `${RANGE}${r.start.line},${r.start.character},${r.end.line},${r.end.character}`;
    }
    const out: Record<string, unknown> = {};
    for (const k in o) {
      const x = o[k];
      if (x !== undefined) out[k] = packParsed(x, uri);
    }
    return out;
  }
  return v;
}

/** Inversa de `packParsed`. Reutiliza los objetos recibidos (los modifica en el lugar). */
export function unpackParsed(v: unknown, uri: string): unknown {
  if (typeof v === 'string') {
    const c = v.charCodeAt(0);
    if (c === 1) {
      const [a, b, d, e] = v.slice(1).split(',');
      return { start: { line: +a, character: +b }, end: { line: +d, character: +e } };
    }
    if (c === 2 && v.length === 1) return uri;
    if (c === 3) return v.slice(1);
    return v;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = unpackParsed(v[i], uri);
    return v;
  }
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k in o) o[k] = unpackParsed(o[k], uri);
    return o;
  }
  return v;
}

function shardOf(filePath: string): number {
  // FNV-1a: estable entre corridas.
  let h = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    h ^= filePath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SHARDS;
}

/**
 * Cache persistente de archivos parseados, por mtime + tamaño.
 * `file` (por ejemplo `.../index-cache.json`) define la carpeta `.../index-cache/` donde se guardan
 * `SHARDS` archivos; solo se reescriben los que cambiaron.
 */
export class ParseCache {
  private entries = new Map<string, CacheEntry>();
  private readonly dirty = new Set<number>();
  private readonly dir: string | undefined;

  constructor(
    private readonly file: string | undefined,
    private readonly key: string,
  ) {
    this.dir = file ? file.replace(/\.json$/i, '') : undefined;
  }

  private shardPath(i: number): string {
    return path.join(this.dir!, `shard-${String(i).padStart(2, '0')}.json`);
  }

  async load(): Promise<void> {
    if (!this.dir) return;
    await Promise.all(
      Array.from({ length: SHARDS }, async (_, i) => {
        try {
          const raw = JSON.parse(await fs.promises.readFile(this.shardPath(i), 'utf8')) as ShardFile;
          if (raw.version !== CACHE_VERSION || raw.key !== this.key) return;
          for (const [k, e] of Object.entries(raw.entries)) this.entries.set(k, { m: e.m, s: e.s, h: e.h, u: e.u, r: e.p });
        } catch {
          // shard ausente o ilegible: esos archivos se vuelven a parsear
        }
      }),
    );
  }

  get(filePath: string, mtime: number, size: number, headersOnly: boolean): ParsedFile | undefined {
    const e = this.entries.get(filePath);
    if (!e || e.m !== mtime || e.s !== size || e.h !== headersOnly) return undefined;
    if (!e.p) {
      e.p = unpackParsed(e.r, e.u ?? '') as ParsedFile;
      e.r = undefined;
    }
    return e.p;
  }

  set(filePath: string, mtime: number, size: number, headersOnly: boolean, parsed: ParsedFile): void {
    this.entries.set(filePath, { m: mtime, s: size, h: headersOnly, p: parsed });
    this.dirty.add(shardOf(filePath));
  }

  /** Descarta entradas de archivos que ya no existen. */
  retain(paths: Set<string>): void {
    for (const k of this.entries.keys()) {
      if (!paths.has(k)) {
        this.entries.delete(k);
        this.dirty.add(shardOf(k));
      }
    }
  }

  /** Escribe los shards modificados. Si alguno falla, sigue con el resto y al final lanza el error. */
  async save(): Promise<void> {
    if (!this.dir || this.dirty.size === 0) return;
    await fs.promises.mkdir(this.dir, { recursive: true });
    const byShard = new Map<number, [string, CacheEntry][]>();
    for (const i of this.dirty) byShard.set(i, []);
    for (const kv of this.entries) byShard.get(shardOf(kv[0]))?.push(kv);
    const errors: string[] = [];
    for (const [i, list] of byShard) {
      const target = this.shardPath(i);
      try {
        if (list.length === 0) {
          await fs.promises.rm(target, { force: true });
        } else {
          const entries: ShardFile['entries'] = {};
          for (const [k, e] of list) {
            const u = e.p?.uri ?? e.u ?? '';
            entries[k] = { m: e.m, s: e.s, h: e.h, u, p: e.p ? packParsed(e.p, u) : e.r };
          }
          const tmp = `${target}.tmp`;
          await fs.promises.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, key: this.key, entries }));
          await fs.promises.rename(tmp, target);
        }
        this.dirty.delete(i);
      } catch (e) {
        errors.push(`${path.basename(target)}: ${(e as Error).message}`);
      }
    }
    // Formato anterior (un único JSON): ya no se usa.
    if (this.file && this.file !== this.dir) await fs.promises.rm(this.file, { force: true }).catch(() => undefined);
    if (errors.length) throw new Error(`No se pudo guardar la cache de índice (${errors.join('; ')})`);
  }
}

export async function listPrgFiles(root: string, exclude: string[]): Promise<string[]> {
  // Rutas relativas: con `absolute: true` fast-glob aplica los ignore sobre la ruta completa, y una raíz
  // que está dentro de `obj\` (los stubs de dovfp) quedaría excluida entera por `**/obj/**`.
  const rel = await fg('**/*.prg', {
    cwd: root,
    onlyFiles: true,
    caseSensitiveMatch: false,
    ignore: exclude,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  return rel.map((r) => path.join(root, r));
}

export function headersOnlyMatcher(globs: string[]): (relPath: string) => boolean {
  if (globs.length === 0) return () => false;
  const m = picomatch(globs, { nocase: true, dot: true });
  return (rel) => m(rel.replace(/\\/g, '/'));
}

/** Parsea un archivo de disco respetando cache y modo encabezados. */
export async function parseFile(
  filePath: string,
  layer: LayerInfo,
  options: ScanOptions,
  headersOnlyByGlob: boolean,
): Promise<FileEntry | undefined> {
  const hint = options.parseHint?.(filePath);
  if (hint?.skip) return undefined;
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return undefined;
  }
  const headersOnly = hint?.headersOnly ?? (headersOnlyByGlob || stat.size > options.maxFileSizeKB * 1024);
  const uri = pathToUri(filePath);
  const cached = options.cache?.get(filePath, stat.mtimeMs, stat.size, headersOnly);
  if (cached) return { uri, parsed: cached, layer };
  const text = await readPrg(filePath);
  const parsed = parsePrg(text, uri, {
    headersOnly,
    callNames: options.callNames,
    fallbackComments: options.fallbackComments,
  });
  options.cache?.set(filePath, stat.mtimeMs, stat.size, headersOnly, parsed);
  return { uri, parsed, layer };
}

/** Indexa todas las raíces. El primer root que contiene un archivo define su capa. */
export async function scanRoots(roots: RootSpec[], index: SymbolIndex, options: ScanOptions): Promise<number> {
  const work: { file: string; layer: LayerInfo; headers: boolean }[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;
    const isHeaders = headersOnlyMatcher(options.headersOnly);
    const files = await listPrgFiles(root.path, options.exclude);
    for (const f of files) {
      const norm = normalizePath(f);
      if (seen.has(norm)) continue;
      seen.add(norm);
      work.push({ file: norm, layer: root.layer, headers: isHeaders(path.relative(root.path, norm)) });
    }
  }
  const total = work.length;
  let done = 0;
  let next = 0;
  const concurrency = options.concurrency ?? 16;
  const worker = async (): Promise<void> => {
    while (next < work.length) {
      if (options.isCancelled?.()) return;
      const item = work[next++];
      try {
        const entry = await parseFile(item.file, item.layer, options, item.headers);
        if (entry) index.upsert(entry);
      } catch {
        // archivo ilegible: se ignora
      }
      done++;
      if (done % 50 === 0 || done === total) options.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, worker));
  options.cache?.retain(seen);
  return total;
}
