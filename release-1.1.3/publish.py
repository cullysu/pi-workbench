# Create release v1.1.3 and upload the five installers + SBOM.
# Usage: python publish.py  (expects zips in D:/下载/pi-workbench-v1.1.3-installers)
import json, os, subprocess, time, zipfile, urllib.request, urllib.parse

TOKEN = subprocess.check_output(['git', 'credential', 'fill'], input=b'protocol=https\nhost=github.com\n', stderr=subprocess.DEVNULL).decode().split('password=')[1].split('\n')[0]
OUT = r"D:/下载/pi-workbench-v1.1.3-installers"
NOTES = r"C:/Users/cully/Documents/pi-workbench/release-1.1.3/notes-zh.md"
REPO = "cullysu/pi-workbench"

class StripAuthRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        h = {k: v for k, v in req.headers.items() if k.lower() != "authorization"}
        return urllib.request.Request(newurl, headers=h, method=req.get_method())

opener = urllib.request.build_opener(StripAuthRedirect)
def gh(url, data=None, headers=None, method=None):
    h = {"Authorization": f"token {TOKEN}", "user-agent": "pi-workbench"}
    if headers: h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    return opener.open(req, timeout=120)

# 1. create the release
body = open(NOTES, encoding='utf-8').read()
payload = json.dumps({"tag_name": "v1.1.3", "target_commitish": "main", "name": "v1.1.3 — 安全与完整性强化版", "body": body, "draft": False, "prerelease": False}).encode()
try:
    rel = json.load(gh(f"https://api.github.com/repos/{REPO}/releases", data=payload, headers={"content-type": "application/json"}, method="POST"))
    print("release created:", rel["id"], rel["html_url"])
except urllib.error.HTTPError as e:
    if e.code == 422:  # already exists
        rel = json.load(gh(f"https://api.github.com/repos/{REPO}/releases/tags/v1.1.3"))
        print("release exists:", rel["id"])
    else:
        raise

# 2. extract installer files from artifact zips and upload
def extract_from(artifact_zip, suffixes):
    dest_dir = os.path.join(OUT, "unpacked")
    os.makedirs(dest_dir, exist_ok=True)
    found = []
    with zipfile.ZipFile(artifact_zip) as z:
        for n in z.namelist():
            if n.endswith(suffixes):
                target = os.path.join(dest_dir, os.path.basename(n))
                with z.open(n) as src, open(target, "wb") as f:
                    f.write(src.read())
                found.append(target)
    return found

uploads = []
uploads += extract_from(os.path.join(OUT, "installer.zip"), (".exe",))
uploads += extract_from(os.path.join(OUT, "tauri-installer.zip"), (".exe",))
uploads += extract_from(os.path.join(OUT, "linux-appimage.zip"), (".AppImage",))
uploads += extract_from(os.path.join(OUT, "mac-dmg.zip"), (".dmg",))
uploads += extract_from(os.path.join(OUT, "sbom.zip"), (".json",))
# release-asset naming convention (v1.1.2 style) — spaces and shell-unfriendly names out
RENAMES = {
    "Pi Workbench_1.1.3_x64-setup.exe": "PiWorkbench-1.1.3-Tauri-x64-setup.exe",
    "Pi Workbench-1.1.3-arm64.dmg": "PiWorkbench-1.1.3-macOS-arm64.dmg",
    "Pi Workbench-1.1.3.dmg": "PiWorkbench-1.1.3-macOS-x64.dmg",
}
renamed = []
for u in uploads:
    base = os.path.basename(u)
    target = os.path.join(os.path.dirname(u), RENAMES.get(base, base))
    if os.path.exists(u) and target != u:
        os.replace(u, target)
    renamed.append(target)
uploads = renamed
for u in uploads: print("extracted:", u, os.path.getsize(u), flush=True)

existing = {a["name"] for a in json.load(gh(f"https://api.github.com/repos/{REPO}/releases/{rel['id']}/assets"))}
for path in uploads:
    name = os.path.basename(path)
    if name in existing:
        print("asset exists, skip:", name); continue
    size = os.path.getsize(path)
    body = open(path, "rb").read()  # explicit length: urllib would chunk a file object and GitHub 400s it
    up = gh(f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets?name={urllib.parse.quote(name)}",
            data=body, headers={"content-type": "application/octet-stream", "content-length": str(size)}, method="POST")
    del body
    print("uploaded:", name, size, flush=True)
print("RELEASE-COMPLETE", rel["html_url"])
