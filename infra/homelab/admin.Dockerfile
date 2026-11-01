FROM --platform=$BUILDPLATFORM oven/bun:1.2.16-alpine@sha256:14beb61b5209e743341a80ff2b05e2eac0ccb794b03902e67735f85f731c2b52 AS build

WORKDIR /src
COPY apps/admin/package.json apps/admin/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/admin ./
RUN bun run build

FROM nginx:1.30-alpine@sha256:0d3b80406a13a767339fbe2f41406d6c7da727ab89cf8fae399e81f780f814d1

ARG RAVEN_VERSION=0.0.0
LABEL org.opencontainers.image.title="Raven admin dashboard"       org.opencontainers.image.description="Static admin dashboard for a Raven server. Serve it beside the API."       org.opencontainers.image.version=$RAVEN_VERSION       org.opencontainers.image.source="https://github.com/raven-collective/raven-prototype"

COPY infra/homelab/admin-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
