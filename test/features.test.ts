import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolIndex, LayerInfo } from '../src/core/index/symbolIndex';
import { parsePrg } from '../src/core/parser/prgParser';
import { readPrgSync } from '../src/core/text/encoding';
import { pathToUri } from '../src/core/uri';
import { buildCursorContext, Resolver } from '../src/core/features/resolve';
import { hoverMarkdown } from '../src/core/features/hover';
import { signatureHelp } from '../src/core/features/signatureHelp';
import { definitionWithLocals, documentSymbols, implementationLocations, typeDefinitionLocations } from '../src/core/features/navigation';
import { removeSemicolonFix, toLspDiagnostic } from '../src/core/features/diagnostics';
import type { HostApi } from '../src/core/plugin';
import { FIXTURES, posOf } from './helpers';

const WS: LayerInfo = { id: 'ws', label: 'drawing', priority: 0, role: 'source' };
const MISC: LayerInfo = { id: 'misc', label: 'misc', priority: 1, role: 'source' };
const DOWN = (n: string, i: number): LayerInfo => ({ id: n, label: `${n} (consumidor)`, priority: 1000 + i, role: 'downstream' });

const index = new SymbolIndex();
const resolver = new Resolver(index, () => [], () => ({}) as HostApi);
const texts = new Map<string, string>();

function load(dir: string, layer: LayerInfo): void {
  for (const f of fs.readdirSync(path.join(FIXTURES, dir))) {
    const p = path.join(FIXTURES, dir, f);
    const text = readPrgSync(p);
    const uri = pathToUri(p);
    texts.set(`${dir}/${f}`, text);
    index.upsert({ uri, parsed: parsePrg(text, uri), layer });
  }
}

beforeAll(() => {
  load('drawing', WS);
  load('misc', MISC);
  load('feline', DOWN('feline', 0));
  load('dragonfish', DOWN('dragonfish', 1));
  load('zl', DOWN('zl', 2));
});

function ctxAt(rel: string, needle: string, occurrence = 1, delta = 0, override?: string) {
  const text = override ?? texts.get(rel)!;
  const uri = pathToUri(path.join(FIXTURES, rel));
  const parsed = parsePrg(text, uri);
  const position = posOf(text, needle, occurrence, delta);
  return buildCursorContext(uri, text, parsed, position, index, WS);
}

describe('hover', () => {
  it('ObtenerLista muestra categoría, parámetros y retorno', () => {
    const ctx = ctxAt('drawing/ComboListaDinamica.prg', 'function ObtenerLista', 1, 'function '.length + 2);
    const md = hoverMarkdown(index, resolver.resolveAt(ctx))!;
    expect(md).toContain('**`Generacion`**');
    expect(md).toContain('`tcEntidad` — Entidad del combo');
    expect(md).toContain('`tcAtributo` — Atributo de la entidad.');
    expect(md).toContain('**Retorna** `String`');
  });

  it('clase con jerarquía y subclases de consumidores', () => {
    const ctx = ctxAt('drawing/ColaboradorListaDinamica.prg', 'define class ColaboradorListaDinamica', 1, 'define class '.length + 1);
    const md = hoverMarkdown(index, resolver.resolveAt(ctx))!;
    expect(md).toContain('ColaboradorListaDinamica → ZooSession');
    expect(md).toContain('Felino_ColaboradorListaDinamica');
  });

  it('Obsoleto y Ejemplo', () => {
    const ctx = ctxAt('misc/NoteTrampa.prg', 'lcX = Sumar(', 1, 7);
    const md = hoverMarkdown(index, resolver.resolveAt(ctx))!;
    expect(md).toContain('~~Suma dos números.~~');
    expect(md).toContain('**Ejemplo**');
  });
});

describe('signature help', () => {
  it('this.ObtenerLista( resalta tcEntidad y luego tcAtributo', () => {
    const base = texts.get('drawing/ComboListaDinamica.prg')!;
    const anchor = 'loColaborador = this.ObtenerColaborador()';
    const typed1 = base.replace(anchor, anchor + '\r\n\t\tthis.ObtenerLista( ');
    const ctx1 = ctxAt('drawing/ComboListaDinamica.prg', 'this.ObtenerLista( ', 1, 'this.ObtenerLista( '.length, typed1);
    const sh1 = signatureHelp(index, resolver, ctx1)!;
    expect(sh1.signatures[0].label).toContain('ObtenerLista( tcEntidad as String, tcAtributo as String )');
    expect(sh1.activeParameter).toBe(0);
    const p0 = sh1.signatures[0].parameters![0];
    expect((p0.documentation as { value: string }).value).toContain('Entidad del combo');

    const typed2 = base.replace(anchor, anchor + '\r\n\t\tthis.ObtenerLista( "CLIENTE", ');
    const ctx2 = ctxAt('drawing/ComboListaDinamica.prg', 'this.ObtenerLista( "CLIENTE", ', 1, 'this.ObtenerLista( "CLIENTE", '.length, typed2);
    expect(signatureHelp(index, resolver, ctx2)!.activeParameter).toBe(1);
  });

  it('cuenta comas por nivel, ignora strings y sigue líneas con ;', () => {
    const nested = ctxAt('misc/Firmas.prg', 'Bar( b, c ),  )', 1, 'Bar( b, c ), '.length);
    const sh = signatureHelp(index, resolver, nested)!;
    expect(sh.signatures[0].label).toMatch(/^Foo\(/);
    expect(sh.activeParameter).toBe(2);

    const str = ctxAt('misc/Firmas.prg', 'Foo( "x,y",  )', 1, 'Foo( "x,y", '.length);
    expect(signatureHelp(index, resolver, str)!.activeParameter).toBe(1);

    const cont = ctxAt('misc/Firmas.prg', '\t\t )', 1, 2);
    const shc = signatureHelp(index, resolver, cont)!;
    expect(shc.signatures[0].label).toMatch(/^Foo\(/);
    expect(shc.activeParameter).toBe(1);
  });
});

describe('definition / implementation', () => {
  it('F12 sobre la clase en "as X of X.prg" va a la línea 1 del archivo', () => {
    const ctx = ctxAt('drawing/ComboListaDinamica.prg', 'toColaborador as ColaboradorListaDinamica', 1, 'toColaborador as '.length + 3);
    const locs = definitionWithLocals(resolver.resolveAt(ctx), ctx);
    expect(locs).toHaveLength(1);
    expect(locs[0].uri).toContain('drawing/ColaboradorListaDinamica.prg');
    expect(locs[0].range.start.line).toBe(0);
  });

  it('F12 sobre "of X.prg" abre el archivo', () => {
    const ctx = ctxAt('drawing/ComboListaDinamica.prg', 'of ColaboradorListaDinamica.prg', 1, 'of '.length + 2);
    const locs = definitionWithLocals(resolver.resolveAt(ctx), ctx);
    expect(locs[0].uri).toContain('ColaboradorListaDinamica.prg');
  });

  it('F12 sobre this.Metodo y variables locales', () => {
    const ctx = ctxAt('drawing/ComboListaDinamica.prg', 'this.ObtenerColaborador()', 1, 'this.'.length + 2);
    const t = resolver.resolveAt(ctx)!;
    expect(t.kind).toBe('member');
    expect(t.heuristic).toBeFalsy();
    expect(t.members![0].decl.name).toBe('ObtenerColaborador');
    const v = ctxAt('drawing/ComboListaDinamica.prg', 'loColaborador = this', 1, 2);
    expect(resolver.resolveAt(v)!.kind).toBe('variable');
  });

  it('miembro de una variable con tipo (local AS)', () => {
    const ctx = ctxAt('drawing/ComboListaDinamica.prg', 'loColaborador.ObtenerColeccion', 1, 'loColaborador.'.length + 2);
    const t = resolver.resolveAt(ctx)!;
    expect(t.heuristic).toBeFalsy();
    expect(t.members![0].owner!.decl.name).toBe('ColaboradorListaDinamica');
  });

  it('Ctrl+F12 sobre ObtenerConcepto lista los 3 overrides', () => {
    const ctx = ctxAt('drawing/ColaboradorListaDinamica.prg', 'protected function ObtenerConcepto', 1, 'protected function '.length + 2);
    const locs = implementationLocations(index, resolver.resolveAt(ctx));
    expect(locs).toHaveLength(3);
  });

  it('dodefault salta al método del padre', () => {
    const ctx = ctxAt('dragonfish/ColorYTalle_ColaboradorListaDinamica.prg', 'dodefault', 1, 2);
    const t = resolver.resolveAt(ctx)!;
    expect(t.members![0].owner!.decl.name).toBe('Felino_ColaboradorListaDinamica');
  });
});

describe('type definition y exclusión heurística', () => {
  const typeDef = (needle: string, delta: number) => {
    const ctx = ctxAt('drawing/ComboListaDinamica.prg', needle, 1, delta);
    return typeDefinitionLocations(index, resolver.typeAt(ctx), ctx).map((l) => path.basename(l.uri));
  };

  it('variable local AS, this y tipo primitivo/desconocido', () => {
    expect(typeDef('loColaborador.ObtenerColeccion', 2)).toEqual(['ColaboradorListaDinamica.prg']);
    expect(typeDef('this.ObtenerColaborador()', 2)).toEqual(['ComboListaDinamica.prg']);
    expect(typeDef('lcRetorno as String', 2)).toEqual([]);
  });

  it('excludeHeuristic de un plugin filtra la búsqueda por nombre, salvo que no quede nada', () => {
    const ctx = ctxAt('drawing/ComboListaDinamica.prg', 'loColaborador.ObtenerColeccion', 1, 2);
    const all = resolver.fallbackByName('ObtenerConcepto', ctx);
    expect(all.some((m) => m.decl.uri.includes('/feline/'))).toBe(true);
    const sinFeline = new Resolver(index, () => [{ id: 'x', excludeHeuristic: (uri: string) => uri.includes('/feline/') }], () => ({}) as HostApi);
    const filtered = sinFeline.fallbackByName('ObtenerConcepto', ctx);
    expect(filtered.length).toBe(all.length - all.filter((m) => m.decl.uri.includes('/feline/')).length);
    const todo = new Resolver(index, () => [{ id: 'x', excludeHeuristic: () => true }], () => ({}) as HostApi);
    expect(todo.fallbackByName('ObtenerConcepto', ctx)).toHaveLength(all.length);
  });
});

describe('diagnósticos y outline', () => {
  it('D2 con quick fix que quita el ; final', () => {
    const text = texts.get('misc/NoteTrampa.prg')!;
    const uri = pathToUri(path.join(FIXTURES, 'misc/NoteTrampa.prg'));
    const parsed = parsePrg(text, uri);
    const d2 = parsed.diagnostics.find((d) => d.code === 'D2')!;
    const lines = text.split(/\r\n/);
    const fix = removeSemicolonFix(uri, toLspDiagnostic(d2), lines[d2.range.start.line])!;
    const edit = fix.edit!.changes![uri][0];
    const line = lines[edit.range.start.line];
    const fixed = line.substring(0, edit.range.start.character) + line.substring(edit.range.end.character);
    expect(fixed.trimEnd().endsWith(';')).toBe(false);
    expect(fixed).toContain('Retorna: Void - nada.');
  });

  it('outline jerárquico', () => {
    const text = texts.get('drawing/ComboListaDinamica.prg')!;
    const syms = documentSymbols(parsePrg(text, 'file:///x.prg'));
    const combo = syms.find((s) => s.name === 'ComboListaDinamica')!;
    expect(combo.children!.map((c) => c.name)).toContain('ObtenerLista');
  });
});
