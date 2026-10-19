# Create release v1.2.4 and upload the five installers + SBOM + SHA256SUMS.txt.
# Usage: python publish.py  (expects zips in D:/下载/pi-workbench-v1.2.4-installers)
import json, os, subprocess, time, zipfile, urllib.request, urllib.parse, hashlib

TOKEN = subprocess.check_output(['git', 'credential', 'fill'], input=b'protocol=https\nhost=github.com\n', stderr=subprocess.DEVNULL).decode().split('password=')[1].split('\n')[0]
OUT = r"D:/下载/pi-workbench-v1.2.4-installers"
NOTES = r"C:/Users/cully/Documents/pi-workbench/release-1.2.4/notes-zh.md"
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
    return opener.open(req, timeout=300)

body = open(NOTES, encoding='utf-8').read()
payload = json.dumps({"tag_name": "v1.2.4", "target_commitish": "main", "name": "v1.2.4 — 发布链与进程树治理", "body": body, "draft": False, "prerelease": False}).encode()
try:
    rel = json.load(gh(f"https://api.github.com/repos/{REPO}/releases", data=payload, headers={"content-type": "application/json"}, method="POST"))
    print("release created:", rel["id"], rel["html_url"], flush=True)
except urllib.error.HTTPError as e:
    if e.code == 422:
        rel = json.load(gh(f"https://api.github.com/repos/{REPO}/releases/tags/v1.2.4"))
        print("release exists:", rel["id"], flush=True)
    else:
        raise

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
RENAMES = {
    "Pi Workbench_1.2.4_x64-setup.exe": "PiWorkbench-1.2.4-Tauri-x64-setup.exe",
    "Pi Workbench-1.2.4-arm64.dmg": "PiWorkbench-1.2.4-macOS-arm64.dmg",
    "Pi Workbench-1.2.4.dmg": "PiWorkbench-1.2.4-macOS-x64.dmg",
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
        print("asset exists, skip:", name, flush=True); continue
    size = os.path.getsize(path)
    with open(path, "rb") as f: data = f.read()
    up = gh(f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets?name={urllib.parse.quote(name)}",
            data=data, headers={"content-type": "application/octet-stream", "content-length": str(size)}, method="POST")
    del data
    print("uploaded:", name, size, flush=True)

# checksums manifest: hash the extracted payload files in a stable order —
# this is what lets a downloader verify what they got without trusting this page
sums = []
for u in sorted(uploads, key=lambda p: os.path.basename(p)):
    h = hashlib.sha256()
    with open(u, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    sums.append(f"{h.hexdigest()}  {os.path.basename(u)}")
sums_path = os.path.join(OUT, "SHA256SUMS.txt")
with open(sums_path, "w", newline="\n") as f:
    f.write("\n".join(sums) + "\n")
print(sums_path + ":\n" + "\n".join(sums), flush=True)
if "SHA256SUMS.txt" not in existing:
    gh(f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets?name=SHA256SUMS.txt",
       data=open(sums_path, "rb").read(), headers={"content-type": "text/plain; charset=utf-8", "content-length": str(os.path.getsize(sums_path))}, method="POST")
    print("uploaded: SHA256SUMS.txt", flush=True)
print("RELEASE-COMPLETE", rel["html_url"])
