import paramiko, json, uuid, sys

results_file = sys.argv[1]
with open(results_file, encoding='utf-8') as f:
    items = json.load(f)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('195.133.88.112', username='root', password='Traplord999!', timeout=20)
sftp = client.open_sftp()

tag = 'd' + uuid.uuid4().hex[:12]
rows = []
for it in items:
    rows.append({
        'id': it['id'],
        # НЕ json.dumps здесь — это вложенный объект в общем payload, а не отдельная строка.
        # Раньше двойная сериализация клала digest как строку JSON внутри jsonb, а не объект
        # (digest->>'rubric' возвращал NULL, реально читалось только через ещё один json.loads).
        'digest': {'rubric': it['rubric'], 'notes': it['notes']},
        'extra_tags': it['tags'],
    })
payload = json.dumps(rows, ensure_ascii=False)
open_tag = '$' + tag + '$'
sql = (
    "UPDATE memories m SET\n"
    "  metadata = m.metadata || jsonb_build_object('digested', true, 'digest', v.digest::jsonb),\n"
    "  tags = (SELECT array_agg(DISTINCT x) FROM unnest(m.tags || v.extra_tags) AS x),\n"
    "  updated_at = now()\n"
    "FROM jsonb_to_recordset(" + open_tag + payload + open_tag + "::jsonb) AS v(id bigint, digest json, extra_tags text[])\n"
    "WHERE m.id = v.id;\n"
)
remote_path = '/tmp/push_digest.sql'
with sftp.open(remote_path, 'w') as rf:
    rf.write(sql)
sftp.close()
cmd = f"docker exec -e PGPASSWORD='mbox_CZWOqGkOGJttaqA0fdqgnNF6Az7L022c' -i mbox-postgres psql -U mbox -d mbox < {remote_path}"
stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
with open('scripts/push_digest_log.txt', 'w', encoding='utf-8') as f:
    f.write(out + '\n---ERR---\n' + err)
client.close()
print('done, log written')
