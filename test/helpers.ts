import * as path from 'path';
import { readPrgSync } from '../src/core/text/encoding';
import { pathToUri } from '../src/core/uri';
import { parsePrg, ParseOptions } from '../src/core/parser/prgParser';

export const FIXTURES = path.join(__dirname, 'fixtures', 'generic');

export function fixturePath(rel: string): string {
  return path.join(FIXTURES, rel);
}

export function loadFixture(rel: string): { text: string; uri: string; path: string } {
  const p = fixturePath(rel);
  return { text: readPrgSync(p), uri: pathToUri(p), path: p };
}

export function parseFixture(rel: string, options?: ParseOptions) {
  const f = loadFixture(rel);
  return { ...f, parsed: parsePrg(f.text, f.uri, options) };
}

/** Posición (línea, columna) de la n-ésima aparición de `needle` en el texto, con offset opcional. */
export function posOf(text: string, needle: string, occurrence = 1, delta = 0): { line: number; character: number } {
  let idx = -1;
  for (let i = 0; i < occurrence; i++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`No se encontró "${needle}" (${occurrence})`);
  }
  idx += delta;
  const before = text.substring(0, idx);
  const lines = before.split(/\r\n|\n|\r/);
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}
