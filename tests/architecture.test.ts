import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Mechanical guard for the rules in CLAUDE.md: the simulation is a pure,
 * deterministic library that knows nothing about rendering, UI or the browser.
 */
const SIM_DIR = fileURLToPath(new URL('../src/sim', import.meta.url));

const RULES: Array<[RegExp, string]> = [
  [/from\s+['"]three/, 'imports three'],
  [/from\s+['"]react/, 'imports react'],
  [/from\s+['"](\.\.\/)+(render|ui|worker|platform)\//, 'imports render/ui/worker/platform'],
  [/\bMath\.random\b/, 'uses Math.random (use Rng)'],
  [/\bDate\.now\b|\bnew Date\b/, 'reads the wall clock'],
  [/\bperformance\.now\b/, 'reads the wall clock'],
  [/\b(window|document|self|globalThis)\./, 'touches browser globals'],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('src/sim stays pure', () => {
  it('has no rendering, UI, browser or nondeterministic dependencies', () => {
    const violations: string[] = [];
    for (const file of files(SIM_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const [pattern, message] of RULES) {
        if (pattern.test(source)) violations.push(`${relative(SIM_DIR, file)}: ${message}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
