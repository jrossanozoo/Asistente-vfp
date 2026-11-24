import { describe, expect, it } from 'vitest';
import { parsePrg } from '../src/core/parser/prgParser';
import { scanLine, scanLines } from '../src/core/text/scanner';
import { buildLogicalLines } from '../src/core/text/logicalLines';
import { parseFixture } from './helpers';

describe('scanner', () => {
  it('distingue strings con corchetes de subíndices', () => {
    const s = scanLine('lcX = [a,b] + laArr[1, 2] && comentario');
    expect(s.strings.map((t) => t.value)).toEqual(['a,b']);
    expect(s.commentStart).toBe(26);
    expect(s.masked).toContain('laArr[1, 2]');
  });

  it('&& dentro de un string no es comentario', () => {
    const s = scanLine('lcX = "a && b"');
    expect(s.commentStart).toBe(-1);
  });

  it('continuación con comentario && después del ;', () => {
    const s = scanLine('lcX = 1 + ; && suma');
    expect(s.continues).toBe(true);
  });

  it('une líneas lógicas', () => {
    const lls = buildLogicalLines(scanLines(['x = Foo( 1, ;', '   2 )', 'y = 1']));
    expect(lls).toHaveLength(2);
    expect(lls[0].code).toBe('x = Foo( 1,     2 )');
    expect(lls[0].endLine).toBe(1);
  });
});

describe('prgParser', () => {
  it('parsea ComboListaDinamica con NOTE completos', () => {
    const { parsed } = parseFixture('drawing/ComboListaDinamica.prg');
    const cls = parsed.classes.find((c) => c.name === 'ComboListaDinamica')!;
    expect(cls).toBeDefined();
    const m = cls.members.find((mm) => mm.name === 'ObtenerLista')!;
    expect(m.params.map((p) => p.name)).toEqual(['tcEntidad', 'tcAtributo']);
    expect(m.returnType).toBe('String');
    expect(m.doc?.source).toBe('note');
    expect(m.doc?.category).toBe('Generacion');
    expect(m.doc?.params.map((p) => p.name)).toEqual(['tcEntidad', 'tcAtributo']);
    expect(m.doc?.returns?.type).toBe('String');
    const dep = cls.members.find((mm) => mm.name === 'ObtenerColaborador')!;
    expect(dep.visibility).toBe('protected');
    expect(dep.doc?.category).toBe('Dependencia');
    expect(dep.returnLib).toBe('ColaboradorListaDinamica.prg');
    expect(parsed.diagnostics.filter((d) => d.code === 'D1' || d.code === 'D2')).toEqual([]);
  });

  it('class header: thisType y comentario de respaldo', () => {
    const { parsed } = parseFixture('drawing/ColaboradorListaDinamica.prg');
    const cls = parsed.classes.find((c) => c.name === 'ColaboradorListaDinamica')!;
    expect(cls.parent).toBe('ZooSession');
    expect(cls.parentLib).toBe('ZooSession.prg');
    expect(cls.thisType).toBe('ColaboradorListaDinamica');
    expect(cls.doc?.source).toBe('comment');
    expect(cls.doc?.summary).toContain('Catalogo de opciones');
    expect(parsed.classes.map((c) => c.name)).toContain('ItemOpcionListaDinamica');
  });

  it('detecta D2 y D1, respaldo de comentarios, LPARAMETERS y TEXT', () => {
    const { parsed, text } = parseFixture('misc/NoteTrampa.prg');
    const d2 = parsed.diagnostics.filter((d) => d.code === 'D2');
    expect(d2).toHaveLength(1);
    expect(d2[0].severity).toBe('error');
    expect(d2[0].range.start.line).toBe(4);
    const d1 = parsed.diagnostics.filter((d) => d.code === 'D1');
    // Solo el NOTE dentro del cuerpo queda huérfano; el que precede a una propiedad la documenta (§5.4).
    expect(d1.length).toBe(1);
    expect(d1[0].range.start.line).toBe(17);
    const cls = parsed.classes[0];
    expect(cls.members.find((m) => m.name === 'nCantidad')?.doc?.category).toBe('Contrato');
    expect(cls.members.find((m) => m.name === 'Desaparece')?.doc?.category).toBe('Gotcha');
    const lcAno = cls.members.find((m) => m.name === 'lcNombre');
    expect(lcAno?.value).toBe('"ñandú"');
    expect(text).toContain('ñandú');
    const cc = cls.members.find((m) => m.name === 'ConComentario')!;
    expect(cc.doc?.source).toBe('comment');
    expect(cc.doc?.summary).toBe('Comentario clásico de respaldo.');
    const lp = cls.members.find((m) => m.name === 'ConLparameters')!;
    expect(lp.params).toEqual([
      { name: 'tcUno', type: 'String', lib: undefined },
      { name: 'tnDos', type: 'Integer', lib: undefined },
    ]);
    expect(lp.locals?.find((l) => l.name === 'loX')?.type).toBe('Custom');
    expect(cls.members.find((m) => m.name === 'NoEsUnaFuncion')).toBeUndefined();
    expect(parsed.calls.find((c) => c.callee === 'createobject')?.args[0].literal).toBe('Trampa');
    const notes = parsed.notes.filter((n) => n.insideBody);
    expect(notes).toHaveLength(1);
  });

  it('NOTE con secciones Parametros, Retorna, Ejemplo y Obsoleto', () => {
    const { parsed } = parseFixture('misc/NoteTrampa.prg');
    const sumar = parsed.procedures.find((p) => p.name === 'Sumar')!;
    expect(sumar.kind).toBe('function');
    expect(sumar.doc?.deprecated).toBe(true);
    expect(sumar.doc?.params).toEqual([
      { name: 'tnA', text: 'Primer sumando.' },
      { name: 'tnB', text: 'Segundo sumando que sigue en otra línea.' },
    ]);
    expect(sumar.doc?.returns).toEqual({ type: 'Number', text: 'la suma.' });
    expect(sumar.doc?.example).toEqual(['? Sumar( 1, 2 )']);
  });

  it('modo encabezados', () => {
    const { text, uri } = parseFixture('drawing/ColaboradorListaDinamica.prg');
    const parsed = parsePrg(text, uri, { headersOnly: true });
    const cls = parsed.classes.find((c) => c.name === 'ColaboradorListaDinamica')!;
    expect(cls.members.filter((m) => m.kind === 'method').map((m) => m.name)).toContain('ObtenerConcepto');
    expect(cls.members.find((m) => m.kind === 'property')).toBeUndefined();
  });
});
