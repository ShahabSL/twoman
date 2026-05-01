#!/usr/bin/env python3

import hashlib
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

class TransportCipher:
    """
    AES-256-CTR stream cipher for hop-by-hop obfuscation.
    """
    def __init__(self, key: bytes, iv: bytes):
        if not key:
            key = b"twoman-default-key"

        # AES-256 requires exactly a 32-byte key
        self.key = hashlib.sha256(key).digest()

        # CTR mode requires a 16-byte nonce/IV
        if len(iv) < 16:
            iv = iv.ljust(16, b'\x00')
        else:
            iv = iv[:16]

        # Initialize AES-256 in CTR mode.
        # The library handles counter increments and keystream generation internally.
        cipher = Cipher(algorithms.AES(self.key), modes.CTR(iv))
        self._stream = cipher.encryptor()  # CTR is symmetric; encryptor == decryptor

    def process(self, data: bytes) -> bytes:
        if not data:
            return b""
        return self._stream.update(data)

    def finalize(self) -> bytes:
        """CTR mode does not use padding, but finalize() is good practice."""
        return self._stream.finalize()
