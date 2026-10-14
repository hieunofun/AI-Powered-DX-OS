FROM golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY infra/audit/verifier/go.mod infra/audit/verifier/go.sum ./
RUN go mod download
COPY infra/audit/verifier/*.go ./
COPY infra/audit/provenance/main.go /tools/provenance.go
RUN go test -mod=readonly ./... && CGO_ENABLED=0 go build -mod=readonly -trimpath -o /verifier . \
    && go run /tools/provenance.go /verifier /provenance/verifier \
    && cp go.mod go.sum /provenance/verifier/ \
    && cp /usr/local/go/LICENSE /provenance/verifier/Go-LICENSE
RUN mkdir /state && chown 3322:3322 /state

FROM scratch
COPY --from=build /verifier /verifier
COPY --from=build --chown=3322:3322 /state /state
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /provenance /provenance
COPY docs/open-source/notices/immudb-v1.9DOM.1-Apache-2.0.txt /licenses/immudb-v1.9DOM.1-Apache-2.0.txt
USER 3322:3322
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD ["/verifier","health"]
ENTRYPOINT ["/verifier"]
