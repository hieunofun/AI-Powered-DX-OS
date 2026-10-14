//go:build ledgerqualification

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func checkArchivedProof(t *testing.T, key string, original map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(original)
	anchor := historyAnchor{SealKey: key, TxID: original["txId"].(string), TxHash: original["txHash"].(string),
		StateTxID: original["stateTxId"].(string), StateHash: original["stateHash"].(string)}
	if _, err := verifyArchivedReceipt(raw, anchor); err != nil {
		t.Fatalf("real archived original proof: %v\n%s", err, raw)
	}
	for _, mutation := range []string{"value", "proof", "mapping", "transaction", "anchor", "missing"} {
		var receipt archivedReceipt
		_ = json.Unmarshal(raw, &receipt)
		changed := anchor
		switch mutation {
		case "value":
			receipt.Entry["merkle_root"] = "forged"
		case "proof":
			receipt.RowProof.SqlEntry.Value[0] ^= 1
		case "mapping":
			receipt.RowProof.ColIdsByName["("+table+".merkle_root)"] = 1
		case "transaction":
			receipt.TransactionHeader.Id++
		case "anchor":
			changed.StateHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		case "missing":
			changed.TxHash = ""
		}
		bad, _ := json.Marshal(receipt)
		if _, err := verifyArchivedReceipt(bad, changed); err == nil {
			t.Fatalf("accepted tampered historical %s", mutation)
		}
	}
	dir := t.TempDir()
	record, _ := json.Marshal(map[string]any{"receipt": original})
	keyHash := sha256.Sum256([]byte(key))
	recordHash := sha256.Sum256(record)
	manifest, _ := json.Marshal(historyManifest{Version: "OPENDX-HISTORY-1", Entries: map[string]string{key: hex.EncodeToString(recordHash[:])}})
	manifestHash := sha256.Sum256(manifest)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, hex.EncodeToString(keyHash[:])+".json")
	if err := os.WriteFile(file, record, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IMMUDB_HISTORY_DIR", dir)
	t.Setenv("IMMUDB_HISTORY_MANIFEST_SHA256", hex.EncodeToString(manifestHash[:]))
	call := func(token string) int {
		body, _ := json.Marshal(anchor)
		request := httptest.NewRequest("POST", "/historical/verify", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		historicalVerify(response, request)
		return response.Code
	}
	if call("qualification-token") != 200 || call("forged-token") != 401 {
		t.Fatal("archive authentication/positive proof failed")
	}
	if err := os.WriteFile(file, append(record, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if call("qualification-token") != 409 {
		t.Fatal("tampered export accepted")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if call("qualification-token") != 503 {
		t.Fatal("missing archive became verified")
	}
	t.Log("PASS real receipt offline inclusion/consistency; corrupt mapping/value/proof/anchor rejected; authenticated immutable archive and missing-file outage")
}
