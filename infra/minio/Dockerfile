# Upstream community images are no longer available (registry checked 2026-10-05).
# Build the unmodified official security release from its immutable commit instead.
FROM golang:1.24.9-alpine@sha256:8f8959f38530d159bf71d0b3eb0c547dc61e7959d8225d1599cf762477384923 AS builder
RUN apk add --no-cache git
WORKDIR /src
RUN git init && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth=1 origin 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a"
RUN CGO_ENABLED=0 GOMAXPROCS=2 go build -p 2 -trimpath -o /minio .

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache ca-certificates curl && addgroup -g 10001 minio \
    && adduser -D -u 10001 -G minio minio && mkdir /data && chown minio:minio /data
COPY --from=builder /minio /usr/local/bin/minio
COPY --from=builder /src/LICENSE /src/NOTICE /usr/share/licenses/minio/
COPY --from=builder /usr/local/go/LICENSE /usr/share/licenses/go/LICENSE
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a" \
      org.opencontainers.image.version="RELEASE.2025-10-15T17-29-55Z" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
USER minio
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
