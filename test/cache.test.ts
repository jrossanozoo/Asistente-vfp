import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import fg from 'fast-glob';
import { parsePrg } from '../src/core/parser/prgParser';
import { readPrgSync } from '../src/core/text/encoding';
import { pathToUri } from '../src/core/uri';
import { packParsed, ParseCache, unpackParsed } from '../src/core/index/workspaceScanner';
import { FIXTURES } from './helpers';

const files = fg.sync('**/*.prg', { cwd: FIXTURES, absolute: true, caseSensitiveMatch: false });
const parseAll = () =>
  files.map((f) => ({ f, p: parsePrg(readPrgSync(f), pathToUri(f), { callNames: ['createobject', 'newobject'], fallbackComments: true }) }));

/** Igual que el modelo original después de un viaje por JSON (sin propiedades `undefined`). */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('cache de parseo', () => {
  it('hay fixtures para probar', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('packParsed/unpackParsed es ida y vuelta exacta', () => {
    for (const { p } of parseAll()) {
      const packed = JSON.parse(JSON.stringify(packParsed(p, p.uri)));
      expect(unpackParsed(packed, p.uri)).toEqual(plain(p));
    }
  });

  it('escapa strings que empiezan con los marcadores', () => {
    const v = { a: '\u0001x', b: '\u0002', c: '\u0003y', uri: 'file:///x.prg', d: 'file:///x.prg' };
    const packed = JSON.parse(JSON.stringify(packParsed(v, v.uri)));
    expect(unpackParsed(packed, v.uri)).toEqual(v);
  });

  it('no modifica el modelo al empaquetar', () => {
    const [{ p }] = parseAll();
    const before = plain(p);
    packParsed(p, p.uri);
    expect(plain(p)).toEqual(before);
  });

  it('guarda en shards y recarga lo mismo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfp-cache-'));
    const file = path.join(dir, 'index-cache.json');
    try {
      const parsed = parseAll();
      const a = new ParseCache(file, 'k');
      parsed.forEach(({ f, p }, i) => a.set(f, 1000 + i, 10 + i, false, p));
      await a.save();
      expect(fs.readdirSync(path.join(dir, 'index-cache')).filter((n) => n.endsWith('.json')).length).toBeGreaterThan(1);

      const b = new ParseCache(file, 'k');
      await b.load();
      parsed.forEach(({ f, p }, i) => {
        expect(b.get(f, 1000 + i, 10 + i, false)).toEqual(plain(p));
        expect(b.get(f, 1000 + i, 99, false)).toBeUndefined();
        expect(b.get(f, 1000 + i, 10 + i, true)).toBeUndefined();
      });

      // Otra clave (por ejemplo, cambian los callNames) invalida todo.
      const c = new ParseCache(file, 'otra');
      await c.load();
      expect(c.get(parsed[0].f, 1000, 10, false)).toBeUndefined();

      // retain + save borra entradas y reescribe solo lo necesario.
      b.retain(new Set([parsed[0].f]));
      await b.save();
      const d = new ParseCache(file, 'k');
      await d.load();
      expect(d.get(parsed[0].f, 1000, 10, false)).toEqual(plain(parsed[0].p));
      expect(d.get(parsed[1].f, 1001, 11, false)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('borra el archivo único del formato anterior', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfp-cache-'));
    const file = path.join(dir, 'index-cache.json');
    try {
      fs.writeFileSync(file, '{"version":3}');
      const [{ f, p }] = parseAll();
      const a = new ParseCache(file, 'k');
      a.set(f, 1, 1, false, p);
      await a.save();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
