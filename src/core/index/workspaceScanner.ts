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
  p: ParsedFile;
}

const CACHE_VERSION = 3;

/** Cache persistente de archivos parseados, por mtime + tamaño. */
export class ParseCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(
    private readonly file: string | undefined,
    private readonly key: string,
  ) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.file, 'utf8')) as {
        version: number;
        key: string;
        entries: Record<string, CacheEntry>;
      };
      if (raw.version !== CACHE_VERSION || raw.key !== this.key) return;
      this.entries = new Map(Object.entries(raw.entries));
    } catch {
      // sin cache
    }
  }

  get(filePath: string, mtime: number, size: number, headersOnly: boolean): ParsedFile | undefined {
    const e = this.entries.get(filePath);
    if (e && e.m === mtime && e.s === size && e.h === headersOnly) return e.p;
    return undefined;
  }

  set(filePath: string, mtime: number, size: number, headersOnly: boolean, parsed: ParsedFile): void {
    this.entries.set(filePath, { m: mtime, s: size, h: headersOnly, p: parsed });
    this.dirty = true;
  }

  /** Descarta entradas de archivos que ya no existen. */
  retain(paths: Set<string>): void {
    for (const k of this.entries.keys()) {
      if (!paths.has(k)) {
        this.entries.delete(k);
        this.dirty = true;
      }
    }
  }

  async save(): Promise<void> {
    if (!this.file || !this.dirty) return;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const obj = { version: CACHE_VERSION, key: this.key, entries: Object.fromEntries(this.entries) };
    await fs.promises.writeFile(this.file, JSON.stringify(obj));
    this.dirty = false;
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
