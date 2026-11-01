FROM --platform=$BUILDPLATFORM golang:1.26.4-bookworm@sha256:b305420a68d0f229d91eb3b3ed9e519fcf2cf5461da4bef997bf927e8c0bfd2b AS build

ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src/services/api
COPY services/api/go.mod services/api/go.sum ./
# The default module proxy refuses some downloads from some networks. "|" moves on to the
# next source after any failure; go.sum still checks every module that arrives.
ARG GOPROXY=https://proxy.golang.org|https://goproxy.cn|direct
ENV GOPROXY=${GOPROXY}
RUN go mod download
COPY services/api ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/raven-api ./cmd/raven-api

FROM debian:12-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/raven-api /usr/local/bin/raven-api
ARG RAVEN_VERSION=0.0.0
ENV RAVEN_VERSION=$RAVEN_VERSION
LABEL org.opencontainers.image.title="Raven API"       org.opencontainers.image.description="The Raven server: accounts, spaces, rooms, chat and LiveKit call tokens."       org.opencontainers.image.version=$RAVEN_VERSION       org.opencontainers.image.source="https://github.com/raven-collective/raven-prototype"
# Local-disk media for self-hosters (RAVEN_MEDIA_DIR); nonroot owns it so a fresh named volume is writable.
RUN mkdir -p /var/lib/raven/media && chown 65532:65532 /var/lib/raven/media
VOLUME /var/lib/raven/media
USER 65532:65532
EXPOSE 6977
ENTRYPOINT ["/usr/local/bin/raven-api"]

