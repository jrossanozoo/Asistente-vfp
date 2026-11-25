import type { CodeAction, Connection, Diagnostic, ServerCapabilities, SignatureInformation } from 'vscode-languageserver';
import { ParseDiagnostic, ParsedFile, Rng, VarDecl } from './model';
import { ClassEntry, FileEntry, LayerInfo, MemberEntry, SymbolIndex } from './index/symbolIndex';
import type { CursorContext, Resolver } from './features/resolve';

/** Raíz a indexar. */
export interface RootSpec {
  path: string;
  layer: LayerInfo;
}

/** Resultado de inferir el tipo de un receptor. */
export interface TypeResult {
  /** Clases candidatas, la preferida primero. */
  classNames: string[];
  heuristic?: boolean;
  /** Explicación para el hover (por ejemplo "goServicios.Mensajes → Mensajes"). */
  note?: string;
}

/** Lo que hay bajo el cursor, resuelto. */
export interface ResolvedTarget {
  kind: 'class' | 'member' | 'procedure' | 'file' | 'variable' | 'none';
  word: string;
  range: Rng;
  classes?: ClassEntry[];
  members?: MemberEntry[];
  files?: string[];
  variable?: VarDecl;
  /** Varias ubicaciones válidas (peek), no una ambigüedad. */
  multi?: boolean;
  /** Resolución heurística (por nombre). */
  heuristic?: boolean;
  receiverType?: TypeResult;
  /** Markdown adicional para el hover. */
  hoverExtra?: string[];
}

/** Llamada que contiene un string literal bajo el cursor. */
export interface StringCallContext {
  callee: string;
  receiver: string;
  argIndex: number;
  literal: string;
  /** Literales de todos los argumentos (undefined si no es literal). */
  literals: (string | undefined)[];
  range: Rng;
}

export interface TypeResolver {
  /** Tipo de una cadena de receptor (`['_screen','zoo','app']`). undefined = no sabe. */
  resolveChain(chain: string[], ctx: CursorContext, api: HostApi): TypeResult | undefined;
}

export interface StringResolver {
  resolveString(call: StringCallContext, ctx: CursorContext, api: HostApi): ResolvedTarget | undefined;
}

export interface HostApi {
  connection: Connection;
  index: SymbolIndex;
  resolver: Resolver;
  /** Configuración completa recibida del cliente (todas las secciones pedidas). */
  settings(): Record<string, unknown>;
  workspaceRoots(): string[];
  /** Texto actual de un documento (abierto o en disco). */
  getText(uri: string): Promise<string | undefined>;
  cursorContext(uri: string, position: { line: number; character: number }): Promise<CursorContext | undefined>;
  log(message: string): void;
  /** Pide reindexar todo. */
  reindex(): Promise<void>;
}

export interface VfpPlugin {
  id: string;
  /** Secciones de configuración adicionales que necesita el plugin. */
  configSections?: string[];
  /** Llamadas cuyos argumentos registra el parser (en minúsculas). */
  callNames?: string[];
  typeResolvers?: TypeResolver[];
  stringResolvers?: StringResolver[];
  capabilities?(): Partial<ServerCapabilities>;
  /** Raíces adicionales a indexar. */
  roots?(api: HostApi): Promise<RootSpec[]>;
  /** Carga índices externos (por ejemplo `.symbols`) después de indexar las fuentes. */
  afterIndex?(api: HostApi): Promise<void>;
  /** Registra handlers LSP adicionales. */
  register?(api: HostApi): void;
  /** Diagnósticos adicionales para un archivo abierto. */
  diagnose?(file: FileEntry, ctx: { text: string; lines: string[] }, api: HostApi): ParseDiagnostic[];
  /** Permite reemplazar o filtrar los diagnósticos del parser (por ejemplo, reclasificar D1). */
  transformDiagnostics?(diagnostics: ParseDiagnostic[], file: FileEntry, api: HostApi): ParseDiagnostic[];
  /** Firmas para llamadas que no resolvió el índice (por ejemplo, funciones nativas de VFP). */
  signatureFallback?(callee: string, hasReceiver: boolean): SignatureInformation[] | undefined;
  /** Code actions adicionales. */
  codeActions?(uri: string, diagnostics: Diagnostic[], range: Rng, api: HostApi): Promise<CodeAction[]> | CodeAction[];
  /** Markdown extra para el hover de un target. */
  hover?(target: ResolvedTarget, ctx: CursorContext, api: HostApi): string[] | undefined;
  /** Opciones de parseo por archivo (por ejemplo, encabezados para generados). */
  parseHint?(path: string, api: HostApi): { headersOnly?: boolean; skip?: boolean } | undefined;
  /**
   * Excluye un archivo de los resultados heurísticos por nombre (receptor de tipo desconocido),
   * por ejemplo mocks o generados. Si todos quedan excluidos, se conservan.
   */
  excludeHeuristic?(uri: string, api: HostApi): boolean;
  onParsed?(file: ParsedFile, api: HostApi): void;
}
