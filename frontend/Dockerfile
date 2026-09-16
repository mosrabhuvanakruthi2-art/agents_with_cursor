# Migration QA Agent — frontend (React 19 + Vite build, served by nginx)
#
# VITE_* values are baked in at build time, so they arrive as build args rather
# than runtime env. Changing them requires a rebuild of this image.
FROM node:22-bookworm-slim AS build

WORKDIR /app/frontend

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_AZURE_CLIENT_ID=""
ARG VITE_AZURE_TENANT_ID="common"
ENV VITE_AZURE_CLIENT_ID=$VITE_AZURE_CLIENT_ID \
    VITE_AZURE_TENANT_ID=$VITE_AZURE_TENANT_ID

# vite.config.js sets envDir: '../', which does not exist in this stage; the two
# VITE_ vars above are supplied through the process env instead.
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
