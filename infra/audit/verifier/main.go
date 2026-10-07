// Internal proof verifier. The linked official immudb v1.11.0 client is BUSL-1.1.
// No custom proof algorithm: VerifyRow and VerifiedTxByID are the authority.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/codenotary/immudb/embedded/logger"
	"github.com/codenotary/immudb/embedded/store"
	"github.com/codenotary/immudb/pkg/api/schema"
	"github.com/codenotary/immudb/pkg/client"
)

const table = "smartprocure_audit_seals"
const columns = "seal_key,invoice_id,audit_package_id,package_version,package_sha256,merkle_root,final_business_state,sealed_at"

var validKey = regexp.MustCompile(`^smartprocure:audit:invoice:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:v1$`)
var proofMu sync.Mutex // one persistent trust-state writer in this verifier instance
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func safeError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrCorruptedData) || strings.Contains(strings.ToLower(err.Error()), "corrupt") || strings.Contains(strings.ToLower(err.Error()), "identity") {
		reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
		return
	}
	reply(w, 503, map[string]string{"errorCode": "LEDGER_VERIFIER_UNAVAILABLE"})
}
func verify(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		reply(w, 405, map[string]string{"errorCode": "METHOD_NOT_ALLOWED"})
		return
	}
	token := os.Getenv("IMMUDB_VERIFIER_TOKEN")
	if token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
		reply(w, 401, map[string]string{"errorCode": "UNAUTHORIZED"})
		return
	}
	var input struct {
		SealKey   string `json:"sealKey"`
		StateTxID string `json:"stateTxId"`
		StateHash string `json:"stateHash"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || !validKey.MatchString(input.SealKey) {
		reply(w, 400, map[string]string{"errorCode": "INVALID_SEAL_KEY"})
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		reply(w, 400, map[string]string{"errorCode": "INVALID_REQUEST"})
		return
	}
	// A bounded queue avoids requests waiting indefinitely for the trust-state lock.
	if !proofMu.TryLock() {
		reply(w, 503, map[string]string{"errorCode": "LEDGER_VERIFIER_BUSY"})
		return
	}
	defer proofMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	port, err := strconv.Atoi(env("IMMUDB_GRPC_PORT", "3322"))
	if err != nil {
		safeError(w, err)
		return
	}
	c := client.NewClient().WithOptions(client.DefaultOptions().WithAddress(env("IMMUDB_HOST", "smartprocure-immudb")).WithPort(port).WithDir(env("IMMUDB_STATE_DIR", "/state")))
	c.WithLogger(logger.NewSimpleLogger("", io.Discard))
	database := env("IMMUDB_DATABASE", "defaultdb")
	if err = c.OpenSession(ctx, []byte(env("IMMUDB_USERNAME", "immudb")), []byte(os.Getenv("IMMUDB_PASSWORD")), database); err != nil {
		safeError(w, err)
		return
	}
	defer func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), time.Second)
		defer closeCancel()
		_ = c.CloseSession(closeCtx)
	}()
	result, err := c.SQLQuery(ctx, "SELECT "+columns+" FROM "+table+" WHERE seal_key=@key", map[string]interface{}{"key": input.SealKey}, true)
	if err != nil {
		safeError(w, err)
		return
	}
	if len(result.Rows) == 0 {
		reply(w, 404, map[string]string{"errorCode": "LEDGER_ENTRY_NOT_FOUND"})
		return
	}
	if len(result.Rows) != 1 {
		reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
		return
	}
	pk := []*schema.SQLValue{{Value: &schema.SQLValue_S{S: input.SealKey}}}
	request := &schema.VerifiableSQLGetRequest{SqlGetRequest: &schema.SQLGetRequest{Table: table, PkValues: pk}}
	before, err := c.GetServiceClient().VerifiableSQLGet(ctx, request)
	if err != nil {
		safeError(w, err)
		return
	}
	if err = c.VerifyRow(ctx, result.Rows[0], table, pk); err != nil {
		safeError(w, err)
		return
	}
	after, err := c.GetServiceClient().VerifiableSQLGet(ctx, request)
	if err != nil {
		safeError(w, err)
		return
	}
	if before.SqlEntry == nil || after.SqlEntry == nil || before.SqlEntry.Tx != after.SqlEntry.Tx {
		reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
		return
	}
	tx, err := c.VerifiedTxByID(ctx, after.SqlEntry.Tx)
	if err != nil {
		safeError(w, err)
		return
	}
	if input.StateTxID != "" || input.StateHash != "" {
		anchorID, parseErr := strconv.ParseUint(input.StateTxID, 10, 64)
		if parseErr != nil || anchorID == 0 || len(input.StateHash) != 64 {
			reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
			return
		}
		anchor, anchorErr := c.VerifiedTxByID(ctx, anchorID)
		if anchorErr != nil {
			safeError(w, anchorErr)
			return
		}
		anchorHash := schema.TxHeaderFromProto(anchor.Header).Alh()
		if hex.EncodeToString(anchorHash[:]) != input.StateHash {
			reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
			return
		}
	}
	state, err := c.StateService.GetState(ctx, database)
	if err != nil {
		safeError(w, err)
		return
	}
	txHash := schema.TxHeaderFromProto(tx.Header).Alh()
	entry := map[string]string{}
	for i, name := range result.Rows[0].Columns {
		parts := strings.Split(strings.Trim(name, "()"), ".")
		entry[parts[len(parts)-1]] = result.Rows[0].Values[i].GetS()
	}
	reply(w, 200, map[string]any{"verified": true, "method": "immudb-go-v1.11.0 VerifyRow + VerifiedTxByID",
		"entry": entry, "txId": strconv.FormatUint(after.SqlEntry.Tx, 10), "txHash": hex.EncodeToString(txHash[:]),
		"stateTxId": strconv.FormatUint(state.TxId, 10), "stateHash": hex.EncodeToString(state.TxHash),
		"rowProof": after, "transactionHeader": tx.Header})
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "health" {
		c := &http.Client{Timeout: 2 * time.Second}
		resp, err := c.Get("http://127.0.0.1:8081/health")
		if err != nil {
			os.Exit(1)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	if os.Getenv("IMMUDB_VERIFIER_TOKEN") == "" || os.Getenv("IMMUDB_PASSWORD") == "" {
		log.Fatal("Verifier credentials are required")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/verify", verify)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		reply(w, 200, map[string]string{"status": "ok", "clientVersion": "1.11.0"})
	})
	server := &http.Server{Addr: ":8081", Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second}
	log.Fatal(server.ListenAndServe())
}
