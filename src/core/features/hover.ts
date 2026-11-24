import { ClassEntry, MemberEntry, SymbolIndex } from '../index/symbolIndex';
import { classSignature, codeBlock, docToMarkdown, memberSignature } from '../parser/noteMarkdown';
import type { ResolvedTarget } from '../plugin';
import { uriToPath } from '../uri';

function provenance(e: { layer: { label: string; quality?: string }; decl: { approximate?: boolean } }): string {
  const parts = [e.layer.label];
  if (e.layer.quality) parts.push(e.layer.quality);
  if (e.decl.approximate) parts.push('posición aproximada');
  return `_${parts.join(' · ')}_`;
}

export function classHover(index: SymbolIndex, c: ClassEntry): string[] {
  const out = [codeBlock(classSignature(c.decl))];
  if (c.decl.doc) out.push(docToMarkdown(c.decl.doc));
  const chain = index.hierarchyNames(c);
  if (chain.length > 1) out.push(`**Jerarquía:** ${chain.join(' → ')}`);
  const subs = index.descendants(c.decl.name, false);
  if (subs.length) {
    const names = subs.slice(0, 8).map((s) => s.decl.name);
    out.push(`**Subclases:** ${names.join(', ')}${subs.length > 8 ? ` y ${subs.length - 8} más` : ''}`);
  }
  out.push(provenance(c));
  return out;
}

export function memberHover(index: SymbolIndex, m: MemberEntry): string[] {
  const out = [codeBlock(memberSignature(m.decl))];
  const { doc, inheritedFrom } = index.effectiveDoc(m);
  if (doc) {
    out.push(docToMarkdown(doc));
    if (inheritedFrom) out.push(`_Doc heredada de ${inheritedFrom}._`);
  }
  out.push(provenance(m));
  return out;
}

export function hoverMarkdown(index: SymbolIndex, target: ResolvedTarget | undefined, extra: string[] = []): string | undefined {
  if (!target) return undefined;
  let out: string[] = [];
  switch (target.kind) {
    case 'class':
      if (target.classes?.length) {
        out = classHover(index, target.classes[0]);
        if (target.multi && target.classes.length > 1) {
          out.push('**Candidatas:** ' + target.classes.map((c) => `\`${c.decl.name}\` (${c.layer.label})`).join(', '));
        }
      }
      break;
    case 'member':
    case 'procedure': {
      const list = target.members ?? [];
      if (list.length === 0) break;
      if (target.heuristic && list.length > 1) {
        out.push(`_Resolución heurística: ${list.length} candidatos._`);
        out.push(...memberHover(index, list[0]));
        const shown = list.slice(0, 8).map((m) => `- \`${m.decl.className ? m.decl.className + '.' : ''}${m.decl.name}\` · ${m.layer.label}`);
        out.push(shown.join('\n') + (list.length > 8 ? `\n- … y ${list.length - 8} más` : ''));
      } else {
        out.push(...memberHover(index, list[0]));
        if (target.heuristic) out.push('_Resolución heurística (por nombre)._');
      }
      break;
    }
    case 'variable': {
      const v = target.variable!;
      let sig = `${v.kind === 'parameter' ? 'lparameters' : v.kind} ${v.name}`;
      if (v.type) sig += ` as ${v.type}`;
      if (v.lib) sig += ` of ${v.lib}`;
      out.push(codeBlock(sig));
      if (v.type && index.hasClass(v.type)) {
        const c = index.getClass(v.type)!;
        if (c.decl.doc) out.push(docToMarkdown(c.decl.doc));
      }
      break;
    }
    case 'file':
      if (target.files?.length) out.push(target.files.map((u) => `\`${uriToPath(u)}\``).join('  \n'));
      else out.push('_Archivo no encontrado en el índice._');
      break;
    default:
      break;
  }
  if (target.receiverType?.note) out.push(`_${target.receiverType.note}_`);
  if (target.hoverExtra) out.push(...target.hoverExtra);
  out.push(...extra);
  return out.length ? out.join('\n\n') : undefined;
}
