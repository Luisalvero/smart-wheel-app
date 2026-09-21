// The website unfolds archives with its own copy of the codec (it is a
// separate Vite app). The two copies must stay byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('website/src/lib/codec.ts is identical to lib/archive/codec.ts', () => {
  const root = join(import.meta.dirname, '..', '..');
  const app = readFileSync(join(root, 'mobile-app/lib/archive/codec.ts'));
  const web = readFileSync(join(root, 'website/src/lib/codec.ts'));
  assert.ok(app.equals(web), 'copy mobile-app/lib/archive/codec.ts over website/src/lib/codec.ts');
});
