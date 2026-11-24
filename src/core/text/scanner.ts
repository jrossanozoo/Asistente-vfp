/**
 * Escaneo línea por línea de fuentes VFP: separa código, strings y comentarios.
 *
 * Reglas de VFP que se respetan:
 * - Comentarios de línea completa: `*`, `&&`, `NOTE`, `REM`.
 * - Comentario al final de línea: `&&` (fuera de strings).
 * - Strings: `"…"`, `'…'` y `[…]`. El `[` es string solo si no sigue a un identificador,
 *   `)` o `]` (en ese caso es subíndice de arreglo), salvo después de palabras clave como `return`.
 * - Continuación: una línea cuyo código termina en `;` sigue en la próxima línea física.
 *   Un comentario de línea completa que termina en `;` también continúa (trampa de VFP).
 * - `TEXT … ENDTEXT`: las líneas intermedias no son código.
 */

export interface StringToken {
  /** Columna del delimitador de apertura. */
  start: number;
  /** Columna siguiente al delimitador de cierre (o fin de línea si no cierra). */
  end: number;
  /** Contenido sin delimitadores. */
  value: string;
  delimiter: '"' | "'" | '[';
}

export interface ScannedLine {
  text: string;
  /** Código sin el comentario `&&` final. Vacío si la línea es comentario o TEXT. */
  code: string;
  /** Como `code`, con el contenido de los strings reemplazado por espacios (mismas columnas). */
  masked: string;
  /** Columna donde empieza el comentario `&&` final, o -1. */
  commentStart: number;
  /** Línea entera de comentario (`*`, `&&`, `NOTE`, `REM`). */
  isComment: boolean;
  /** Línea que empieza con `NOTE`. */
  isNote: boolean;
  /** Línea dentro de un bloque TEXT…ENDTEXT (no es código). */
  isText: boolean;
  /** Termina en `;` (continuación). */
  continues: boolean;
  /** Columna del `;` de continuación, o -1. */
  continuationCol: number;
  strings: StringToken[];
}

const KEYWORDS_BEFORE_BRACKET_STRING = new Set([
  'return', 'and', 'or', 'not', 'if', 'case', 'while', 'to', 'with', 'else', 'in', 'iif', 'at', 'of',
]);

const NOTE_RE = /^\s*note(?:\s|$)/i;
const DECL_RE = /^\s*(?:(?:prot\w*|hidd\w*)\s+)?(?:func\w*|proc\w*)\s+[\w.]+|^\s*define\s+class\s+\w+|^\s*(?:enddef\w*|endfunc|endproc)\b/i;

/** Línea que declara (o cierra) una clase o función. */
export function isDeclarationLine(text: string): boolean {
  return DECL_RE.test(text);
}

function commentContinuation(text: string): ScannedLine {
  const col = continuationColumn(text);
  return {
    text,
    code: '',
    masked: '',
    commentStart: text.length - text.trimStart().length,
    isComment: true,
    isNote: false,
    isText: false,
    continues: col >= 0,
    continuationCol: col,
    strings: [],
  };
}
const REM_RE = /^\s*rem(?:\s|$)/i;
const TEXT_START_RE = /^\s*text(?:\s|$)(?!\s*=)/i;
const TEXT_END_RE = /^\s*endtext\b/i;

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

export function isFullLineComment(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('*') || t.startsWith('&&') || NOTE_RE.test(text) || REM_RE.test(text);
}

/** Escanea el código de una línea (no comentario de línea completa). */
export function scanCode(text: string): { code: string; masked: string; commentStart: number; strings: StringToken[] } {
  const strings: StringToken[] = [];
  let masked = '';
  let i = 0;
  let commentStart = -1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '&' && text[i + 1] === '&') {
      commentStart = i;
      break;
    }
    let delimiter: StringToken['delimiter'] | undefined;
    if (ch === '"' || ch === "'") {
      delimiter = ch;
    } else if (ch === '[' && isBracketString(text, i)) {
      delimiter = '[';
    }
    if (delimiter) {
      const close = delimiter === '[' ? ']' : delimiter;
      const endIdx = text.indexOf(close, i + 1);
      const end = endIdx < 0 ? text.length : endIdx + 1;
      const value = text.substring(i + 1, endIdx < 0 ? text.length : endIdx);
      strings.push({ start: i, end, value, delimiter });
      masked += ch + ' '.repeat(value.length) + (endIdx < 0 ? '' : close);
      i = end;
      continue;
    }
    masked += ch;
    i++;
  }
  const code = commentStart < 0 ? text : text.substring(0, commentStart);
  return { code, masked: masked.substring(0, code.length), commentStart, strings };
}

function isBracketString(text: string, idx: number): boolean {
  let j = idx - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  if (j < 0) return true;
  const prev = text[j];
  if (prev === ')' || prev === ']') return false;
  if (!isIdentChar(prev)) return true;
  // Identificador antes del '[': subíndice, salvo que sea una palabra clave.
  let k = j;
  while (k >= 0 && isIdentChar(text[k])) k--;
  const word = text.substring(k + 1, j + 1).toLowerCase();
  return KEYWORDS_BEFORE_BRACKET_STRING.has(word);
}

function continuationColumn(text: string): number {
  let j = text.length - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  return j >= 0 && text[j] === ';' ? j : -1;
}

export function scanLine(text: string): ScannedLine {
  if (isFullLineComment(text)) {
    const col = continuationColumn(text);
    return {
      text,
      code: '',
      masked: '',
      commentStart: text.length - text.trimStart().length,
      isComment: true,
      isNote: NOTE_RE.test(text),
      isText: false,
      continues: col >= 0,
      continuationCol: col,
      strings: [],
    };
  }
  const { code, masked, commentStart, strings } = scanCode(text);
  const col = continuationColumn(masked);
  return {
    text,
    code,
    masked,
    commentStart,
    isComment: false,
    isNote: false,
    isText: false,
    continues: col >= 0,
    continuationCol: col,
    strings,
  };
}

/** Escanea todas las líneas, con estado para TEXT…ENDTEXT. */
export function scanLines(lines: string[]): ScannedLine[] {
  const result: ScannedLine[] = [];
  let inText = false;
  let pendingText = false;
  for (const text of lines) {
    if (inText) {
      if (TEXT_END_RE.test(text)) {
        inText = false;
        result.push(scanLine(text));
      } else {
        result.push({
          text,
          code: '',
          masked: '',
          commentStart: -1,
          isComment: false,
          isNote: false,
          isText: true,
          continues: false,
          continuationCol: -1,
          strings: [],
        });
      }
      continue;
    }
    const prev = result[result.length - 1];
    if (prev && prev.isComment && prev.continues && text.trim() !== '' && !isDeclarationLine(text)) {
      // VFP: un comentario que termina en ';' sigue en la línea siguiente.
      result.push(commentContinuation(text));
      continue;
    }
    const scanned = scanLine(text);
    result.push(scanned);
    if (!scanned.isComment && TEXT_START_RE.test(text)) {
      pendingText = true;
    }
    if (pendingText && !scanned.continues) {
      // El bloque empieza después de la última línea física de la sentencia TEXT.
      pendingText = false;
      inText = true;
    }
  }
  return result;
}
