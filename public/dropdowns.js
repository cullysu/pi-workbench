/* Codex-style dropdown menus (model / thinking) — composer anchors open upward */

function friendlyModel(id) {
  let m = (id || '').split('/').pop() || id;
  if (m.startsWith('gpt-')) m = m.slice(4);
  return m
    .split('-')
    .map((t) => (t.length > 2 ? t[0].toUpperCase() + t.slice(1) : t))
    .join(' ');
}

function openDropdown(anchor, buildItems) {
  document.querySelectorAll('.wb-dropdown').forEach((d) => d.remove());
  const menu = document.createElement('div');
  menu.className = 'wb-dropdown';
  // P3-13 (v1.3.9 review): these menus were mouse-only — plain divs with an onclick and no
  // role, focus target, or key handling, so a keyboard user could open a menu and then be
  // stuck in it (Escape did nothing, Tab walked into the page behind it). role=menu plus
  // roving focus is the minimum the WAI-ARIA authoring practice asks for.
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  const items = typeof buildItems === 'function' ? buildItems() : buildItems;
  const rows = [];
  for (const it of items) {
    if (it.header) {
      const h = document.createElement('div');
      h.className = 'dd-header';
      h.setAttribute('role', 'presentation');
      h.textContent = it.header;
      menu.appendChild(h);
      continue;
    }
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'dd-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'dd-item';
    row.setAttribute('role', 'menuitem');
    row.tabIndex = -1;
    row.setAttribute('aria-checked', it.checked ? 'true' : 'false');
    const check = document.createElement('span');
    check.className = 'dd-check';
    check.textContent = it.checked ? '✓' : '';
    const label = document.createElement('span');
    label.textContent = it.label;
    row.append(check, label);
    row.onclick = () => {
      menu.remove();
      if (it.cb) it.cb();
    };
    rows.push(row);
    menu.appendChild(row);
  }
  const focusRow = (i) => {
    if (!rows.length) return;
    const n = ((i % rows.length) + rows.length) % rows.length;
    rows[n].focus();
  };
  menu.addEventListener('keydown', (e) => {
    const at = rows.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menu.remove(); if (anchor && anchor.focus) anchor.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(at + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(at < 0 ? rows.length - 1 : at - 1); return; }
    if (e.key === 'Home') { e.preventDefault(); focusRow(0); return; }
    if (e.key === 'End') { e.preventDefault(); focusRow(rows.length - 1); return; }
    if ((e.key === 'Enter' || e.key === ' ') && at >= 0) { e.preventDefault(); rows[at].click(); }
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  // composer sits at the bottom — flip upward when there is no room below
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8) {
    const up = r.top - menu.offsetHeight - 6;
    top = up > 8 ? up : Math.max(8, window.innerHeight - menu.offsetHeight - 8);
  }
  menu.style.top = top + 'px';
  // focus lands on the current selection (or the first row) so the arrow keys have an origin
  focusRow(Math.max(0, rows.findIndex((r) => r.getAttribute('aria-checked') === 'true')));
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    });
  }, 0);
  return menu;
}

// model chip → only models from the provider currently in use.
// switching provider config happens in 配置→模型（设为默认）; failover also lands here.
document.querySelector('#model-chip').onclick = () => {
  const st = __wb.state;
  const curProv = (st.selModel || st.cfg?.defaultModel || '').split('/')[0]
    || (st.modelsAvailable[0] || {}).provider || '';
  const mine = st.modelsAvailable.filter((m) => m.provider === curProv).slice(0, 200);
  const items = [{ header: `模型 · ${curProv || '未选择配置'}` }];
  if (!mine.length) {
    items.push({ label: '该配置没有已获取的模型 — 到 配置 → 模型 获取', cb: () => {} });
  }
  for (const m of mine) {
    const key = `${m.provider}/${m.id}`;
    items.push({
      label: friendlyModel(m.id),
      checked: key === st.selModel,
      cb: () => {
        st.selModel = key;
        __wb.updateModelChip();
        // F41 (v1.3.5 audit): the chip is optimistic — remember what we asked for and
        // what was ACKED before, so a FAILED set_model reverts instead of leaving a lie
        st.pendingSetModel = { model: key, prev: st.lastAckedModel || null };
        __wb.rpcTo({ type: 'set_model', provider: m.provider, modelId: m.id });
        __wb.rpcTo({ type: 'get_available_thinking_levels' }); // the new model may support different levels
      },
    });
  }
  openDropdown(document.querySelector('#model-chip'), items);
};

// thinking chip → thinking levels only
document.querySelector('#think-chip').onclick = () => {
  const levels = { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '特高', max: '最大' };
  // a model that advertises its levels gets only those offered — xhigh/max exist on some models only
  const avail = Array.isArray(__wb.state.availableLevels) ? __wb.state.availableLevels.map(String) : null;
  if (__wb.state.tabId) __wb.rpcTo({ type: 'get_available_thinking_levels' }); // refresh for the next open
  openDropdown(document.querySelector('#think-chip'), () =>
    Object.entries(levels)
      .filter(([lv]) => !avail || avail.includes(lv))
      .map(([lv, zh]) => ({
        label: zh,
        checked: lv === (__wb.state.thinkLevel || 'medium'),
        cb: () => {
          __wb.state.thinkLevel = lv;
          document.querySelector('#think-chip').textContent = `思考 · ${zh}`;
          __wb.rpcTo({ type: 'set_thinking_level', level: lv });
        },
      }))
  );
};

(function ddStyles() {
  const st = document.createElement('style');
  st.textContent = [
    '.wb-dropdown { position: fixed; z-index: 200; background: var(--card); border: 1px solid var(--card-border);',
    '  border-radius: 14px; box-shadow: var(--shadow); padding: 6px; min-width: 220px; max-height: 55vh; overflow-y: auto; }',
    '.dd-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px;',
    '  font-size: 13px; color: var(--text); cursor: pointer; }',
    '.dd-item:hover { background: var(--hover); }',
    '.dd-check { width: 16px; color: var(--text); font-weight: 600; }',
    '.dd-header { font-size: 11px; font-weight: 600; color: var(--text3); padding: 6px 12px 3px; letter-spacing: 0.4px; }',
    '.dd-sep { height: 1px; background: var(--hairline); margin: 5px 8px; }',
  ].join('\n');
  document.head.appendChild(st);
})();
