// tests/ledger.test.mjs — P3-22 (v1.3.9 review): the ledger had no fixture test.
//
// ledger.mjs is the one module that reads OTHER tools' on-disk formats (Codex
// rollouts, ZCode model-io + v2 sessions, Claude transcripts). Every one of its
// bug fixes so far came from a review, not from a test: per-dimension counter
// clamping (audit #26), last-wins dedupe by message id (F26), zcode's own
// cacheReadTokens/cacheWriteTokens field names, `aggregate` rows staying out of
// the totals. Those are exactly the things a synthetic fixture can pin.
//
// The fixtures below are hand-written to the field shapes the scanners expect,
// not copied from a real home directory — a test that reads the developer's own
// ~/.codex would pass or fail depending on who runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ledger } from '../ledger.mjs';
import { trackTemp } from './_tmp.mjs'; // v1.4.3 review #33: scratch dirs are removed on exit

// (the scanners take a day count; these fixtures are all "now", so `days: 1` covers them)

// A throwaway $HOME with all three engines' trees.
function fixtureHome() {
  const home = trackTemp(fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-ledger-')));
  const now = new Date();
  const iso = now.toISOString();

  // --- Codex: cumulative totals that must be diffed, then clamped on a reset
  const codexDir = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'rollout-a.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/proj-a', timestamp: iso } }),
    // first total is real usage: 100/50 from a zero baseline
    JSON.stringify({ type: 'event_msg', payload: { info: { model: 'gpt-5', total_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 } } } }),
    // incremental: +50 input, +30 output, +5 cached
    JSON.stringify({ type: 'event_msg', payload: { info: { model: 'gpt-5', total_token_usage: { input_tokens: 150, output_tokens: 80, cached_input_tokens: 15 } } } }),
    // counter reset (new process): input 120 < 150 but output 10 < 80 — the old
    // any-positive gate booked these as negative deltas (audit #26)
    JSON.stringify({ type: 'event_msg', payload: { info: { model: 'gpt-5', total_token_usage: { input_tokens: 120, output_tokens: 10, cached_input_tokens: 5 } } } }),
  ].join('\n') + '\n');

  // --- ZCode model-io rollouts: per-call rows with their own field names
  const zroll = path.join(home, '.zcode', 'cli', 'rollout');
  fs.mkdirSync(zroll, { recursive: true });
  fs.writeFileSync(path.join(zroll, 'call-1.jsonl'), JSON.stringify({
    startedAt: iso,
    model: { modelId: 'z-model-1' }, // an object here used to print as [object Object]
    response: { usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 8, cacheWriteTokens: 3 } },
  }) + '\n');

  // --- ZCode v2 sessions: a session-level AGGREGATE of the same tokens above.
  // It must appear in `recent` but never in byEngine/byDay/byModel, or one batch
  // of tokens gets billed twice.
  const v2 = path.join(home, '.zcode', 'v2', 'sessions');
  fs.mkdirSync(v2, { recursive: true });
  fs.writeFileSync(path.join(v2, 'sess-1.json'), JSON.stringify({
    cwd: '/work/proj-b',
    model: 'z-model-1',
    usage: { inputTokens: 999, outputTokens: 999 },
  }));

  // --- Claude: the SAME api message id in two rows. The first row is the
  // partial stream (output 0); the final row carries the real counts. Last wins.
  const claudeDir = path.join(home, '.claude', 'projects', 'proj');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'sess.jsonl'), [
    JSON.stringify({ timestamp: iso, cwd: '/work/proj-c', message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 300, output_tokens: 0 } } }),
    JSON.stringify({ timestamp: iso, cwd: '/work/proj-c', message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 300, output_tokens: 20 } } }),
    // a second, distinct call
    JSON.stringify({ timestamp: iso, cwd: '/work/proj-c', message: { id: 'msg_2', model: 'claude-x', usage: { input_tokens: 40, output_tokens: 5 } } }),
    // a row with no usage at all must be skipped, not counted as a zero call
    JSON.stringify({ timestamp: iso, message: { id: 'msg_3', model: 'claude-x' } }),
  ].join('\n') + '\n');

  return home;
}

test('ledger diffs codex cumulative totals and clamps a counter reset', () => {
  const home = fixtureHome();
  const out = ledger({ days: 1, engines: ['codex'], home });
  // row 1 → 100/50/10, row 2 → +50/+30/+5, row 3 → reset, contributes nothing
  assert.equal(out.byEngine.codex.calls, 2, 'the reset row must not book a negative-delta call');
  assert.equal(out.byEngine.codex.input, 150);
  assert.equal(out.byEngine.codex.output, 80);
  assert.equal(out.byEngine.codex.cached, 15);
  assert.ok(out.byEngine.codex.input > 0 && out.byEngine.codex.output > 0, 'no negative or zeroed totals');
});

test('ledger reads zcode model-io field names but keeps v2 aggregates out of the totals', () => {
  const home = fixtureHome();
  const out = ledger({ days: 1, engines: ['zcode'], home });
  // cacheReadTokens/cacheWriteTokens are zcode's own names — deepFindUsage does
  // not know them, so the caches used to come back as 0
  assert.equal(out.byEngine.zcode.cached, 8);
  assert.equal(out.byEngine.zcode.cacheWrite, 3);
  assert.equal(out.byEngine.zcode.calls, 1, 'the v2 aggregate row must not add a call');
  // the aggregate is still visible in recent — just not summed
  assert.ok(out.recent.some((r) => r.aggregate === true), 'v2 aggregate stays visible in recent');
  // 999 from the aggregate must never reach the per-model totals
  assert.equal(out.byModel['zcode/z-model-1'].input, 200);
});

test('ledger lets the LAST claude row win for a repeated message id', () => {
  const home = fixtureHome();
  const out = ledger({ days: 1, engines: ['claude'], home });
  // msg_1: partial (output 0) then final (output 20) → one call, output 20
  assert.equal(out.byEngine.claude.calls, 2, 'msg_1 counted once, msg_2 once; msg_3 has no usage');
  assert.equal(out.byEngine.claude.output, 25); // 20 + 5
  assert.equal(out.byEngine.claude.input, 340); // 300 + 40
});

test('ledger reports an honest, all-zero cap state on a small tree', () => {
  const home = fixtureHome();
  const out = ledger({ days: 1, home });
  // the caps exist so a giant tree cannot hang /api/ledger; on a small tree they
  // must report zero rather than a stale count from a previous call
  assert.equal(out.cappedSources, 0, 'file-walk budget must not be reported as hit');
  assert.equal(out.truncatedFiles, 0, 'line cap must be reported per call, not accumulated');
  // and a second call must not have inherited anything from the first
  const again = ledger({ days: 1, home });
  assert.deepEqual(again.byEngine, out.byEngine);
  // window filtering: a 0-day window has a `since` of "now", so nothing qualifies
  const none = ledger({ days: 0, home });
  assert.equal(none.sessions, 0, 'a 0-day window must return nothing, not everything');
});

test('ledger skips a file that vanishes between walk and stat', () => {
  const home = fixtureHome();
  const codexDir = path.join(home, '.codex', 'sessions');
  fs.symlinkSync(path.join(codexDir, 'nope-does-not-exist.jsonl'), path.join(codexDir, 'ghost.jsonl'));
  // walkFiles lists the symlink; statSync on it throws ENOENT. The scanner must
  // `continue`, not let the throw escape and 500 the whole /api/ledger route.
  const out = ledger({ days: 1, engines: ['codex'], home });
  assert.equal(out.byEngine.codex.calls, 2);
  assert.ok(Date.now() - 0 >= 0);
});

test('ledger tolerates an absent engine tree instead of throwing', () => {
  const home = trackTemp(fs.mkdtempSync(path.join(os.tmpdir(), 'piwb-ledger-empty-')));
  const out = ledger({ days: 30, home });
  assert.deepEqual(out.byEngine, {});
  assert.deepEqual(out.recent, []);
  assert.equal(out.sessions, 0);
  assert.equal(out.days, 30);
});
