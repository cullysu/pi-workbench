# Remove the pretend EN switch (i18n was a facade — EN left most of the UI Chinese),
# guard esc() against non-strings, fix README shell description to both channels.
import io

def load(p):
    s = io.open(p, encoding='utf-8', newline='').read()
    return s, ('\r\n' if '\r\n' in s else '\n')

def rep(s, eol, old, new, n=1, tag=''):
    old = old.replace('\n', eol); new = new.replace('\n', eol)
    c = s.count(old)
    assert c == n, '%s: expected %d found %d' % (tag, n, c)
    return s.replace(old, new, n)

# 1. index.html: drop the language segment entirely (UI is Chinese; a switch that
#    leaves 90% of the page Chinese is a broken promise, not a feature)
p = 'public/index.html'
s, e = load(p)
seg = ('            <label>语言</label>\n'
       '            <div class="seg">\n'
       '              <button data-lang-set="zh">中文</button>\n'
       '              <button data-lang-set="en">EN</button>\n'
       '            </div>\n')
c = s.count(seg.replace('\n', eol))
if c == 1:
    s = rep(s, e, seg, '', 1, 'lang-seg')
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('index.html: language switcher removed')
else:
    print('index.html: language switcher already gone (%d)' % c)

# 2. app.js: remove the lang handlers, dead i18n attr plumbing, keep t() zh strings
p = 'public/app.js'
s, e = load(p)
s = rep(s, e,
  "  $$('[data-lang-set]').forEach((b) => b.classList.toggle('active', b.dataset.langSet === state.cfg.lang));\n",
  '', 1, 'lang-active')
old_lang_handler = s[s.index("$$('[data-lang-set]').forEach((b) => b.onclick = async () => {"):]
end = old_lang_handler.index(eol + '});' + eol)
old_lang_handler = old_lang_handler[:end + len(eol + '});' + eol)]
assert 'lang' in old_lang_handler and 'data-lang-set' in old_lang_handler
s = s.replace(old_lang_handler, '', 1)
# applyI18n: the data-i18n attribute plumbing has zero targets in index.html — keep only the theme side-effect
s = rep(s, e,
  "function applyI18n() {\n  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });\n  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });\n  document.body.classList.toggle('dark', state.cfg.theme === 'dark');\n}",
  "function applyI18n() {\n  // t() serves the Chinese strings inline; a real i18n pass would hang strings off\n  // data-i18n attributes — none exist yet, so this only keeps the theme in sync\n  document.body.classList.toggle('dark', state.cfg.theme === 'dark');\n}", 1, 'applyi18n')
# esc() must not explode on a non-string from server data
s = rep(s, e,
  "const esc = (s) => s.replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));",
  "const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));", 1, 'esc')
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('app.js: lang handlers removed, esc guarded, applyI18n honest')

# 3. READMEs: describe BOTH shipped shells (Tauri 1.0.0 shipped 2026-09-16 and is the
#    lightweight channel; Electron is the actively-developed one — neither is residue)
p = 'README.md'
s, e = load(p)
s = rep(s, e,
  'Windows 桌面应用（Electron 壳 + WebView2，安装包见 Releases），中文界面。',
  'Windows 桌面应用，双壳通道（Tauri 轻量壳 ≈10MB / Electron 完整壳），中文界面。', 1, 'readme-zh')
io.open(p, 'w', encoding='utf-8', newline='').write(s)
p = 'README.en.md'
s, e = load(p)
s = rep(s, e,
  'Windows desktop app (Electron shell + WebView2, NSIS installer), Chinese UI.',
  'Windows desktop app with two packaged shells (Tauri ~10MB lightweight, Electron full), Chinese UI.', 1, 'readme-en')
s = rep(s, e,
  'npm run dist           # Electron NSIS installer (artifact in dist_electron/)',
  'npx tauri build        # Tauri NSIS installer (from tauri/, ~10MB)\nnpm run dist           # Electron NSIS installer (artifact in dist_electron/)', 1, 'readme-en-build')
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('READMEs: both shells described')
