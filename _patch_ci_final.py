# Remaining v1.1.1 CI pieces (EOL-aware this time): AppImage smoke + mac build job.
import io

def load(p):
    s = io.open(p, encoding='utf-8', newline='').read()
    return s, ('\r\n' if '\r\n' in s else '\n')

def rep(s, eol, old, new, n=1, tag=''):
    old = old.replace('\n', eol); new = new.replace('\n', eol)
    c = s.count(old)
    assert c == n, '%s: expected %d found %d' % (tag, n, c)
    return s.replace(old, new, n)

p = '.github/workflows/ci.yml'
s, e = load(p)

rep(s, e,
  "      - name: Build Linux AppImage\n        run: npx electron-builder --linux AppImage --x64 --publish never\n",
  "      - name: Build Linux AppImage\n"
  "        run: npx electron-builder --linux AppImage --x64 --publish never\n"
  "      - name: Smoke test AppImage structure\n"
  "        run: |\n"
  "          f=(dist_electron/*.AppImage)\n"
  "          chmod +x \"${f[0]}\"\n"
  "          \"${f[0]}\" --appimage-extract > /dev/null\n"
  "          test -x squashfs-root/AppRun\n"
  "          echo 'AppImage structure verified (AppRun executable)'\n",
  1, 'smoke')

anchor = "          name: linux-appimage\n          path: dist_electron/*.AppImage\n          retention-days: 7"
assert s.count(anchor.replace('\n', eol)) == 1
mac_job = ("          name: linux-appimage\n          path: dist_electron/*.AppImage\n          retention-days: 7\n"
  + "\n"
  + "  build-mac:\n"
  + "    if: github.ref == 'refs/heads/main' && github.event_name == 'push'\n"
  + "    runs-on: macos-latest\n"
  + "    needs: test\n"
  + "    steps:\n"
  + "      - uses: actions/checkout@v4\n"
  + "      - uses: actions/setup-node@v4\n"
  + "        with:\n"
  + "          node-version: 22\n"
  + "      - name: Install build deps\n"
  + "        run: |\n"
  + "          npm ci\n"
  + "          node node_modules/electron/install.js\n"
  + "      - name: Assemble runtime (pi + server + public)\n"
  + "        run: |\n"
  + "          npm install --prefix pkg-build @earendil-works/pi-coding-agent@0.85.0 ws@8.21.3 --omit=dev --no-fund --no-audit\n"
  + "          cp server.mjs zip.mjs electron-main.cjs pkg-build/\n"
  + "          cp -r extensions pkg-build/extensions\n"
  + "          mkdir -p pkg-build/public\n"
  + "          cp -r public/. pkg-build/public/\n"
  + "          node scripts/make-runtime.mjs\n"
  + "      - name: Build macOS dmg\n"
  + "        run: npx electron-builder --mac dmg --publish never\n"
  + "        env:\n"
  + "          CSC_IDENTITY_AUTO_DISCOVERY: 'false'\n"
  + "      - uses: actions/upload-artifact@v4\n"
  + "        with:\n"
  + "          name: mac-dmg\n"
  + "          path: dist_electron/*.dmg\n"
  + "          retention-days: 7")
s = s.replace(anchor.replace('\n', eol), mac_job.replace('\n', eol), 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('smoke + mac job OK')
