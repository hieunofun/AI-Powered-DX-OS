//go:build ledgerqualification

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestLedgerHistoricalMigrationAcrossRealEpochs(t *testing.T) {
	legacyBinary := os.Getenv("IMMUDB_HISTORICAL_BINARY")
	legacyVerifierBinary := os.Getenv("IMMUDB_HISTORICAL_VERIFIER_BINARY")
	if legacyBinary == "" || legacyVerifierBinary == "" || os.Getenv("POSTGRES_HOST") == "" {
		t.Fatal("Pinned real v1.11 binary and isolated PostgreSQL are required")
	}
	root := t.TempDir()
	file := filepath.Join(root, "records.json")
	archive := filepath.Join(root, "archive")
	script := filepath.Join("..", "history", "qualification.cjs")
	if supplied := os.Getenv("IMMUDB_HISTORY_QUALIFICATION_SCRIPT"); supplied != "" {
		script = supplied
	}
	run := func(mode string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		output, err := exec.CommandContext(ctx, "node", script, mode, file, archive).CombinedOutput()
		if err != nil {
			t.Fatalf("real history %s: %v\n%s", mode, err, output)
		}
		t.Log(string(output))
	}
	legacy := &realLedger{binary: legacyBinary, dir: filepath.Join(root, "old-data"), port: unusedPort(t), sqlPort: unusedPort(t)}
	legacy.start(t)
	t.Cleanup(func() { legacy.stop(t) })
	t.Setenv("IMMUDB_HOST", "127.0.0.1")
	t.Setenv("IMMUDB_GRPC_PORT", strconv.Itoa(legacy.port))
	t.Setenv("IMMUDB_PGSQL_PORT", strconv.Itoa(legacy.sqlPort))
	t.Setenv("IMMUDB_PASSWORD", qualificationPassword)
	t.Setenv("IMMUDB_USERNAME", "immudb")
	t.Setenv("IMMUDB_DATABASE", "defaultdb")
	t.Setenv("IMMUDB_VERIFIER_TOKEN", "qualification-token")
	t.Setenv("IMMUDB_STATE_DIR", filepath.Join(root, "old-state"))
	if err := os.MkdirAll(filepath.Join(root, "old-state"), 0700); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/verify", verify)
	mux.HandleFunc("/historical/verify", historicalVerify)
	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()
	t.Setenv("IMMUDB_VERIFIER_URL", httpServer.URL)
	run("prepare")
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var records []struct {
		Package map[string]any `json:"package"`
		Seal    map[string]any `json:"seal"`
		Receipt map[string]any `json:"receipt"`
	}
	if json.Unmarshal(raw, &records) != nil {
		t.Fatal("invalid fixture packages")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	writer := nativeClient(t, legacy, t.TempDir())
	_, err = writer.SQLExec(ctx, `CREATE TABLE smartprocure_audit_seals (seal_key VARCHAR[150],invoice_id VARCHAR[36],audit_package_id VARCHAR[36],package_version VARCHAR[30],package_sha256 VARCHAR[64],merkle_root VARCHAR[64],final_business_state VARCHAR[50],sealed_at VARCHAR[40],PRIMARY KEY seal_key)`, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		p, s := record.Package, record.Seal
		_, err = writer.SQLExec(ctx, "INSERT INTO "+table+" ("+columns+") VALUES (@key,@id,@package,@version,@sha,@root,@state,@time)", map[string]interface{}{
			"key": s["seal_key"], "id": p["invoice_id"], "package": p["id"], "version": p["package_version"], "sha": p["package_sha256"], "root": p["merkle_root"], "state": p["final_business_state"], "time": "2026-10-14T00:00:00.000000Z"})
		if err != nil {
			t.Fatal(err)
		}
	}
	for index := range records {
		record := &records[index]
		// Run the ORIGINAL PR3 verifier source/module, including SDK v1.11.0,
		// to create genuine old-format receipts, not an emulated JSON fixture.
		oldProofDir := filepath.Join(root, "original-sdk-state")
		if err := os.MkdirAll(oldProofDir, 0700); err != nil {
			t.Fatal(err)
		}
		process := exec.Command(legacyVerifierBinary)
		process.Env = append(os.Environ(), "IMMUDB_STATE_DIR="+oldProofDir)
		if err := process.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- process.Wait() }()
		stop := func() {
			if process.Process != nil {
				_ = process.Process.Kill()
				<-done
				process.Process = nil
			}
		}
		t.Cleanup(stop)
		httpClient := &http.Client{Timeout: 10 * time.Second}
		ready := false
		for attempt := 0; attempt < 100; attempt++ {
			response, err := httpClient.Get("http://127.0.0.1:8081/health")
			if err == nil {
				_ = response.Body.Close()
				if response.StatusCode == 200 {
					ready = true
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		if !ready {
			t.Fatal("original v1.11 verifier did not start")
		}
		body, _ := json.Marshal(map[string]any{"sealKey": record.Seal["seal_key"]})
		request, _ := http.NewRequest("POST", "http://127.0.0.1:8081/verify", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer qualification-token")
		response, err := httpClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var receipt map[string]any
		err = json.NewDecoder(response.Body).Decode(&receipt)
		_ = response.Body.Close()
		stop()
		if err != nil || response.StatusCode != 200 || receipt["verified"] != true {
			t.Fatalf("original v1.11 receipt: %v %v", err, receipt)
		}
		if _, exists := receipt["ledgerEpoch"]; exists {
			t.Fatal("historical verifier source changed")
		}
		record.Receipt = receipt
		record.Seal["receipt"] = receipt
		for _, pair := range [][2]string{{"immudb_tx_id", "txId"}, {"immudb_tx_hash", "txHash"}, {"immudb_state_tx_id", "stateTxId"}, {"immudb_state_hash", "stateHash"}} {
			record.Seal[pair[0]] = receipt[pair[1]]
		}
		checkArchivedProof(t, record.Seal["seal_key"].(string), receipt)
	}
	raw, _ = json.Marshal(records)
	if os.WriteFile(file, raw, 0600) != nil {
		t.Fatal("persist fixture")
	}
	run("persist")
	run("export")
	legacy.stop(t)
	// Restore the actual old ledger and independent trust cache into new dirs,
	// keeping the originals. Check original anchors before any new-epoch write.
	clone := func(source, target string) {
		t.Helper()
		err := filepath.WalkDir(source, func(file string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative, err := filepath.Rel(source, file)
			if err != nil {
				return err
			}
			destination := filepath.Join(target, relative)
			if entry.IsDir() {
				return os.MkdirAll(destination, 0700)
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("unexpected synthetic backup symlink")
			}
			input, err := os.Open(file)
			if err != nil {
				return err
			}
			defer input.Close()
			output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			_, err = io.Copy(output, input)
			closeErr := output.Close()
			if err != nil {
				return err
			}
			return closeErr
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	clone(legacy.dir, filepath.Join(root, "restored-old-data"))
	clone(filepath.Join(root, "old-state"), filepath.Join(root, "restored-old-state"))
	restored := &realLedger{binary: legacyBinary, dir: filepath.Join(root, "restored-old-data"), port: unusedPort(t), sqlPort: unusedPort(t)}
	restored.start(t)
	t.Cleanup(func() { restored.stop(t) })
	t.Setenv("IMMUDB_GRPC_PORT", strconv.Itoa(restored.port))
	t.Setenv("IMMUDB_STATE_DIR", filepath.Join(root, "restored-old-state"))
	for _, record := range records {
		code, proof := verifierCall(t, record.Seal["seal_key"].(string), record.Receipt)
		if code != 200 || proof["txId"] != record.Receipt["txId"] || proof["txHash"] != record.Receipt["txHash"] {
			t.Fatal("isolated original ledger/state restore changed receipt identity")
		}
	}
	restored.stop(t)
	apache := &realLedger{binary: os.Getenv("IMMUDB_QUALIFICATION_BINARY"), dir: filepath.Join(root, "new-data"), port: unusedPort(t), sqlPort: unusedPort(t)}
	apache.start(t)
	t.Cleanup(func() { apache.stop(t) })
	t.Setenv("IMMUDB_GRPC_PORT", strconv.Itoa(apache.port))
	t.Setenv("IMMUDB_PGSQL_PORT", strconv.Itoa(apache.sqlPort))
	t.Setenv("IMMUDB_STATE_DIR", filepath.Join(root, "new-state"))
	if err := os.MkdirAll(filepath.Join(root, "new-state"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IMMUDB_LEDGER_EPOCH", "apache-d5f425e-opendx-1")
	pin, err := os.ReadFile(archive + "-pin.txt")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("IMMUDB_HISTORY_DIR", archive)
	t.Setenv("IMMUDB_HISTORY_MANIFEST_SHA256", string(pin))
	run("cutover")
	t.Log("PASS separate old/new data and trust-state directories; old receipts verify without old server or resealing")
}
