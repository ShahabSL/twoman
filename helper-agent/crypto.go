package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
)

const (
	cipherSuiteHMACSHA256CTR = "hmac-sha256-ctr-v1"
	cipherSuiteAES256CTR     = "aes-256-ctr-v2"
)

type transportCipher interface {
	process(dst, src []byte)
	processInPlace(buf []byte)
}

func newTransportCipher(key, iv []byte) transportCipher {
	return newTransportCipherSuite(cipherSuiteHMACSHA256CTR, key, iv)
}

func newTransportCipherSuite(suite string, key, iv []byte) transportCipher {
	switch suite {
	case cipherSuiteAES256CTR:
		return newAESCTRTransportCipher(key, iv)
	default:
		return newHMACCTRTransportCipher(key, iv)
	}
}

type aesCTRTransportCipher struct {
	stream cipher.Stream
}

func newAESCTRTransportCipher(key, iv []byte) *aesCTRTransportCipher {
	if len(key) == 0 {
		key = []byte("twoman-default-key")
	}
	keyHash := sha256.Sum256(key)
	var paddedIV [16]byte
	copy(paddedIV[:], iv)

	block, err := aes.NewCipher(keyHash[:])
	if err != nil {
		panic("aes.NewCipher: " + err.Error())
	}
	return &aesCTRTransportCipher{stream: cipher.NewCTR(block, paddedIV[:])}
}

func (c *aesCTRTransportCipher) process(dst, src []byte) {
	c.stream.XORKeyStream(dst, src)
}

func (c *aesCTRTransportCipher) processInPlace(buf []byte) {
	c.stream.XORKeyStream(buf, buf)
}

type hmacCTRTransportCipher struct {
	key       []byte
	iv        [16]byte
	block     uint64
	keystream []byte
}

func newHMACCTRTransportCipher(key, iv []byte) *hmacCTRTransportCipher {
	if len(key) == 0 {
		key = []byte("twoman-default-key")
	}
	keyHash := sha256.Sum256(key)
	c := &hmacCTRTransportCipher{key: keyHash[:]}
	copy(c.iv[:], iv)
	return c
}

func (c *hmacCTRTransportCipher) process(dst, src []byte) {
	if len(src) == 0 {
		return
	}
	for i := range src {
		if len(c.keystream) == 0 {
			c.keystream = c.nextBlock()
		}
		dst[i] = src[i] ^ c.keystream[0]
		c.keystream = c.keystream[1:]
	}
}

func (c *hmacCTRTransportCipher) processInPlace(buf []byte) {
	c.process(buf, buf)
}

func (c *hmacCTRTransportCipher) nextBlock() []byte {
	var counter [24]byte
	copy(counter[:16], c.iv[:])
	binary.BigEndian.PutUint64(counter[16:], c.block)
	c.block += 1
	mac := hmac.New(sha256.New, c.key)
	mac.Write(counter[:]) //nolint:errcheck
	return mac.Sum(nil)
}
