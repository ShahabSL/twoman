package main

import (
	"encoding/hex"
	"testing"
)

func TestHMACCipherMatchesPythonCompatibilityVector(t *testing.T) {
	iv := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	plaintext := []byte("hello world")
	cipher := newTransportCipherSuite(cipherSuiteHMACSHA256CTR, []byte("token"), iv)
	out := make([]byte, len(plaintext))
	cipher.process(out, plaintext)

	if got := hex.EncodeToString(append(iv, out...)); got != "000102030405060708090a0b0c0d0e0f84ec1371bca2c68b2401eb" {
		t.Fatalf("unexpected compatibility vector: %s", got)
	}
}
