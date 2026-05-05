#!/usr/bin/env python3

import hashlib
import hmac
import os
import struct
import sys


class TransportCipher:
    """
    A zero-dependency, pure-Python stream cipher based on HMAC-SHA256 CTR mode.
    Used for hop-by-hop obfuscation to protect `twoman_protocol` frames from DPI.
    """
    def __init__(self, key: bytes, iv: bytes):
        if not key:
            key = b"twoman-default-key"
        self.key = hashlib.sha256(key).digest()
        
        # IV should be at least 16 bytes. If smaller, pad it.
        if len(iv) < 16:
            iv = iv.ljust(16, b'\x00')
        else:
            iv = iv[:16]
            
        self.counter_base = iv
        self.block_index = 0
        self.stream_offset = 0
        self.keystream_buffer = b""

    def _generate_block(self):
        # Pack the 16-byte base IV and an 8-byte incrementing block index
        # We use a 24-byte payload to the HMAC to derive the next 32 bytes of keystream
        counter_bytes = self.counter_base + struct.pack(">Q", self.block_index)
        self.block_index += 1
        return hmac.new(self.key, counter_bytes, hashlib.sha256).digest()

    def process(self, data: bytes) -> bytes:
        """
        Encrypts or decrypts the target data. (CTR mode is symmetric).
        """
        if not data:
            return b""
            
        data_len = len(data)
        
        # Ensure we have enough keystream generated for this chunk
        while len(self.keystream_buffer) < data_len:
            self.keystream_buffer += self._generate_block()
            
        # Extract exactly what we need
        chunk_keystream = self.keystream_buffer[:data_len]
        self.keystream_buffer = self.keystream_buffer[data_len:]
        
        # Fast C-level XOR
        data_int = int.from_bytes(data, sys.byteorder)
        key_int = int.from_bytes(chunk_keystream, sys.byteorder)
        res_int = data_int ^ key_int
        
        self.stream_offset += data_len
        return res_int.to_bytes(data_len, sys.byteorder)
