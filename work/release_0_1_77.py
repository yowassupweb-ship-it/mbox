"""Release MBOX Desktop 0.1.77 + сервер: архив изменений от последнего выкаченного коммита, установщик по SFTP,
сборка образа app. Доступы читаются из .env.local (как в прежних deploy_*.py). Запуск: python work/release_0_1_77.py [база-на-случай-если-на-сервере-нет-.deployed-commit]"""

from pathlib import Path
import hashlib
import posixpath
import re
import shlex
import subprocess
import sys
import time

import paramiko

ROOT = Path(__file__).resolve().parent.parent
BASE = sys.argv[1] if len(sys.argv) > 1 else "84b494b"  # запасная база: origin/main = 0.1.75, его бандл уже отдаёт прод; основная — /opt/mbox/.deployed-commit
VERSION = "0.1.77"
REMOTE = "/opt/mbox"
DOWNLOADS = ROOT / "public" / "downloads"
INSTALLER = DOWNLOADS / f"mbox-desktop-setup-{VERSION}.exe"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


head = git("rev-parse", "HEAD").decode().strip()
short = head[:7]
if git("status", "--porcelain", "--untracked-files=no").strip():
    raise SystemExit("Есть незакоммиченные изменения: выкатывается только закоммиченное")
if not INSTALLER.exists():
    raise SystemExit(f"Нет установщика {INSTALLER}")

index_html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
bundle = re.search(r"assets/(index-[A-Za-z0-9_-]+\.js)", index_html).group(1)

cfg = {}
for line in (ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
    if line.strip() and not line.lstrip().startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        cfg[key.strip()] = value.strip().strip('"').strip("'")


def run(client, command, timeout=1800, check=True):
    print(">", command, flush=True)
    _, stdout, _ = client.exec_command(command, timeout=timeout)
    stdout.channel.set_combine_stderr(True)
    output = stdout.read().decode("utf-8", "replace")
    if output.strip():
        print(output[-4000:].strip(), flush=True)
    code = stdout.channel.recv_exit_status()
    if code and check:
        raise RuntimeError(f"Remote exit {code}: {command}")
    return output


client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(cfg["MBOX_SSH_HOST"], username=cfg["MBOX_SSH_USER"], password=cfg["MBOX_SSH_PASSWORD"], look_for_keys=False, allow_agent=False, timeout=30)
try:
    deployed = run(client, "cat /opt/mbox/.deployed-commit 2>/dev/null || true", check=False).strip()
    if deployed and subprocess.run(["git", "cat-file", "-e", f"{deployed}^{{commit}}"], cwd=ROOT, capture_output=True).returncode == 0:
        BASE = deployed
    print(f"BASE (выкаченный коммит) = {BASE}", flush=True)
    changed = [name.decode("utf-8") for name in git("diff", "--name-only", "-z", "--diff-filter=ACMRT", BASE, head).split(b"\0") if name]
    changed = [name for name in changed if not (name.startswith("public/downloads/") and name.endswith((".exe", ".zip")))]
    entries = [entry.decode("utf-8") for entry in git("diff", "--name-status", "-z", "-M", BASE, head).split(b"\0") if entry]
    stale = []
    index = 0
    while index < len(entries):
        status = entries[index]
        index += 1
        source = entries[index]
        index += 1
        if status.startswith(("R", "C")):
            index += 1
        if status.startswith(("D", "R")):
            stale.append(source)
    archive = ROOT / "work" / f"mbox-deploy-{short}.tar.gz"
    subprocess.run(["git", "-c", "core.autocrlf=false", "archive", "--format=tar.gz", f"--output={archive}", head, *changed], cwd=ROOT, check=True)
    print(f"HEAD={head} archive={archive.stat().st_size} bytes files={len(changed)} remove={len(stale)}", flush=True)

    run(client, "df -h / | tail -1")
    run(client, "df -h / | tail -1")

    local_hash = hashlib.sha512(INSTALLER.read_bytes()).hexdigest()
    remote_installer = posixpath.join(REMOTE, "public/downloads", INSTALLER.name)
    existing = run(client, f"sha512sum {remote_installer} 2>/dev/null || true").split()
    sftp = client.open_sftp()
    try:
        remote_archive = f"/tmp/mbox-deploy-{short}.tar.gz"
        print("> upload archive", archive.stat().st_size, flush=True)
        sftp.put(str(archive), remote_archive)
        if not existing or existing[0] != local_hash:
            print("> upload installer", INSTALLER.stat().st_size, flush=True)
            sftp.put(str(INSTALLER), remote_installer)
    finally:
        sftp.close()
    remote_hash = run(client, f"sha512sum {remote_installer}").split()[0]
    if remote_hash != local_hash:
        raise RuntimeError("Хеш установщика на сервере не совпал")

    run(client, f"cd {REMOTE} && tar -xzf {remote_archive} && rm -f {remote_archive}")
    for file in stale:
        if not re.fullmatch(r"[A-Za-z0-9_./ -]+", file) or ".." in file.split("/"):
            raise RuntimeError(f"Небезопасный путь: {file}")
    if stale:
        run(client, "rm -f -- " + " ".join(shlex.quote(posixpath.join(REMOTE, file)) for file in stale))

    run(client, f"cd {REMOTE} && docker compose -f docker-compose.production.yml build app")
    run(client, f"cd {REMOTE} && docker compose -f docker-compose.production.yml up -d app")

    for attempt in range(15):
        try:
            run(client, f"curl -fsS https://mbox.shar-os.ru/ | grep -F '{bundle}'", timeout=30)
            break
        except RuntimeError:
            if attempt == 14:
                run(client, "docker logs --tail 60 mbox-ui", check=False)
                raise
            time.sleep(4)
    run(client, f"curl -fsS https://mbox.shar-os.ru/downloads/latest.yml | grep -F 'version: {VERSION}'")
    run(client, f"curl -fsSI https://mbox.shar-os.ru/downloads/{INSTALLER.name} | head -4")
    run(client, "docker logs --tail 25 mbox-ui 2>&1 | grep -i -E 'migrat|error|listening' || true", check=False)
    run(client, f"printf '%s\\n' {head} > {REMOTE}/.deployed-commit")
    run(client, "df -h / | tail -1")
    print("DEPLOY OK", head, flush=True)
finally:
    client.close()
