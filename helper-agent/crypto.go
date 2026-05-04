package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
)

// transportCipher implements the same AES-256-CTR stream cipher as
// twoman_crypto.py. key is SHA-256-hashed to produce a 32-byte AES key;
// iv is padded/truncated to 16 bytes.
type transportCipher struct {
	stream cipher.Stream
}

func newTransportCipher(key, iv []byte) *transportCipher {
	if len(key) == 0 {
		key = []byte("twoman-default-key")
	}
	keyHash := sha256.Sum256(key)

	// Pad IV to exactly 16 bytes (Python: iv.ljust(16, b'\x00'))
	var paddedIV [16]byte
	copy(paddedIV[:], iv)

	block, err := aes.NewCipher(keyHash[:])
	if err != nil {
		panic("aes.NewCipher: " + err.Error())
	}
	return &transportCipher{stream: cipher.NewCTR(block, paddedIV[:])}
}

// process XORs dst with src using the current cipher state.
// dst and src may alias (in-place encryption/decryption).
func (c *transportCipher) process(dst, src []byte) {
	c.stream.XORKeyStream(dst, src)
}

// processInPlace encrypts/decrypts buf in place.
func (c *transportCipher) processInPlace(buf []byte) {
	c.stream.XORKeyStream(buf, buf)
}
