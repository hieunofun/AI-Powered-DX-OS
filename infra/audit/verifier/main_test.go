package main

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/codenotary/immudb/embedded/logger"
	"github.com/codenotary/immudb/pkg/api/schema"
	"github.com/codenotary/immudb/pkg/client/cache"
	"github.com/codenotary/immudb/pkg/client/state"
)

func TestReceiptReadsPersistentSDKStateAfterProofLockReleased(t *testing.T) {
	// Exercise the real pinned SDK file cache, not a mock ledger/proof result.
	service, err := state.NewStateServiceWithUUID(cache.NewFileCache(t.TempDir()), logger.NewSimpleLogger("", io.Discard), nil, "test-server")
	if err != nil {
		t.Fatal(err)
	}
	want := &schema.ImmutableState{Db: "defaultdb", TxId: 12, TxHash: bytes.Repeat([]byte{0xab}, 32)}
	if err = service.CacheLock(); err != nil {
		t.Fatal(err)
	}
	if err = service.SetState("defaultdb", want); err != nil {
		t.Fatal(err)
	}
	if err = service.CacheUnlock(); err != nil {
		t.Fatal(err)
	}
	// This reproduces the prior integration failure: the underlying state file
	// is closed, so a raw GetState cannot read the verified receipt anchor.
	if _, err = service.GetState(context.Background(), "defaultdb"); err == nil {
		t.Fatal("unlocked SDK cache read unexpectedly succeeded")
	}
	for n := 0; n < 2; n++ {
		got, err := receiptState(context.Background(), service, "defaultdb")
		if err != nil {
			t.Fatal(err)
		}
		if got.TxId != want.TxId || got.Db != want.Db || !bytes.Equal(got.TxHash, want.TxHash) {
			t.Fatal("persisted SDK receipt anchor changed")
		}
	}
}
