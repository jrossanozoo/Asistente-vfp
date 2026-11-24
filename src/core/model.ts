/** Modelo de símbolos VFP. Todo es JSON plano (se guarda en cache). Posiciones 0-based de LSP. */

export interface Pos {
  line: number;
  character: number;
}

export interface Rng {
  start: Pos;
  end: Pos;
}

export interface DocParam {
  name: string;
  text: string;
}

export interface DocInfo {
  /** `note`: docstring NOTE. `comment`: comentarios clásicos usados como respaldo. `symbols`: viene de un índice externo. */
  source: 'note' | 'comment' | 'symbols';
  category?: string;
  summary: string;
  detail: string[];
  params: DocParam[];
  returns?: { type?: string; text: string };
  example: string[];
  deprecated: boolean;
  /** Rango del bloque en el archivo (solo `note`/`comment`). */
  range?: Rng;
}

export interface Param {
  name: string;
  type?: string;
  lib?: string;
}

export interface VarDecl {
  name: string;
  type?: string;
  lib?: string;
  line: number;
  range: Rng;
  kind: 'local' | 'parameter' | 'public' | 'private' | 'this';
}

export type MemberKind = 'method' | 'property' | 'object' | 'procedure' | 'function';
export type Visibility = 'public' | 'protected' | 'hidden';

export interface MemberDecl {
  kind: MemberKind;
  name: string;
  /** Clase contenedora (undefined para procedimientos/funciones sueltas). */
  className?: string;
  uri: string;
  nameRange: Rng;
  /** Desde la declaración hasta el cierre (o la siguiente declaración). */
  range: Rng;
  params: Param[];
  /** `function` o `procedure` (para mostrar la firma). */
  keyword?: string;
  returnType?: string;
  returnLib?: string;
  visibility: Visibility;
  doc?: DocInfo;
  /** Para propiedades: valor inicial (texto). Para `add object`: clase. */
  value?: string;
  /** Para `add object`: clase del objeto. */
  objectClass?: string;
  /** Variables declaradas en el cuerpo (LOCAL/LPARAMETERS con AS). */
  locals?: VarDecl[];
  /** La posición es aproximada (por ejemplo, viene de un índice sin número de línea). */
  approximate?: boolean;
}

export interface ClassDecl {
  name: string;
  parent?: string;
  parentLib?: string;
  parentLibRange?: Rng;
  parentRange?: Rng;
  uri: string;
  nameRange: Rng;
  range: Rng;
  olepublic: boolean;
  members: MemberDecl[];
  doc?: DocInfo;
  /** Tipo declarado en `#if .f. / local this as X of Y / #endif`. */
  thisType?: string;
  approximate?: boolean;
  /** Tipo de archivo de origen (prg, vcx, …). */
  fileType?: string;
  /** Ruta del fuente real cuando decl.uri apunta a otro lugar (stub, .symbols). */
  sourcePath?: string;
}

/** Llamada con argumentos, registrada para nombres de interés (fábricas, createobject, …). */
export interface CallArg {
  text: string;
  /** Valor si el argumento es un único string literal. */
  literal?: string;
  range: Rng;
}

export interface CallSite {
  callee: string;
  /** Texto del receptor antes de `.callee` (por ejemplo `_screen.zoo`), o vacío. */
  receiver: string;
  args: CallArg[];
  range: Rng;
  /** Miembro/procedimiento contenedor. */
  container?: { className?: string; member?: string };
}

export type DiagnosticCode = 'D1' | 'D2';

export interface ParseDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: Rng;
  /** Datos para quick fixes. */
  data?: unknown;
  /** Ubicaciones relacionadas (se muestran debajo del diagnóstico). */
  related?: { uri: string; range: Rng; message: string }[];
  /** Tags LSP (1 = Unnecessary, 2 = Deprecated). */
  tags?: number[];
}

/** Bloque NOTE encontrado en el archivo (lo usan reglas de diagnóstico de plugins). */
export interface NoteRef {
  range: Rng;
  doc: DocInfo;
  /** Quedó asociado a una declaración. */
  attached: boolean;
  /** Está dentro del cuerpo de una función/método. */
  insideBody: boolean;
  /** Tiene caracteres fuera de ASCII. */
  nonAscii: boolean;
}

export interface ParsedFile {
  uri: string;
  classes: ClassDecl[];
  procedures: MemberDecl[];
  calls: CallSite[];
  notes: NoteRef[];
  /** Identificadores usados en cláusulas AS/OF del archivo (para ordenar heurísticas). */
  referencedClasses: string[];
  diagnostics: ParseDiagnostic[];
  /** Indexado solo por encabezados. */
  headersOnly?: boolean;
}

export const VFP_BASE_CLASSES = new Set(
  [
    'activedoc', 'checkbox', 'collection', 'column', 'combobox', 'commandbutton', 'commandgroup', 'container',
    'control', 'cursor', 'cursoradapter', 'custom', 'dataenvironment', 'editbox', 'empty', 'exception', 'form',
    'formset', 'grid', 'header', 'hyperlink', 'image', 'label', 'line', 'listbox', 'olecontrol', 'oleboundcontrol',
    'optionbutton', 'optiongroup', 'page', 'pageframe', 'projecthook', 'relation', 'reportlistener', 'separator',
    'session', 'shape', 'spinner', 'textbox', 'timer', 'toolbar', 'xmladapter', 'xmlfield', 'xmltable',
  ],
);

export function lower(s: string): string {
  return s.toLowerCase();
}
