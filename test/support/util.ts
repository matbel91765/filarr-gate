import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Attend qu'une condition devienne vraie (ou échoue au bout du délai). */
export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const tempDir = (prefix = 'filarr-gate-'): string => mkdtempSync(join(tmpdir(), prefix));
