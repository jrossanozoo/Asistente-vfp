import { MarkupKind, ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver-types';
import { MemberEntry, SymbolIndex } from '../index/symbolIndex';
import { docParamText, docToMarkdown } from '../parser/noteMarkdown';
import { CursorContext, findEnclosingCall, Resolver } from './resolve';

/** Firma con offsets de cada parámetro dentro del label. */
export function buildSignature(index: SymbolIndex, m: MemberEntry, heuristic: boolean): SignatureInformation {
  const owner = m.decl.className ? `${m.decl.className}.` : '';
  let label = `${owner}${m.decl.name}(`;
  const params: ParameterInformation[] = [];
  const { doc, inheritedFrom } = index.effectiveDoc(m);
  m.decl.params.forEach((p, i) => {
    label += i === 0 ? ' ' : ', ';
    const start = label.length;
    label += p.name + (p.type ? ` as ${p.type}` : '');
    const text = docParamText(doc, p.name);
    params.push({
      label: [start, label.length],
      documentation: text ? { kind: MarkupKind.Markdown, value: text } : undefined,
    });
  });
  label += m.decl.params.length ? ' )' : ')';
  if (m.decl.returnType) label += ` as ${m.decl.returnType}`;
  const docParts: string[] = [];
  if (doc) docParts.push(docToMarkdown(doc, { includeParams: false }));
  if (inheritedFrom) docParts.push(`_Doc heredada de ${inheritedFrom}._`);
  if (heuristic) docParts.push('_Resolución heurística (por nombre)._');
  docParts.push(`_${m.layer.label}_`);
  return {
    label,
    parameters: params,
    documentation: { kind: MarkupKind.Markdown, value: docParts.join('\n\n') },
  };
}

/** Ayuda de parámetros (§6.7.1). */
export function signatureHelp(
  index: SymbolIndex,
  resolver: Resolver,
  ctx: CursorContext,
  fallback?: (callee: string, hasReceiver: boolean) => SignatureInformation[] | undefined,
): SignatureHelp | undefined {
  if (!ctx.ll || ctx.offset < 0) return undefined;
  const call = findEnclosingCall(ctx.ll, ctx.offset);
  if (!call) return undefined;
  let candidates = resolver.resolveCall(call, ctx);
  if (candidates.length === 0) {
    const native = fallback?.(call.callee, !!(call.chain || call.withDot));
    if (!native?.length) return undefined;
    for (const s of native) s.activeParameter = call.argIndex < (s.parameters?.length ?? 0) ? call.argIndex : (s.parameters?.length ?? 0);
    return { signatures: native, activeSignature: 0, activeParameter: native[0].activeParameter };
  }
  const heuristic = candidates.length > 1 || !!(call.chain && !resolver.resolveChainType(call.chain, ctx));
  // Overrides con firmas distintas: se ofrecen como firmas alternativas (↑/↓).
  if (!heuristic && candidates[0].owner) {
    candidates = [...candidates, ...index.overrides(candidates[0].owner.decl.name, candidates[0].decl.name)];
  }
  const seen = new Set<string>();
  const signatures: SignatureInformation[] = [];
  for (const m of candidates.slice(0, 10)) {
    const sig = buildSignature(index, m, heuristic);
    const key = sig.label.replace(/^[^.(]*\./, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sig.activeParameter = call.argIndex < (sig.parameters?.length ?? 0) ? call.argIndex : (sig.parameters?.length ?? 0);
    signatures.push(sig);
  }
  const first = signatures[0];
  return {
    signatures,
    activeSignature: 0,
    activeParameter: first.activeParameter,
  };
}
