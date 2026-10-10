// io.mjs — 共享文件/进程 IO 惯用法（server、sources、ledger、backup-terminal 四家共用）。
// 读 JSONL 只有两条路：headLines 只取头部字节（列表预览/探测，O(bytes)）；
// readJsonl 分块流过全文件（账本/回读，1MB 步进，hot 过滤控制解析开销）。
// 目录遍历、子进程输出收集也只有一个实现。
import fs from 'node:fs';
import path from 'node:path';
import { killTree, spawnTreeOpts } from './proctree.mjs';

/**
 * Bounded recursive file walk.
 * opts.exts     — keep files ending with any of these (default ['.jsonl'])
 * opts.maxDepth — explore directories down to this level (root = 0)
 * opts.maxFiles — stop collecting after this many files
 * opts.match    — predicate on the file name; overrides exts when given
 */
export function walkFiles(root, {exts = ['.jsonl'], maxDepth = 6, maxFiles = Infinity, match = null} = {}) {
  const out = [];
  const walk = (d, lvl) => {
    if (out.length >= maxFiles || lvl > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, lvl + 1);
      else if (e.isFile() && (match ? match(e.name) : exts.some((x) => e.name.endsWith(x)))) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** First N bytes of a file as lines — previews and probes must not read whole sessions. */
export function headLines(file, bytes = 16384) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n).replace(/^\uFEFF/, '').split('\n').filter(Boolean);
  } catch { return []; }
  finally { try { fd && fs.closeSync(fd); } catch { /* fd may already be closed */ } }
}

/**
 * Parse a JSONL file line by line with a 1MB chunked reader — session files run to
 * hundreds of MB and must never be read whole. hot: lines containing this substring
 * are the only ones parsed (usage scanning); session_meta lines always pass because
 * cwd/timestamps live there and never contain any usage keyword.
 */
import { StringDecoder } from 'node:string_decoder';

export function readJsonl(file, {hot = null, max = 200000} = {}) {
  const out = [];
  let buf = '';
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return out; }
  const chunk = Buffer.alloc(1 << 20);
  const decoder = new StringDecoder('utf8');
  try {
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      buf += decoder.write(chunk.subarray(0, n)); // multibyte chars straddle the 1MB chunk boundary — toString corrupts them
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1); // a BOM must not kill the first record
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.length > 32 * 1024 * 1024) continue; // a hostile/corrupt giant line is skipped, never parsed
        if (!line.trim()) continue;
        if (hot && !line.includes(hot) && !line.includes('session_meta')) continue;
        if (out.length >= max) return out; // the cap is exact — it used to fire one line late (max+1)
        try { out.push(JSON.parse(line)); } catch { /* skip torn/non-JSON lines */ }
      }
    }
    // an unterminated line must not accumulate to EOF — drop it instead of letting
    // a hostile/no-newline file grow the heap without bound
    if (buf.length > 32 * 1024 * 1024) buf = '';
    buf += decoder.end();
    if (out.length < max && buf.length <= 32 * 1024 * 1024 && buf.trim()) { try { out.push(JSON.parse(buf)); } catch { /* partial trailing line */ } }
  } finally { fs.closeSync(fd); }
  return out;
}

/**
 * Run a short-lived process, cap-collect stdout/stderr, resolve once on error or close.
 * Spawn failure resolves {error}; normal exit resolves {code, out, err}.
 */
export function collectProc(spawnFn, exe, args, {cwd, timeoutMs = 0, maxOut = 200000, maxErr = 2000, timeoutTag = '\n[timeout]'} = {}) {
  return new Promise((resolve) => {
    const p = spawnFn(exe, args, { cwd, windowsHide: true, ...spawnTreeOpts() }); // detached on POSIX: makes the child a group leader so the timeout killer can take the whole tree
    let out = '', err = '';
    p.stdout.setEncoding('utf8'); // chunkwise coercion would corrupt multibyte output split across packets
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => { if (out.length < maxOut) out += c; });
    p.stderr.on('data', (c) => { if (err.length < maxErr) err += c; });
    let killer = null;
    if (timeoutMs > 0) killer = setTimeout(() => { try { killTree(p); } catch { /* exited already */ } err += timeoutTag; }, timeoutMs); // bare kill() orphans the cmd/sh wrapper and its grandchildren
    const settle = (r) => { if (killer) clearTimeout(killer); resolve(r); };
    p.on('error', (e) => settle({ error: e.message }));
    p.on('close', (code) => settle({ code, out: out.slice(0, maxOut), err }));
  });
}
