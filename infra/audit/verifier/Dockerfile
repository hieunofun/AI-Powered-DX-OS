FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY infra/audit/verifier/go.mod infra/audit/verifier/go.sum ./
RUN go mod download
COPY infra/audit/verifier/*.go ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -o /verifier .
RUN mkdir /state && chown 3322:3322 /state

FROM scratch
COPY --from=build /verifier /verifier
COPY --from=build --chown=3322:3322 /state /state
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY docs/open-source/notices/immudb-v1.11.0-BUSL-1.1.txt /licenses/immudb-v1.11.0-BUSL-1.1.txt
USER 3322:3322
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD ["/verifier","health"]
ENTRYPOINT ["/verifier"]
