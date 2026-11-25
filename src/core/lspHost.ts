import * as path from 'path';
import type { Connection, InitializeResult, ServerCapabilities } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CodeAction, Diagnostic } from 'vscode-languageserver-types';
import { ParsedFile } from './model';
import { FileEntry, LayerInfo, SymbolIndex } from './index/symbolIndex';
import { parseFile, ParseCache, scanRoots, ScanOptions } from './index/workspaceScanner';
import { DEFAULT_CALL_NAMES, parsePrg } from './parser/prgParser';
import type { HostApi, RootSpec, VfpPlugin } from './plugin';
import { buildCursorContext, CursorContext, Resolver } from './features/resolve';
import { hoverMarkdown } from './features/hover';
import { signatureHelp } from './features/signatureHelp';
import {
  definitionWithLocals,
  documentSymbols,
  implementationLocations,
  typeDefinitionLocations,
  declarationLocations,
  prepareTypeHierarchy,
  subtypes,
  supertypes,
  workspaceSymbols,
} from './features/navigation';
import { removeSemicolonFix, toLspDiagnostic } from './features/diagnostics';
import { readPrg, splitLines } from './text/encoding';
import { normalizePath, normalizeUri, uriToPath } from './uri';

export interface CoreSettings {
  extraRoots: string[];
  downstreamRoots: string[];
  exclude: string[];
  headersOnly: string[];
  maxFileSizeKB: number;
  fallbackComments: boolean;
  documentSymbols: boolean;
}

export interface HostOptions {
  plugins?: VfpPlugin[];
  /** Sección de configuración del núcleo (por defecto `vfp`). */
  configSection?: string;
  /** Prefijo de requests propios (`<prefix>/reindex`, `<prefix>/status`). */
  requestPrefix?: string;
  name?: string;
  diagnosticSource?: string;
}

export const WORKSPACE_LAYER: LayerInfo = { id: 'workspace', label: 'Workspace', priority: 0, role: 'source', quality: 'fuente' };

function readCoreSettings(raw: Record<string, unknown> | undefined): CoreSettings {
  const get = <T>(key: string, def: T): T => {
    if (!raw) return def;
    // Acepta tanto claves planas ("index.headersOnly") como anidadas.
    if (key in raw) return raw[key] as T;
    const parts = key.split('.');
    let cur: unknown = raw;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
      else return def;
    }
    return cur as T;
  };
  return {
    extraRoots: get('extraRoots', [] as string[]),
    downstreamRoots: get('downstreamRoots', [] as string[]),
    exclude: get('exclude', ['**/node_modules/**', '**/.git/**', '**/bin/**', '**/obj/**']),
    headersOnly: get('index.headersOnly', ['**/*Generated*/**']),
    maxFileSizeKB: get('index.maxFileSizeKB', 512),
    fallbackComments: get('docstring.fallbackComments', true),
    documentSymbols: get('features.documentSymbols', true),
  };
}

export class LspHost {
  readonly index = new SymbolIndex();
  readonly resolver: Resolver;
  readonly api: HostApi;
  private readonly plugins: VfpPlugin[];
  private readonly section: string;
  private readonly prefix: string;
  private readonly source: string;
  private documents = new Map<string, TextDocument>();
  private parsedByVersion = new Map<string, { version: number; parsed: ParsedFile }>();
  private pending = new Map<string, NodeJS.Timeout>();
  private workspaceFolders: string[] = [];
  private storagePath: string | undefined;
  private rawSettings: Record<string, unknown> = {};
  private settings: CoreSettings = readCoreSettings(undefined);
  private roots: RootSpec[] = [];
  private indexing: Promise<void> | undefined;
  private indexGeneration = 0;
  private cache: ParseCache | undefined;

  constructor(
    readonly connection: Connection,
    options: HostOptions = {},
  ) {
    this.plugins = options.plugins ?? [];
    this.section = options.configSection ?? 'vfp';
    this.prefix = options.requestPrefix ?? 'asistenteVfp';
    this.source = options.diagnosticSource ?? 'Asistente VFP';
    this.resolver = new Resolver(this.index, () => this.plugins, () => this.api);
    this.api = {
      connection,
      index: this.index,
      resolver: this.resolver,
      settings: () => this.rawSettings,
      workspaceRoots: () => this.workspaceFolders,
      getText: (uri) => this.getText(uri),
      cursorContext: (uri, pos) => this.cursorContext(uri, pos),
      log: (m) => connection.console.log(m),
      reindex: () => this.reindex(),
    };
  }

  get coreSettings(): CoreSettings {
    return this.settings;
  }

  private callNames(): string[] {
    return [...DEFAULT_CALL_NAMES, ...this.plugins.flatMap((p) => p.callNames ?? [])];
  }

  layerFor(filePath: string): LayerInfo {
    const norm = normalizePath(filePath).toLowerCase();
    let best: RootSpec | undefined;
    for (const r of this.roots) {
      const rp = normalizePath(r.path).toLowerCase();
      if (norm.startsWith(rp + path.sep) || norm === rp) {
        if (!best || rp.length > normalizePath(best.path).length) best = r;
      }
    }
    return best?.layer ?? WORKSPACE_LAYER;
  }

  private capabilities(): ServerCapabilities {
    let caps: ServerCapabilities = {
      textDocumentSync: { openClose: true, change: 2 },
      hoverProvider: true,
      definitionProvider: true,
      implementationProvider: true,
      typeDefinitionProvider: true,
      declarationProvider: true,
      typeHierarchyProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
      codeActionProvider: { codeActionKinds: ['quickfix'] },
    };
    for (const p of this.plugins) caps = { ...caps, ...(p.capabilities?.() ?? {}) };
    return caps;
  }

  start(): void {
    const c = this.connection;
    c.onInitialize((params): InitializeResult => {
      this.workspaceFolders = (params.workspaceFolders ?? []).map((f) => uriToPath(f.uri));
      if (this.workspaceFolders.length === 0 && params.rootUri) this.workspaceFolders = [uriToPath(params.rootUri)];
      const init = params.initializationOptions as { storagePath?: string } | undefined;
      this.storagePath = init?.storagePath;
      return { capabilities: this.capabilities() };
    });
    c.onInitialized(async () => {
      await this.loadSettings();
      c.onDidChangeConfiguration(async () => {
        const before = JSON.stringify(this.rawSettings);
        await this.loadSettings();
        if (JSON.stringify(this.rawSettings) !== before) await this.reindex();
      });
      void this.reindex();
    });

    c.onDidOpenTextDocument((p) => {
      const uri = normalizeUri(p.textDocument.uri);
      this.documents.set(uri, TextDocument.create(uri, p.textDocument.languageId, p.textDocument.version, p.textDocument.text));
      this.schedule(uri, 0);
    });
    c.onDidChangeTextDocument((p) => {
      const uri = normalizeUri(p.textDocument.uri);
      const doc = this.documents.get(uri);
      if (!doc) return;
      this.documents.set(uri, TextDocument.update(doc, p.contentChanges, p.textDocument.version));
      this.schedule(uri, 300);
    });
    c.onDidCloseTextDocument(async (p) => {
      const uri = normalizeUri(p.textDocument.uri);
      this.documents.delete(uri);
      this.parsedByVersion.delete(uri);
      c.sendDiagnostics({ uri: p.textDocument.uri, diagnostics: [] });
      if (uri.startsWith('file:')) await this.refreshFromDisk(uri);
    });
    c.onDidChangeWatchedFiles(async (p) => {
      for (const ch of p.changes) {
        const uri = normalizeUri(ch.uri);
        if (!/\.prg$/i.test(uri)) continue;
        if (ch.type === 3) this.index.remove(uri);
        else if (!this.documents.has(uri)) await this.refreshFromDisk(uri);
      }
    });

    c.onHover(async (p) => {
      const ctx = await this.cursorContext(p.textDocument.uri, p.position);
      if (!ctx) return null;
      const target = this.resolver.resolveAt(ctx);
      if (!target || target.kind === 'none') return null;
      const extra = this.plugins.flatMap((pl) => pl.hover?.(target, ctx, this.api) ?? []);
      const value = hoverMarkdown(this.index, target, extra);
      return value ? { contents: { kind: 'markdown', value }, range: target.range } : null;
    });
    c.onDefinition(async (p) => {
      const ctx = await this.cursorContext(p.textDocument.uri, p.position);
      if (!ctx) return [];
      return definitionWithLocals(this.resolver.resolveAt(ctx), ctx);
    });
    c.onImplementation(async (p) => {
      const ctx = await this.cursorContext(p.textDocument.uri, p.position);
      if (!ctx) return [];
      return implementationLocations(this.index, this.resolver.resolveAt(ctx));
    });
    c.onDeclaration(async (p) => {
      const ctx = await this.cursorContext(p.textDocument.uri, p.position);
      if (!ctx) return [];
      return declarationLocations(this.resolver.resolveAt(ctx), ctx);
    });
    c.onTypeDefinition(async (p) => {
      const ctx = await this.cursorContext(p.textDocument.uri, p.position);
      if (!ctx) return [];
      return typeDefinitionLocations(this.index, this.resolver.typeAt(ctx), ctx);
    });
    c.onSignatureHelp(async (p) => {
      const ctx = await this.cursorContext(p.textDocument.uri, p.position);
      if (!ctx) return null;
      const fallback = (callee: string, hasReceiver: boolean) => {
        for (const pl of this.plugins) {
          const s = pl.signatureFallback?.(callee, hasReceiver);
          if (s?.length) return s;
        }
        return undefined;
      };
      return signatureHelp(this.index, this.resolver, ctx, fallback) ?? null;
    });
    c.onDocumentSymbol(async (p) => {
      if (this.settings.documentSymbols === false) return [];
      const parsed = await this.parsedFor(normalizeUri(p.textDocument.uri));
      return parsed ? documentSymbols(parsed) : [];
    });
    c.onWorkspaceSymbol((p) => workspaceSymbols(this.index, p.query));
    c.languages.typeHierarchy.onPrepare(async (p) => {
      const ctx = await this.cursorContext(p.textDocument.uri, p.position);
      if (!ctx) return null;
      const items = prepareTypeHierarchy(this.resolver, ctx);
      return items.length ? items : null;
    });
    c.languages.typeHierarchy.onSupertypes((p) => supertypes(this.index, p.item));
    c.languages.typeHierarchy.onSubtypes((p) => subtypes(this.index, p.item));
    c.onCodeAction(async (p) => {
      const uri = normalizeUri(p.textDocument.uri);
      const actions: CodeAction[] = [];
      const text = await this.getText(uri);
      const lines = text ? splitLines(text) : [];
      for (const d of p.context.diagnostics) {
        const fix = removeSemicolonFix(p.textDocument.uri, d, lines[d.range.start.line] ?? '');
        if (fix) actions.push(fix);
      }
      for (const pl of this.plugins) {
        if (pl.codeActions) actions.push(...(await pl.codeActions(p.textDocument.uri, p.context.diagnostics, p.range, this.api)));
      }
      return actions;
    });
    c.onRequest(`${this.prefix}/reindex`, async () => {
      await this.reindex();
      return { files: this.index.fileCount };
    });
    c.onRequest(`${this.prefix}/status`, () => ({
      files: this.index.fileCount,
      classes: this.index.classNames().length,
      roots: this.roots.map((r) => ({ path: r.path, layer: r.layer.label, role: r.layer.role })),
    }));

    for (const p of this.plugins) p.register?.(this.api);
    c.listen();
  }

  private async loadSettings(): Promise<void> {
    const sections = [this.section, ...this.plugins.flatMap((p) => p.configSections ?? [])];
    try {
      const values = (await this.connection.workspace.getConfiguration(sections.map((s) => ({ section: s })))) as unknown[];
      const raw: Record<string, unknown> = {};
      sections.forEach((s, i) => (raw[s] = values[i] ?? {}));
      this.rawSettings = raw;
    } catch {
      this.rawSettings = {};
    }
    this.settings = readCoreSettings(this.rawSettings[this.section] as Record<string, unknown> | undefined);
  }

  private resolveRootPath(p: string): string {
    if (path.isAbsolute(p)) return normalizePath(p);
    const base = this.workspaceFolders[0] ?? process.cwd();
    return normalizePath(path.resolve(base, p));
  }

  private async computeRoots(): Promise<RootSpec[]> {
    const roots: RootSpec[] = this.workspaceFolders.map((f, i) => ({
      path: normalizePath(f),
      layer: { ...WORKSPACE_LAYER, id: `workspace:${i}`, label: path.basename(f) || 'Workspace' },
    }));
    this.settings.extraRoots.forEach((r, i) => {
      const p = this.resolveRootPath(r);
      roots.push({ path: p, layer: { id: `extra:${i}`, label: path.basename(p), priority: 10 + i, role: 'source', quality: 'fuente' } });
    });
    for (const pl of this.plugins) {
      if (pl.roots) roots.push(...(await pl.roots(this.api)));
    }
    this.settings.downstreamRoots.forEach((r, i) => {
      const p = this.resolveRootPath(r);
      roots.push({
        path: p,
        layer: { id: `downstream:${i}`, label: `${path.basename(p)} (consumidor)`, priority: 1000 + i, role: 'downstream', quality: 'fuente' },
      });
    });
    // Sin duplicados: la primera aparición manda.
    const seen = new Set<string>();
    return roots.filter((r) => {
      const k = r.path.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private scanOptions(): ScanOptions {
    return {
      exclude: this.settings.exclude,
      headersOnly: this.settings.headersOnly,
      maxFileSizeKB: this.settings.maxFileSizeKB,
      callNames: this.callNames(),
      fallbackComments: this.settings.fallbackComments,
      parseHint: (p) => {
        for (const pl of this.plugins) {
          const h = pl.parseHint?.(p, this.api);
          if (h) return h;
        }
        return undefined;
      },
      cache: this.cache,
    };
  }

  async reindex(): Promise<void> {
    const generation = ++this.indexGeneration;
    const run = async (): Promise<void> => {
      this.roots = await this.computeRoots();
      const cacheKey = JSON.stringify({ calls: this.callNames().sort(), fb: this.settings.fallbackComments });
      this.cache = new ParseCache(this.storagePath ? path.join(this.storagePath, 'index-cache.json') : undefined, cacheKey);
      await this.cache.load();
      let progress: { begin: Function; report: Function; done: Function } | undefined;
      try {
        progress = (await this.connection.window.createWorkDoneProgress()) as unknown as typeof progress;
        progress?.begin('Asistente VFP', 0, 'Indexando fuentes…', false);
      } catch {
        progress = undefined;
      }
      const started = Date.now();
      this.index.clear();
      const total = await scanRoots(this.roots, this.index, {
        ...this.scanOptions(),
        isCancelled: () => generation !== this.indexGeneration,
        onProgress: (done, tot) => progress?.report(Math.round((done / Math.max(tot, 1)) * 100), `${done}/${tot} archivos`),
      });
      if (generation !== this.indexGeneration) {
        progress?.done();
        return;
      }
      // Los documentos abiertos mandan sobre el disco.
      for (const uri of this.documents.keys()) this.reparseOpen(uri);
      for (const pl of this.plugins) {
        if (pl.afterIndex) {
          progress?.report(100, `Cargando índices de ${pl.id}…`);
          try {
            await pl.afterIndex(this.api);
          } catch (e) {
            this.connection.console.error(`${pl.id}: ${(e as Error).message}`);
          }
        }
      }
      progress?.done();
      this.connection.console.log(
        `Indexados ${total} archivos .prg en ${((Date.now() - started) / 1000).toFixed(1)} s (${this.index.classNames().length} clases).`,
      );
      for (const uri of this.documents.keys()) this.publishDiagnostics(uri);
      await this.cache.save().catch(() => undefined);
    };
    this.indexing = run();
    await this.indexing;
  }

  private schedule(uri: string, delay: number): void {
    const t = this.pending.get(uri);
    if (t) clearTimeout(t);
    this.pending.set(
      uri,
      setTimeout(() => {
        this.pending.delete(uri);
        this.reparseOpen(uri);
        this.publishDiagnostics(uri);
      }, delay),
    );
  }

  private parseText(uri: string, text: string): ParsedFile {
    // Un documento abierto se parsea completo (aunque esté en una carpeta de "solo encabezados"),
    // salvo que sea enorme.
    const headersOnly = text.length > this.settings.maxFileSizeKB * 1024 * 4;
    return parsePrg(text, uri, {
      headersOnly,
      callNames: this.callNames(),
      fallbackComments: this.settings.fallbackComments,
    });
  }

  private reparseOpen(uri: string): ParsedFile | undefined {
    const doc = this.documents.get(uri);
    if (!doc) return undefined;
    const parsed = this.parsedFor(uri, true) as ParsedFile;
    this.index.upsert({ uri, parsed, layer: this.layerFor(uriToPath(uri)) });
    for (const pl of this.plugins) pl.onParsed?.(parsed, this.api);
    return parsed;
  }

  private async refreshFromDisk(uri: string): Promise<void> {
    const p = uriToPath(uri);
    const entry = await parseFile(p, this.layerFor(p), this.scanOptions(), false);
    if (entry) this.index.upsert(entry);
    else this.index.remove(uri);
  }

  /** Parse del documento abierto en su versión actual (con cache por versión). */
  private parsedFor(uri: string, sync: true): ParsedFile | undefined;
  private parsedFor(uri: string): Promise<ParsedFile | undefined>;
  private parsedFor(uri: string, sync?: true): ParsedFile | undefined | Promise<ParsedFile | undefined> {
    const doc = this.documents.get(uri);
    if (doc) {
      const cached = this.parsedByVersion.get(uri);
      if (cached && cached.version === doc.version) return sync ? cached.parsed : Promise.resolve(cached.parsed);
      const parsed = this.parseText(uri, doc.getText());
      this.parsedByVersion.set(uri, { version: doc.version, parsed });
      return sync ? parsed : Promise.resolve(parsed);
    }
    if (sync) return this.index.getFile(uri)?.parsed;
    return (async () => {
      const entry = this.index.getFile(uri);
      if (entry) return entry.parsed;
      const text = await this.getText(uri);
      return text === undefined ? undefined : this.parseText(uri, text);
    })();
  }

  async getText(uri: string): Promise<string | undefined> {
    const key = normalizeUri(uri);
    const doc = this.documents.get(key);
    if (doc) return doc.getText();
    try {
      return await readPrg(uriToPath(key));
    } catch {
      return undefined;
    }
  }

  async cursorContext(rawUri: string, position: { line: number; character: number }): Promise<CursorContext | undefined> {
    const uri = normalizeUri(rawUri);
    const text = await this.getText(uri);
    if (text === undefined) return undefined;
    let parsed = await this.parsedFor(uri);
    if (!parsed) parsed = this.parseText(uri, text);
    return buildCursorContext(uri, text, parsed, position, this.index, this.layerFor(uriToPath(uri)));
  }

  fileEntry(uri: string): FileEntry | undefined {
    return this.index.getFile(normalizeUri(uri));
  }

  private publishDiagnostics(uri: string): void {
    const doc = this.documents.get(uri);
    if (!doc) return;
    const parsed = this.parsedFor(uri, true);
    if (!parsed) return;
    const entry: FileEntry = { uri, parsed, layer: this.layerFor(uriToPath(uri)) };
    let base = parsed.diagnostics;
    for (const pl of this.plugins) if (pl.transformDiagnostics) base = pl.transformDiagnostics(base, entry, this.api);
    const diagnostics: Diagnostic[] = base.map((d) => toLspDiagnostic(d, this.source));
    const text = doc.getText();
    const lines = splitLines(text);
    for (const pl of this.plugins) {
      try {
        for (const d of pl.diagnose?.(entry, { text, lines }, this.api) ?? []) diagnostics.push(toLspDiagnostic(d, this.source));
      } catch (e) {
        this.connection.console.error(`${pl.id}: ${(e as Error).message}`);
      }
    }
    this.connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics });
  }
}

export function startHost(connection: Connection, options: HostOptions = {}): LspHost {
  const host = new LspHost(connection, options);
  host.start();
  return host;
}
