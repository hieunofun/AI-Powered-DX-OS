# Qualification only: no production ledger/state volumes or published ports.
FROM codenotary/immudb:1.11.0@sha256:460cb34bb0a690ee743336a174c59f2f24edf79dd00c26d936717495db32d1cf AS historical
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS source
WORKDIR /server
COPY infra/audit/server/go.mod infra/audit/server/go.sum ./
COPY infra/audit/server/main.go ./
COPY infra/audit/provenance/main.go /tools/provenance.go
RUN go mod download && CGO_ENABLED=0 go build -mod=readonly -trimpath \
    -ldflags '-X github.com/codenotary/immudb/cmd/version.Version=v1.9DOM.1-opendx.1 -X github.com/codenotary/immudb/cmd/version.App=immudb' -o /immudb . \
    && go run /tools/provenance.go /immudb /provenance/server \
    && cp go.mod go.sum /provenance/server/ \
    && go list -m -json all > /provenance/server-modules.json
RUN go install golang.org/x/vuln/cmd/govulncheck@v1.9.0
RUN govulncheck ./... > /provenance/server-source-security.txt \
    && govulncheck -mode=binary -show=verbose /immudb > /provenance/server-binary-security.txt

FROM source AS legacyVerifier
WORKDIR /legacy-proof
COPY infra/audit/qualification/legacy-verifier.mod ./go.mod
COPY infra/audit/qualification/legacy-verifier.sum ./go.sum
COPY infra/audit/qualification/legacy-verifier.go.txt ./main.go
RUN go mod download && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /legacy-verifier . \
    && mkdir /provenance/legacy-test-only && cp go.mod go.sum main.go /provenance/legacy-test-only/ \
    && go version -m /legacy-verifier > /provenance/legacy-test-only/build.txt

FROM source AS build
WORKDIR /verifier
COPY infra/audit/verifier/go.mod ./go.mod
COPY infra/audit/verifier/go.sum ./go.sum
RUN go mod download
COPY infra/audit/verifier/*.go ./
RUN go test -mod=readonly ./... \
    && CGO_ENABLED=0 go test -mod=readonly -tags ledgerqualification -c -o /qualification \
    && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /proof-verifier . \
    && govulncheck ./... > /provenance/verifier-source-security.txt \
    && govulncheck -mode=binary -show=verbose /proof-verifier > /provenance/verifier-binary-security.txt \
    && go run /tools/provenance.go /proof-verifier /provenance/verifier \
    && go version -m /qualification > /provenance/verifier-build.txt \
    && go list -m -json all > /provenance/verifier-modules.json \
    && cp go.mod /provenance/verifier.mod && cp go.sum /provenance/verifier.sum
# Retain packaged dependency license/notice files with their original paths.
RUN mkdir -p /provenance/dependency-notices && cd /go/pkg/mod \
    && find . -type f \( -iname '*license*' -o -iname 'notice*' -o -iname 'copying*' -o -iname 'copyright*' \) \
       -exec cp --parents '{}' /provenance/dependency-notices/ \; \
    && cp /usr/local/go/LICENSE /provenance/Go-LICENSE

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS adapter
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api ./apps/api
COPY apps/web/package.json ./apps/web/package.json
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build:api && npm prune --omit=dev \
    && mkdir /node-provenance && node --version > /node-provenance/node-version.txt \
    && cp package-lock.json /node-provenance/package-lock.json

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app/infra/audit/verifier
COPY --from=adapter /app/node_modules /app/node_modules
COPY --from=adapter /app/apps/api/dist /app/apps/api/dist
COPY infra/audit/qualification/wire.cjs /app/infra/audit/qualification/wire.cjs
COPY infra/audit/history /app/infra/audit/history
COPY docs/open-source/notices/nodable-val-parsers-MIT.txt /provenance/nodable-val-parsers-MIT.txt
COPY --from=build /immudb /immudb
COPY --from=build /qualification /qualification
COPY --from=build /proof-verifier /verifier
COPY --from=historical /usr/sbin/immudb /legacy-immudb
COPY --from=legacyVerifier /legacy-verifier /legacy-verifier
COPY --from=legacyVerifier /provenance/legacy-test-only /provenance/legacy-test-only
COPY docs/open-source/notices/immudb-v1.11.0-BUSL-1.1.txt /provenance/test-only-legacy-BUSL-1.1.txt
COPY --from=build /provenance /provenance
COPY --from=adapter /node-provenance /provenance/node
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.source="https://github.com/codenotary/immudb" \
      org.opencontainers.image.revision="d5f425e46b4bfd0771274cb4c2ea77634421600c" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT AND BUSL-1.1" \
      org.opencontainers.image.description="Disposable OpenDX ledger qualification; not a production cutover"
RUN addgroup -g 3322 qualification && adduser -D -u 3322 -G qualification qualification
USER qualification:qualification
ENV IMMUDB_QUALIFICATION_BINARY=/immudb
ENV IMMUDB_HISTORICAL_BINARY=/legacy-immudb IMMUDB_HISTORY_VERIFIER_BINARY=/verifier
ENV IMMUDB_HISTORICAL_VERIFIER_BINARY=/legacy-verifier
ENTRYPOINT ["/qualification", "-test.v", "-test.timeout=180s"]
