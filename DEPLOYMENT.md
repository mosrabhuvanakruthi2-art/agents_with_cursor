# Deployment — Docker Compose

Runs the Migration QA Agent System on a Linux server as two containers: the Express backend
(with Playwright/Chromium) and an nginx container serving the built React SPA and proxying
`/api` to the backend.

| File | Purpose |
|---|---|
| [docker-compose.yml](docker-compose.yml) | The two services, volumes, network, optional local Mongo |
| [backend/Dockerfile](backend/Dockerfile) | Node 22 + `npm ci --omit=dev` + `playwright install chromium` |
| [frontend/Dockerfile](frontend/Dockerfile) | Vite build stage → `nginx:1.27-alpine` |
| [frontend/nginx.conf](frontend/nginx.conf) | SPA fallback, `/api` proxy, 1900 s read timeout |

---

## 1. Put the folder on the server

Copy the whole `QA agent` folder (or `git clone` it) to e.g. `/opt/qa-agent`.

Two things are **gitignored**, so a fresh clone will not have them — copy them across by hand,
over `scp`, not a shared drive:

- the root `.env` (real credentials)
- `backend/config/*.json` (Google service-account keys for Domain-Wide Delegation)

Everything else the containers need is in the repo.

## 2. Check the root `.env`

The root `.env` does double duty: Compose reads it for `${VITE_AZURE_CLIENT_ID}` /
`${FRONTEND_PORT}`, and it is mounted read-only into the backend at `/app/.env`, which is
exactly the path `backend/src/config/env.js` resolves. Nothing secret is copied into an image.

Values to review before the first `up`:

```bash
PORT=5000                       # leave as-is; compose maps it
MONGODB_URI=...                 # must be reachable FROM THE SERVER (see §4)
JWT_SECRET=...                  # a long random string, not the dev one
BACKEND_BASE=https://qa.example.com   # public origin; OAuth callbacks are built from it
VITE_AZURE_CLIENT_ID=...        # baked into the frontend bundle at build time
VITE_AZURE_TENANT_ID=...
FRONTEND_PORT=3000              # host port for the dashboard
SCHEDULER_ENABLED=false         # 'true' only on ONE host, or cron jobs run twice
GOOGLE_SERVICE_ACCOUNT_KEY=./config/google-service-account-migrationn.json
```

Paths like `./config/...` and `./data/...` are relative to the process working directory,
which is `/app/backend` inside the container — the same shape as running `npm run dev` from
`backend/`, so these values need no change.

## 3. Register the server origin with the identity providers

Login is Microsoft PKCE from the browser, and the redirect URI is always
`window.location.origin`. Add the server origin (e.g. `https://qa.example.com`, or
`http://SERVER_IP:3000`) to:

- the Azure AD app registration's redirect URIs (SPA platform), and
- any Google / Box / Slack app whose callback the backend builds from `BACKEND_BASE`.

Without this, login fails with a redirect-URI mismatch.

## 4. MongoDB

Mongo is optional by design — `src/db/mongo.js` lets `getDb()` return `null` and the JSON files
under `backend/data/` take over. Three ways to run:

- **Atlas (what the team uses).** Add the server's public IP under Atlas → Network Access.
  Leave `MONGODB_URI` as it is.
- **A local container.** Set `MONGODB_URI=mongodb://mongo:27017` in `.env` and start with
  `docker compose --profile local-mongo up -d`.
- **No database.** Leave `MONGODB_URI` empty; executions persist to `backend/data/executions.json`.

## 5. Start it

```bash
cd /opt/qa-agent
docker compose up -d --build
docker compose ps
curl -s localhost:5000/api/health        # {"status":"ok",...}
curl -sI localhost:3000                  # 200 from nginx
docker compose logs -f backend
```

The dashboard is then on `http://SERVER:3000`.

The first build takes several minutes — `npx playwright install --with-deps chromium` pulls
Chromium plus its system libraries. Later builds reuse that layer unless
`backend/package.json` changes.

## 6. Day-to-day

```bash
docker compose logs -f backend            # Winston console output
docker compose restart backend            # after an .env change
docker compose up -d --build backend      # after backend code changes
docker compose up -d --build frontend     # after frontend code OR a VITE_* change
docker compose down                       # stop (named volumes survive)
```

`VITE_*` values are inlined by Vite at build time. Editing them in `.env` does nothing until
the frontend image is rebuilt.

## What is mounted, and why

| Host path | Container path | Mode | Reason |
|---|---|---|---|
| `./.env` | `/app/.env` | ro | The single file `config/env.js` loads |
| `./backend/config` | `/app/backend/config` | ro | Service-account keys, deliberately not in the image |
| `./backend/data` | `/app/backend/data` | rw | Seeded `*.xlsx` test cases + runtime state (`executions.json`, `oauth-tokens.json`, caches) |
| `./backend/logs` | `/app/backend/logs` | rw | `app.log` and the per-execution log files the UI reads |

The backend container runs as root so that these bind mounts stay writable regardless of the
host UID — the usual cause of a "works locally, EACCES on the server" first boot.

## Notes and limits

- **Single instance.** `SCHEDULER_ENABLED=true` on two hosts runs every `node-cron` job twice.
  Scale out is not supported by this compose file.
- **No TLS here.** Put a reverse proxy (Caddy, nginx, an ALB) in front if the server is
  internet-facing, and set `BACKEND_BASE` to the `https://` origin.
- **Long requests.** A migration run can occupy a request for ~30 minutes; nginx is set to a
  1900 s read timeout to match `server.timeout` in `src/server.js`. Any proxy you add in front
  needs the same, or the UI gets a 504 mid-run.
- **Backend port 5000** is published on `127.0.0.1` only. Browsers reach the API through nginx.
- **Secrets stay out of the images** — `.dockerignore` excludes `.env*` and `backend/config`,
  and both arrive as mounts at runtime.
