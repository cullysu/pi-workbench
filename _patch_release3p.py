# v1.1.1 three-platform release prep: mac dmg target, AppImage smoke test, version bump.
import io

def load(p):
    s = io.open(p, encoding='utf-8', newline='').read()
    return s, ('\r\n' if '\r\n' in s else '\n')

def rep(s, eol, old, new, n=1, tag=''):
    old = old.replace('\n', eol); new = new.replace('\n', eol)
    c = s.count(old)
    assert c == n, '%s: expected %d found %d' % (tag, n, c)
    return s.replace(old, new, n)

# 1. electron-builder.yml: mac dmg target with the tauri icns icon
p = 'electron-builder.yml'
s, e = load(p)
s = rep(s, e,
  "linux:\n  target:\n    - AppImage\n  category: Development\n  icon: tauri/icons/icon.png",
  "mac:\n  target:\n    - dmg\n  category: Development\n  icon: tauri/icons/icon.icns\nlinux:\n  target:\n    - AppImage\n  category: Development\n  icon: tauri/icons/icon.png",
  1, 'mac-target')
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('electron-builder mac target OK')

# 2. versions -> 1.1.1
for p in ['package.json', 'tauri/tauri.conf.json']:
    s, e = load(p)
    s = rep(s, e, '"version": "1.1.0",', '"version": "1.1.1",', 1, p)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print(p, '-> 1.1.1')

# 3. ci.yml: AppImage structural smoke test + mac dmg build job
p = '.github/workflows/ci.yml'
s, e = load(p)

old = ("      - name: Build Linux AppImage\n"
       "        run: npx electron-builder --linux AppImage --x64 --publish never\n")
assert s.count(old) == 1
new = ("      - name: Build Linux AppImage\n"
       "        run: npx electron-builder --linux AppImage --x64 --publish never\n"
       "      - name: Smoke test AppImage structure\n"
       "        run: |\n"
       "          f=(dist_electron/*.AppImage)\n"
       "          chmod +x \"${f[0]}\"\n"
       "          \"${f[0]}\" --appimage-extract > /dev/null\n"
       "          test -x squashfs-root/AppRun\n"
       "          echo 'AppImage structure verified (AppRun executable)'\n")
s = s.replace(old, new, 1)
print('AppImage smoke step OK')

anchor = eol + '          name: linux-appimage' + eol + '          path: dist_electron/*.AppImage' + eol + '          retention-days: 7'
assert s.count(anchor) == 1
mac_job = (anchor + eol + eol
  + '  build-mac:' + eol
  + "    if: github.ref == 'refs/heads/main' && github.event_name == 'push'" + eol
  + '    runs-on: macos-latest' + eol
  + '    needs: test' + eol
  + '    steps:' + eol
  + '      - uses: actions/checkout@v4' + eol
  + '      - uses: actions/setup-node@v4' + eol
  + '        with:' + eol
  + '          node-version: 22' + eol
  + '      - name: Install build deps' + eol
  + '        run: |' + eol
  + '          npm ci' + eol
  + '          node node_modules/electron/install.js' + eol
  + '      - name: Assemble runtime (pi + server + public)' + eol
  + '        run: |' + eol
  + '          npm install --prefix pkg-build @earendil-works/pi-coding-agent@0.85.0 ws@8.21.3 --omit=dev --no-fund --no-audit' + eol
  + '          cp server.mjs zip.mjs electron-main.cjs pkg-build/' + eol
  + '          cp -r extensions pkg-build/extensions' + eol
  + '          mkdir -p pkg-build/public' + eol
  + '          cp -r public/. pkg-build/public/' + eol
  + '          node scripts/make-runtime.mjs' + eol
  + '      - name: Build macOS dmg' + eol
  + '        run: npx electron-builder --mac dmg --publish never' + eol
  + '        env:' + eol
  + "          CSC_IDENTITY_AUTO_DISCOVERY: 'false'" + eol
  + '      - uses: actions/upload-artifact@v4' + eol
  + '        with:' + eol
  + '          name: mac-dmg' + eol
  + '          path: dist_electron/*.dmg' + eol
  + '          retention-days: 7')
s = s.replace(anchor, mac_job, 1)
print('mac build job OK')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
