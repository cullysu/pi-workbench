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
  const items = typeof buildItems === 'function' ? buildItems() : buildItems;
  for (const it of items) {
    if (it.header) {
      const h = document.createElement('div');
      h.className = 'dd-header';
      h.textContent = it.header;
      menu.appendChild(h);
      continue;
    }
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'dd-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'dd-item';
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
    menu.appendChild(row);
  }
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
        __wb.rpcTo({ type: 'set_model', provider: m.provider, modelId: m.id });
      },
    });
  }
  openDropdown(document.querySelector('#model-chip'), items);
};

// thinking chip → thinking levels only
document.querySelector('#think-chip').onclick = () => {
  const levels = { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '特高', max: '最大' };
  openDropdown(document.querySelector('#think-chip'), () =>
    Object.entries(levels).map(([lv, zh]) => ({
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
