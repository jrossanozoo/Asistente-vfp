import { ScannedLine, StringToken } from './scanner';

/** Tramo de una línea física dentro de una línea lógica. */
export interface Segment {
  line: number;
  /** Columna física donde empieza el tramo. */
  col: number;
  /** Offset en el texto lógico. */
  offset: number;
  length: number;
}

/** Sentencia VFP: una o más líneas físicas unidas por `;`. Solo líneas de código. */
export interface LogicalLine {
  startLine: number;
  endLine: number;
  /** Código unido (sin `;` de continuación ni comentarios `&&`). Los tramos se separan con un espacio. */
  code: string;
  /** Igual que `code` con el contenido de los strings en blanco. */
  masked: string;
  segments: Segment[];
  /** Strings con offsets lógicos. */
  strings: StringToken[];
}

function isCodeLine(s: ScannedLine): boolean {
  return !s.isComment && !s.isText;
}

function build(scanned: ScannedLine[], start: number): LogicalLine {
  let code = '';
  let masked = '';
  const segments: Segment[] = [];
  const strings: StringToken[] = [];
  let line = start;
  for (;;) {
    const s = scanned[line];
    const cut = s.continues ? s.continuationCol : s.code.length;
    if (segments.length > 0) {
      code += ' ';
      masked += ' ';
    }
    const offset = code.length;
    code += s.code.substring(0, cut);
    masked += s.masked.substring(0, cut);
    segments.push({ line, col: 0, offset, length: cut });
    for (const st of s.strings) {
      if (st.start < cut) strings.push({ ...st, start: st.start + offset, end: Math.min(st.end, cut) + offset });
    }
    if (!s.continues || line + 1 >= scanned.length || !isCodeLine(scanned[line + 1])) break;
    line++;
  }
  return { startLine: start, endLine: line, code, masked, segments, strings };
}

/** Construye todas las líneas lógicas de código del archivo (omite comentarios y TEXT). */
export function buildLogicalLines(scanned: ScannedLine[]): LogicalLine[] {
  const result: LogicalLine[] = [];
  let i = 0;
  while (i < scanned.length) {
    if (!isCodeLine(scanned[i])) {
      i++;
      continue;
    }
    const ll = build(scanned, i);
    result.push(ll);
    i = ll.endLine + 1;
  }
  return result;
}

/** Línea lógica que contiene a la línea física `lineNo`, o undefined si es comentario/TEXT. */
export function logicalLineAt(scanned: ScannedLine[], lineNo: number): LogicalLine | undefined {
  if (lineNo < 0 || lineNo >= scanned.length || !isCodeLine(scanned[lineNo])) return undefined;
  let start = lineNo;
  while (start > 0 && isCodeLine(scanned[start - 1]) && scanned[start - 1].continues) start--;
  return build(scanned, start);
}

/** Convierte un offset lógico a posición física. */
export function toPosition(ll: LogicalLine, offset: number): { line: number; character: number } {
  for (let i = ll.segments.length - 1; i >= 0; i--) {
    const seg = ll.segments[i];
    if (offset >= seg.offset) {
      return { line: seg.line, character: seg.col + Math.min(offset - seg.offset, seg.length) };
    }
  }
  const first = ll.segments[0];
  return { line: first.line, character: first.col };
}

/** Convierte una posición física a offset lógico (o -1 si está fuera). */
export function toOffset(ll: LogicalLine, line: number, character: number): number {
  const seg = ll.segments.find((s) => s.line === line);
  if (!seg) return -1;
  return seg.offset + Math.min(Math.max(character - seg.col, 0), seg.length);
}
