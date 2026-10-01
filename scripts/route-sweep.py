# Final acceptance sweep: hit every API route with a sane payload, record status.
# PASS = expected status. Any 500 / unexpected 404 / auth fail = FAIL.
# Deliberately skipped (with reasons): /api/cron/run-now (spawns a real pi child that
# would outlive the probe), /api/term/open (opens a visible cmd window on the desktop).
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = 39999
BASE = f'http://127.0.0.1:{PORT}'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

home = tempfile.mkdtemp(prefix='piwb-sweep-')
proj = tempfile.mkdtemp(prefix='piwb-sweepproj-')
with open(os.path.join(proj, 'calc.py'), 'w', encoding='utf-8') as f:
    f.write('print(1/0)\n')

# seed a pi session file + codex session for tree/import-read
sess_dir = os.path.join(home, '.pi', 'agent', 'sessions', 'sweep-proj')
os.makedirs(sess_dir, exist_ok=True)
pi_session = os.path.join(sess_dir, 'sweep-session.jsonl')
with open(pi_session, 'w', encoding='utf-8') as f:
    f.write(json.dumps({'type': 'session', cwd: proj} if False else {'type': 'session', 'cwd': proj}) + '\n')
    f.write(json.dumps({'id': 'n1', 'type': 'message', 'timestamp': '2026-09-29T00:00:00Z', 'message': {'role': 'user', 'content': '你好'}}) + '\n')

codex_dir = os.path.join(home, '.codex', 'sessions', '2026', '09', '29')
os.makedirs(codex_dir, exist_ok=True)
codex_session = os.path.join(codex_dir, 'rollout-sweep.jsonl')
with open(codex_session, 'w', encoding='utf-8') as f:
    f.write(json.dumps({'timestamp': '2026-09-29T00:00:00Z', 'type': 'session_meta', 'payload': {'id': 'sweep', 'cwd': proj}}) + '\n')
    f.write(json.dumps({'timestamp': '2026-09-29T00:00:01Z', 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '扫一下'}]}}) + '\n')

env = dict(os.environ, PIWB_PORT=str(PORT), HOME=home, USERPROFILE=home)
# node discovery: env override > PATH (works on CI linux runners) > the usual
# Windows install dir (works from a bare Windows shell where PATH may not carry node)
NODE = os.environ.get('NODE_BIN') or shutil.which('node') or r'C:\Program Files\nodejs\node.exe'
server = subprocess.Popen([NODE, 'server.mjs'], env=env,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

results = []
def call(name, method, path, body=None, want=None, timeout=35):
    headers = {'Content-Type': 'application/json'}
    if TOKEN:
        headers['x-api-token'] = TOKEN
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    t0 = time.time()
    try:
        r = opener.open(req, timeout=timeout)
        code, payload = r.status, r.read()[:200000]
    except urllib.error.HTTPError as err:
        code, payload = err.code, err.read()[:200000]
    ms = int((time.time() - t0) * 1000)
    want_disp = want if want is not None else '2xx/4xx-val'
    ok = (code == want) if want is not None else (200 <= code < 500)
    results.append((name, method, path, code, want_disp, ms, ok, str(payload[:120])))
    return code, payload

TOKEN = None
try:
    for _ in range(60):
        time.sleep(0.25)
        try:
            page = opener.open(BASE + '/', timeout=2).read().decode()
            m = re.search(r'__API_TOKEN = "([0-9a-f]+)"', page)
            if m:
                TOKEN = m.group(1)
                break
        except Exception:
            pass
    assert TOKEN, 'server did not start'

    call('账本', 'GET', '/api/ledger?days=30', want=200)
    call('配置读', 'GET', '/api/config', want=200)
    call('配置写', 'POST', '/api/config', {'theme': 'dark'}, want=200)
    call('项目添加', 'POST', '/api/projects/add', {'path': proj}, want=200)
    call('会话列表(pi)', 'GET', '/api/sessions/pi', want=200)
    call('会话树', 'GET', '/api/session/tree?path=' + urllib.parse.quote(pi_session), want=200)
    call('会话删除(校验)', 'POST', '/api/sessions/delete', {'path': os.path.join(home, 'outside.jsonl')}, want=400)
    call('模型读', 'GET', '/api/models', want=200)
    call('模型写', 'POST', '/api/models', {'providers': {}}, want=200)
    call('模型枚举', 'GET', '/api/models/available', want=200)
    call('供应商发现', 'POST', '/api/providers/discover', {'baseUrl': 'https://example.com'}, want=200)
    call('知识库填充(校验)', 'POST', '/api/providers/kbfill', {'provider': 'nope'}, want=400)
    call('回复测试(校验)', 'POST', '/api/providers/test', {}, want=400)
    call('路由读', 'GET', '/api/routing', want=200)
    call('路由写', 'POST', '/api/routing', {'chains': [['x/y']]}, want=200)
    call('路由探测', 'POST', '/api/routing/probe', {'model': 'x/y'}, want=200)
    call('路由失败上报', 'POST', '/api/routing/fail', {'model': 'x/y', 'error': 'boom'}, want=200)
    call('路由恢复', 'POST', '/api/routing/ok', {'model': 'x/y'}, want=200)
    call('定时列表', 'GET', '/api/cron', want=200)
    call('定时写入', 'POST', '/api/cron', {'jobs': [{'id': 'job-sweep', 'name': 'sweep', 'kind': 'daily', 'time': '03:00', 'prompt': 'ping', 'enabled': False}]}, want=200)
    call('定时日志列表', 'POST', '/api/cron/logs', {'id': 'job-sweep'}, want=200)
    call('定时末次日志', 'POST', '/api/cron/lastlog', {'id': 'job-sweep'}, want=200)
    call('定时删除', 'POST', '/api/cron/delete', {'id': 'job-sweep'}, want=200)
    call('更新检查', 'GET', '/api/update/check', want=200)
    call('会话导出', 'GET', '/api/session/export?path=' + urllib.parse.quote(pi_session), want=200)
    call('用量汇总', 'GET', '/api/usage', want=200)
    call('文件列表', 'GET', '/api/files/list?root=' + urllib.parse.quote(proj), want=200)
    call('文件读取', 'GET', '/api/files/read?root=' + urllib.parse.quote(proj) + '&path=calc.py', want=200)
    call('内核信息', 'GET', '/api/kernel', want=200)
    call('环境探测', 'GET', '/api/env', want=200)
    call('导入列表(codex)', 'GET', '/api/import/codex', want=200)
    code, payload = call('导入回读(codex)', 'GET', '/api/import/codex/read?path=' + urllib.parse.quote(codex_session), want=200)
    call('导入列表(aider)', 'GET', '/api/import/aider', want=200)
    call('git状态', 'GET', '/api/git/status?cwd=' + urllib.parse.quote(proj), want=200)
    call('git差异', 'GET', '/api/git/diff?cwd=' + urllib.parse.quote(proj), want=200)
    call('git工作树', 'GET', '/api/git/worktrees?cwd=' + urllib.parse.quote(proj), want=200)
    call('技能列表', 'GET', '/api/skills', want=200)
    call('模板列表', 'GET', '/api/templates', want=200)
    call('MCP配置读', 'GET', '/api/mcp/config', want=200)
    call('MCP配置写', 'POST', '/api/mcp/config', {'mcpServers': {}}, want=200)
    seed = os.path.join(home, '.pi', 'agent', 'extensions', 'mcp-bridge', 'node_modules', 'typebox')
    os.makedirs(seed, exist_ok=True)  # pre-seed so install never spawns background npm
    call('MCP安装', 'POST', '/api/mcp/install', {}, want=200)
    code, payload = call('备份导出', 'POST', '/api/backup/export', {}, want=200)
    zip_path = json.loads(payload).get('path')
    call('备份导入', 'POST', '/api/backup/import', {'path': zip_path}, want=200)
    call('迁移扫描', 'GET', '/api/migrate/scan', want=200)
    call('终端执行', 'POST', '/api/term/exec', {'cwd': proj, 'cmd': 'echo sweep-ok'}, want=200)
    call('静态首页', 'GET', '/', want=200)
    call('未知路由', 'GET', '/api/definitely-missing', want=404)

    fails = [r for r in results if not r[6]]
    print('=' * 30)
    print(f'SWEEP: {len(results)} routes, {len(fails)} failures')
    slow = sorted(results, key=lambda r: -r[5])[:3]
    for name, method, path, code, want, ms, ok, _ in results:
        mark = 'PASS' if ok else 'FAIL'
        print(f'{mark} {code:>3} ({ms:>5}ms) {method:<4} {name}')
    if fails:
        for name, method, path, code, want, ms, ok, payload in fails:
            print('FAIL DETAIL:', name, code, payload)
        raise SystemExit(1)
finally:
    try: server.kill()
    except Exception: pass
    time.sleep(0.5)
