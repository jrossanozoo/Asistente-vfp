import { describe, expect, it } from 'vitest';
import fg from 'fast-glob';
import { memberLocals, parsePrg } from '../src/core/parser/prgParser';
import { readPrgSync, splitLines } from '../src/core/text/encoding';
import { pathToUri } from '../src/core/uri';
import { buildCursorContext } from '../src/core/features/resolve';
import { SymbolIndex } from '../src/core/index/symbolIndex';
import type { MemberDecl } from '../src/core/model';
import { FIXTURES } from './helpers';

const files = fg.sync('**/*.prg', { cwd: FIXTURES, absolute: true, caseSensitiveMatch: false });
const code = (m: MemberDecl) => m.kind === 'method' || m.kind === 'procedure' || m.kind === 'function';

describe('locals fuera del índice', () => {
  it('locals: false no guarda variables', () => {
    for (const f of files) {
      const p = parsePrg(readPrgSync(f), pathToUri(f), { locals: false });
      for (const m of [...p.procedures, ...p.classes.flatMap((c) => c.members)]) expect(m.locals).toBeUndefined();
    }
  });

  it('memberLocals da lo mismo que el parseo completo, método por método', () => {
    let checked = 0;
    for (const f of files) {
      const text = readPrgSync(f);
      const lines = splitLines(text);
      const full = parsePrg(text, pathToUri(f));
      const lean = parsePrg(text, pathToUri(f), { locals: false });
      const fullMembers = [...full.procedures, ...full.classes.flatMap((c) => c.members)].filter(code);
      const leanMembers = [...lean.procedures, ...lean.classes.flatMap((c) => c.members)].filter(code);
      expect(leanMembers.length).toBe(fullMembers.length);
      leanMembers.forEach((m, i) => {
        expect(memberLocals(lines, m), `${f} ${m.className ?? ''}.${m.name}`).toEqual(fullMembers[i].locals ?? []);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('buildCursorContext completa las variables del método', () => {
    for (const f of files) {
      const text = readPrgSync(f);
      const full = parsePrg(text, pathToUri(f));
      const lean = parsePrg(text, pathToUri(f), { locals: false });
      const target = full.classes.flatMap((c) => c.members).find((m) => code(m) && (m.locals?.length ?? 0) > 0);
      if (!target) continue;
      const pos = { line: target.range.start.line + 1, character: 0 };
      const layer = { id: 'ws', label: 'ws', priority: 0, role: 'source' as const };
      const ctx = buildCursorContext(full.uri, text, lean, pos, new SymbolIndex(), layer);
      expect(ctx.member?.locals).toEqual(target.locals);
      return;
    }
    throw new Error('ningún fixture tiene métodos con variables');
  });
});
