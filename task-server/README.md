# ClaudeMC Task Server

Kleiner REST-Service der Shell-Scripte als Hintergrund-Jobs ausführt und Output via SSE streamt. Wird vom ClaudeMC-Client per VPN angesprochen.

## API

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET`    | `/health`        | Liveness — keine Auth |
| `POST`   | `/jobs`          | Job anlegen + sofort starten. Body: `{ script, env?, name? }` |
| `GET`    | `/jobs`          | Letzte 100 Jobs |
| `GET`    | `/jobs/:id`      | Job-Status |
| `GET`    | `/jobs/:id/log`  | SSE-Stream: Backlog + Live-Output, `event: end` zum Schluss |
| `DELETE` | `/jobs/:id`      | Job killen (SIGTERM, nach 3s SIGKILL) |

Alle Endpoints außer `/health` brauchen Header `Authorization: Bearer $API_KEY`.

## Deploy via Docker

```bash
# Build (auf dem VPS oder per Registry)
docker build -t claudemc-task-server:latest .

# Run — bindet nur ans WireGuard-Interface (10.0.0.x)
docker run -d --restart unless-stopped \
  --name claudemc-task-server \
  -p 10.0.0.2:4243:4243 \
  -v claudemc-task-data:/data \
  -e API_KEY="$(openssl rand -hex 32)" \
  claudemc-task-server:latest

# Token notieren — wird im ClaudeMC-Vault gespeichert
docker logs claudemc-task-server
```

`-p 10.0.0.2:4243:4243` heißt: nur auf der WG-IP lauschen. Auf Public-IPs (eth0) ist der Port unsichtbar.

## Lokaler Smoke-Test

```bash
npm install
npm run build
API_KEY=test DATA_DIR=/tmp/claudemc-task PORT=4243 HOST=127.0.0.1 npm start

# In zweitem Terminal
curl -s http://127.0.0.1:4243/health
# {"ok":true,"version":"0.1.0"}

JOB=$(curl -s -X POST http://127.0.0.1:4243/jobs \
  -H 'Authorization: Bearer test' \
  -H 'Content-Type: application/json' \
  -d '{"script":"echo hello; sleep 1; date; exit 0","name":"smoke"}')
JOB_ID=$(echo "$JOB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "Job: $JOB_ID"

# Live-Log via SSE
curl -N -H 'Authorization: Bearer test' http://127.0.0.1:4243/jobs/$JOB_ID/log

# Status
curl -s -H 'Authorization: Bearer test' http://127.0.0.1:4243/jobs/$JOB_ID
```

## Datenmodell

`/data/jobs.sqlite` — Job-Metadaten + Status  
`/data/logs/{job-id}.log` — kompletter stdout/stderr des Jobs

## Sicherheit

- Bind nur an WG-IP (kein public Port)
- Bearer-Token als zweite Verteidigungslinie
- Läuft als unprivilegierter `node`-User im Container
- Scripte laufen via `bash -c` — kein chroot, also nichts ausführen was du nicht trust-en kannst
