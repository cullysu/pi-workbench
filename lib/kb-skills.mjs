// kbSkills.mjs — 模型知识库 + 技能扫描（从 server.mjs 抽出，工厂注入依赖）

export function createKbSkills(ctx) {
  const { MODEL_KB, MODEL_META_FILE, CFG_DIR, PI_SKILLS, AGENTS_SKILLS, readJson, loadConfig, fs, path } = ctx;
// Look up a model id in the knowledge base. Exact id first (with common suffixes
// stripped), then longest family-prefix match. Family matches carry structure
// (context window / max output) but never invented pricing.
function kbLookup(modelId) {
  let id = String(modelId || '').toLowerCase();
  if (id.includes('/')) id = id.slice(id.lastIndexOf('/') + 1);
  id = id.replace(/:latest$/, '').replace(/:free$/, '').replace(/:beta$/, '');
  const exact = MODEL_KB.models[id];
  if (exact) return { ...exact, source: 'exact' };
  const dated = id.replace(/-\d{8}$/, '');
  if (dated !== id && MODEL_KB.models[dated]) return { ...MODEL_KB.models[dated], source: 'exact' };
  let best = null;
  for (const [prefix, meta] of Object.entries(MODEL_KB.family || {})) {
    if (id.startsWith(prefix) && (!best || prefix.length > best._len)) best = { ...meta, _len: prefix.length };
  }
  if (best) return { ctx: best.ctx, max: best.max, price: best.price, source: 'family' };
  return null;
}function kbPrice(modelId) {
  const hit = kbLookup(modelId);
  if (hit && hit.price && hit.price.cur === 'usd') return hit.price;
  return null;
}function loadModelMeta() {
  return readJson(MODEL_META_FILE) || {};
}function saveModelMeta(meta) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(MODEL_META_FILE, JSON.stringify(meta, null, 2));
}function parseFrontmatter(md) {
  const text = String(md || '').replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 1) continue;
      fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: m ? text.slice(m[0].length) : text };
}function loadSkillFile(file, source, fallbackName) {
  let md = '';
  try { md = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { fm, body } = parseFrontmatter(md);
  const name = String(fm.name || fallbackName || path.basename(path.dirname(file))).trim();
  const description = String(fm.description || '').trim();
  if (!description && !fm.name) return null;
  return {
    name,
    description,
    path: file,
    dir: path.dirname(file),
    source,
    license: fm.license || '',
    compatibility: fm.compatibility || '',
    body,
  };
}function walkSkillDir(root, source, out, depth = 0) {
  if (depth > 5 || !root) return;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const isPiRoot = source === 'pi' || source === 'project-pi';
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const skillMd = path.join(full, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const s = loadSkillFile(skillMd, source, e.name);
        if (s) out.push(s);
      } else walkSkillDir(full, source, out, depth + 1);
    } else if (isPiRoot && depth === 0 && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'skill.md') {
      const s = loadSkillFile(full, source, e.name.replace(/\.md$/i, ''));
      if (s) out.push(s);
    }
  }
}function listSkills(cwd) {
  const out = [];
  walkSkillDir(PI_SKILLS, 'pi', out);
  walkSkillDir(AGENTS_SKILLS, 'agents', out);
  if (cwd) {
    walkSkillDir(path.join(cwd, '.pi', 'skills'), 'project-pi', out);
    walkSkillDir(path.join(cwd, '.agents', 'skills'), 'project-agents', out);
  }
  const disabled = new Set(loadConfig().disabledSkills || []);
  const seen = new Set();
  const skills = [];
  for (const s of out) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    skills.push({ ...s, enabled: !disabled.has(s.name) });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, disabled: [...disabled] };
}function skillArgsFor(cwd) {
  const { skills, disabled } = listSkills(cwd);
  if (!disabled.length) return [];
  const args = ['--no-skills'];
  for (const s of skills) {
    if (s.enabled && s.path) args.push('--skill', s.path);
  }
  return args;
}
  return { kbLookup, kbPrice, loadModelMeta, saveModelMeta, parseFrontmatter, loadSkillFile, walkSkillDir, listSkills, skillArgsFor };
}
