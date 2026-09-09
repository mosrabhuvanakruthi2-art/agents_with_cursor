# /deploy — Start Backend or Frontend Dev Server

Starts the backend API server or Vite frontend dev server.

## Usage

```
/deploy [backend|frontend|both]
```

Default (no argument): starts backend only.

## What This Command Does

### Backend (`/deploy backend` or `/deploy`)

Runs: `npm start` from `backend/` — executes `node src/server.js`

Expected output on success:
```
MongoDB: connected
Server running on port 5000
```

If `MONGODB_URI` is not set in `.env`:
```
MongoDB: MONGODB_URI not set — skipping
Server running on port 5000
```

If MongoDB fails and `MONGODB_URI` is set — server exits with code 1. Check Atlas connectivity or the connection string in `backend/.env`.

### Frontend (`/deploy frontend`)

Runs: `npm run dev` from `frontend/` — executes `vite`

Expected output: Vite dev server URL at `http://localhost:5173`

### Both (`/deploy both`)

Starts backend first, then frontend.

## Pre-flight Checks

Before running:
1. Confirm `backend/.env` exists: `ls backend/.env`
2. Confirm required env vars are set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_TENANT_ID`
3. Confirm dependencies installed: `ls backend/node_modules` and `ls frontend/node_modules`
4. If node_modules is missing: run `npm install` in the respective directory first

## Scripts Reference

From `backend/package.json`:
```json
"scripts": {
  "start": "node src/server.js",
  "dev":   "node src/server.js"
}
```

From `frontend/package.json`:
```json
"scripts": {
  "dev":   "vite",
  "build": "vite build",
  "lint":  "eslint ."
}
```

## Health Check

After starting: `GET http://localhost:5000/api/health`

Expected: `{ "status": "ok", "timestamp": "..." }`
