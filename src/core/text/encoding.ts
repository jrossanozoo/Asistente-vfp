import * as fs from 'fs';
import * as iconv from 'iconv-lite';

/**
 * Único punto de lectura de fuentes VFP. Los .prg se guardan en Windows-1252:
 * nunca se leen como UTF-8 (rompería ñ y acentos).
 */
export function decodePrg(buffer: Buffer): string {
  return iconv.decode(buffer, 'win1252');
}

export async function readPrg(path: string): Promise<string> {
  const buffer = await fs.promises.readFile(path);
  return decodePrg(buffer);
}

export function readPrgSync(path: string): string {
  return decodePrg(fs.readFileSync(path));
}

export function encodePrg(text: string): Buffer {
  return iconv.encode(text, 'win1252');
}

/** Divide en líneas físicas aceptando CRLF, LF y CR. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}
