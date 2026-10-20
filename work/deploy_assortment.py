"""Deploy "Ассортимент" (#518): changed files of HEAD against the commit marked on the server, rebuild app, verify, roll back on failure.

Safety nets:
  * the server files that this release overwrites must match the previously deployed commit (otherwise prod diverged: stop);
  * the running image is tagged mbox-app:pre-assortment before the build; any failed check puts it back;
  * health checks: site answers, the new API answers JSON, the new bundle is served, no schema error in the log.
Credentials come from .env.local (MBOX_SSH_HOST / MBOX_SSH_USER / MBOX_SSH_PASSWORD), as in the other work/deploy_*.py.
"""

from pathlib import Path
import hashlib
import subprocess
import sys
import time

import paramiko

ROOT = Path(__file__).resolve().parent.parent
REMOTE = "/opt/mbox"
COMPOSE = f"cd {REMOTE} && docker compose -f docker-compose.production.yml"

head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
cfg = {}
for line in (ROOT / ".env.local").read_text(encoding="utf-8").splitlines():
    if line.strip() and not line.lstrip().startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        cfg[key.strip()] = value.strip().strip('"').strip("'")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(cfg["MBOX_SSH_HOST"], username=cfg["MBOX_SSH_USER"], password=cfg["MBOX_SSH_PASSWORD"], look_for_keys=False, allow_agent=False, timeout=30)


def run(command, timeout=1800, check=True, show=True):
    if show:
        print(">", command[:200], flush=True)
    _, stdout, _ = client.exec_command(command, timeout=timeout)
    stdout.channel.set_combine_stderr(True)
    output = stdout.read().decode("utf-8", "replace")
    if show and output.strip():
        print(output[-3000:].strip(), flush=True)
    code = stdout.channel.recv_exit_status()
    if check and code:
        raise RuntimeError(f"Remote exit {code}: {command[:120]}")
    return output.strip() if code == 0 else output.strip() + f"\n[exit {code}]"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def rollback(reason):
    print(f"\n!!! ROLLBACK: {reason}", flush=True)
    run("docker tag mbox-app:pre-assortment mbox-app:latest", check=False)
    run(f"{COMPOSE} up -d --no-build app", check=False)
    time.sleep(8)
    run("curl -fsS -o /dev/null -w 'site after rollback: %{http_code}\\n' https://mbox.shar-os.ru/", check=False)
    raise SystemExit(f"Deploy rolled back: {reason}")


try:
    base = run(f"cat {REMOTE}/.deployed-commit").split()[0]
    # History of main was rewritten on 2026-10-19, so the deployed commit is not an ancestor of HEAD: compare trees instead.
    fork = git("merge-base", head, "main")
    drift = git("diff", "--name-only", base, fork, "--", ".", ":(exclude)public").splitlines()
    if drift:
        raise SystemExit(f"Deployed {base[:7]} differs from main {fork[:7]} outside public/: {drift[:10]}")
    print(f"deployed {base[:7]} has the same source tree as main {fork[:7]}", flush=True)
    changed = [x for x in git("diff", "--name-only", "--diff-filter=AM", base, head).splitlines() if x]
    removed = [x for x in git("diff", "--name-only", "--diff-filter=D", base, head).splitlines() if x]
    print(f"base {base[:7]} -> {head[:7]}: {len(changed)} changed, {len(removed)} removed", flush=True)

    # 1. the files this release overwrites must equal the previously deployed versions
    tracked = [x for x in changed if x in set(git("ls-tree", "-r", "--name-only", base).splitlines()) and not x.startswith("public/")]
    mismatches = []
    for path in tracked:
        expected = hashlib.sha256(subprocess.check_output(["git", "show", f"{base}:{path}"], cwd=ROOT).replace(b"\r\n", b"\n")).hexdigest()
        actual = run(f"tr -d '\\r' < {REMOTE}/{path} | sha256sum | cut -d' ' -f1", check=False, show=False).split()[0]
        if actual != expected:
            mismatches.append(path)
    if mismatches:
        raise SystemExit(f"Prod diverged from {base[:7]} in: {mismatches}. Nothing changed.")
    print(f"prod matches {base[:7]} for the {len(tracked)} tracked files to be overwritten", flush=True)

    run("df -h / | tail -1")
    archive = ROOT / f"work/mbox-deploy-{head[:7]}.tar.gz"
    subprocess.check_call(["git", "archive", "--format=tar.gz", "-o", str(archive), head, *changed], cwd=ROOT)
    remote_archive = f"/tmp/mbox-deploy-{head[:7]}.tar.gz"
    sftp = client.open_sftp()
    try:
        sftp.put(str(archive), remote_archive)
    finally:
        sftp.close()

    # 2. keep the running image for rollback, then apply files
    run("docker tag $(docker inspect mbox-ui --format '{{.Image}}') mbox-app:pre-assortment")
    run(f"cd {REMOTE} && tar -xzf {remote_archive} && rm -f {remote_archive}")
    stale = [x for x in removed if x.startswith("public/assets/")]
    for path in stale:
        run(f"rm -f {REMOTE}/{path}", show=False)
    print(f"removed {len(stale)} stale bundles", flush=True)

    # 3. build and restart
    run(f"{COMPOSE} build app")
    run(f"{COMPOSE} up -d app")

    # 4. checks
    ok = False
    for _ in range(20):
        out = run("curl -s -o /dev/null -w '%{http_code}' https://mbox.shar-os.ru/", check=False, show=False)
        if out.startswith("200"):
            ok = True
            break
        time.sleep(4)
    if not ok:
        rollback("site does not answer 200 after restart")
    probe = run("curl -s -w ' [%{http_code}]' https://mbox.shar-os.ru/api/share/assortment/AAAAAAAAAAAAAAAAAAAAAAAAAAAA/me", check=False)
    if "link_revoked" not in probe or "[404]" not in probe:
        rollback(f"new assortment API did not answer as expected: {probe[:200]}")
    bundle = run("docker exec mbox-ui sh -c 'ls /app/public/assets | grep -c SharedAssortmentPage'", check=False)
    if not bundle.startswith("1"):
        rollback(f"public bundle missing: {bundle}")
    log = run("docker logs --since 3m mbox-ui 2>&1 | tail -40", check=False)
    if "assortment schema" in log or "Error:" in log and "assortment" in log:
        rollback("assortment error in the server log")
    if "MBOX listening" not in log:
        rollback("no 'MBOX listening' line in the log")
    run(f"printf '%s\\n' {head} > {REMOTE}/.deployed-commit")
    run("df -h / | tail -1")
    print("DEPLOY OK", head, flush=True)
finally:
    client.close()
