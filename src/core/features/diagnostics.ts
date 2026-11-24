import { CodeAction, CodeActionKind, Diagnostic, DiagnosticSeverity, DiagnosticTag, TextEdit } from 'vscode-languageserver-types';
import { ParseDiagnostic } from '../model';

export const DIAGNOSTIC_SOURCE = 'Asistente VFP';

const SEVERITY: Record<ParseDiagnostic['severity'], DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export function toLspDiagnostic(d: ParseDiagnostic, source = DIAGNOSTIC_SOURCE): Diagnostic {
  return {
    range: d.range,
    severity: SEVERITY[d.severity],
    code: d.code,
    source,
    message: d.message,
    data: d.data,
    tags: d.tags as DiagnosticTag[] | undefined,
    relatedInformation: d.related?.map((r) => ({ location: { uri: r.uri, range: r.range }, message: r.message })),
  };
}

/** Quick fix de D2: quitar el `;` final del comentario. */
export function removeSemicolonFix(uri: string, diagnostic: Diagnostic, lineText: string): CodeAction | undefined {
  const data = diagnostic.data as { kind?: string; line: number; character: number } | undefined;
  if (data?.kind !== 'removeTrailingSemicolon') return undefined;
  let end = data.character + 1;
  while (end < lineText.length && /\s/.test(lineText[end])) end++;
  let start = data.character;
  while (start > 0 && /[ \t]/.test(lineText[start - 1])) start--;
  return {
    title: "Quitar el ';' final del comentario",
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: [TextEdit.del({ start: { line: data.line, character: start }, end: { line: data.line, character: end } })],
      },
    },
  };
}
