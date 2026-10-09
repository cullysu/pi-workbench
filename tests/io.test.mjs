import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl } from '../lib/io.mjs';

test('readJsonl keeps multibyte chars intact across the 1MB chunk boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-io-'));
  const file = path.join(dir, 's.jsonl');
  // the 3-byte char starts at byte offset 1MB-1: it straddles the chunk edge
  const line1 = '{"n":"' + 'a'.repeat((1 << 20) - 16) + '"}';
  fs.writeFileSync(file, line1 + '\n' + '{"t":"中"}' + '\n');
  const rows = readJsonl(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].t, '中'); // chunk.toString would yield mojibake here
});

test('readJsonl skips a giant corrupt line instead of parsing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-io-'));
  const file = path.join(dir, 's.jsonl');
  const giant = '{"t":"' + 'x'.repeat(33 * 1024 * 1024) + '"}';
  fs.writeFileSync(file, giant + '\n{"ok":true}\n');
  const rows = readJsonl(file);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
});
