import { ClassDecl, DocInfo, MemberDecl, Param } from '../model';

function paramText(p: Param): string {
  let s = p.name;
  if (p.type) s += ` as ${p.type}`;
  if (p.lib) s += ` of ${p.lib}`;
  return s;
}

/** Firma legible de un miembro: `function Nombre( a as T, b ) as R`. */
export function memberSignature(m: MemberDecl): string {
  if (m.kind === 'property') {
    const prefix = m.visibility !== 'public' ? `${m.visibility} ` : '';
    const owner = m.className ? `${m.className}.` : '';
    return `${prefix}${owner}${m.name}${m.value !== undefined ? ` = ${m.value}` : ''}${m.objectClass ? ` && ${m.objectClass}` : ''}`;
  }
  if (m.kind === 'object') {
    return `add object ${m.name} as ${m.objectClass ?? '?'}`;
  }
  const vis = m.visibility !== 'public' ? `${m.visibility} ` : '';
  const owner = m.className ? `${m.className}.` : '';
  const params = m.params.length ? `( ${m.params.map(paramText).join(', ')} )` : '()';
  let ret = '';
  if (m.returnType) ret = ` as ${m.returnType}${m.returnLib ? ` of ${m.returnLib}` : ''}`;
  return `${vis}${m.keyword ?? 'function'} ${owner}${m.name}${params}${ret}`;
}

export function classSignature(c: ClassDecl): string {
  let s = `define class ${c.name}`;
  if (c.parent) s += ` as ${c.parent}`;
  if (c.parentLib) s += ` of ${c.parentLib}`;
  if (c.olepublic) s += ' olepublic';
  return s;
}

export function codeBlock(code: string): string {
  return '```foxpro\n' + code + '\n```';
}

/** Convierte la doc a Markdown: categoría como badge, parámetros como lista, retorno en su línea. */
export function docToMarkdown(doc: DocInfo, options: { includeParams?: boolean } = {}): string {
  const out: string[] = [];
  let first = doc.summary;
  if (doc.deprecated) first = `~~${first}~~`;
  if (doc.category) first = `**\`${doc.category}\`** ${first}`;
  if (first.trim()) out.push(first);
  if (doc.detail.length) out.push(doc.detail.join('  \n'));
  if (options.includeParams !== false && doc.params.length) {
    out.push('**Parámetros**\n\n' + doc.params.map((p) => `- \`${p.name}\` — ${p.text}`).join('\n'));
  }
  if (doc.returns) {
    const type = doc.returns.type ? `\`${doc.returns.type}\`` : '';
    out.push(`**Retorna** ${type}${type && doc.returns.text ? ' — ' : ''}${doc.returns.text}`);
  }
  if (doc.example.length) {
    out.push('**Ejemplo**\n\n' + codeBlock(doc.example.join('\n')));
  }
  if (doc.deprecated) out.push('_Obsoleto._');
  if (doc.source === 'comment') out.push('_comentario (no docstring)_');
  return out.join('\n\n');
}

/** Texto de un parámetro desde la doc, emparejado por nombre (sin distinguir mayúsculas). */
export function docParamText(doc: DocInfo | undefined, name: string): string | undefined {
  return doc?.params.find((p) => p.name.toLowerCase() === name.toLowerCase())?.text;
}
