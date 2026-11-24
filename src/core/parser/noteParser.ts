import { DocInfo, DocParam, ParseDiagnostic, Rng } from '../model';
import { isDeclarationLine, ScannedLine } from '../text/scanner';

/**
 * Docstrings `NOTE` (convención propuesta en Organic, utilizable por cualquier sistema VFP).
 *
 *   DocBlock   := NoteLine ( ContLine )*            ; líneas unidas por ';' final
 *   Body       := [ "[" Categoria "]" ] Resumen ( Detalle )* [ Parametros ] [ Retorna ] [ Ejemplo ]
 *   Parametros := "Parametros:" ( nombre - texto )+
 *   Retorna    := "Retorna:" Tipo - texto
 *   Ejemplo    := "Ejemplo:" ( texto )+
 *
 * Un bloque documenta la primera declaración que lo sigue. Entre medio solo puede haber
 * líneas en blanco, separadores `*---` o etiquetas `*-- @tag`.
 */

export interface NoteBlock {
  startLine: number;
  endLine: number;
  doc: DocInfo;
  /** Línea candidata a declaración documentada. */
  targetLine?: number;
  /** La última línea termina en `;` y se come la línea `swallowedLine` (D2). */
  swallowedLine?: number;
  nonAscii: boolean;
}

const SEPARATOR_RE = /^\s*\*[-=*_~#]*\s*$/;
const TAG_RE = /^\s*\*--\s*@/;
const NOTE_KEYWORD_RE = /^\s*note\b/i;

export { isDeclarationLine };

export function isSeparatorLine(text: string): boolean {
  return SEPARATOR_RE.test(text) || TAG_RE.test(text);
}

function rowText(scanned: ScannedLine, first: boolean): string {
  let t = scanned.continues ? scanned.text.substring(0, scanned.continuationCol) : scanned.text;
  if (first) t = t.replace(NOTE_KEYWORD_RE, '');
  return t.replace(/\s+/g, ' ').trim();
}

const PARAMS_RE = /^(?:par[aá]metros|parameters|params)\s*:\s*(.*)$/i;
const RETURNS_RE = /^(?:retorna|retorno|devuelve|returns?)\s*:\s*(.*)$/i;
const EXAMPLE_RE = /^(?:ejemplo|example)\s*:\s*(.*)$/i;
const PARAM_ROW_RE = /^@?([A-Za-z_]\w*)\s*(?:-|–|:)\s*(.*)$/;

function parseReturns(text: string): { type?: string; text: string } {
  const m = /^(\S+?)\s+[-–]\s+(.*)$/.exec(text);
  if (m) return { type: m[1], text: m[2] };
  if (/^\S+$/.test(text)) return { type: text, text: '' };
  return { text };
}

/** Interpreta las filas de texto de un bloque NOTE (sin la palabra NOTE ni los `;`). */
export function parseNoteRows(rows: string[]): DocInfo {
  const doc: DocInfo = { source: 'note', summary: '', detail: [], params: [], example: [], deprecated: false };
  let section: 'summary' | 'detail' | 'params' | 'returns' | 'example' = 'summary';
  const pushParamRow = (row: string): void => {
    const m = PARAM_ROW_RE.exec(row);
    if (m) {
      doc.params.push({ name: m[1], text: m[2] });
    } else if (doc.params.length > 0) {
      const last: DocParam = doc.params[doc.params.length - 1];
      last.text = (last.text + ' ' + row).trim();
    } else {
      doc.detail.push(row);
    }
  };
  rows.forEach((raw, idx) => {
    let row = raw;
    if (idx === 0) {
      const cat = /^\[([^\]]+)\]\s*(.*)$/.exec(row);
      if (cat) {
        doc.category = cat[1].trim();
        row = cat[2];
      }
    }
    let m: RegExpExecArray | null;
    if ((m = PARAMS_RE.exec(row))) {
      section = 'params';
      if (m[1]) pushParamRow(m[1]);
      return;
    }
    if ((m = RETURNS_RE.exec(row))) {
      section = 'returns';
      doc.returns = parseReturns(m[1]);
      return;
    }
    if ((m = EXAMPLE_RE.exec(row))) {
      section = 'example';
      if (m[1]) doc.example.push(m[1]);
      return;
    }
    switch (section) {
      case 'summary':
        doc.summary = row;
        section = 'detail';
        break;
      case 'detail':
        if (row) doc.detail.push(row);
        break;
      case 'params':
        if (row) pushParamRow(row);
        break;
      case 'returns':
        if (doc.returns) {
          doc.returns.text = (doc.returns.text + ' ' + row).trim();
        }
        break;
      case 'example':
        doc.example.push(row);
        break;
    }
  });
  const cat = doc.category?.toLowerCase();
  doc.deprecated = cat === 'obsoleto' || cat === 'deprecated';
  return doc;
}

function rangeOf(scanned: ScannedLine[], start: number, end: number): Rng {
  const first = scanned[start].text;
  return {
    start: { line: start, character: first.length - first.trimStart().length },
    end: { line: end, character: scanned[end].text.length },
  };
}

/**
 * Recorre los comentarios del archivo: arma los bloques NOTE y detecta comentarios
 * (NOTE o `*`) cuya última línea termina en `;` y se comen la sentencia siguiente (D2).
 */
export function extractNoteBlocks(scanned: ScannedLine[]): { blocks: NoteBlock[]; diagnostics: ParseDiagnostic[] } {
  const blocks: NoteBlock[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  const n = scanned.length;
  let i = 0;
  while (i < n) {
    const s = scanned[i];
    if (!s.isComment) {
      i++;
      continue;
    }
    // Seguir la continuación del comentario.
    let j = i;
    let swallowed: number | undefined;
    while (scanned[j].continues && j + 1 < n) {
      const next = scanned[j + 1];
      if (next.text.trim() === '') break;
      if (next.isComment) {
        j++;
        continue;
      }
      if (!next.isText) swallowed = j + 1;
      break;
    }
    if (swallowed !== undefined) {
      const last = scanned[j];
      const isDecl = isDeclarationLine(scanned[swallowed].text);
      diagnostics.push({
        code: 'D2',
        severity: 'error',
        message: isDecl
          ? `La última línea del comentario termina en ';': VFP toma la declaración de la línea ${swallowed + 1} como parte del comentario y la descarta en silencio.`
          : `La última línea del comentario termina en ';': VFP toma la línea ${swallowed + 1} como parte del comentario y no la ejecuta.`,
        range: {
          start: { line: j, character: last.continuationCol },
          end: { line: j, character: last.continuationCol + 1 },
        },
        data: { kind: 'removeTrailingSemicolon', line: j, character: last.continuationCol },
      });
    }
    if (s.isNote) {
      const rows: string[] = [];
      let nonAscii = false;
      for (let k = i; k <= j; k++) {
        rows.push(rowText(scanned[k], k === i));
        // eslint-disable-next-line no-control-regex
        if (/[^\x00-\x7F]/.test(scanned[k].text)) nonAscii = true;
      }
      const doc = parseNoteRows(rows);
      doc.range = rangeOf(scanned, i, j);
      let target: number | undefined;
      if (swallowed !== undefined) {
        target = swallowed;
      } else {
        let k = j + 1;
        while (k < n && (scanned[k].text.trim() === '' || isSeparatorLine(scanned[k].text))) k++;
        if (k < n) target = k;
      }
      blocks.push({ startLine: i, endLine: j, doc, targetLine: target, swallowedLine: swallowed, nonAscii });
    }
    i = j + 1;
  }
  return { blocks, diagnostics };
}

function stripCommentMarker(text: string): string {
  return text
    .trim()
    .replace(/^(\*!\*|&&|\*+|note\b|rem\b)/i, '')
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function commentDoc(rows: string[], range: Rng): DocInfo | undefined {
  const clean = rows.map(stripCommentMarker).filter((r) => r.length > 0);
  if (clean.length === 0) return undefined;
  return {
    source: 'comment',
    summary: clean[0],
    detail: clean.slice(1),
    params: [],
    example: [],
    deprecated: false,
    range,
  };
}

/**
 * Respaldo cuando una declaración no tiene NOTE: comentarios `*`, `*!*` o `&&`
 * contiguos justo encima (sin separadores ni etiquetas), o el `&&` al final de la línea.
 */
export function commentDocAbove(scanned: ScannedLine[], declLine: number): DocInfo | undefined {
  const rows: string[] = [];
  let k = declLine - 1;
  while (k >= 0 && TAG_RE.test(scanned[k].text)) k--;
  const end = k;
  while (k >= 0) {
    const s = scanned[k];
    if (!s.isComment || s.isNote || SEPARATOR_RE.test(s.text) || TAG_RE.test(s.text)) break;
    rows.unshift(s.text);
    k--;
  }
  if (rows.length > 0) return commentDoc(rows, rangeOf(scanned, k + 1, end));
  const decl = scanned[declLine];
  if (decl && decl.commentStart >= 0 && !decl.isComment) {
    const text = decl.text.substring(decl.commentStart);
    return commentDoc([text], {
      start: { line: declLine, character: decl.commentStart },
      end: { line: declLine, character: decl.text.length },
    });
  }
  return undefined;
}

/**
 * Respaldo para clases: comentarios `&&`/`*` al principio del cuerpo de la clase,
 * después del bloque `#if .f. … #endif` si existe.
 */
export function commentDocInClassHeader(scanned: ScannedLine[], defineLine: number, endLine: number): DocInfo | undefined {
  let k = defineLine + 1;
  const skipBlank = (): void => {
    while (k <= endLine && k < scanned.length && scanned[k].text.trim() === '') k++;
  };
  skipBlank();
  if (k < scanned.length && /^\s*#if\s+\.f\./i.test(scanned[k].text)) {
    while (k <= endLine && k < scanned.length && !/^\s*#endif\b/i.test(scanned[k].text)) k++;
    k++;
    skipBlank();
  }
  const start = k;
  const rows: string[] = [];
  while (k <= endLine && k < scanned.length && scanned[k].isComment && !scanned[k].isNote && !isSeparatorLine(scanned[k].text)) {
    rows.push(scanned[k].text);
    k++;
  }
  if (rows.length === 0) return undefined;
  return commentDoc(rows, rangeOf(scanned, start, k - 1));
}
