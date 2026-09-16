# Migration QA Agent — backend (Node 22 + Express + Playwright/Chromium)
#
# The image mirrors the repo layout on purpose: src/config/env.js loads the .env
# from `../../../.env` relative to itself, so the app must live at /app/backend
# with the shared .env mounted at /app/.env. Relative env values such as
# GOOGLE_SERVICE_ACCOUNT_KEY=./config/... resolve against the CWD, which is why
# WORKDIR stays /app/backend.
FROM node:22-bookworm-slim

# Keep Playwright's browsers outside the home directory so the path is stable.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    PORT=5000

WORKDIR /app/backend

# Dependencies first — this layer is reused whenever only source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Chromium + its system libraries. Playwright resolves the revision that matches
# the installed playwright package, so this stays in sync with package.json.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# Created here so the container still starts when the host bind mounts are absent.
RUN mkdir -p logs data config

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
