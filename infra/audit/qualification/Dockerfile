# Qualification only: no production ledger/state volumes or published ports.
FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS source
RUN apk add --no-cache git
WORKDIR /upstream
RUN git init && git remote add origin https://github.com/codenotary/immudb.git \
    && git fetch --depth=1 origin d5f425e46b4bfd0771274cb4c2ea77634421600c \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "d5f425e46b4bfd0771274cb4c2ea77634421600c"
RUN mkdir /provenance && cp LICENSE /provenance/immudb-v1.9DOM.1-Apache-2.0.txt \
    && git rev-parse HEAD > /provenance/source-commit.txt \
    && cp go.mod go.sum /provenance/ \
    && go version > /provenance/toolchain.txt \
    && CGO_ENABLED=0 go build -mod=readonly -trimpath \
       -ldflags '-X github.com/codenotary/immudb/cmd/version.Version=v1.9DOM.1 -X github.com/codenotary/immudb/cmd/version.App=immudb' \
       -o /immudb ./cmd/immudb \
    && go version -m /immudb > /provenance/server-build.txt \
    && go list -m -json all > /provenance/server-modules.json

FROM source AS build
WORKDIR /verifier
COPY infra/audit/verifier/candidate.mod ./go.mod
COPY infra/audit/verifier/candidate.sum ./go.sum
RUN go mod download
COPY infra/audit/verifier/*.go ./
RUN go test -mod=readonly ./... \
    && CGO_ENABLED=0 go test -mod=readonly -tags ledgerqualification -c -o /qualification \
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
COPY docs/open-source/notices/nodable-val-parsers-MIT.txt /provenance/nodable-val-parsers-MIT.txt
COPY --from=build /immudb /immudb
COPY --from=build /qualification /qualification
COPY --from=build /provenance /provenance
COPY --from=adapter /node-provenance /provenance/node
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
LABEL org.opencontainers.image.source="https://github.com/codenotary/immudb" \
      org.opencontainers.image.revision="d5f425e46b4bfd0771274cb4c2ea77634421600c" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="Disposable OpenDX ledger qualification; not a production cutover"
RUN addgroup -g 3322 qualification && adduser -D -u 3322 -G qualification qualification
USER qualification:qualification
ENV IMMUDB_QUALIFICATION_BINARY=/immudb
ENTRYPOINT ["/qualification", "-test.v", "-test.timeout=180s"]
