package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVerifierRejectsUnauthorizedAndMalformedRequestsBeforeLedgerAccess(t *testing.T) {
	t.Setenv("IMMUDB_VERIFIER_TOKEN", "security-test-token")
	for _, handler := range []func(http.ResponseWriter, *http.Request){verify, historicalVerify} {
		request := httptest.NewRequest("POST", "/verify", strings.NewReader(`{}`))
		response := httptest.NewRecorder()
		handler(response, request)
		if response.Code != 401 {
			t.Fatal("unauthorized request reached proof service")
		}
		for _, body := range []string{`{}`, `{"sealKey":"../../archive"}`, `{"sealKey":"smartprocure:audit:invoice:11111111-1111-4111-8111-111111111111:v1","unknown":true}`, strings.Repeat("a", 2048)} {
			request = httptest.NewRequest("POST", "/verify", strings.NewReader(body))
			request.Header.Set("Authorization", "Bearer security-test-token")
			response = httptest.NewRecorder()
			handler(response, request)
			if response.Code != 400 {
				t.Fatal("malformed request reached proof service")
			}
		}
	}
}

func TestMalformedArchivedProofNeverPanicsOrVerifies(t *testing.T) {
	for _, body := range []string{`null`, `{}`, `{"transactionHeader":{}}`, `{"rowProof":{"verifiableTx":{"tx":null}}}`} {
		if _, err := verifyArchivedReceipt([]byte(body), historyAnchor{}); err == nil {
			t.Fatal("malformed archive accepted")
		}
	}
}
