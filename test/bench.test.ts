import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../src/core/index/symbolIndex';
import { scanRoots } from '../src/core/index/workspaceScanner';

/**
 * Medición sobre un repo real. Solo corre con VFP_BENCH_ROOT definido, por ejemplo:
 *   VFP_BENCH_ROOT=c:/LinceV3/Organic.Drawing npx vitest run test/bench.test.ts
 */
const root = process.env.VFP_BENCH_ROOT;

describe.skipIf(!root)('bench', () => {
  it('indexa el repo', async () => {
    const index = new SymbolIndex();
    const started = Date.now();
    const total = await scanRoots([{ path: root!, layer: { id: 'ws', label: 'ws', priority: 0, role: 'source' } }], index, {
      exclude: ['**/node_modules/**', '**/.git/**', '**/bin/**', '**/obj/**'],
      headersOnly: ['**/*Generated*/**'],
      maxFileSizeKB: 512,
      callNames: [],
      fallbackComments: true,
    });
    const secs = (Date.now() - started) / 1000;
    console.log(`${total} archivos, ${index.classNames().length} clases, ${secs.toFixed(1)} s`);
    expect(total).toBeGreaterThan(0);
  }, 600_000);
});
