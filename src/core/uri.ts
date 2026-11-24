import * as path from 'path';
import { URI } from 'vscode-uri';

/** Normaliza rutas de Windows: letra de unidad en minúscula, como las envía VS Code. */
export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return /^[A-Za-z]:/.test(resolved) ? resolved[0].toLowerCase() + resolved.substring(1) : resolved;
}

export function pathToUri(p: string): string {
  return URI.file(normalizePath(p)).toString();
}

export function uriToPath(uri: string): string {
  return normalizePath(URI.parse(uri).fsPath);
}

/** Normaliza un URI que viene del cliente para usarlo como clave. */
export function normalizeUri(uri: string): string {
  const parsed = URI.parse(uri);
  if (parsed.scheme !== 'file') return uri;
  return pathToUri(parsed.fsPath);
}

export function baseNameNoExt(p: string): string {
  return path.basename(p).replace(/\.[^.]+$/, '');
}
