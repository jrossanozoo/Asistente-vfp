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

const MAX_LISTED = 25;

/**
 * Métodos y propiedades públicos de una clase (incluidos los heredados, el más cercano gana),
 * con el resumen de su doc. Para el hover de una variable de tipo objeto.
 */
export function membersSummary(index: SymbolIndex, c: ClassEntry): string[] {
  const all = index.allMembers(c.decl.name, { fromUri: c.decl.uri }).filter((m) => m.decl.visibility === 'public');
  const line = (m: MemberEntry): string => {
    const d = m.decl;
    const name = d.kind === 'method' ? `${d.name}(${d.params.length ? ' ' + d.params.map((p) => p.name).join(', ') + ' ' : ''})` : d.name;
    const summary = index.effectiveDoc(m).doc?.summary?.trim();
    const owner = m.owner && m.owner.decl.name.toLowerCase() !== c.decl.name.toLowerCase() ? ` _(${m.owner.decl.name})_` : '';
    return `- \`${name}\`${summary ? ` — ${summary}` : ''}${owner}`;
  };
  const section = (title: string, list: MemberEntry[]): string | undefined => {
    if (!list.length) return undefined;
    const shown = list.slice(0, MAX_LISTED).map(line).join('\n');
    return `**${title}** (${list.length})\n\n${shown}${list.length > MAX_LISTED ? `\n- … y ${list.length - MAX_LISTED} más` : ''}`;
  };
  const out: string[] = [];
  const methods = section('Métodos', all.filter((m) => m.decl.kind === 'method'));
  const props = section('Propiedades', all.filter((m) => m.decl.kind === 'property' || m.decl.kind === 'object'));
  if (methods) out.push(methods);
  if (props) out.push(props);
  return out;
}

/**
 * Bloque común para un objeto de tipo conocido (variable o propiedad): la clase con su doc,
 * las candidatas por producto y sus métodos y propiedades públicos.
 */
export function typedObjectSection(index: SymbolIndex, classes: ClassEntry[]): string[] {
  if (!classes.length) return [];
  const out = classHover(index, classes[0]);
  if (classes.length > 1) {
    out.push('**Candidatas:** ' + classes.map((c) => `\`${c.decl.name}\` (${c.layer.label})`).join(', '));
  }
  out.push(...membersSummary(index, classes[0]));
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
      if (target.classes?.length && !target.heuristic) {
        // Propiedad con tipo deducido: lo mismo que el hover de una variable de ese tipo.
        out.push(`**Tipo deducido:** ${target.classes.map((c) => `\`${c.decl.name}\``).join(' | ')}`);
        out.push(...typedObjectSection(index, target.classes));
      }
      break;
    }
    case 'variable': {
      const v = target.variable;
      const classes = target.classes ?? [];
      let sig = v ? `${v.kind === 'parameter' ? 'lparameters' : v.kind} ${v.name}` : target.word;
      if (v?.type) sig += ` as ${v.type}`;
      if (v?.lib) sig += ` of ${v.lib}`;
      const declared = v?.type?.toLowerCase();
      if (classes.length && classes[0].decl.name.toLowerCase() !== declared) sig += `  && → ${classes.map((c) => c.decl.name).join(' | ')}`;
      out.push(codeBlock(sig));
      if (classes.length) {
        out.push(...typedObjectSection(index, classes));
      } else if (v?.type && index.hasClass(v.type)) {
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
