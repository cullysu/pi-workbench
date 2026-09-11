/* pi-workbench frontend — talks to server.mjs (REST + WS), renders pi rpc events */
(() => {
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// vector icons (lucide paths, 24 viewBox) — emoji is banned as icon per design system
const svg = (paths, fill = false) =>
  `<svg viewBox="0 0 24 24" ${fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'}>${paths}</svg>`;
const ICONS = {
  sparkles: svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>'),
  wrench: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
};

const I18N = {
  zh: {
    appname: '工作台', tab_sessions: '会话', tab_usage: '用量', tab_import: '导入', tab_models: '模型', tab_routing: '路由', tab_settings: '设置',
    save: '保存', theme: '主题', lang: '语言', relay_token: '150 中转密钥', gitdiff: '改动', tree: '分支', today: '今日',
    drop_images: '拖放图片到此处', ask_anything: '向 pi 提问，输入 / 选择技能',
    new_session: '新建会话', empty_title: '开始一个对话', empty_sub: '选择左侧会话，或点 ＋ 新建。模型在右上角切换。',
    running: '运行中', done: '完成', failed: '出错', thinking: '思考中', thought: '思考', think: '思考',
    tokens: 'tokens', cost: '费用', add_project: '添加项目', project_path: '项目目录路径',
    import_hint: '选择来源查看历史会话（只读浏览）', confirm_new: '当前会话进行中，开新会话？',
    yes: '开新会话', no: '取消', models_saved: '已保存 models.json（pi 自动热加载）',
    sec_ok: '已按配置读取（仅内存）', sec_no: '未配置', loading: '加载中…',
    local_only: '本地运行 · 数据不出本机', search_ph: '搜索会话…', add_prov: '添加',
    light: '浅色', dark: '深色', zh_lang: '中文', en_lang: 'EN',
    u_sessions: '会话', u_replies: '回复', u_errors: '出错', u_in: '输入 tokens', u_out: '输出 tokens',
    u_hit: '缓存命中', u_cost: '费用', u_cw: '缓存写入', u_cr: '缓存读取',
    u_today: '今日全部供应商', u_provider: '供应商', u_by_prov: '今日按供应商', u_days: '近 14 天输入量', u_by_model: '按模型（累计）',
    r_hint: '开关即时生效；回退链按顺序尝试', r_chains: '回退链（JSON 数组，模型按顺序尝试）', r_save: '保存回退链',
    on: '启用', off: '停用', probe: '探测',
  },
  en: {
    appname: 'Workbench', tab_sessions: 'Sessions', tab_usage: 'Usage', tab_import: 'Import', tab_models: 'Models', tab_routing: 'Routing', tab_settings: 'Settings',
    save: 'Save', theme: 'Theme', lang: 'Language', relay_token: '150 relay key', gitdiff: 'Diff', tree: 'Branches', today: 'Today',
    drop_images: 'Drop images here', ask_anything: 'Ask pi anything… type / for skills',
    new_session: 'New session', empty_title: 'Start a conversation', empty_sub: 'Pick a session on the left, or click ＋. Switch models top right.',
    running: 'running', done: 'done', failed: 'error', thinking: 'thinking', thought: 'thought', think: 'Think',
    tokens: 'tokens', cost: 'cost', add_project: 'Add project', project_path: 'Project directory path',
    import_hint: 'Pick a source to browse past sessions (read-only)', confirm_new: 'Session is running. Start a new one?',
    yes: 'New session', no: 'Cancel', models_saved: 'models.json saved (pi hot-reloads)',
    sec_ok: 'loaded per config (memory only)', sec_no: 'not configured', loading: 'loading…',
    local_only: 'Runs locally · nothing leaves this machine', search_ph: 'Search sessions…', add_prov: 'Add',
    light: 'Light', dark: 'Dark', zh_lang: '中文', en_lang: 'EN',
    u_sessions: 'Sessions', u_replies: 'Replies', u_errors: 'Errors', u_in: 'Input tokens', u_out: 'Output tokens',
    u_hit: 'Cache hit', u_cost: 'Cost', u_cw: 'Cache write', u_cr: 'Cache read',
    u_today: 'Today · all providers', u_provider: 'Provider', u_by_prov: 'Today by provider', u_days: 'Last 14 days input', u_by_model: 'By model (all time)',
    r_hint: 'Toggles apply instantly; chains try models in order', r_chains: 'Fallback chains (JSON array, tried in order)', r_save: 'Save chains',
    on: 'On', off: 'Off', probe: 'Probe',
  },
};

const state = {
  cfg: { projects: [], lang: 'zh', theme: 'dark' },
  project: null,            // {path, name}
  tabId: null,              // active pi tab
  streaming: false,
  ws: null,
  wsReady: false,
  // live assembly of current assistant message
  cur: null,                // {content:[{type:'text'|'thinking'|'toolCall',...}], el}
  toolCards: new Map(),     // toolCallId -> el
  modelsAvailable: [],
  importSrc: 'codex',
  thinkLevel: 'medium',
  entryEls: new Map(),      // contentIndex -> element for streaming
};

// ---------- utils ----------
const t = (k) => (I18N[state.cfg.lang] || I18N.zh)[k] || k;
const fmtTime = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtDay = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
function relTime(ms) {
  const dsec = (Date.now() - ms) / 1000;
  if (dsec < 60) return '刚刚';
  if (dsec < 3600) return `${Math.floor(dsec / 60)} 分钟前`;
  if (dsec < 86400) return `${Math.floor(dsec / 3600)} 小时前`;
  if (dsec < 86400 * 7) return `${Math.floor(dsec / 86400)} 天前`;
  return fmtDay(ms);
}
function cleanTitle(raw, limit = 60) {
  if (!raw) return '';
  let s = String(raw).replace(/<[^>]{0,80}>/g, ' ').replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*`_>~\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const seg of s.split(/[。！？.;；\n]/)) {
    const t = seg.trim();
    if (t.length >= 6) { s = t; break; }
  }
  s = s.trim() || '无标题会话';
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}
function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深啦，别忘了照顾好自己哦';
  if (h < 11) return '早上好，新的一天开始啦';
  if (h < 13) return '中午好，休息一下吧';
  if (h < 18) return '下午好，继续加油';
  return '晚上好，今天过得怎么样';
}
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mdRender(text) {
  try {
    return marked.parse(text, { breaks: true, gfm: true });
  } catch { return `<p>${esc(text)}</p>`; }
}
function applyI18n() {
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.body.classList.toggle('dark', state.cfg.theme === 'dark');
}

// ---------- api ----------
const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  post: (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()),
};

// ---------- websocket ----------
function wsConnect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsReady = true; $('#conn-dot').className = 'dot on';
    while (wsQueue.length) { try { state.ws.send(JSON.stringify(wsQueue.shift())); } catch { break; } }
  };
  ws.onclose = () => { state.wsReady = false; $('#conn-dot').className = 'dot off'; setTimeout(wsConnect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pi-event') (window.__evts = window.__evts || []).push(msg.data);
    if (msg.type === 'pi-session-file') {
      state.sessionFile = msg.sessionFile;
      if (state.pendingNewSession) { state.pendingNewSession = false; renderProjectTree(true); }
      return;
    }
    if (msg.tabId !== state.tabId) return;
    if (msg.type === 'pi-event') handlePiEvent(msg.data);
    else if (msg.type === 'pi-exit') handlePiExit(msg);
    else if (msg.type === 'pi-stderr') $('#statusline').textContent = msg.data.slice(0, 200);
    else if (msg.type === 'opened') { /* noop */ }
  };
}
const wsQueue = [];
function wsSend(obj) {
  if (state.wsReady) { state.ws.send(JSON.stringify(obj)); return; }
  wsQueue.push(obj); // flushed on open — never drop open/prompt frames
}

// ---------- pi event handling ----------
function handlePiEvent(ev) {
  switch (ev.type) {
    case 'message_start': onMessageStart(ev.message); break;
    case 'message_update': onMessageUpdate(ev.assistantMessageEvent); break;
    case 'message_end': onMessageEnd(ev.message); break;
    case 'tool_execution_start': onToolStart(ev); break;
    case 'tool_execution_update': onToolUpdate(ev); break;
    case 'tool_execution_end': onToolEnd(ev); break;
    case 'agent_start': state.streaming = true; state.turnStart = Date.now(); setBusy(true); break;
    case 'agent_settled':
      state.streaming = false; setBusy(false); refreshStats(); loadTodayStats();
      if (state.lastStop === 'error') maybeFailover('assistant ended with error after auto-retry');
      else if (state.lastStop) markRouteOk();
      maybeGoalContinue();
      break;
    case 'extension_ui_request': handleUiRequest(ev); break;
  }
}
function handlePiExit(msg) {
  if (msg.tabId === state.tabId) { setBusy(false); state.streaming = false; $('#statusline').textContent = `pi exited (${msg.code})`; $('#conn-dot').className = 'dot off'; }
}

function ensureAssistantBlock() {
  if (state.cur) return state.cur;
  const el = msgShell('assistant');
  const body = el.querySelector('.msg-body');
  body.innerHTML = `<div class="md"></div>`;
  state.cur = { content: [], el: body.querySelector('.md'), blocks: new Map() };
  return state.cur;
}
// ---------- per-turn stats line (input / output / cache rate / cost / duration) ----------
function cacheRate(input, cacheRead) {
  const tot = (input || 0) + (cacheRead || 0);
  return tot > 0 ? Math.round(((cacheRead || 0) / tot) * 100) : null;
}
function fillTurnStats(el, usage, ms) {
  if (!usage || (!usage.input && !usage.output && !usage.cacheRead)) return;
  const hit = cacheRate(usage.input, usage.cacheRead);
  const parts = [`输入 ${fmtTok(usage.input)}`, `输出 ${fmtTok(usage.output)}`, `缓存率 ${hit === null ? '—' : hit + '%'}`];
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  if (ms) parts.push(`${(ms / 1000).toFixed(1)}s`);
  el.textContent = parts.join(' · ');
  el.title = `本轮调用：输入 ${usage.input || 0} tokens · 输出 ${usage.output || 0} tokens · 缓存读 ${usage.cacheRead || 0} · 缓存写 ${usage.cacheWrite || 0} · 缓存率 ${hit === null ? '—' : hit + '%'}`;
}
function onMessageStart(message) {
  if (message?.role === 'assistant') {
    state.cur = null; // start fresh; ensureAssistantBlock creates shell
    ensureAssistantBlock();
  }
}
function blockEl(cur, idx, kind) {
  if (cur.blocks.has(idx)) return cur.blocks.get(idx);
  let el;
  if (kind === 'thinking') {
    el = document.createElement('div');
    el.className = 'thinking open';
    el.innerHTML = `<div class="th-label">${ICONS.sparkles}<span>${t('thought')}</span></div><div class="th-body"></div>`;
    el.onclick = () => el.classList.toggle('open');
    cur.el.appendChild(el);
    const body = el.querySelector('.th-body');
    cur.blocks.set(idx, { el, body, kind });
    return cur.blocks.get(idx);
  }
  if (kind === 'text') {
    el = document.createElement('div');
    el.className = 'md-text';
    cur.el.appendChild(el);
    cur.blocks.set(idx, { el, body: el, kind });
    return cur.blocks.get(idx);
  }
  // toolcall placeholder — rendered as card on toolcall_start; args stream into card
  el = document.createElement('div');
  cur.el.appendChild(el);
  cur.blocks.set(idx, { el, body: el, kind: 'toolcall' });
  return cur.blocks.get(idx);
}
function onMessageUpdate(ae) {
  if (!ae) return;
  const cur = ensureAssistantBlock();
  if (ae.type === 'text_start' || ae.type === 'text_delta' || ae.type === 'text_end') {
    const b = blockEl(cur, ae.contentIndex, 'text');
    b.text = (b.text || '') + (ae.delta || ae.content || '');
    b.el.innerHTML = mdRender(b.text);
    b.el.classList.add('cursor');
    scrollBottom();
  } else if (ae.type === 'thinking_start' || ae.type === 'thinking_delta' || ae.type === 'thinking_end') {
    const b = blockEl(cur, ae.contentIndex, 'thinking');
    b.body.textContent = (b.body.textContent || '') + (ae.delta || ae.content || '');
    scrollBottom();
  } else if (ae.type === 'toolcall_start') {
    const b = blockEl(cur, ae.contentIndex, 'toolcall');
    b.el.innerHTML = toolCardHtml(ae.id, ae.toolName, '', 'run');
    wireToolCard(b.el.firstChild);
    state.toolCards.set(ae.id, b.el.firstChild);
    scrollBottom();
  } else if (ae.type === 'toolcall_delta') {
    const b = cur.blocks.get(ae.contentIndex);
    if (b && b.el.firstChild) {
      const argsEl = b.el.firstChild.querySelector('.t-args');
      if (argsEl && ae.delta) { b.argsStr = (b.argsStr || '') + ae.delta; argsEl.textContent = b.argsStr; }
    }
  } else if (ae.type === 'toolcall_end') {
    const b = cur.blocks.get(ae.contentIndex);
    if (b && ae.toolCall) {
      b.el.innerHTML = toolCardHtml(ae.toolCall.id, ae.toolCall.name, JSON.stringify(ae.toolCall.arguments || {}), 'run');
      wireToolCard(b.el.firstChild);
      state.toolCards.set(ae.toolCall.id, b.el.firstChild);
    }
  }
}
function onMessageEnd(message) {
  if (message?.role !== 'assistant') return;
  const cur = ensureAssistantBlock();
  cur.el.innerHTML = '';
  cur.blocks.clear();
  let sawContent = false;
  for (const block of message.content || []) {
    if (block.type === 'text' && block.text) {
      sawContent = true;
      const d = document.createElement('div'); d.innerHTML = mdRender(block.text); cur.el.appendChild(d);
    } else if (block.type === 'thinking' && block.thinking) {
      sawContent = true;
      const el = document.createElement('div');
      el.className = 'thinking open';
      el.innerHTML = `<div class="th-label">${ICONS.sparkles}<span>${t('thought')}</span></div><div class="th-body"></div>`;
      el.querySelector('.th-body').textContent = block.thinking;
      el.onclick = () => el.classList.toggle('open');
      cur.el.appendChild(el);
    } else if (block.type === 'toolCall') {
      sawContent = true;
      const w = document.createElement('div');
      w.innerHTML = toolCardHtml(block.id, block.name, JSON.stringify(block.arguments || {}), 'run');
      wireToolCard(w.firstChild);
      state.toolCards.set(block.id, w.firstChild);
      cur.el.appendChild(w);
    }
  }
  if (!sawContent) {
    if (message.stopReason === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'msg-error';
      errEl.textContent = message.errorMessage || `上游返回错误（${state.selModel || '模型'}），已计入路由状态`;
      cur.el.appendChild(errEl);
    } else if (message.usage && (message.usage.input || message.usage.output || message.usage.cacheRead)) {
      // keep the bubble: usage stats below still render for content-less turns
    } else {
      // aborted / blank turn with nothing to show — drop the empty bubble entirely
      const shell = cur.el.closest('.msg');
      if (shell) shell.remove();
      state.cur = null;
      scrollBottom();
      return;
    }
  }
  const u = message.usage;
  if (u && (u.input || u.output || u.cacheRead)) {
    const st = document.createElement('div');
    st.className = 'turn-stats';
    fillTurnStats(st, u, state.turnStart ? Date.now() - state.turnStart : null);
    cur.el.appendChild(st);
    state.turnStart = null;
  }
  cur.el.classList.remove('cursor');
  state.cur = null;
  scrollBottom();
}

// ---------- tool cards ----------
function toolCardHtml(id, name, args, status) {
  let argSummary = '';
  try { const a = typeof args === 'string' ? JSON.parse(args) : args; argSummary = a?.command || a?.path || a?.file_path || a?.pattern || ''; }
  catch { argSummary = String(args || '').slice(0, 80); }
  argSummary = String(argSummary).replace(/\s+/g, ' ').slice(0, 110);
  const stMap = { run: t('running'), ok: t('done'), err: t('failed') };
  return `<div class="tool-card" data-id="${esc(id || '')}">
    <div class="tool-head">
      <span class="t-icon">${ICONS.wrench}</span><span class="t-name">${esc(name || '')}</span>
      <span class="t-args">${esc(argSummary)}</span>
      <span class="t-status ${status}">${stMap[status] || status}</span>
    </div>
    <div class="tool-body"><pre>${esc(typeof args === 'string' && args.startsWith('{') ? prettyJson(args) : (args || ''))}</pre></div>
  </div>`;
}
function prettyJson(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } }
function wireToolCard(card) {
  if (!card) return;
  card.querySelector('.tool-head').onclick = () => card.classList.toggle('open');
}
function onToolStart(ev) {
  const holder = state.toolCards.get(ev.toolCallId);
  if (holder) {
    const body = holder.querySelector('.tool-body pre');
    if (body && !body.textContent) body.textContent = JSON.stringify(ev.args || {}, null, 2);
  } else {
    // tool call issued by another path (e.g. resumed session) — standalone card
    const cur = ensureAssistantBlock();
    const w = document.createElement('div');
    w.innerHTML = toolCardHtml(ev.toolCallId, ev.toolName, JSON.stringify(ev.args || {}), 'run');
    wireToolCard(w.firstChild);
    state.toolCards.set(ev.toolCallId, w.firstChild);
    cur.el.appendChild(w);
  }
  scrollBottom();
}
function onToolUpdate(ev) {
  const holder = state.toolCards.get(ev.toolCallId);
  if (holder && ev.partialResult?.content) {
    const txt = ev.partialResult.content.map((c) => c.text || '').join('');
    const body = holder.querySelector('.tool-body pre');
    if (body) { body.textContent = txt; holder.classList.add('open'); }
    scrollBottom();
  }
}
function onToolEnd(ev) {
  const holder = state.toolCards.get(ev.toolCallId);
  if (holder) {
    const st = holder.querySelector('.t-status');
    st.textContent = ev.isError ? t('failed') : t('done');
    st.className = `t-status ${ev.isError ? 'err' : 'ok'}`;
    const body = holder.querySelector('.tool-body pre');
    if (body && ev.result?.content) body.textContent = ev.result.content.map((c) => c.text || '').join('');
  }
}

// ---------- extension ui ----------
function handleUiRequest(ev) {
  const { id, method } = ev;
  if (method === 'notify') { $('#statusline').textContent = `[${ev.notifyType || 'info'}] ${ev.message || ''}`; return; }
  if (method === 'confirm') {
    modal(ev.title || 'confirm', ev.message || '', [
      { label: 'OK', primary: true, cb: () => wsSend({ type: 'rpc', tabId: state.tabId, data: { type: 'extension_ui_response', id, confirmed: true } }) },
      { label: 'Cancel', cb: () => wsSend({ type: 'rpc', tabId: state.tabId, data: { type: 'extension_ui_response', id, confirmed: false } }) },
    ]);
  } else if (method === 'select') {
    modal(ev.title || 'select', '', (ev.options || []).map((o) => ({ label: o, cb: () => wsSend({ type: 'rpc', tabId: state.tabId, data: { type: 'extension_ui_response', id, value: o } }) })));
  } else if (method === 'input' || method === 'editor') {
    modalWithInput(ev.title || method, ev.placeholder || '', ev.prefill || '', (val) => wsSend({ type: 'rpc', tabId: state.tabId, data: { type: 'extension_ui_response', id, value: val } }),
      () => wsSend({ type: 'rpc', tabId: state.tabId, data: { type: 'extension_ui_response', id, cancelled: true } }));
  }
}

// ---------- modal ----------
function modal(title, body, actions) {
  $('#modal-title').textContent = title;
  $('#modal-body').textContent = body;
  const act = $('#modal-actions'); act.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label; if (a.primary) b.className = 'primary';
    b.onclick = () => { closeModal(); a.cb && a.cb(); };
    act.appendChild(b);
  }
  $('#modal-backdrop').classList.remove('hidden');
}
function modalWithInput(title, placeholder, prefill, onOk, onCancel) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = `<input id="modal-input" placeholder="${esc(placeholder)}">`;
  const act = $('#modal-actions'); act.innerHTML = '';
  const input = () => $('#modal-input');
  const b1 = document.createElement('button'); b1.textContent = 'OK'; b1.className = 'primary';
  b1.onclick = () => { closeModal(); onOk(input().value); };
  const b2 = document.createElement('button'); b2.textContent = 'Cancel';
  b2.onclick = () => { closeModal(); onCancel && onCancel(); };
  act.append(b2, b1);
  $('#modal-backdrop').classList.remove('hidden');
  setTimeout(() => { input().value = prefill || ''; input().focus(); }, 30);
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
// bfcache restores a stale page (dead WS, old timeline) — force a fresh boot instead
window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

// ---------- timeline shell ----------
function msgShell(role, ts, withHeader = true) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (withHeader) {
    const name = role === 'user' ? 'You' : 'pi';
    const av = role === 'user' ? 'U' : 'π';
    wrap.innerHTML = `<div class="role-line"><div class="avatar ${role}">${av}</div><span class="role-name">${name}</span><span class="msg-time">${ts ? fmtTime(ts) : ''}</span></div><div class="msg-body"></div>`;
  } else {
    wrap.innerHTML = `<div class="msg-body"></div>`;
  }
  $('#timeline .tl-inner').appendChild(wrap);
  scrollBottom();
  return wrap;
}
function initSuggestions() {
  const row = $('#suggest-row');
  if (!row || row.children.length) return;
  for (const p of ['解释这个项目的结构', '帮我修复一个报错', '给核心逻辑补上测试']) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p;
    b.onclick = () => { const i = $('#input'); i.value = p; i.focus(); };
    row.appendChild(b);
  }
}
function scrollBottom() {
  const tl = $('#timeline');
  if (tl.scrollHeight - tl.scrollTop - tl.clientHeight < 400) tl.scrollTop = tl.scrollHeight;
}
function clearTimeline(withPlaceholder) {
  $('#timeline').innerHTML = `<div class="tl-inner"></div>`;
  if (withPlaceholder) {
    $('.tl-inner').innerHTML = `<div class="placeholder"><div class="big">π</div><div>${t('empty_title')}</div><div class="muted small" style="margin-top:6px">${t('empty_sub')}</div></div>`;
  }
}

// ---------- session lifecycle ----------
function rpcTo(data) { wsSend({ type: 'rpc', tabId: state.tabId, data }); }
function openPiSession({ sessionPath = null, isNew = false }) {
  if (!state.project) { askAddProject(); return; }
  const doOpen = () => {
    if (state.tabId) { wsSend({ type: 'close', tabId: state.tabId }); }
    state.tabId = 'tab-' + Math.random().toString(36).slice(2, 9);
    state.streaming = false; state.cur = null; state.toolCards.clear();
    state.goalRound = 0; state.goalDone = false; state.goalInjected = false;
    state.sessionFile = null;
    state.pendingNewSession = !!isNew;
    clearTimeline(isNew || !sessionPath);
    $('#proj-title').textContent = state.project.path;
    wsSend({
      type: 'open', tabId: state.tabId,
      cwd: state.project.path,
      sessionPath: isNew ? null : sessionPath,
      model: state.selModel || null,
    });
    $('#conn-dot').className = 'dot busy';
    $('#statusline').textContent = t('loading');
    if (!isNew && sessionPath) rpcTo({ id: 'replay', type: 'get_entries' });
    rpcTo({ type: 'get_available_models' });
    rpcTo({ id: 'st-' + Date.now(), type: 'get_state' });
    setTimeout(refreshStats, 800);
  };
  if (!state.selModel) {
    return api.get('/api/models/available').then((r) => {
      const models = r.models || [];
      const want = state.cfg && state.cfg.defaultModel ? state.cfg.defaultModel.split('/') : null;
      const pref = (want && models.find((m) => m.provider === want[0] && m.id === want[1]))
        || models.find((m) => !['google', 'anthropic', 'openai', 'openai-codex', 'github-copilot'].includes(m.provider));
      if (pref) {
        state.selModel = `${pref.provider}/${pref.id}`;
        updateModelChip();
      }
      return doOpen();
    }).catch(() => doOpen());
  }
  return doOpen();
}
// replay get_entries response
const origHandle = handlePiEvent;
handlePiEvent = function (ev) {
  if (ev.type === 'response' && ev.command === 'get_entries' && ev.success && ev.data?.entries) {
    renderReplay(ev.data.entries);
    return;
  }
  if (ev.type === 'response' && ev.command === 'get_available_models' && ev.success) {
    state.modelsAvailable = ev.data?.models || [];
    updateModelChip();
    return;
  }
  origHandle(ev);
};
function renderReplay(entries) {
  // entries: [{type:'message', id, message:{role, content|text, ...}}...]
  clearTimeline(false);
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const m = e.message || {};
    if (m.role === 'user') {
      const el = msgShell('user', m.timestamp);
      const txt = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((c) => c.type !== 'image').map((c) => c.text || '').join(' ') : '';
      el.querySelector('.msg-body').textContent = txt;
    } else if (m.role === 'assistant') {
      const hasContent = (m.content || []).some((b) => (b.type === 'text' && b.text) || (b.type === 'thinking' && b.thinking) || b.type === 'toolCall');
      if (!hasContent) {
        if (m.stopReason === 'error') {
          const el = msgShell('assistant', m.timestamp);
          const errEl = document.createElement('div');
          errEl.className = 'msg-error';
          errEl.textContent = m.errorMessage || '上游返回错误';
          el.querySelector('.msg-body').appendChild(errEl);
        }
        continue; // skip empty assistant shells (aborted/blank turns)
      }
      const el = msgShell('assistant', m.timestamp);
      const body = el.querySelector('.msg-body');
      const inner = document.createElement('div'); inner.className = 'md';
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) { const d = document.createElement('div'); d.innerHTML = mdRender(b.text); inner.appendChild(d); }
        else if (b.type === 'thinking' && b.thinking) {
          const th = document.createElement('div'); th.className = 'thinking open';
          th.innerHTML = `<div class="th-label">${ICONS.sparkles}<span>${t('thought')}</span></div><div class="th-body"></div>`;
          th.querySelector('.th-body').textContent = b.thinking;
          th.onclick = () => th.classList.toggle('open');
          inner.appendChild(th);
        } else if (b.type === 'toolCall') {
          const w = document.createElement('div');
          w.innerHTML = toolCardHtml(b.id, b.name, JSON.stringify(b.arguments || {}), 'done');
          wireToolCard(w.firstChild); inner.appendChild(w);
        }
      }
      body.appendChild(inner);
      if (m.usage && (m.usage.input || m.usage.output || m.usage.cacheRead)) {
        const st = document.createElement('div');
        st.className = 'turn-stats';
        fillTurnStats(st, m.usage, null);
        body.appendChild(st);
      }
    } else if (m.role === 'toolResult') {
      // attach under preceding toolCall card if present
      const holder = state.toolCards.get(m.toolCallId);
      if (holder) {
        const st = holder.querySelector('.t-status');
        st.textContent = m.isError ? t('failed') : t('done');
        st.className = `t-status ${m.isError ? 'err' : 'ok'}`;
        const body = holder.querySelector('.tool-body pre');
        if (body && m.content) body.textContent = m.content.map((c) => c.text || '').join('');
      }
    }
  }
  state.toolCards.clear();
  scrollBottom();
  renderHomeHero();
}

// ---------- stats / model chip ----------
async function refreshStats() {
  if (!state.tabId) return;
  rpcTo({ id: 'stats-' + Date.now(), type: 'get_session_stats' });
}
// intercept stats response — "本轮对话统计"
const origHandle2 = handlePiEvent;
handlePiEvent = function (ev) {
  if (ev.type === 'response' && ev.command === 'get_session_stats' && ev.success && ev.data) {
    const s = ev.data;
    state.lastStats = s;
    const tk = s.tokens || {};
    const tot = tk.total || ((tk.input || 0) + (tk.output || 0) + (tk.cacheRead || 0) + (tk.cacheWrite || 0));
    const hit = cacheRate(tk.input, tk.cacheRead);
    $('#stats-chip').textContent = `本轮 ${fmtTok(tot)}` + (hit === null ? '' : ` · 缓存率 ${hit}%`) + ` · ${(s.cost || 0).toFixed(4)}`;
    const pct = s.contextUsage ? Number(s.contextUsage.percent || 0).toFixed(1) : null;
    const sbc = document.querySelector('#sb-ctx');
    if (sbc) sbc.textContent = '上下文 ' + (pct === null ? '—' : pct + '%');
    return;
  }
  if (ev.type === 'response' && ev.command === 'get_state' && ev.success && ev.data) {
    state.sessionFile = ev.data.sessionFile;
    return;
  }
  origHandle2(ev);
};
// stats-chip click → session stats detail
$('#stats-chip').onclick = () => {
  const s = state.lastStats;
  if (!s) { $('#statusline').textContent = '本轮还没有统计数据'; return; }
  const tk = s.tokens || {};
  const hit = cacheRate(tk.input, tk.cacheRead);
  const cu = s.contextUsage || {};
  modal('本轮对话统计', '', [{ label: '关闭', primary: true }]);
  $('#modal-body').innerHTML = `<div class="stats-detail">
    <div class="sd-row"><span>输入 tokens</span><b>${(tk.input || 0).toLocaleString()}</b></div>
    <div class="sd-row"><span>输出 tokens</span><b>${(tk.output || 0).toLocaleString()}</b></div>
    <div class="sd-row"><span>缓存读</span><b>${(tk.cacheRead || 0).toLocaleString()}</b></div>
    <div class="sd-row"><span>缓存写</span><b>${(tk.cacheWrite || 0).toLocaleString()}</b></div>
    <div class="sd-row"><span>缓存率</span><b>${hit === null ? '—' : hit + '%'}</b></div>
    <div class="sd-row"><span>费用</span><b>$${(s.cost || 0).toFixed(4)}</b></div>
    <div class="sd-row"><span>消息</span><b>${s.userMessages || 0} 问 / ${s.assistantMessages || 0} 答</b></div>
    <div class="sd-row"><span>上下文占用</span><b>${fmtTok(cu.tokens || 0)} / ${fmtTok(cu.contextWindow || 0)}（${Number(cu.percent || 0).toFixed(1)}%）</b></div>
  </div>`;
};
// ---------- today stats chip (all conversations today, local date) ----------
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function renderTodayPop(d) {
  const pop = $('#today-pop');
  if (!pop) return;
  if (!d || (!d.input && !d.output && !d.cacheRead && !d.cacheWrite)) {
    pop.innerHTML = `<div class="pop-head">今日统计</div><div class="muted small">还没有用量</div>`;
    return;
  }
  const hit = cacheRate(d.input, d.cacheRead);
  pop.innerHTML = `<div class="pop-head">今日统计</div>
    <div class="stats-detail">
      <div class="sd-row"><span>输入</span><b>${fmtTok(d.input)}</b></div>
      <div class="sd-row"><span>输出</span><b>${fmtTok(d.output)}</b></div>
      <div class="sd-row"><span>缓存读</span><b>${fmtTok(d.cacheRead)}</b></div>
      <div class="sd-row"><span>缓存写</span><b>${fmtTok(d.cacheWrite)}</b></div>
      <div class="sd-row"><span>缓存率</span><b>${hit === null ? '—' : hit + '%'}</b></div>
      <div class="sd-row"><span>回复</span><b>${d.ok || 0} 次</b></div>
      <div class="sd-row"><span>费用</span><b>$${(d.cost || 0).toFixed(4)}</b></div>
    </div>`;
}
async function loadTodayStats() {
  try {
    const u = await api.get('/api/usage');
    const d = (u.days || {})[localToday()];
    const el = $('#today-chip');
    if (!d || (!d.input && !d.output && !d.cacheRead && !d.cacheWrite)) {
      el.textContent = '今日 0';
      renderTodayPop(null);
      return;
    }
    const tot = (d.input || 0) + (d.output || 0) + (d.cacheRead || 0) + (d.cacheWrite || 0);
    el.textContent = `今日 ${fmtTok(tot)}`;
    const sbt = document.querySelector('#sb-today');
    if (sbt) sbt.textContent = `今日 ${fmtTok(tot)}`;
    renderTodayPop(d);
  } catch {}
}
(function bindTodayPop() {
  const wrap = $('#today-wrap');
  const pop = $('#today-pop');
  if (!wrap || !pop) return;
  let hideTimer = 0;
  const show = () => { clearTimeout(hideTimer); pop.classList.remove('hidden'); };
  const hide = () => { if (state.todayPopPinned) return; pop.classList.add('hidden'); };
  wrap.addEventListener('mouseenter', show);
  wrap.addEventListener('mouseleave', () => { hideTimer = setTimeout(hide, 160); });
  $('#today-chip').addEventListener('click', (e) => {
    e.stopPropagation();
    state.todayPopPinned = !state.todayPopPinned;
    if (state.todayPopPinned) show();
    else pop.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (wrap.contains(e.target)) return;
    state.todayPopPinned = false;
    pop.classList.add('hidden');
  });
})();
// failover triggers: agent settled with error / abnormal pi exit (borrowed from oh-my-pi)
// note: pi auto-retries internally — wait for agent_settled, don't switch on the first error frame
const origHandle3 = handlePiEvent;
handlePiEvent = function (ev) {
  if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
    state.lastAssistantText = (ev.message.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
    state.lastStop = ev.message.stopReason || null;
  }
  if (ev.type === 'pi-exit' && ev.code !== 0 && state.streaming) maybeFailover('pi exited with code ' + ev.code);
  pushLog(ev);
  origHandle3(ev);
};
function fmtK(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

// ---------- log drawer (Hermes logs) ----------
const logBuf = [];
let logOpen = false;
function logRowHtml(e) {
  return `<div class="lr"><b>${new Date(e.at).toLocaleTimeString()}</b>${esc(e.t + (e.d ? ' · ' + e.d : ''))}</div>`;
}
function pushLog(ev) {
  let d = '';
  if (ev.type === 'message_end') d = `${ev.message?.role || ''} ${ev.message?.stopReason || ''}`.trim();
  else if (ev.type === 'response') d = ev.command || ev.id || '';
  else if (ev.type === 'tool_execution_start') d = ev.toolName || '';
  const e = { at: Date.now(), t: ev.type, d };
  logBuf.push(e);
  if (logBuf.length > 400) logBuf.shift();
  if (logOpen) {
    const rows = $('#log-rows');
    rows.insertAdjacentHTML('beforeend', logRowHtml(e));
    if (rows.children.length > 400) rows.removeChild(rows.firstChild);
    rows.scrollTop = 1e9;
  }
}
$('#btn-logs').onclick = () => {
  logOpen = !logOpen;
  $('#log-drawer').classList.toggle('hidden', !logOpen);
  if (logOpen) {
    const rows = $('#log-rows');
    rows.innerHTML = logBuf.map(logRowHtml).join('') || '<div class="lr muted">暂无事件</div>';
    rows.scrollTop = 1e9;
  }
};
$('#btn-log-close').onclick = () => { logOpen = false; $('#log-drawer').classList.add('hidden'); };
$('#btn-log-clear').onclick = () => { logBuf.length = 0; $('#log-rows').innerHTML = '<div class="lr muted">已清空</div>'; };
function renderLogPage() {
  const box = $('#log-page-rows');
  if (!box) return;
  box.innerHTML = logBuf.map(logRowHtml).join('') || '<div class="muted small">尚无事件</div>';
  box.scrollTop = 1e9;
}
$('#btn-log-export').onclick = () => {
  const blob = new Blob([JSON.stringify(logBuf, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pi-workbench-logs.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#btn-log-page-clear').onclick = () => {
  logBuf.length = 0;
  $('#log-rows').innerHTML = '<div class="lr muted">已清空</div>';
  renderLogPage();
};

// ---------- files panel (Hermes files) ----------
let filesRoot = null, filesRel = '';
$('#btn-files').onclick = () => {
  const p = $('#files-panel');
  const show = p.classList.contains('hidden');
  p.classList.toggle('hidden', !show);
  if (show) {
    filesRoot = state.project?.path || null;
    filesRel = '';
    $('#file-view').classList.add('hidden');
    renderFiles();
  }
};
$('#btn-files-close').onclick = () => $('#files-panel').classList.add('hidden');
async function renderFiles() {
  const crumbs = $('#files-crumbs');
  const parts = filesRel ? filesRel.split('/') : [];
  let html = `<button data-p="">${esc(filesRoot || '—')}</button>`;
  let acc = '';
  for (const part of parts) {
    acc += (acc ? '/' : '') + part;
    html += `<span class="sep">/</span><button data-p="${esc(acc)}">${esc(part)}</button>`;
  }
  crumbs.innerHTML = html;
  crumbs.querySelectorAll('button').forEach((b) => { b.onclick = () => { filesRel = b.dataset.p; $('#file-view').classList.add('hidden'); renderFiles(); }; });
  const list = $('#files-list');
  list.innerHTML = `<div class="muted small" style="padding:10px">${t('loading')}</div>`;
  const r = await api.get(`/api/files/list?root=${encodeURIComponent(filesRoot || '')}&path=${encodeURIComponent(filesRel)}`).catch(() => null);
  list.innerHTML = '';
  if (!r || r.error) { list.innerHTML = `<div class="muted small" style="padding:10px">${esc((r && r.error) || '加载失败')}</div>`; return; }
  for (const it of r.items) {
    const row = document.createElement('div');
    row.className = 'file-row' + (it.dir ? ' dir' : '');
    row.innerHTML = `<span class="f-name">${esc(it.name)}</span><span class="f-size">${it.dir ? '目录' : fmtK(it.size)}</span>`;
    row.onclick = async () => {
      const child = filesRel ? `${filesRel}/${it.name}` : it.name;
      if (it.dir) { filesRel = child; $('#file-view').classList.add('hidden'); renderFiles(); return; }
      const rr = await api.get(`/api/files/read?root=${encodeURIComponent(filesRoot)}&path=${encodeURIComponent(child)}`).catch(() => null);
      const fv = $('#file-view');
      fv.classList.remove('hidden');
      fv.textContent = !rr ? '读取失败' : rr.tooBig ? `文件过大（${fmtK(rr.size)}）` : (rr.binary ? '（二进制文件）' : (rr.text || '（空文件）'));
      fv.scrollTop = 0;
    };
    list.appendChild(row);
  }
  if (!list.children.length) list.innerHTML = '<div class="muted small" style="padding:10px">空目录</div>';
}
// ---------- goal mode (ZCode/Codex style: pinned objective + auto-continue) ----------
const GOAL_MAX_ROUNDS = 15;
function currentGoal() { return (state.cfg.goals || {})[state.project?.path || ''] || null; }
function renderGoalBanner() {
  const g = currentGoal();
  const b = $('#goal-banner');
  if (!g || !g.text) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const tv = $('#goal-text-view');
  tv.textContent = g.text + (state.goalDone ? ' — 已完成' : (g.auto ? `（自动续跑 · 第 ${state.goalRound || 0} 轮）` : ''));
  tv.classList.toggle('done', !!state.goalDone);
  $('#btn-goal-stop').classList.toggle('hidden', !g.auto || !!state.goalDone);
}
$('#btn-goal').onclick = () => {
  const proj = state.project?.path || '';
  const g = (state.cfg.goals || {})[proj] || { text: '', auto: false };
  $('#modal-title').textContent = '目标模式';
  $('#modal-body').innerHTML = `<textarea id="goal-text" placeholder="描述要达成的目标，如：修复登录页 502 并确保测试通过">${esc(g.text)}</textarea>
    <label><input type="checkbox" id="goal-auto" ${g.auto ? 'checked' : ''}> 自动续跑（每轮完成后自动继续，直到模型输出 GOAL_DONE 或达到轮数上限）</label>`;
  $('#modal-actions').innerHTML = '';
  const mkBtn = (label, primary, cb) => {
    const b = document.createElement('button');
    b.textContent = label; if (primary) b.className = 'primary';
    b.onclick = () => { closeModal(); cb && cb(); };
    $('#modal-actions').appendChild(b);
  };
  mkBtn('清除', false, async () => {
    const goals = state.cfg.goals || {};
    delete goals[proj];
    state.cfg.goals = goals;
    await api.post('/api/config', { goals });
    state.goalRound = 0; state.goalDone = false; state.goalInjected = false;
    renderGoalBanner();
  });
  mkBtn('保存', true, async () => {
    const goals = state.cfg.goals || {};
    const text = $('#goal-text').value.trim();
    const auto = $('#goal-auto')?.checked || false;
    if (text) goals[proj] = { text, auto }; else delete goals[proj];
    state.cfg.goals = goals;
    state.goalRound = 0; state.goalDone = false; state.goalInjected = false;
    await api.post('/api/config', { goals });
    renderGoalBanner();
  });
};
$('#btn-goal-stop').onclick = () => { state.goalStop = true; $('#statusline').textContent = '已停止自动续跑'; renderGoalBanner(); };
const GOAL_CONTINUE_PROMPT = '继续推进目标；若目标已完全完成，请在回复末尾单独一行输出 GOAL_DONE。';
function maybeGoalContinue() {
  const g = currentGoal();
  if (!g || !g.auto || !g.text || state.userAborted || state.goalStop || state.goalDone) { renderGoalBanner(); return; }
  if (state.lastStop === 'error') { renderGoalBanner(); return; } // failover owns error turns
  const txt = state.lastAssistantText || '';
  if (/GOAL_DONE/.test(txt)) {
    state.goalDone = true; renderGoalBanner();
    $('#statusline').textContent = '目标完成（模型输出 GOAL_DONE）';
    return;
  }
  if ((state.goalRound || 0) >= GOAL_MAX_ROUNDS) {
    $('#statusline').textContent = `目标自动续跑达到上限 ${GOAL_MAX_ROUNDS} 轮，已暂停`;
    renderGoalBanner();
    return;
  }
  state.goalRound = (state.goalRound || 0) + 1;
  renderGoalBanner();
  setTimeout(() => submitPrompt(GOAL_CONTINUE_PROMPT, { resend: true }), 700);
}
function updateModelChip() {
  const chip = document.querySelector('#model-chip');
  const mid = (state.selModel || '').split('/')[1] || state.selModel || '';
  if (!mid) { chip.textContent = '—'; return; }
  const short = mid.startsWith('gpt-') ? mid.slice(4) : mid;
  const label = short.split('-').map((t) => (t.length > 2 ? t[0].toUpperCase() + t.slice(1) : t)).join(' ');
  chip.innerHTML = `${esc(label)} ${ICONS.chevron}`;
  const sb = document.querySelector('#sb-model');
  if (sb) sb.textContent = '模型 ' + (label || '—');
}

// ---------- composer ----------
const inputEl = $('#input');
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPrompt(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
});
function queueImageFile(f) {
  if (!f || !String(f.type || '').startsWith('image/')) return;
  const rd = new FileReader();
  rd.onload = () => {
    state.pendingImage = { data: String(rd.result).split(',')[1], mimeType: f.type };
    $('#statusline').textContent = `${f.type} 图片就绪`;
  };
  rd.readAsDataURL(f);
}
inputEl.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      queueImageFile(it.getAsFile());
      e.preventDefault();
    }
  }
});
const dropZone = $('#composer') || document.body;
dropZone.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  $('#drop-hint')?.classList.remove('hidden');
});
dropZone.addEventListener('dragleave', () => $('#drop-hint')?.classList.add('hidden'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  $('#drop-hint')?.classList.add('hidden');
  const f = [...(e.dataTransfer.files || [])].find((x) => String(x.type || '').startsWith('image/'));
  if (f) queueImageFile(f);
});
$('#btn-attach').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => queueImageFile(inp.files && inp.files[0]);
  inp.click();
};
$('#btn-theme').onclick = async () => {
  state.cfg.theme = state.cfg.theme === 'dark' ? 'light' : 'dark';
  applyI18n();
  applyThemeBtns();
  await api.post('/api/config', { theme: state.cfg.theme });
};
async function sendPrompt() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  submitPrompt(text);
}
async function submitPrompt(text, { resend = false } = {}) {
  if (!text) return;
  if (!state.tabId) {
    await openPiSession({ isNew: true });
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!state.tabId) return;
  // goal context injection: first prompt of a session carries the pinned objective
  const g = currentGoal();
  if (g && g.text && !state.goalInjected) {
    text = `【目标】${g.text}\n\n${text}`;
    state.goalInjected = true;
  }
  state.lastPrompt = text;
  state.failoverDone = false;
  state.userAborted = false;
  if (!resend) clearTimeline(false);
  const el = msgShell('user', Date.now(), false);
  el.querySelector('.msg-body').textContent = text;
  const cmd = { type: 'prompt', message: text };
  if (state.pendingImage) { cmd.images = [state.pendingImage]; state.pendingImage = null; $('#statusline').textContent = ''; }
  if (state.streaming) cmd.streamingBehavior = 'followUp';
  rpcTo(cmd);
  scrollBottom();
  renderHomeHero();
}
// failover along the routing chain (borrowed from oh-my-pi fallback chains)
async function maybeFailover(detail) {
  if (state.failoverDone || state.userAborted || !state.selModel) return;
  state.failoverDone = true;
  let r;
  try { r = await api.post('/api/routing/fail', { model: state.selModel, error: detail || 'assistant error', tabId: state.tabId }); }
  catch { return; }
  const from = state.selModel;
  if (!r.next || r.next === from) {
    $('#statusline').textContent = `${from} 失败，链上无可用备选（冷却 120s 后可重试）`;
    return;
  }
  state.selModel = r.next;
  updateModelChip();
  $('#statusline').textContent = `路由切换：${from} → ${r.next}，自动重发…`;
  const sp = state.sessionFile;
  setTimeout(() => {
    openPiSession({ sessionPath: sp, isNew: !sp });
    setTimeout(() => submitPrompt(state.lastPrompt, { resend: true }), 1500);
  }, 300);
}
function markRouteOk() {
  state.failoverDone = false;
  if (state.selModel) api.post('/api/routing/ok', { model: state.selModel }).catch(() => {});
}
$('#btn-send').onclick = sendPrompt;
$('#btn-stop').onclick = () => {
  // user-initiated abort: never let the resulting error frame trigger failover/resend
  state.userAborted = true;
  rpcTo({ type: 'abort' });
};
function setBusy(b) {
  $('#btn-send').classList.toggle('hidden', b);
  $('#btn-stop').classList.toggle('hidden', !b);
  $('#conn-dot').className = 'dot ' + (b ? 'busy' : 'on');
  if (!b) $('#statusline').textContent = '';
}

// ---------- sessions sidebar ----------
function filterSessionList() {
  const q = ($('#global-search')?.value || '').toLowerCase();
  $$('#project-tree .conv-item').forEach((d) => {
    const hay = (d.dataset.title || d.textContent || '').toLowerCase();
    d.style.display = (!q || hay.includes(q)) ? '' : 'none';
  });
}
// ---------- projects (tree: conversations live under their project) ----------
async function loadSessions() { return renderProjectTree(); }
function selectProject(p) {
  state.project = p || null;
  $('#proj-title').textContent = p?.path || '—';
  if (p) { state.expanded = state.expanded || new Set(); state.expanded.add(p.path); }
  renderGoalBanner();
  renderProjectTree();
}
const FOLDER_ICON = svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');
const PLUS_ICON = svg('<path d="M12 5v14M5 12h14"/>');
const DOTS_ICON = svg('<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>');
const CARET_DOWN = svg('<path d="m6 9 6 6 6-6"/>');
const CARET_RIGHT = svg('<path d="m9 6 6 6-6 6"/>');
const TRASH_ICON = svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');

function askDeleteSession(proj, s) {
  const title = cleanTitle(s.preview) || s.name || s.id.slice(0, 8);
  modal('删除对话', `删除「${title}」？会话文件将从磁盘删除，不可恢复。`, [
    { label: '取消' },
    { label: '删除', primary: true, cb: async () => {
      const r = await api.post('/api/sessions/delete', { path: s.file });
      if (r.error) { $('#statusline').textContent = '删除失败：' + r.error; return; }
      if (state.sessionFile === s.file && state.tabId) {
        wsSend({ type: 'close', tabId: state.tabId });
        state.tabId = null; state.sessionFile = null; state.pendingNewSession = false;
        clearTimeline(true);
      }
      if (state.sessionsByPath) delete state.sessionsByPath[proj.path];
      renderProjectTree();
    } },
  ]);
}

async function startInProject(p) {
  selectProject(p);
  await openPiSession({ isNew: true });
  renderProjectTree();
}
function askRemoveProject(p) {
  modal('移除项目', `从工作台移除「${p.name || p.path}」？只移出入口，不会删除磁盘文件。`, [
    { label: '取消' },
    { label: '移除', primary: true, cb: async () => {
      await api.post('/api/projects/remove', { path: p.path });
      state.cfg = await api.get('/api/config');
      if (state.project?.path === p.path) state.project = state.cfg.projects?.[0] || null;
      if (state.project) { state.expanded?.add(state.project.path); $('#proj-title').textContent = state.project.path; }
      renderProjectTree();
    } },
  ]);
}
async function renderProjectTree(useCache = false) {
  const list = $('#project-tree');
  if (!list) return;
  const projects = state.cfg.projects || [];
  if (!projects.length) {
    list.innerHTML = `<div class="muted small" style="padding:12px 10px">还没有项目，点右上角 ＋ 添加。</div>`;
    return;
  }
  state.expanded = state.expanded || new Set();
  state.sessionsByPath = state.sessionsByPath || {};
  if (!useCache) {
    const results = await Promise.all(projects.map((p) =>
      api.get(`/api/sessions/pi?cwd=${encodeURIComponent(p.path)}`).then((r) => r.sessions || []).catch(() => [])
    ));
    projects.forEach((p, i) => { state.sessionsByPath[p.path] = results[i]; });
  }
  const q = ($('#global-search')?.value || '').toLowerCase();
  const nameCounts = {};
  for (const p of projects) {
    const n = p.name || p.path;
    nameCounts[n] = (nameCounts[n] || 0) + 1;
  }
  const labelFor = (p) => {
    const base = p.name || p.path;
    if ((nameCounts[base] || 0) <= 1) return base;
    const segs = p.path.split(/[\\/]/).filter(Boolean);
    return `${base} · ${segs.slice(-2).join('\\')}`;
  };
  list.innerHTML = '';
  for (const p of projects) {
    const sessions = state.sessionsByPath[p.path] || [];
    const open = q ? true : (state.expanded.has(p.path) || state.project?.path === p.path);
    const block = document.createElement('div');
    block.className = 'proj-block';
    const head = document.createElement('div');
    head.className = 'session-item proj-row' + (state.project?.path === p.path ? ' active' : '');
    head.dataset.path = p.path;
    head.innerHTML = `<div class="proj-line">
        <span class="proj-caret" title="展开 / 收起">${open ? CARET_DOWN : CARET_RIGHT}</span>
        <span class="proj-ico">${FOLDER_ICON}</span>
        <span class="s-name" title="${esc(p.path)}">${esc(labelFor(p))}</span>
        <span class="proj-count">${sessions.length || ''}</span>
        <span class="proj-acts">
          <button class="pa-btn" data-act="new" title="在此项目下新建对话">${PLUS_ICON}</button>
          <button class="pa-btn" data-act="more" title="更多">${DOTS_ICON}</button>
        </span>
      </div>`;
    head.onclick = (e) => {
      if (e.target.closest('.pa-btn')) return;
      state.project = p;
      $('#proj-title').textContent = p.path;
      renderGoalBanner();
      state.expanded.add(p.path);
      renderProjectTree();
    };
    head.querySelector('.proj-caret').onclick = (e) => {
      e.stopPropagation();
      if (state.expanded.has(p.path)) state.expanded.delete(p.path); else state.expanded.add(p.path);
      renderProjectTree();
    };
    head.querySelector('[data-act="new"]').onclick = (e) => { e.stopPropagation(); startInProject(p); };
    head.querySelector('[data-act="more"]').onclick = (e) => {
      e.stopPropagation();
      openDropdown(e.currentTarget, [
        { header: p.name || p.path },
        { label: '在此项目下新建对话', cb: () => startInProject(p) },
        { label: '移除项目', cb: () => askRemoveProject(p) },
      ]);
    };
    block.appendChild(head);
    if (open) {
      if (state.pendingNewSession && state.tabId && state.project?.path === p.path) {
        const d = document.createElement('div');
        d.className = 'session-item conv-item active';
        d.innerHTML = `<div class="s-name">新建对话</div><div class="s-preview">进行中</div>`;
        block.appendChild(d);
      }
      for (const s of sessions.slice(0, 50)) {
        const d = document.createElement('div');
        d.className = 'session-item conv-item' + (state.sessionFile === s.file ? ' active' : '');
        d.dataset.title = (cleanTitle(s.preview) || s.id).toLowerCase();
        d.innerHTML = `<div class="conv-line">
          <div style="min-width:0;flex:1">
            <div class="s-name">${esc(cleanTitle(s.preview) || s.name || s.id.slice(0, 8))}</div>
            <div class="s-preview">${relTime(s.mtime)}</div>
          </div>
          <span class="conv-acts">
            <button class="pa-btn" data-act="del" title="删除对话">${TRASH_ICON}</button>
          </span>
        </div>`;
        d.onclick = (e) => {
          if (e.target.closest('.pa-btn')) return;
          $$('#project-tree .conv-item').forEach((x) => x.classList.remove('active'));
          d.classList.add('active');
          openPiSession({ sessionPath: s.file });
        };
        d.querySelector('[data-act="del"]').onclick = (e) => {
          e.stopPropagation();
          askDeleteSession(p, s);
        };
        block.appendChild(d);
      }
      if (!sessions.length && !(state.pendingNewSession && state.project?.path === p.path)) {
        const d = document.createElement('div');
        d.className = 'muted small conv-empty';
        d.textContent = '暂无对话，点 ⊕ 开始';
        block.appendChild(d);
      }
    }
    list.appendChild(block);
  }
}
async function loadProjects() {
  state.cfg = await api.get('/api/config');
  applyI18n(); applyThemeBtns();
  if (!state.project && state.cfg.projects?.length) state.project = state.cfg.projects[0];
  if (state.project && !(state.cfg.projects || []).some((p) => p.path === state.project.path)) {
    state.project = state.cfg.projects?.[0] || null;
  }
  if (state.project) {
    state.expanded = state.expanded || new Set();
    state.expanded.add(state.project.path);
  }
  $('#proj-title').textContent = state.project?.path || '—';
  await renderProjectTree();
}
function askAddProject() {
  modalWithInput(t('add_project'), t('project_path'), '', async (val) => {
    if (!val) return;
    const cfg = await api.post('/api/projects/add', { path: val.trim(), name: val.trim().split(/[\\/]/).pop() });
    state.cfg = cfg;
    await loadProjects();
  });
}
$('#btn-add-project').onclick = () => {
  const list = $('#project-tree');
  list.querySelector('.proj-add-row')?.remove();
  list.querySelector('.muted')?.remove();
  const row = document.createElement('div');
  row.className = 'proj-add-row';
  row.innerHTML = `<input class="proj-add-input" placeholder="粘贴项目文件夹路径，回车确认" spellcheck="false">
    <div class="proj-add-err"></div>`;
  list.prepend(row);
  const input = row.querySelector('input');
  const err = row.querySelector('.proj-add-err');
  setTimeout(() => input.focus(), 0);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { row.remove(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const val = input.value.trim();
    if (!val) { row.remove(); return; }
    const r = await api.post('/api/projects/add', { path: val, name: val.split(/[\\/]/).pop() });
    if (r.error) { err.textContent = '目录不存在，检查路径后重试'; input.focus(); return; }
    state.cfg = r;
    state.project = r.projects.find((p) => p.path.toLowerCase() === val.toLowerCase()) || r.projects[0];
    state.expanded = state.expanded || new Set();
    if (state.project) state.expanded.add(state.project.path);
    $('#proj-title').textContent = state.project?.path || '—';
    renderProjectTree();
  });
  document.addEventListener('click', function cancel(e) {
    if (row.contains(e.target)) return;
    if (!input.value.trim()) row.remove();
    document.removeEventListener('click', cancel);
  });
};

// ---------- top chips ----------
$('#btn-new-session').onclick = async () => {
  await openPiSession({ isNew: true });
  if (state.project) { state.expanded = state.expanded || new Set(); state.expanded.add(state.project.path); }
  renderProjectTree();
};
// (model/thinking dropdowns live in dropdowns.js)
$('#btn-diff').onclick = async () => {
  if (!state.project) return;
  const r = await api.get(`/api/git/diff?cwd=${encodeURIComponent(state.project.path)}`);
  const panel = $('#diff-panel');
  const body = $('#diff-body');
  body.innerHTML = '';
  const out = r.out || '(no diff)';
  for (const line of out.split('\n')) {
    const s = document.createElement('span');
    s.className = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : '';
    s.textContent = line + '\n';
    body.appendChild(s);
  }
  panel.classList.remove('hidden');
};
$('#btn-diff-close').onclick = () => $('#diff-panel').classList.add('hidden');

// ---------- import ----------
$$('.import-head .chip').forEach((b) => {
  b.onclick = () => {
    $$('.import-head .chip').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.importSrc = b.dataset.src;
    loadImportList();
  };
});
async function loadImportList() {
  const list = $('#import-list');
  list.innerHTML = `<div class="muted small" style="padding:20px 10px">${t('loading')}</div>`;
  const r = await api.get(`/api/import/${state.importSrc}`);
  list.innerHTML = '';
  for (const s of r.sessions || []) {
    const d = document.createElement('div');
    d.className = 'session-item';
    d.dataset.title = (cleanTitle(s.preview) || s.id).toLowerCase();
    d.innerHTML = `<div class="s-name">${esc(cleanTitle(s.preview) || s.id.slice(0, 10))}</div>
      <div class="s-preview">${esc(s.cwd || '')} · ${relTime(s.mtime)}</div>`;
    d.onclick = () => openImported(state.importSrc, s.file);
    list.appendChild(d);
  }
  if (!r.sessions?.length) list.innerHTML = `<div class="placeholder small" style="padding:30px 10px">no sessions found</div>`;
}
async function openImported(src, file) {
  const r = await api.get(`/api/import/${src}/read?path=${encodeURIComponent(file)}`);
  clearTimeline(false);
  $('#proj-title').textContent = `${src} · ${file.split(/[\\/]/).pop()}`;
  for (const e of r.entries || []) {
    if (e.kind === 'message') {
      const el = msgShell(e.role, e.ts ? Date.parse(e.ts) : null);
      const body = el.querySelector('.msg-body');
      if (e.role === 'assistant') body.innerHTML = `<div class="md">${mdRender(e.text)}</div>`;
      else body.textContent = e.text;
    } else if (e.kind === 'thinking') {
      const el = msgShell('assistant', e.ts ? Date.parse(e.ts) : null);
      el.querySelector('.msg-body').innerHTML = `<div class="thinking"><div class="th-label">${ICONS.sparkles}<span>${t('thought')}</span></div><div class="th-body">${esc(e.text)}</div></div>`;
      el.querySelector('.thinking').onclick = (ev) => ev.currentTarget.classList.toggle('open');
    } else if (e.kind === 'toolcall') {
      const el = msgShell('assistant', e.ts ? Date.parse(e.ts) : null);
      const body = el.querySelector('.msg-body');
      const w = document.createElement('div');
      w.innerHTML = toolCardHtml(e.id, e.name, typeof e.args === 'string' ? e.args : JSON.stringify(e.args || {}), 'done');
      wireToolCard(w.firstChild);
      body.appendChild(w);
    } else if (e.kind === 'toolresult') {
      // merge into previous card by id if visible
      const cards = $$('#timeline .tool-card');
      const card = cards[cards.length - 1];
      if (card) {
        const st = card.querySelector('.t-status');
        st.textContent = t('done'); st.className = 't-status ok';
        const body = card.querySelector('.tool-body pre');
        if (body && e.output) body.textContent = String(e.output).slice(0, 20000);
      }
    }
  }
}

// ---------- providers tab (beginner flow: URL + key → discover models → pick) ----------
async function loadModelsEditor() {
  const m = await api.get('/api/models');
  state.modelsDoc = m;
  state.routingMeta = await api.get('/api/routing').catch(() => ({ providers: [] }));
  state.cfg = await api.get('/api/config').catch(() => state.cfg);
  const names = Object.keys(m.providers || {});
  const sel = $('#prov-select');
  sel.innerHTML = names.map((n) => {
    const url = (m.providers[n] || {}).baseUrl || '';
    return `<option value="${esc(n)}">${esc(n)}${url ? ' · ' + esc(url) : ''}</option>`;
  }).join('');
  if (!state.editProv || !names.includes(state.editProv)) {
    // default to the provider currently in use, not just the first one
    const defProv = (state.cfg.defaultModel || '').split('/')[0];
    state.editProv = names.includes(defProv) ? defProv : (names[0] || null);
  }
  if (state.editProv) sel.value = state.editProv;
  $('#models-status').textContent = '';
  renderCurrentCfg();
  renderProvForm();
}
function renderCurrentCfg() {
  const box = $('#cur-cfg');
  if (!box) return;
  const providers = (state.modelsDoc || {}).providers || {};
  const defModel = state.cfg.defaultModel || '';
  const defProv = defModel.split('/')[0];
  const pv = providers[defProv] || null;
  const keyDesc = !pv ? '供应商未配置' : (pv.apiKey ? (String(pv.apiKey).startsWith('$') ? '环境变量 ' + pv.apiKey : '已保存') : '未配置');
  box.innerHTML = `
    <div class="cur-head">当前使用（新会话默认）</div>
    <div class="cur-main">
      <span class="cur-model">${esc(defModel || '未设置')}</span>
      <span class="cur-url">${esc(pv?.baseUrl || '—')}</span>
      <span class="cur-tag">${esc(pv?.api || '—')}</span>
      <span class="cur-key ${pv?.apiKey ? 'ok' : 'bad'}">Key：${esc(keyDesc)}</span>
    </div>
    <div class="cur-list">
      ${Object.entries(providers).map(([name, p]) => `
        <div class="cur-row${name === defProv ? ' active' : ''}" data-prov="${esc(name)}" title="点击编辑该供应商">
          <span class="cur-dot"></span>
          <span class="cur-name">${esc(name)}</span>
          <span class="cur-url2">${esc(p.baseUrl || '')}</span>
          ${name === defProv
            ? '<span class="cur-use">使用中</span>'
            : `<button class="mini-btn cur-set" data-prov="${esc(name)}" title="把该供应商的测试/首个模型设为新会话默认">设为默认</button>`}
        </div>`).join('')}
    </div>`;
  $$('#cur-cfg .cur-row').forEach((r) => {
    r.onclick = (e) => {
      if (e.target.closest('.cur-set')) return;
      state.editProv = r.dataset.prov;
      $('#prov-select').value = r.dataset.prov;
      renderProvForm();
    };
  });
  $$('#cur-cfg .cur-set').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const name = b.dataset.prov;
      const models = (state.modelsDoc?.providers?.[name] || {}).models || [];
      const test = (state.routingMeta?.providers || []).find((x) => x.name === name)?.testModel;
      const mid = test || (models[0] || {}).id;
      if (!mid) { $('#models-status').textContent = `${name} 还没有可用模型，先获取模型列表`; return; }
      const key = `${name}/${mid}`;
      await api.post('/api/config', { defaultModel: key });
      state.cfg.defaultModel = key;
      state.selModel = key;
      updateModelChip();
      try { rpcTo({ type: 'set_model', provider: name, modelId: mid }); } catch {}
      renderCurrentCfg();
      if (state.editProv === name) renderProvModels(state.modelsDoc.providers[name] || {});
    };
  });
}
function currentProv() { return (state.modelsDoc?.providers || {})[state.editProv] || null; }
function renderProvForm() {
  const p = currentProv() || {};
  $('#pf-url').value = p.baseUrl || '';
  $('#pf-api').value = p.api || 'openai-responses';
  $('#pf-key').value = '';
  $('#pf-key').placeholder = p.apiKey
    ? (p.apiKey.startsWith('$') ? `环境变量 ${p.apiKey}（留空保持）` : '已保存（留空保持不变）')
    : 'sk-…';
  $('#discover-status').textContent = '';
  renderProvModels(p);
}
function renderProvModels(p) {
  const box = $('#pf-models');
  box.innerHTML = '';
  const defModel = state.cfg.defaultModel || '';
  const testModel = (state.routingMeta?.providers || []).find((x) => x.name === state.editProv)?.testModel || '';
  for (const m of p.models || []) {
    const key = `${state.editProv}/${m.id}`;
    const row = document.createElement('div');
    row.className = 'pm-row';
    row.innerHTML = `
      <div class="pm-line1">
        <label class="pm-radio" title="新会话默认使用"><input type="radio" name="pm-default" value="${esc(key)}" ${defModel === key ? 'checked' : ''}>默认</label>
        <label class="pm-radio" title="路由探测用"><input type="radio" name="pm-test" value="${esc(key)}" ${testModel === key ? 'checked' : ''}>测试</label>
        <span class="pm-id" title="${esc(m.id)}">${esc(m.id)}</span>
        <button class="mini-btn pm-test">测试</button>
        <span class="pm-result muted small"></span>
      </div>
      <div class="pm-line2">
        <span class="pm-lbl">上下文</span>
        <input class="pm-ctx" type="number" value="${m.contextWindow || ''}" placeholder="128000">
        <span class="pm-lbl">输出</span>
        <input class="pm-max" type="number" value="${m.maxTokens || ''}" placeholder="4096">
      </div>`;
    row.querySelector('.pm-test').onclick = async () => {
      const btn = row.querySelector('.pm-test'); const out = row.querySelector('.pm-result');
      btn.textContent = '…'; btn.disabled = true; out.textContent = ''; out.className = 'pm-result muted small';
      const r = await api.post('/api/providers/test', { model: key }).catch(() => ({ ok: false, detail: '网络错误' }));
      btn.textContent = '测试'; btn.disabled = false;
      out.textContent = r.ok ? `✓ ${r.ms}ms ${r.reply || ''}`.trim() : `✗ ${r.detail || r.status || '失败'}`;
      out.classList.add(r.ok ? 'pm-ok' : 'pm-bad');
    };
    box.appendChild(row);
  }
  if (!box.children.length) box.innerHTML = '<div class="muted small" style="padding:6px 2px">暂无模型 — 填好地址后点「获取模型列表」自动拉取</div>';
}
$('#prov-select').onchange = (e) => { state.editProv = e.target.value; renderProvForm(); };
// universal provider presets (Claude Code style: any model provider, one click)
const PROVIDER_PRESETS = {
  glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
  xai: { baseUrl: 'https://api.x.ai/v1', api: 'openai-completions' },
  openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages' },
};
$('#pf-preset').onchange = (e) => {
  const p = PROVIDER_PRESETS[e.target.value];
  if (!p) return;
  $('#pf-url').value = p.baseUrl;
  $('#pf-api').value = p.api;
  $('#discover-status').textContent = '已填地址，填入 API Key 后点「获取模型列表」';
};
$('#btn-prov-add').onclick = () => {
  if (!state.modelsDoc) return;
  modalWithInput('添加 Provider', '名称（如 my-relay）', '', async (val) => {
    const name = (val || '').trim().replace(/\s+/g, '-');
    if (!name) return;
    state.modelsDoc.providers = state.modelsDoc.providers || {};
    if (!state.modelsDoc.providers[name]) state.modelsDoc.providers[name] = { baseUrl: '', api: 'openai-responses', models: [] };
    state.editProv = name;
    await api.post('/api/models', state.modelsDoc);
    loadModelsEditor();
  });
};
$('#btn-discover').onclick = async () => {
  if (!state.modelsDoc) return;
  const btn = $('#btn-discover'); const out = $('#discover-status');
  btn.textContent = '获取中…'; btn.disabled = true; out.textContent = '';
  const r = await api.post('/api/providers/discover', {
    provider: state.editProv,
    baseUrl: $('#pf-url').value.trim(),
    apiKey: $('#pf-key').value.trim() || undefined,
  }).catch(() => null);
  btn.textContent = '获取模型列表'; btn.disabled = false;
  if (!r || !r.ok) { out.textContent = (r && (r.detail || `HTTP ${r.status}`)) || '获取失败'; return; }
  const p = state.modelsDoc.providers[state.editProv] = state.modelsDoc.providers[state.editProv] || { baseUrl: '', api: 'openai-responses', models: [] };
  if (!$('#pf-url').value.trim() && p.baseUrl) $('#pf-url').value = p.baseUrl;
  const have = new Set((p.models || []).map((m) => m.id));
  let added = 0;
  for (const id of r.models) if (!have.has(id)) { p.models.push({ id, contextWindow: 128000, maxTokens: 4096 }); added++; }
  out.textContent = `发现 ${r.models.length} 个模型` + (added ? `，新增 ${added}` : '');
  renderProvModels(p);
};
$('#btn-prov-save').onclick = async () => {
  if (!state.modelsDoc || !state.editProv) return;
  const doc = state.modelsDoc;
  const prev = doc.providers[state.editProv] || {};
  const keyInput = $('#pf-key').value.trim();
  const models = $$('#pf-models .pm-row').map((row) => {
    const id = row.querySelector('.pm-id').textContent;
    const ctx = parseInt(row.querySelector('.pm-ctx').value, 10);
    const max = parseInt(row.querySelector('.pm-max').value, 10);
    const prevM = (prev.models || []).find((x) => x.id === id) || {};
    const next = { ...prevM, id };
    delete next.contextWindow; delete next.maxTokens;
    if (Number.isFinite(ctx) && ctx > 0) next.contextWindow = ctx;
    if (Number.isFinite(max) && max > 0) next.maxTokens = max;
    return next;
  });
  const prov = { ...prev, baseUrl: $('#pf-url').value.trim() || prev.baseUrl, api: $('#pf-api').value, models };
  if (keyInput) prov.apiKey = keyInput;
  else if (!prev.apiKey) delete prov.apiKey;
  doc.providers[state.editProv] = prov;
  await api.post('/api/models', doc);
  const def = document.querySelector('input[name="pm-default"]:checked');
  const test = document.querySelector('input[name="pm-test"]:checked');
  if (test) await api.post('/api/routing', { providers: { [state.editProv]: { testModel: test.value } } });
  if (def) { state.cfg.defaultModel = def.value; await api.post('/api/config', { defaultModel: def.value }); state.selModel = def.value; updateModelChip(); }
  $('#models-status').textContent = t('models_saved');
  renderCurrentCfg();
  setTimeout(() => { $('#models-status').textContent = ''; }, 3000);
};
$('#btn-prov-del').onclick = () => {
  if (!state.modelsDoc || !state.editProv) return;
  modal('删除 Provider', `确定删除 ${state.editProv}？（只删本地配置，不影响上游）`, [
    { label: '取消' },
    { label: '删除', primary: true, cb: async () => {
      delete state.modelsDoc.providers[state.editProv];
      await api.post('/api/models', state.modelsDoc);
      state.editProv = null;
      loadModelsEditor();
    } },
  ]);
};
$('#btn-advanced').onclick = () => {
  const ed = $('#models-editor'); const adv = $('#advanced-actions'); const form = $('#prov-form');
  const showing = !ed.classList.contains('hidden');
  if (showing) {
    ed.classList.add('hidden'); adv.classList.add('hidden'); form.classList.remove('hidden');
    loadModelsEditor();
  } else {
    ed.value = JSON.stringify(state.modelsDoc, null, 2);
    ed.classList.remove('hidden'); adv.classList.remove('hidden'); form.classList.add('hidden');
  }
};
$('#btn-models-save').onclick = async () => {
  try {
    const obj = JSON.parse($('#models-editor').value);
    await api.post('/api/models', obj);
    $('#models-status').classList.remove('hidden');
    $('#models-status').textContent = t('models_saved');
  } catch (e) { $('#models-status').classList.remove('hidden'); $('#models-status').textContent = 'JSON error: ' + e.message; }
};

// ---------- usage panel (omp-stats inspired) ----------
function fmtTok(n) { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function statCard(k, v) { return `<div class="ucard"><div class="u-k">${k}</div><div class="u-v">${v}</div></div>`; }
async function loadUsage() {
  const box = $('#usage-box');
  box.innerHTML = `<div class="muted small" style="padding:20px 8px">${t('loading')}</div>`;
  const u = await api.get('/api/usage').catch(() => null);
  if (!u) { box.innerHTML = '<div class="muted small" style="padding:20px 8px">加载失败</div>'; return; }
  const hit = Math.round((u.cacheHit || 0) * 100);
  const days = Object.entries(u.days || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14);
  const maxIn = Math.max(1, ...days.map(([, v]) => v.input));
  const today = u.days?.[localToday()] || null;
  const todayRow = (providers) => {
    if (!providers || !Object.keys(providers).length) return '<tr><td colspan="6" class="muted">今日暂无用量</td></tr>';
    return Object.entries(providers).map(([p, v]) => {
      const r = cacheRate(v.input, v.cacheRead);
      return `<tr><td>${esc(p)}</td><td>${v.ok}</td><td>${fmtTok(v.input)}</td><td>${fmtTok(v.output)}</td><td>${r === null ? '—' : r + '%'}</td><td>$${(v.cost || 0).toFixed(4)}</td></tr>`;
    }).join('');
  };
  let todayHead = '';
  if (today) {
    const tot = (today.input || 0) + (today.output || 0) + (today.cacheRead || 0);
    const r = cacheRate(today.input, today.cacheRead);
    todayHead = `<div class="usage-sec">${t('u_today')}</div>
      <div class="today-total"><b>${fmtTok(tot)}</b> tokens · ${today.ok || 0} ${t('u_replies')} · ${t('u_hit')} ${r === null ? '—' : r + '%'} · $${(today.cost || 0).toFixed(4)}</div>`;
  }
  box.innerHTML = `
    <div class="usage-cards">
      ${statCard(t('u_sessions'), u.sessions || 0)}
      ${statCard(t('u_replies'), u.ok || 0)}
      ${statCard(t('u_errors'), u.err || 0)}
      ${statCard(t('u_in'), fmtTok(u.input))}
      ${statCard(t('u_out'), fmtTok(u.output))}
      ${statCard(t('u_hit'), hit + '%')}
      ${statCard(t('u_cost'), '$' + (u.cost || 0).toFixed(2))}
      ${statCard(t('u_cw'), fmtTok(u.cacheWrite))}
      ${statCard(t('u_cr'), fmtTok(u.cacheRead))}
    </div>
    ${todayHead}
    <div class="usage-sec">${t('u_by_prov')}</div>
    <table class="usage-table"><thead><tr><th>${t('u_provider')}</th><th>${t('u_replies')}</th><th>${t('u_in')}</th><th>${t('u_out')}</th><th>${t('u_hit')}</th><th>${t('u_cost')}</th></tr></thead>
    <tbody>${todayRow(today?.providers)}</tbody></table>
    <div class="usage-sec">${t('u_days')}</div>
    <div class="usage-bars">${days.map(([d, v]) =>
      `<div class="ubar" title="${d} · ${t('u_in')} ${fmtTok(v.input)} · ${t('u_out')} ${fmtTok(v.output)} · ${v.ok} ${t('u_replies')}"><i style="height:${Math.max(3, Math.round((v.input / maxIn) * 64))}px"></i><span>${d.slice(5)}</span></div>`).join('') || '<span class="muted small">暂无数据</span>'}</div>
    <div class="usage-sec">${t('u_by_model')}</div>
    <table class="usage-table"><thead><tr><th>模型</th><th>${t('u_replies')}</th><th>${t('u_in')}</th><th>${t('u_out')}</th><th>${t('u_hit')}</th><th>${t('u_cost')}</th></tr></thead>
    <tbody>${Object.entries(u.models || {}).map(([m, v]) => {
      const r = cacheRate(v.input, v.cacheRead);
      return `<tr><td>${esc(m)}</td><td>${v.ok}</td><td>${fmtTok(v.input)}</td><td>${fmtTok(v.output)}</td><td>${r === null ? '—' : r + '%'}</td><td>$${(v.cost || 0).toFixed(4)}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>'}</tbody></table>`;
}

// ---------- routing panel ----------
async function loadRoutingUI() {
  const r = await api.get('/api/routing').catch(() => null);
  if (!r) { $('#routing-providers').innerHTML = '<div class="muted small">加载失败</div>'; return; }
  const box = $('#routing-providers');
  box.innerHTML = '';
  for (const pr of r.providers || []) {
    const row = document.createElement('div');
    row.className = 'route-row';
    row.dataset.name = pr.name;
    row.dataset.enabled = pr.enabled ? '1' : '0';
    const cooled = pr.cooldown && pr.cooldown.remainMs > 0;
    row.innerHTML = `<div class="rr-main"><div class="rr-name">${esc(pr.name)}</div>
      <div class="rr-sub">${pr.keyCount} key · P${pr.priority}${cooled ? ` · <span class="cooled">冷却中 ${Math.ceil(pr.cooldown.remainMs / 60000)} 分</span>` : ''}</div></div>`;
    const seg = document.createElement('div');
    seg.className = 'seg rr-seg';
    const on = document.createElement('button'); on.textContent = t('on');
    const off = document.createElement('button'); off.textContent = t('off');
    (pr.enabled ? on : off).classList.add('active');
    // toggles persist immediately — no separate save step
    const setEnabled = (val) => {
      on.classList.toggle('active', val);
      off.classList.toggle('active', !val);
      api.post('/api/routing', { providers: { [pr.name]: { enabled: val } } }).catch(() => {});
    };
    on.onclick = () => setEnabled(true);
    off.onclick = () => setEnabled(false);
    const probe = document.createElement('button');
    probe.className = 'mini-btn'; probe.textContent = t('probe');
    probe.onclick = async () => {
      probe.textContent = '…'; probe.disabled = true;
      const m = (state.modelsAvailable || []).find((x) => x.provider === pr.name);
      const res = m ? await api.post('/api/routing/probe', { model: `${pr.name}/${m.id}` }).catch(() => ({ ok: false })) : { ok: false, detail: '模型列表中无该 provider' };
      probe.textContent = res.ok ? `✓ ${res.ms}ms` : '✗';
      if (!res.ok && res.detail) $('#routing-status').textContent = res.detail;
      probe.disabled = false;
      setTimeout(() => { probe.textContent = t('probe'); }, 5000);
    };
    seg.append(on, off);
    row.append(seg, probe);
    box.appendChild(row);
  }
  if (!box.children.length) box.innerHTML = '<div class="muted small">models.json 中暂无 provider</div>';
  $('#routing-chains').value = JSON.stringify(r.chains || [], null, 1);
}
$('#btn-routing-save').onclick = async () => {
  try {
    const chains = JSON.parse($('#routing-chains').value || '[]');
    await api.post('/api/routing', { chains });
    $('#routing-status').textContent = '回退链已保存';
    setTimeout(() => { $('#routing-status').textContent = ''; }, 3000);
  } catch (e) { $('#routing-status').textContent = 'JSON 错误：' + e.message; }
};

// ---------- session tree view (omp /tree inspired) ----------
$('#btn-tree').onclick = async () => {
  const f = state.sessionFile;
  if (!f) { $('#statusline').textContent = '当前没有已保存的会话文件'; return; }
  const r = await api.get('/api/session/tree?path=' + encodeURIComponent(f)).catch(() => null);
  if (!r || r.error) { $('#statusline').textContent = (r && r.error) || '读取会话树失败'; return; }
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of r.nodes) if (n.parentId) kids.set(n.parentId, (kids.get(n.parentId) || []).concat(n.id));
  const roleLabel = { user: '你', assistant: 'pi', toolResult: '工具' };
  let html = '';
  const walk = (id, depth) => {
    const n = byId.get(id);
    if (!n) return;
    const active = r.activePath.includes(n.id);
    const branch = (kids.get(id) || []).length > 1;
    if (n.type === 'message' || n.type === 'model_change' || n.type === 'thinking_level_change') {
      const who = n.role ? (roleLabel[n.role] || n.role) : n.type === 'model_change' ? '模型' : '思考级';
      html += `<div class="tnode ${active ? 'active' : ''}" style="margin-left:${Math.min(depth, 12) * 14}px">
        <span class="tn-role">${esc(who)}</span><span class="tn-prev">${esc(n.preview || '')}</span>
        ${n.model ? `<span class="tn-meta">${esc(n.model)}</span>` : ''}
        ${n.stop === 'error' ? '<span class="tn-meta" style="color:var(--err)">error</span>' : ''}
        ${branch ? '<span class="tn-branch">分叉</span>' : ''}</div>`;
    }
    for (const c of kids.get(id) || []) walk(c, depth + 1);
  };
  for (const n of r.nodes) if (!n.parentId) walk(n.id, 0);
  modal(`会话分支树 · ${r.count} 节点 · ${r.branches} 处分叉`, '', [{ label: '关闭', primary: true }]);
  $('#modal-body').innerHTML = `<div class="tree-view">${html || '<span class="muted small">空会话</span>'}</div>`;
};

// ---------- health / kernel / env pages (Hermes 高级 section) ----------
async function loadHealth() {
  const box = $('#health-box');
  box.innerHTML = '<div class="muted small" style="padding:10px">' + t('loading') + '</div>';
  const routing = await api.get('/api/routing').catch(() => null);
  const kernel = await api.get('/api/kernel').catch(() => null);
  const rows = [];
  const push = (name, state, text) => rows.push({ name, state, text });
  push('本地服务', 'ok', '127.0.0.1:' + (kernel ? kernel.port : 32123) + ' · 已响应');
  if (kernel) push('Node 运行时', 'ok', kernel.node + ' · ' + kernel.platform);
  if (kernel) push('pi 内核', kernel.pi ? 'ok' : 'warn', kernel.pi ? 'v' + kernel.pi : '未检测到 pi 包');
  push('WS 连接', state.wsReady ? 'ok' : 'err', state.wsReady ? '已连接' : '未连接');
  push('中转密钥', kernel && kernel.secrets && kernel.secrets.relay ? 'ok' : 'warn', kernel && kernel.secrets.relay ? '已按配置读取（仅内存）' : '未配置');
  const dm = (state.cfg.defaultModel) || '未设置';
  push('默认模型', state.cfg.defaultModel ? 'ok' : 'warn', dm);
  for (const pr of (routing && routing.providers) || []) {
    if (pr.enabled === false) { push('供应商 ' + pr.name, 'warn', '已停用'); continue; }
    const m = (state.modelsAvailable || []).find((x) => x.provider === pr.name);
    if (!m) { push('供应商 ' + pr.name, 'warn', '模型列表未加载'); continue; }
    const r = await api.post('/api/routing/probe', { model: pr.name + '/' + m.id }).catch(() => ({ ok: false, detail: '探测失败' }));
    push('供应商 ' + pr.name, r.ok ? 'ok' : 'err', r.ok ? ('通 ' + r.ms + 'ms · ' + (r.models ?? '?') + ' 模型') : (r.detail || ('HTTP ' + (r.status || '?'))));
  }
  const nOk = rows.filter((r) => r.state === 'ok').length;
  const nWarn = rows.filter((r) => r.state === 'warn').length;
  const nErr = rows.filter((r) => r.state === 'err').length;
  const cls = { ok: 'ok', warn: 'warn', err: 'err' };
  box.innerHTML = '<div class="usage-cards">' +
    statCard('正常项', nOk) + statCard('注意项', nWarn) + statCard('异常项', nErr) +
    '</div><div class="usage-sec">检查明细（' + rows.length + ' 项）</div>' +
    rows.map((r) => '<div class="health-row"><span class="h-dot ' + (cls[r.state] || '') + '"></span><span class="h-name">' + esc(r.name) + '</span><span class="h-text">' + esc(r.text) + '</span></div>').join('') +
    '<div class="muted small" style="padding:8px 4px">刷新节奏：每次进入本页重新探测；真实额度与连通性以模型页探测结果为准。</div>';
}
async function loadKernel() {
  const k = await api.get('/api/kernel').catch(() => null);
  const box = $('#kernel-box');
  if (!k) { box.innerHTML = '<div class="muted small">加载失败</div>'; return; }
  const row = (kk, v) => '<div class="health-row"><span class="h-name">' + esc(kk) + '</span><span class="h-text">' + esc(v) + '</span></div>';
  box.innerHTML = '<div class="usage-sec">运行时</div><div class="health-row"><span class="h-name">Node</span><span class="h-text">' + esc(k.node) + ' · ' + esc(k.platform) + '</span></div>' +
    row('pi 内核', k.pi ? 'v' + k.pi : '未知') +
    row('网关端口', k.port) +
    row('已运行', Math.floor(k.uptimeSec / 60) + ' 分 ' + (k.uptimeSec % 60) + ' 秒') +
    row('可执行文件', k.execPath) +
    '<div class="usage-sec">路径</div>' +
    row('config.json', k.paths.config) +
    row('routing.json', k.paths.routing) +
    row('models.json', k.paths.models) +
    row('会话目录', k.paths.sessions) +
    '<div class="usage-sec">启动命令</div><div class="health-row"><span class="h-text" style="white-space:normal;word-break:break-all">"' + esc(k.execPath) + '" "' + esc(k.paths.server) + '"</span></div>';
}
async function loadEnv() {
  const e = await api.get('/api/env').catch(() => null);
  const box = $('#env-box');
  if (!e) { box.innerHTML = '<div class="muted small">加载失败</div>'; return; }
  const rows = [];
  rows.push(['平台', e.platform, 'ok']);
  rows.push(['Node', e.node, 'ok']);
  rows.push(['Git', e.git || '未检测到（影响 Git 面板）', e.git ? 'ok' : 'warn']);
  rows.push(['中转密钥', e.secrets && e.secrets.relay ? '已加载（内存）' : '未配置', e.secrets && e.secrets.relay ? 'ok' : 'warn']);
  for (const p of e.providers) rows.push(['供应商 ' + p, '已配置', 'ok']);
  box.innerHTML = '<div class="usage-sec">核心环境</div>' +
    rows.map(([k, v, st]) => '<div class="health-row"><span class="h-dot ' + st + '"></span><span class="h-name">' + esc(k) + '</span><span class="h-text">' + esc(v) + '</span></div>').join('') +
    '<div class="muted small" style="padding:8px 4px">可选能力缺失不影响启动，仅影响对应功能。</div>';
}

// ---------- settings ----------
function applyThemeBtns() {
  $$('[data-theme-set]').forEach((b) => b.classList.toggle('active', b.dataset.themeSet === state.cfg.theme));
  $$('[data-lang-set]').forEach((b) => b.classList.toggle('active', b.dataset.langSet === state.cfg.lang));
}
$$('[data-theme-set]').forEach((b) => b.onclick = async () => {
  state.cfg.theme = b.dataset.themeSet;
  applyI18n(); applyThemeBtns();
  await api.post('/api/config', { theme: state.cfg.theme });
});
$$('[data-lang-set]').forEach((b) => b.onclick = async () => {
  state.cfg.lang = b.dataset.langSet;
  applyI18n(); applyThemeBtns();
  $('#think-chip').textContent = `${t('think')} · ${({ off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '特高', max: '最大' })[state.thinkLevel || 'medium']}`;
  await api.post('/api/config', { lang: state.cfg.lang });
  // re-render language-sensitive dynamic panels
  const active = document.querySelector('.rail-item.active')?.dataset.panel;
  if (active === 'usage') loadUsage();
  if (active === 'health') loadHealth();
  if (active === 'routing') loadRoutingUI();
  if (active === 'sessions') loadSessions();
  if (active === 'import') loadImportList();
  if (state.streaming === false && !document.querySelector('#timeline .msg')) clearTimeline(true);
});

// ---------- views & rails (Hermes-style shell) ----------
function setView(view) {
  state.view = view;
  $$('.tn-view').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-workbench').classList.toggle('hidden', view !== 'workbench');
  $('#view-config').classList.toggle('hidden', view !== 'config');
  $('#view-advanced').classList.toggle('hidden', view !== 'advanced');
  $('#rail-workbench').classList.toggle('hidden', view !== 'workbench');
  $('#rail-config').classList.toggle('hidden', view !== 'config');
  $('#rail-advanced').classList.toggle('hidden', view !== 'advanced');
  if (view !== 'workbench') {
    const activeItem = document.querySelector('#rail-' + view + ' .rail-item.active');
    if (activeItem) activeItem.click();
  }
  if (view === 'workbench') renderHomeHero();
}
$$('.tn-view').forEach((b) => { b.onclick = () => setView(b.dataset.view); });

async function loadSkills() {
  const cwd = state.project?.path || '';
  const r = await api.get('/api/skills' + (cwd ? ('?cwd=' + encodeURIComponent(cwd)) : '')).catch(() => ({ skills: [] }));
  const list = $('#skills-list');
  const detail = $('#skills-detail');
  const skills = r.skills || [];
  if (!skills.length) {
    list.innerHTML = '<div class="muted small" style="padding:12px">还没有发现技能。把 SKILL.md 放到 ~/.pi/agent/skills 或 ~/.agents/skills。</div>';
    detail.innerHTML = '';
    return;
  }
  const srcLabel = { pi: '全局 pi', agents: '全局 agents', 'project-pi': '项目 .pi', 'project-agents': '项目 .agents' };
  list.innerHTML = skills.map((s, i) => `<div class="skill-row${i === 0 ? ' active' : ''}" data-i="${i}">
    <input type="checkbox" class="switch" data-name="${esc(s.name)}" ${s.enabled ? 'checked' : ''}>
    <div style="min-width:0;flex:1">
      <div class="s-name">${esc(s.name)}</div>
      <div class="s-preview">${esc(s.description || '')}</div>
      <div class="s-src">${esc(srcLabel[s.source] || s.source)}</div>
    </div>
  </div>`).join('');
  const show = (i) => {
    const s = skills[i];
    if (!s) return;
    $$('#skills-list .skill-row').forEach((el) => el.classList.toggle('active', el.dataset.i === String(i)));
    detail.innerHTML = `<div class="s-name" style="font-size:16px;font-weight:600;margin-bottom:6px">${esc(s.name)}</div>
      <div class="muted small" style="margin-bottom:10px">${esc(s.path)}</div>
      <pre style="white-space:pre-wrap;font:12.5px/1.6 var(--mono)">${esc(s.body || '')}</pre>`;
  };
  $$('#skills-list .skill-row').forEach((el) => { el.onclick = (e) => { if (e.target.classList.contains('switch')) return; show(Number(el.dataset.i)); }; });
  $$('#skills-list .switch').forEach((sw) => {
    sw.onclick = async (e) => {
      e.stopPropagation();
      await api.post('/api/skills', { name: sw.dataset.name, enabled: sw.checked });
    };
  });
  show(0);
}
async function loadBackup() {
  $('#backup-status').textContent = '';
}
async function loadMigration() {
  $('#migrate-box').innerHTML = '<div class="muted small" style="padding:8px 0">点「检查来源」扫描本机 Codex / Claude / ZCode / 模型文件。</div>';
}
async function loadConsole() {
  const cwd = state.project?.path || '';
  $('#term-cwd').textContent = '工作目录 ' + (cwd || '（还没选项目，默认用户目录）');
  if (!$('#term-out').dataset.ready) {
    $('#term-out').textContent = '就绪。输入命令后回车。\n';
    $('#term-out').dataset.ready = '1';
  }
}

const PANEL_LOADERS = {
  models: loadModelsEditor,
  routing: loadRoutingUI,
  import: loadImportList,
  skills: loadSkills,
  console: loadConsole,
  backup: loadBackup,
  migration: loadMigration,
  health: loadHealth,
  usage: loadUsage,
  logs: renderLogPage,
  kernel: loadKernel,
  env: loadEnv,
  settings: loadSecStatus,
};
$$('.rail-item[data-panel]').forEach((b) => {
  b.onclick = () => {
    $$('.rail-item[data-panel]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $$('#view-config .cfg-panel, #view-advanced .cfg-panel').forEach((p) => p.classList.add('hidden'));
    const panel = $('#panel-' + b.dataset.panel);
    if (!panel) return;
    panel.classList.remove('hidden');
    (PANEL_LOADERS[b.dataset.panel] || (() => {}))();
  };
});
$('#btn-backup-export').onclick = async () => {
  $('#backup-status').textContent = '正在打包…';
  const r = await api.post('/api/backup/export', {}).catch((e) => ({ error: e.message }));
  if (r.error) { $('#backup-status').textContent = '失败：' + r.error; return; }
  $('#backup-status').textContent = `已导出 ${r.path}（${Math.round((r.size || 0) / 1024)} KB）`;
};
$('#btn-backup-import').onclick = () => {
  modalWithInput('导入备份', '本地 zip 完整路径', '', async (val) => {
    if (!val) return;
    $('#backup-status').textContent = '正在导入…';
    const r = await api.post('/api/backup/import', { path: val.trim() }).catch((e) => ({ error: e.message }));
    if (r.error) { $('#backup-status').textContent = '失败：' + r.error; return; }
    $('#backup-status').textContent = `已恢复 ${ (r.restored || []).join('、') }；覆盖前副本在 ${r.backup}`;
  });
};
$('#btn-migrate-scan').onclick = async () => {
  const r = await api.get('/api/migrate/scan').catch(() => ({ sources: [] }));
  const steps = ['1. 检查来源', '2. 给出迁移建议', '3. 你确认后再改', '4. 导入页验证会话'];
  $('#migrate-box').innerHTML = (r.sources || []).map((s) =>
    `<div class="step-card"><b>${esc(s.name)}</b><span class="muted small">${s.found ? '发现 · ' : '未发现 · '}${esc(s.detail)}</span></div>`
  ).join('') + `<div class="usage-sec">迁移怎么进行</div>` + steps.map((x) => `<div class="step-card">${esc(x)}</div>`).join('') +
    '<div class="muted small" style="padding:8px 0">具体会话导入仍走「导入」页，不会在这一页静默覆盖。</div>';
};
$('#btn-term-external').onclick = async () => {
  await api.post('/api/term/open', { cwd: state.project?.path || '' });
};
$('#term-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('#term-cmd').value.trim();
  if (!cmd) return;
  $('#term-cmd').value = '';
  const out = $('#term-out');
  out.textContent += '\n$ ' + cmd + '\n';
  const r = await api.post('/api/term/exec', { cwd: state.project?.path || '', cmd }).catch((err) => ({ err: err.message, out: '' }));
  out.textContent += (r.out || '') + (r.err || '');
  out.scrollTop = 1e9;
});

// global search (Ctrl K): filters sessions, Enter opens first hit
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    setView('workbench');
    $('#global-search').focus();
  }
});
$('#global-search').addEventListener('input', () => {
  setView('workbench');
  renderProjectTree(true).then(filterSessionList);
});
$('#global-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = [...document.querySelectorAll('#project-tree .conv-item')].find((el) => el.style.display !== 'none');
  if (first) {
    first.click();
    e.target.value = '';
    filterSessionList();
  }
});

// workbench home hero (time-aware greeting + counters)
function renderHomeHero() {
  const hasChat = document.querySelectorAll('#timeline .msg').length > 0;
  $('#home-hero').classList.toggle('hidden', hasChat);
  if (hasChat) return;
  const h = new Date().getHours();
  const greet = h < 6 ? '夜深了，休息一下？' : h < 11 ? '早上好，准备开工' : h < 13 ? '中午好，歇一歇' : h < 18 ? '下午好，继续推进' : '晚上好，今天收尾如何';
  $('#hero-greet').textContent = greet;
  const d = new Date();
  $('#hero-date').textContent = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' · 周' + '日一二三四五六'[d.getDay()];
  const g = currentGoal();
  $('#hero-counts').textContent = (state.streaming ? 1 : 0) + ' 个任务进行中 · ' + (g && g.text ? '目标进行中' : '未设目标');
}

async function loadSecStatus() {
  const k = await api.get('/api/kernel').catch(() => null);
  const ok = !!(k && k.secrets && k.secrets.relay);
  $('#sec150').textContent = ok ? t('sec_ok') : t('sec_no');
}

// ---------- boot ----------
(async function boot() {
  marked.setOptions({ breaks: true, gfm: true });
  await loadProjects();
  wsConnect();
  clearTimeline(true);
  initSuggestions();
  if (state.cfg.defaultModel) { state.selModel = state.cfg.defaultModel; updateModelChip(); }
  api.get('/api/models/available').then((r) => {
    state.modelsAvailable = r.models || [];
    updateModelChip();
  }).catch(() => {});
  $('#think-chip').textContent = '思考 · 中';
  applyI18n();
  loadTodayStats();
  renderGoalBanner();
  renderHomeHero();
  api.get('/api/kernel').then((k) => {
    $('#sb-kernel').textContent = `内核 pi ${k.pi || '?'} · node ${k.node}`;
  }).catch(() => {});
  window.__wb = { get state() { return state; }, rpcTo, updateModelChip };
})();
})();
