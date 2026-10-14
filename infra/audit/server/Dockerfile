FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY infra/audit/server/go.mod infra/audit/server/go.sum ./
RUN go mod download
COPY infra/audit/server/main.go ./
COPY infra/audit/provenance/main.go /tools/provenance.go
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath \
    -ldflags '-X github.com/codenotary/immudb/cmd/version.Version=v1.9DOM.1-opendx.1 -X github.com/codenotary/immudb/cmd/version.App=immudb' -o /immudb . \
    && go run /tools/provenance.go /immudb /provenance/server \
    && cp go.mod go.sum /provenance/server/ \
    && cp /usr/local/go/LICENSE /provenance/server/Go-LICENSE
RUN mkdir /data && chown 3322:3322 /data \
    && addgroup -g 3322 ledger && adduser -D -u 3322 -G ledger ledger

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
COPY --from=build /etc/passwd /etc/passwd
COPY --from=build /etc/group /etc/group
COPY --from=build /immudb /immudb
COPY --from=build /provenance /provenance
COPY --from=build --chown=3322:3322 /data /data
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.source="https://github.com/hieunofun/AI-Powered-DX-OS" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT" \
      org.opencontainers.image.description="Apache d5f425e source with explicit OpenDX transport dependency overrides"
USER ledger:ledger
ENV IMMUDB_DIR=/data IMMUDB_LOGFILE="" IMMUDB_PIDFILE="" IMMUDB_METRICS_SERVER=false IMMUDB_WEB_SERVER=false
HEALTHCHECK --interval=5s --timeout=3s --retries=30 CMD ["/immudb","health"]
ENTRYPOINT ["/immudb"]
