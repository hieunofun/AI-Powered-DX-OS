package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/codenotary/immudb/embedded/sql"
	"github.com/codenotary/immudb/embedded/store"
	"github.com/codenotary/immudb/pkg/api/schema"
)

type historyAnchor struct {
	SealKey   string `json:"sealKey"`
	TxID      string `json:"txId"`
	TxHash    string `json:"txHash"`
	StateTxID string `json:"stateTxId"`
	StateHash string `json:"stateHash"`
}
type archivedReceipt struct {
	Entry             map[string]string          `json:"entry"`
	TxID              string                     `json:"txId"`
	TxHash            string                     `json:"txHash"`
	StateTxID         string                     `json:"stateTxId"`
	StateHash         string                     `json:"stateHash"`
	RowProof          *schema.VerifiableSQLEntry `json:"rowProof"`
	TransactionHeader *schema.TxHeader           `json:"transactionHeader"`
}

var errArchiveInvalid = errors.New("historical proof invalid")

// Decode only our fixed eight VARCHAR columns. Native SQL decoding and native
// proof primitives are upstream; no locally invented successful proof result.
// IDs/types/PK encoding are fixed by the reviewed table, not untrusted mappings.
func verifyArchivedReceipt(raw json.RawMessage, anchor historyAnchor) (result *archivedReceipt, failure error) {
	// Malformed archived proto data must fail closed, including malformed input
	// rejected by upstream decoders. A recovered panic never yields VERIFIED.
	defer func() {
		if recover() != nil {
			result = nil
			failure = errArchiveInvalid
		}
	}()
	var receipt archivedReceipt
	if json.Unmarshal(raw, &receipt) != nil {
		return nil, errArchiveInvalid
	}
	txID, e1 := strconv.ParseUint(anchor.TxID, 10, 64)
	stateID, e2 := strconv.ParseUint(anchor.StateTxID, 10, 64)
	txHash, e3 := hex.DecodeString(anchor.TxHash)
	stateHash, e4 := hex.DecodeString(anchor.StateHash)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil || txID == 0 || stateID == 0 || len(txHash) != 32 || len(stateHash) != 32 ||
		!validKey.MatchString(anchor.SealKey) || receipt.TxID != anchor.TxID || receipt.TxHash != anchor.TxHash ||
		receipt.StateTxID != anchor.StateTxID || receipt.StateHash != anchor.StateHash || len(receipt.Entry) != 8 ||
		receipt.Entry["seal_key"] != anchor.SealKey || receipt.TransactionHeader == nil || receipt.TransactionHeader.Id != txID {
		return nil, errArchiveInvalid
	}
	header := schema.TxHeaderFromProto(receipt.TransactionHeader)
	alh := header.Alh()
	if !bytes.Equal(alh[:], txHash) {
		return nil, errArchiveInvalid
	}
	p := receipt.RowProof
	if p == nil || p.SqlEntry == nil || p.SqlEntry.Tx != txID || p.VerifiableTx == nil || p.VerifiableTx.Tx == nil ||
		p.VerifiableTx.Tx.Header == nil || p.InclusionProof == nil || p.VerifiableTx.DualProof == nil ||
		p.MaxColId != 8 || len(p.PKIDs) != 1 || p.PKIDs[0] != 1 {
		return nil, errArchiveInvalid
	}
	proofAlh := schema.TxHeaderFromProto(p.VerifiableTx.Tx.Header).Alh()
	if proofAlh != alh {
		return nil, errArchiveInvalid
	}
	names := strings.Split(columns, ",")
	lengths := []int32{150, 36, 36, 30, 64, 64, 50, 40}
	for index, name := range names {
		id := uint32(index + 1)
		if p.ColTypesById[id] != sql.VarcharType || p.ColLenById[id] != lengths[index] ||
			(p.ColIdsByName[name] != id && p.ColIdsByName["("+table+"."+name+")"] != id) {
			return nil, errArchiveInvalid
		}
	}
	encodedPK, _, err := sql.EncodeRawValueAsKey(anchor.SealKey, sql.VarcharType, 150)
	if err != nil {
		return nil, errArchiveInvalid
	}
	key := sql.MapKey([]byte{2}, sql.RowPrefix, sql.EncodeID(p.DatabaseId), sql.EncodeID(p.TableId), sql.EncodeID(sql.PKIndexID), encodedPK)
	// SQLGet's lookup key can be the mapped-index key. Inclusion authenticates
	// the primary-row key derived here, exactly as the upstream VerifyRow does.
	value := p.SqlEntry.Value
	if len(value) < 4 || binary.BigEndian.Uint32(value) != 8 {
		return nil, errArchiveInvalid
	}
	offset := 4
	seen := map[uint32]bool{}
	for range names {
		if offset+4 > len(value) {
			return nil, errArchiveInvalid
		}
		id := binary.BigEndian.Uint32(value[offset:])
		offset += 4
		if id < 1 || id > 8 || seen[id] {
			return nil, errArchiveInvalid
		}
		seen[id] = true
		decoded, count, err := sql.DecodeValue(value[offset:], sql.VarcharType)
		if err != nil || count <= 0 || decoded.RawValue() != receipt.Entry[names[id-1]] {
			return nil, errArchiveInvalid
		}
		offset += count
	}
	if offset != len(value) {
		return nil, errArchiveInvalid
	}
	digest, err := store.EntrySpecDigestFor(header.Version)
	if err != nil {
		return nil, errArchiveInvalid
	}
	entry := &store.EntrySpec{Key: key, Value: value, Metadata: schema.KVMetadataFromProto(p.SqlEntry.Metadata)}
	if !store.VerifyInclusion(schema.InclusionProofFromProto(p.InclusionProof), digest(entry), header.Eh) {
		return nil, errArchiveInvalid
	}
	if stateID == txID {
		if !bytes.Equal(stateHash, txHash) {
			return nil, errArchiveInvalid
		}
	} else {
		var trusted [32]byte
		copy(trusted[:], stateHash)
		sourceID, targetID, sourceHash, targetHash := txID, stateID, alh, trusted
		if txID > stateID {
			sourceID, targetID, sourceHash, targetHash = stateID, txID, trusted, alh
		}
		if !store.VerifyDualProof(schema.DualProofFromProto(p.VerifiableTx.DualProof), sourceID, targetID, sourceHash, targetHash) {
			return nil, errArchiveInvalid
		}
	}
	return &receipt, nil
}

func readArchiveFile(file string, limit int64) ([]byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errArchiveInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(raw)) > limit {
		return nil, errArchiveInvalid
	}
	return raw, err
}

type historyManifest struct {
	Version string            `json:"version"`
	Entries map[string]string `json:"entries"` // stable key -> SHA-256 of exact export bytes
}

func historicalVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		reply(w, 405, map[string]string{"errorCode": "METHOD_NOT_ALLOWED"})
		return
	}
	if !authorized(r) {
		reply(w, 401, map[string]string{"errorCode": "UNAUTHORIZED"})
		return
	}
	var anchor historyAnchor
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&anchor) != nil || !validKey.MatchString(anchor.SealKey) || decoder.Decode(new(any)) != io.EOF {
		reply(w, 400, map[string]string{"errorCode": "INVALID_REQUEST"})
		return
	}
	dir, pin := os.Getenv("IMMUDB_HISTORY_DIR"), os.Getenv("IMMUDB_HISTORY_MANIFEST_SHA256")
	if dir == "" || pin == "" {
		reply(w, 503, map[string]string{"errorCode": "HISTORY_ARCHIVE_UNAVAILABLE"})
		return
	}
	raw, err := readArchiveFile(filepath.Join(dir, "manifest.json"), 4<<20)
	if err != nil {
		reply(w, 503, map[string]string{"errorCode": "HISTORY_ARCHIVE_UNAVAILABLE"})
		return
	}
	hash := sha256.Sum256(raw)
	var manifest historyManifest
	if hex.EncodeToString(hash[:]) != pin || json.Unmarshal(raw, &manifest) != nil || manifest.Version != "OPENDX-HISTORY-1" {
		reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
		return
	}
	expected, exists := manifest.Entries[anchor.SealKey]
	if !exists {
		reply(w, 404, map[string]string{"errorCode": "HISTORY_ENTRY_NOT_FOUND"})
		return
	}
	keyHash := sha256.Sum256([]byte(anchor.SealKey))
	raw, err = readArchiveFile(filepath.Join(dir, hex.EncodeToString(keyHash[:])+".json"), 32<<20)
	if err != nil {
		reply(w, 503, map[string]string{"errorCode": "HISTORY_ARCHIVE_UNAVAILABLE"})
		return
	}
	hash = sha256.Sum256(raw)
	var exported struct {
		Receipt json.RawMessage `json:"receipt"`
	}
	if hex.EncodeToString(hash[:]) != expected || json.Unmarshal(raw, &exported) != nil {
		reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
		return
	}
	receipt, err := verifyArchivedReceipt(exported.Receipt, anchor)
	if err != nil {
		reply(w, 409, map[string]string{"errorCode": "LEDGER_PROOF_INVALID"})
		return
	}
	reply(w, 200, map[string]any{"verified": true, "method": "Apache SDK native archived inclusion/consistency proof",
		"ledgerEpoch": "pr3-archive", "entry": receipt.Entry, "txId": receipt.TxID, "txHash": receipt.TxHash,
		"stateTxId": receipt.StateTxID, "stateHash": receipt.StateHash, "rowProof": receipt.RowProof, "transactionHeader": receipt.TransactionHeader})
}
