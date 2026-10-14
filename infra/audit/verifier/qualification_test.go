//go:build ledgerqualification

// These tests launch a real source-built server and use native TCP proofs.
// All writes, deliberate row changes and process failures use t.TempDir storage.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codenotary/immudb/embedded/logger"
	"github.com/codenotary/immudb/embedded/store"
	"github.com/codenotary/immudb/pkg/api/schema"
	"github.com/codenotary/immudb/pkg/client"
	"google.golang.org/grpc"
)

const qualificationPassword = "disposable-ledger-qualification-only"

func unusedPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

type realLedger struct {
	binary, dir   string
	port, sqlPort int
	process       *exec.Cmd
	done          chan error
}

func (ledger *realLedger) start(t *testing.T) {
	t.Helper()
	logFile, err := os.CreateTemp(t.TempDir(), "ledger-*.log")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = logFile.Close() })
	ledger.process = exec.Command(ledger.binary,
		"--dir", ledger.dir, "--address", "127.0.0.1", "--port", strconv.Itoa(ledger.port),
		"--pgsql-server=true", "--pgsql-server-port", strconv.Itoa(ledger.sqlPort),
		"--metrics-server=false", "--web-server=false", "--auth=true", "--devmode=false",
		"--admin-password", qualificationPassword, "--logfile", "", "--pidfile", "")
	ledger.process.Dir = filepath.Dir(ledger.dir)
	ledger.process.Stdout, ledger.process.Stderr = logFile, logFile
	if err = ledger.process.Start(); err != nil {
		t.Fatal(err)
	}
	ledger.done = make(chan error, 1)
	go func(process *exec.Cmd, done chan error) { done <- process.Wait() }(ledger.process, ledger.done)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-ledger.done:
			ledger.process = nil
			content, _ := os.ReadFile(logFile.Name())
			t.Fatalf("candidate server exited: %v\n%s", err, content)
		default:
		}
		connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", ledger.port), 100*time.Millisecond)
		if err == nil {
			_ = connection.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("candidate server startup timed out")
}

func (ledger *realLedger) stop(t *testing.T) {
	t.Helper()
	if ledger.process == nil {
		return
	}
	if err := ledger.process.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ledger.done:
	case <-time.After(10 * time.Second):
		t.Fatal("candidate server stop timed out")
	}
	ledger.process = nil
}

func nativeClient(t *testing.T, ledger *realLedger, stateDir string) client.ImmuClient {
	t.Helper()
	c := client.NewClient().WithOptions(client.DefaultOptions().WithAddress("127.0.0.1").WithPort(ledger.port).WithDir(stateDir))
	c.WithLogger(logger.NewSimpleLogger("", io.Discard))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.OpenSession(ctx, []byte("immudb"), []byte(qualificationPassword), "defaultdb"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseSession(context.Background()) })
	return c
}

func verifierCall(t *testing.T, key string, anchor map[string]any) (int, map[string]any) {
	t.Helper()
	input := map[string]any{"sealKey": key}
	for _, name := range []string{"stateTxId", "stateHash", "serverUUID"} {
		if anchor != nil {
			if value, exists := anchor[name]; exists {
				input[name] = value
			}
		}
	}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/verify", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer qualification-token")
	response := httptest.NewRecorder()
	verify(response, request)
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return response.Code, result
}

func wireAdapter(t *testing.T, mode string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	script := os.Getenv("IMMUDB_QUALIFICATION_WIRE_SCRIPT")
	if script == "" {
		script = filepath.Join("..", "qualification", "wire.cjs")
	}
	command := exec.CommandContext(ctx, "node", script, mode)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("actual project pg adapter (%s): %v\n%s", mode, err, output)
	}
}

// Fault injection corrupts a real server response before the official SDK
// consumes it. No successful proof or verification result is simulated.
type corruptInclusion struct {
	schema.ImmuServiceClient
	modified bool
}

func (service *corruptInclusion) VerifiableSQLGet(ctx context.Context, request *schema.VerifiableSQLGetRequest, options ...grpc.CallOption) (*schema.VerifiableSQLEntry, error) {
	proof, err := service.ImmuServiceClient.VerifiableSQLGet(ctx, request, options...)
	if err == nil && proof.InclusionProof != nil && len(proof.InclusionProof.Terms) > 0 && len(proof.InclusionProof.Terms[0]) > 0 {
		proof.InclusionProof.Terms[0][0] ^= 1
		service.modified = true
	} else if err == nil && proof.VerifiableTx != nil && proof.VerifiableTx.DualProof != nil {
		// A one-entry transaction has no sibling terms. Corrupt the real
		// authenticated inclusion root instead, in either proof direction.
		for _, header := range []*schema.TxHeader{proof.VerifiableTx.DualProof.SourceTxHeader, proof.VerifiableTx.DualProof.TargetTxHeader} {
			if header != nil && len(header.EH) > 0 {
				header.EH[0] ^= 1
				service.modified = true
			}
		}
	}
	return proof, err
}

func TestLedgerQualificationNativeProofTrustTamperAndRecovery(t *testing.T) {
	binary := os.Getenv("IMMUDB_QUALIFICATION_BINARY")
	if binary == "" {
		t.Fatal("IMMUDB_QUALIFICATION_BINARY must name the exact source-built candidate; no fallback/mock")
	}
	ledger := &realLedger{binary: binary, dir: filepath.Join(t.TempDir(), "ledger"), port: unusedPort(t), sqlPort: unusedPort(t)}
	ledger.start(t)
	t.Cleanup(func() { ledger.stop(t) })
	stateDir := t.TempDir()
	t.Setenv("IMMUDB_HOST", "127.0.0.1")
	t.Setenv("IMMUDB_GRPC_PORT", strconv.Itoa(ledger.port))
	t.Setenv("IMMUDB_PGSQL_PORT", strconv.Itoa(ledger.sqlPort))
	t.Setenv("IMMUDB_DATABASE", "defaultdb")
	t.Setenv("IMMUDB_USERNAME", "immudb")
	t.Setenv("IMMUDB_PASSWORD", qualificationPassword)
	t.Setenv("IMMUDB_VERIFIER_TOKEN", "qualification-token")
	t.Setenv("IMMUDB_STATE_DIR", stateDir)

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	keys := []string{
		"smartprocure:audit:invoice:11111111-1111-4111-8111-111111111111:v1",
		"smartprocure:audit:invoice:22222222-2222-4222-8222-222222222222:v1",
	}
	writer := nativeClient(t, ledger, t.TempDir())
	if _, err := writer.SQLExec(ctx, `CREATE TABLE IF NOT EXISTS smartprocure_audit_seals (
		seal_key VARCHAR[150],invoice_id VARCHAR[36],audit_package_id VARCHAR[36],package_version VARCHAR[30],
		package_sha256 VARCHAR[64],merkle_root VARCHAR[64],final_business_state VARCHAR[50],sealed_at VARCHAR[40],PRIMARY KEY seal_key)`, nil); err != nil {
		t.Fatal(err)
	}
	for index, key := range keys {
		id := strings.TrimSuffix(strings.TrimPrefix(key, "smartprocure:audit:invoice:"), ":v1")
		_, err := writer.SQLExec(ctx, "INSERT INTO "+table+" ("+columns+") VALUES (@key,@id,@package,@version,@sha,@root,@state,@time)", map[string]interface{}{
			"key": key, "id": id, "package": id, "version": "SMARTPROCURE-AUDIT-1", "sha": strings.Repeat("a", 64),
			"root": strings.Repeat(strconv.Itoa(index+1), 64), "state": "READY_FOR_PAYMENT", "time": "2026-10-14T00:00:00.000000Z"})
		if err != nil {
			t.Fatal(err)
		}
	}
	code, original := verifierCall(t, keys[0], nil)
	if code != 200 || original["verified"] != true || original["rowProof"] == nil || original["transactionHeader"] == nil {
		t.Fatalf("real original proof: %d %v", code, original)
	}
	checkArchivedProof(t, keys[0], original)
	wrongIdentity := map[string]any{"serverUUID": "replaced-server"}
	if code, _ := verifierCall(t, keys[0], wrongIdentity); code != 409 {
		t.Fatal("server identity replacement accepted")
	}
	if code, later := verifierCall(t, keys[1], original); code != 200 || later["verified"] != true || later["stateTxId"] == original["txId"] {
		t.Fatalf("real consistency proof across rows: %d %v", code, later)
	}
	if code, repeated := verifierCall(t, keys[0], original); code != 200 || repeated["txId"] != original["txId"] || repeated["txHash"] != original["txHash"] {
		t.Fatalf("persisted trust restart: %d %v", code, repeated)
	}
	entries, err := os.ReadDir(stateDir)
	if err != nil || len(entries) == 0 {
		t.Fatal("verified SDK trust state was not persisted")
	}
	t.Log("PASS real native SQL, inclusion/consistency proofs and reopened persistent client state; this does not qualify the Node wire adapter")

	c := nativeClient(t, ledger, t.TempDir())
	query, err := c.SQLQuery(ctx, "SELECT "+columns+" FROM "+table+" WHERE seal_key=@key", map[string]interface{}{"key": keys[0]}, true)
	if err != nil || len(query.Rows) != 1 {
		t.Fatalf("real row query: %v", err)
	}
	pk := []*schema.SQLValue{{Value: &schema.SQLValue_S{S: keys[0]}}}
	query.Rows[0].Values[5] = &schema.SQLValue{Value: &schema.SQLValue_S{S: strings.Repeat("f", 64)}}
	if err = c.VerifyRow(ctx, query.Rows[0], table, pk); err == nil {
		t.Fatal("SDK accepted a forged row against the actual ledger proof")
	}
	query, err = c.SQLQuery(ctx, "SELECT "+columns+" FROM "+table+" WHERE seal_key=@key", map[string]interface{}{"key": keys[0]}, true)
	if err != nil {
		t.Fatal(err)
	}
	corrupt := &corruptInclusion{ImmuServiceClient: c.GetServiceClient()}
	c.WithServiceClient(corrupt)
	if err = c.VerifyRow(ctx, query.Rows[0], table, pk); !corrupt.modified || !errors.Is(err, store.ErrCorruptedData) {
		t.Fatalf("real inclusion evidence must be modified and rejected cryptographically: modified=%t error=%v", corrupt.modified, err)
	}
	t.Log("PASS official SDK rejects forged row values and corrupted real inclusion proof bytes")

	badAnchor := map[string]any{"stateTxId": original["stateTxId"], "stateHash": strings.Repeat("f", 64)}
	if code, _ := verifierCall(t, keys[0], badAnchor); code != 409 {
		t.Fatalf("corrupt receipt anchor returned %d", code)
	}
	// A new cache can prove an independently retained original anchor, but it
	// cannot claim continuity with the lost cache when no anchor survives.
	t.Setenv("IMMUDB_STATE_DIR", t.TempDir())
	if code, _ := verifierCall(t, keys[0], badAnchor); code != 409 {
		t.Fatalf("fresh trust cache accepted invalid retained anchor: %d", code)
	}
	if code, recovered := verifierCall(t, keys[0], original); code != 200 || recovered["txHash"] != original["txHash"] {
		t.Fatalf("retained receipt anchor recovery: %d %v", code, recovered)
	}
	t.Log("PASS wrong anchors fail with persisted or fresh cache; genuine retained anchor verifies after cache loss")

	ledger.stop(t)
	if code, _ := verifierCall(t, keys[0], original); code != 503 {
		t.Fatalf("stopped real ledger returned %d", code)
	}
	ledger.start(t)
	if code, recovered := verifierCall(t, keys[0], original); code != 200 || recovered["txId"] != original["txId"] || recovered["txHash"] != original["txHash"] {
		t.Fatalf("real process crash/restart recovery: %d %v", code, recovered)
	}
	reopened := nativeClient(t, ledger, t.TempDir())
	rows, err := reopened.SQLQuery(ctx, "SELECT seal_key FROM "+table, nil, true)
	if err != nil || len(rows.Rows) != 2 {
		t.Fatalf("crash recovery lost/duplicated rows: %v", err)
	}
	seen := map[string]bool{}
	for _, row := range rows.Rows {
		seen[row.Values[0].GetS()] = true
	}
	if !seen[keys[0]] || !seen[keys[1]] {
		t.Fatal("crash recovery changed row identities")
	}
	t.Log("PASS actual process outage returns 503; same ledger/state restart preserves transactions and exact row count")

	if _, err := reopened.SQLExec(ctx, "UPDATE "+table+" SET merkle_root=@root WHERE seal_key=@key", map[string]interface{}{"root": strings.Repeat("f", 64), "key": keys[0]}); err != nil {
		t.Fatal(err)
	}
	code, changed := verifierCall(t, keys[0], original)
	if code != 200 || changed["verified"] != true || changed["txId"] == original["txId"] || changed["txHash"] == original["txHash"] {
		t.Fatalf("real appended row revision: %d %v", code, changed)
	}
	// A new row revision can itself have a valid proof. Existing AuditSealService
	// must reject its different transaction identity as the original seal.
	t.Log("PASS privileged append has a new proven transaction; original receipt identity cannot be silently adopted")
}

// A separate acceptance gate: failure must remain visible and cannot prevent
// gathering native proof evidence. Passing native tests cannot substitute for it.
func TestLedgerQualificationProjectWireCompatibility(t *testing.T) {
	binary := os.Getenv("IMMUDB_QUALIFICATION_BINARY")
	if binary == "" {
		t.Fatal("IMMUDB_QUALIFICATION_BINARY is required")
	}
	ledger := &realLedger{binary: binary, dir: filepath.Join(t.TempDir(), "ledger"), port: unusedPort(t), sqlPort: unusedPort(t)}
	ledger.start(t)
	t.Cleanup(func() { ledger.stop(t) })
	t.Setenv("IMMUDB_HOST", "127.0.0.1")
	t.Setenv("IMMUDB_PGSQL_PORT", strconv.Itoa(ledger.sqlPort))
	t.Setenv("IMMUDB_DATABASE", "defaultdb")
	t.Setenv("IMMUDB_USERNAME", "immudb")
	t.Setenv("IMMUDB_PASSWORD", qualificationPassword)
	wireAdapter(t, "seed")
	wireAdapter(t, "count")
}
