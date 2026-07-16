FROM oven/bun:1.2.16-alpine@sha256:14beb61b5209e743341a80ff2b05e2eac0ccb794b03902e67735f85f731c2b52 AS build

WORKDIR /src
COPY apps/operations/package.json apps/operations/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/desktop/src/assets/fonts/Monda-VariableFont_wght.ttf /desktop/src/assets/fonts/Monda-VariableFont_wght.ttf
COPY apps/operations ./
ARG VITE_RAVEN_OPERATIONS_API_URL=https://ops.rvn.bluehour.cloud
ENV VITE_RAVEN_OPERATIONS_API_URL=${VITE_RAVEN_OPERATIONS_API_URL}
RUN bun run build

FROM nginx:1.30-alpine@sha256:0d3b80406a13a767339fbe2f41406d6c7da727ab89cf8fae399e81f780f814d1

COPY infra/homelab/operations-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 80
