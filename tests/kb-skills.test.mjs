import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKbSkills } from '../lib/kb-skills.mjs';
import { trackTemp } from './_tmp.mjs'; // v1.4.3 review #33: scratch dirs are removed on exit

// Build a two-directory fixture where the SAME skill name lives in both, so the
// shadowing rules in listSkills are exercised end to end.
function fixture() {
  const root = trackTemp(fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-skills-')));
  const first = path.join(root, 'first', 'dup');
  const second = path.join(root, 'second', 'dup');
  for (const [dir, body] of [[first, 'A'], [second, 'B']]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'),
      `---\nname: dup\ndescription: from ${body}\n---\nbody ${body}\n`);
  }
  return { root, first: path.join(first, 'SKILL.md'), second: path.join(second, 'SKILL.md') };
}

function api(root, disabledSkills) {
  return createKbSkills({
    MODEL_KB: { models: {}, family: {} },
    MODEL_META_FILE: path.join(root, 'model-meta.json'),
    CFG_DIR: root,
    PI_SKILLS: path.join(root, 'first'),
    AGENTS_SKILLS: path.join(root, 'second'),
    readJson: () => ({}),
    loadConfig: () => ({ disabledSkills }),
    fs,
    path,
  });
}

test('both copies enabled: one entry survives, the first directory wins', () => {
  const { root } = fixture();
  const { skills } = api(root, []).listSkills('');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].description, 'from A');
  assert.equal(skills[0].enabled, true);
});

test('disabling by NAME takes both copies down', () => {
  const { root } = fixture();
  const { skills } = api(root, ['dup']).listSkills('');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].enabled, false);
});

test('disabling the shadowed copy by PATH keeps the other copy usable', () => {
  const { root, first } = fixture();
  // the first copy is the one that would otherwise win the dedup
  const { skills } = api(root, [first]).listSkills('');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].enabled, true, 'the surviving copy must be enabled');
  assert.equal(skills[0].description, 'from B', 'dedup must fall through to the enabled copy');
});

test('disabling both copies by PATH leaves nothing usable', () => {
  const { root, first, second } = fixture();
  const { skills } = api(root, [first, second]).listSkills('');
  assert.equal(skills.length, 1);
  assert.equal(skills[0].enabled, false);
});

test('a disabled path entry still counts as disabled for skillArgsFor', () => {
  const { root, first } = fixture();
  const args = api(root, [first]).skillArgsFor('');
  assert.equal(args[0], '--no-skills');
  assert.equal(args.length, 3, 'the surviving copy is passed through as --skill <path>');
  assert.equal(args[1], '--skill');
  assert.equal(path.basename(path.dirname(args[2])), 'dup');
});

test('path entries are normalized so a differently spelled path still matches', () => {
  const { root, first } = fixture();
  const messy = first.replace(/\//g, path.sep) + path.sep + '.' + path.sep + '..' + path.sep + 'SKILL.md';
  const { skills } = api(root, [messy]).listSkills('');
  assert.equal(skills[0].enabled, true);
  assert.equal(skills[0].description, 'from B');
});

test('disabled list is echoed back verbatim for the settings UI', () => {
  const { root, first } = fixture();
  const { disabled } = api(root, ['dup', first]).listSkills('');
  assert.deepEqual(disabled, ['dup', first]);
});
