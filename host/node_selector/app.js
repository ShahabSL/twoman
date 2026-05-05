var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// host/node_selector/node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "host/node_selector/node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// host/node_selector/node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "host/node_selector/node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// host/node_selector/node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "host/node_selector/node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// host/node_selector/node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "host/node_selector/node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// host/node_selector/node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "host/node_selector/node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// host/node_selector/node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "host/node_selector/node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver;
  }
});

// host/node_selector/node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "host/node_selector/node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// host/node_selector/node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "host/node_selector/node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// host/node_selector/node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "host/node_selector/node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// host/node_selector/node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "host/node_selector/node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http2 = require("http");
    var net2 = require("net");
    var tls = require("tls");
    var { randomBytes, createHash } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL: URL2 } = require("url");
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver = require_receiver();
    var Sender = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http2.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net2.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net2.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// host/node_selector/node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "host/node_selector/node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream;
  }
});

// host/node_selector/node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "host/node_selector/node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// host/node_selector/node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "host/node_selector/node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http2 = require("http");
    var { Duplex } = require("stream");
    var { createHash } = require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http2.createServer((req, res) => {
            const body = http2.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server2, map) {
      for (const event of Object.keys(map)) server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http2.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http2.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// host/node_selector/node_modules/ws/index.js
var require_ws = __commonJS({
  "host/node_selector/node_modules/ws/index.js"(exports2, module2) {
    "use strict";
    var createWebSocketStream = require_stream();
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver = require_receiver();
    var Sender = require_sender();
    var subprotocol = require_subprotocol();
    var WebSocket2 = require_websocket();
    var WebSocketServer2 = require_websocket_server();
    WebSocket2.createWebSocketStream = createWebSocketStream;
    WebSocket2.extension = extension;
    WebSocket2.PerMessageDeflate = PerMessageDeflate;
    WebSocket2.Receiver = Receiver;
    WebSocket2.Sender = Sender;
    WebSocket2.Server = WebSocketServer2;
    WebSocket2.subprotocol = subprotocol;
    WebSocket2.WebSocket = WebSocket2;
    WebSocket2.WebSocketServer = WebSocketServer2;
    module2.exports = WebSocket2;
  }
});

// host/node_selector/broker.js
var fs = require("fs");
var http = require("http");
var net = require("net");
var crypto = require("crypto");
var path = require("path");
var { WebSocketServer, WebSocket } = require_ws();
var CIPHER_SUITE_HMAC_SHA256_CTR = "hmac-sha256-ctr-v1";
var CIPHER_SUITE_AES_256_CTR = "aes-256-ctr-v2";
var SUPPORTED_CIPHER_SUITES = /* @__PURE__ */ new Set([CIPHER_SUITE_HMAC_SHA256_CTR, CIPHER_SUITE_AES_256_CTR]);
var TransportCipher = class {
  constructor(keyBuffer, ivBuffer, suite = CIPHER_SUITE_HMAC_SHA256_CTR) {
    if (!keyBuffer || keyBuffer.length === 0) {
      keyBuffer = Buffer.from("twoman-default-key");
    }
    this.suite = SUPPORTED_CIPHER_SUITES.has(suite) ? suite : CIPHER_SUITE_HMAC_SHA256_CTR;
    this.key = crypto.createHash("sha256").update(keyBuffer).digest();
    this.iv = ivBuffer.length < 16 ? Buffer.concat([ivBuffer, Buffer.alloc(16 - ivBuffer.length)]) : ivBuffer.subarray(0, 16);
    if (this.suite === CIPHER_SUITE_AES_256_CTR) {
      this.aesCipher = crypto.createCipheriv("aes-256-ctr", this.key, this.iv);
      return;
    }
    this.blockIndex = 0n;
    this.keystreamBuffer = Buffer.alloc(0);
    this.streamOffset = 0;
  }
  _generateBlock() {
    const indexBuf = Buffer.alloc(8);
    indexBuf.writeBigUInt64BE(this.blockIndex, 0);
    this.blockIndex += 1n;
    const counterBytes = Buffer.concat([this.iv, indexBuf]);
    return crypto.createHmac("sha256", this.key).update(counterBytes).digest();
  }
  process(data) {
    if (!data || data.length === 0) return Buffer.alloc(0);
    if (this.aesCipher) {
      return this.aesCipher.update(data);
    }
    const output = Buffer.alloc(data.length);
    let processed = 0;
    while (processed < data.length) {
      if (this.keystreamBuffer.length === 0) {
        this.keystreamBuffer = this._generateBlock();
      }
      const chunkSize = Math.min(data.length - processed, this.keystreamBuffer.length);
      for (let i = 0; i < chunkSize; i++) {
        output[processed + i] = data[processed + i] ^ this.keystreamBuffer[i];
      }
      this.keystreamBuffer = this.keystreamBuffer.subarray(chunkSize);
      processed += chunkSize;
    }
    this.streamOffset += data.length;
    return output;
  }
};
var ROOT_DIR = path.resolve(__dirname, "..", "..");
var CONFIG_PATH = process.env.TWOMAN_CONFIG_PATH || path.join(__dirname, "config.json");
var TRACE_ENABLED = /^(1|true|yes|on|debug|verbose)$/i.test(process.env.TWOMAN_TRACE || "");
var DEBUG_STATS_ENABLED = /^(1|true|yes|on|debug|verbose)$/i.test(process.env.TWOMAN_DEBUG_STATS || "");
var HEARTBEAT_INTERVAL_MS = 2e4;
var DEFAULT_RUNTIME_LOG_MAX_BYTES = 5 * 1024 * 1024;
var DEFAULT_RUNTIME_LOG_BACKUP_COUNT = 3;
var DEFAULT_EVENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
var DEFAULT_EVENT_LOG_BACKUP_COUNT = 5;
var DEFAULT_RECENT_EVENT_LIMIT = 200;
var DEFAULT_BINARY_MEDIA_TYPE = "image/webp";
var DEFAULT_MAX_FRAME_PAYLOAD_BYTES = 2 * 1024 * 1024;
var DEFAULT_UPLOAD_PROBE_EVENT_LIMIT = 4096;
var RUNTIME_LOG_PATH = process.env.TWOMAN_RUNTIME_LOG_PATH || "";
var EVENT_LOG_PATH = process.env.TWOMAN_EVENT_LOG_PATH || "";
var RUNTIME_LOG_MAX_BYTES = DEFAULT_RUNTIME_LOG_MAX_BYTES;
var RUNTIME_LOG_BACKUP_COUNT = DEFAULT_RUNTIME_LOG_BACKUP_COUNT;
var EVENT_LOG_MAX_BYTES = DEFAULT_EVENT_LOG_MAX_BYTES;
var EVENT_LOG_BACKUP_COUNT = DEFAULT_EVENT_LOG_BACKUP_COUNT;
var RECENT_EVENT_LIMIT = DEFAULT_RECENT_EVENT_LIMIT;
var BINARY_MEDIA_TYPE = DEFAULT_BINARY_MEDIA_TYPE;
var FRAME_HEADER_SIZE = 20;
var FRAME_FIN = 8;
var FRAME_DATA = 6;
var FRAME_WINDOW = 7;
var FRAME_PING = 10;
var FRAME_OPEN = 3;
var FRAME_OPEN_FAIL = 5;
var FRAME_RST = 9;
var FRAME_DNS_QUERY = 12;
var FRAME_DNS_RESPONSE = 13;
var FRAME_DNS_FAIL = 14;
var FLAG_DATA_BULK = 1;
var LANE_CTL = "ctl";
var LANE_DATA = "data";
var DEFAULT_DATA_REPLAY_RESEND_MS = 750;
var DNS_FRAME_TYPES = /* @__PURE__ */ new Set([FRAME_DNS_QUERY, FRAME_DNS_RESPONSE, FRAME_DNS_FAIL]);
var PROFILE_MANAGED_HOST_HTTP = "managed_host_http";
var PROFILE_MANAGED_HOST_WS = "managed_host_ws";
var CAPABILITY_VERSION = 1;
function coerceInt(value, fallbackValue, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return Math.max(minimum, fallbackValue);
  }
  return Math.max(minimum, parsed);
}
function brokerCapabilities() {
  const agentDownWaitMs = state ? state.downWaitMsForRole("agent") : { ctl: 1e3, data: 1e3 };
  const agentDownReadTimeoutSeconds = Math.max(15, Math.max(agentDownWaitMs.ctl, agentDownWaitMs.data) / 1e3 + 10);
  const helperDownCombinedDataLane = state ? state.helperDownCombinedDataLane : false;
  const agentDownCombinedDataLane = state ? state.agentDownCombinedDataLane : false;
  const websocketPublicEnabled = state ? state.websocketPublicEnabled : false;
  const maxFramePayloadBytes = state ? state.maxFramePayloadBytes : DEFAULT_MAX_FRAME_PAYLOAD_BYTES;
  const helperDataUpWorkers = state ? state.helperDataUpWorkers : 8;
  const agentDataUpWorkers = state ? state.agentDataUpWorkers : 8;
  const helperDataUploadProfile = state ? state.helperDataUploadProfile : { maxBatchBytes: 524288, flushDelaySeconds: 6e-3 };
  const agentDataUploadProfile = state ? state.agentDataUploadProfile : { maxBatchBytes: 524288, flushDelaySeconds: 6e-3 };
  const supportedProfiles = [PROFILE_MANAGED_HOST_HTTP];
  if (websocketPublicEnabled) {
    supportedProfiles.push(PROFILE_MANAGED_HOST_WS);
  }
  return {
    version: CAPABILITY_VERSION,
    backend_family: "node_selector",
    recommended_profile: PROFILE_MANAGED_HOST_HTTP,
    supported_profiles: supportedProfiles,
    cipher_suites: [CIPHER_SUITE_AES_256_CTR, CIPHER_SUITE_HMAC_SHA256_CTR],
    max_frame_payload_bytes: maxFramePayloadBytes,
    profiles: {
      [PROFILE_MANAGED_HOST_HTTP]: {
        transport: "http",
        helper: {
          http2_enabled: { ctl: true, data: false },
          down_lanes: helperDownCombinedDataLane ? ["data"] : ["ctl", "data"],
          down_parallelism: helperDownCombinedDataLane ? { data: 2 } : { ctl: 1, data: 1 },
          up_workers: { data: helperDataUpWorkers },
          upload_profiles: {
            data: {
              max_batch_bytes: helperDataUploadProfile.maxBatchBytes,
              flush_delay_seconds: helperDataUploadProfile.flushDelaySeconds
            }
          },
          idle_repoll_delay_seconds: { ctl: 0.05, data: 0.1 },
          streaming_up_lanes: [],
          ...helperDownCombinedDataLane ? { stream_control_lane: "pri" } : {}
        },
        agent: {
          http2_enabled: { ctl: false, data: false },
          down_lanes: agentDownCombinedDataLane ? ["data"] : ["ctl", "data"],
          down_parallelism: agentDownCombinedDataLane ? { data: 2 } : { ctl: 1, data: 1 },
          up_workers: { data: agentDataUpWorkers },
          proxy_keepalive_connections: 2,
          proxy_keepalive_expiry_seconds: 15,
          upload_profiles: {
            data: {
              max_batch_bytes: agentDataUploadProfile.maxBatchBytes,
              flush_delay_seconds: agentDataUploadProfile.flushDelaySeconds
            }
          },
          down_read_timeout_seconds: agentDownReadTimeoutSeconds,
          idle_repoll_delay_seconds: { ctl: 0.05, data: 0.1 },
          streaming_up_lanes: [],
          ...agentDownCombinedDataLane ? { stream_control_lane: "pri" } : {}
        }
      },
      [PROFILE_MANAGED_HOST_WS]: {
        transport: "ws",
        helper: {
          streaming_up_lanes: []
        },
        agent: {
          streaming_up_lanes: []
        }
      }
    },
    camouflage: {
      binary_media_type: BINARY_MEDIA_TYPE,
      route_template: loadedConfig.route_template || "/{lane}/{direction}",
      health_template: loadedConfig.health_template || "/health"
    }
  };
}
function defaultLogDir() {
  return path.join(path.dirname(path.resolve(CONFIG_PATH)), "logs");
}
function resolveLogPath(configValue, envValue, defaultFilename) {
  const explicitEnv = String(envValue || "").trim();
  if (explicitEnv) {
    return path.resolve(explicitEnv);
  }
  const configured = String(configValue || "").trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(path.dirname(path.resolve(CONFIG_PATH)), configured);
  }
  const sharedLogDir = String(process.env.TWOMAN_LOG_DIR || "").trim();
  const baseDir = sharedLogDir ? path.resolve(sharedLogDir) : defaultLogDir();
  return path.join(baseDir, defaultFilename);
}
function ensureLogDir(filePath) {
  const directory = path.dirname(path.resolve(filePath));
  fs.mkdirSync(directory, { recursive: true });
}
function rotateFile(filePath, backupCount) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  if (backupCount <= 0) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  const oldest = `${filePath}.${backupCount}`;
  if (fs.existsSync(oldest)) {
    fs.rmSync(oldest, { force: true });
  }
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, target);
    }
  }
  fs.renameSync(filePath, `${filePath}.1`);
}
function appendRotatedLine(filePath, maxBytes, backupCount, line) {
  try {
    ensureLogDir(filePath);
    const incomingBytes = Buffer.byteLength(line, "utf8");
    const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (maxBytes > 0 && currentSize + incomingBytes > maxBytes) {
      rotateFile(filePath, backupCount);
    }
    fs.appendFileSync(filePath, line, "utf8");
  } catch (_error) {
  }
}
function normalizeLaneProfiles(config) {
  const defaults = {
    ctl: { maxBytes: 4096, maxFrames: 8, holdMs: 1, padMin: 1024 },
    pri: { maxBytes: 32768, maxFrames: 16, holdMs: 2, padMin: 1024 },
    bulk: { maxBytes: 262144, maxFrames: 64, holdMs: 4, padMin: 0 }
  };
  const configured = config && typeof config.lane_profiles === "object" && config.lane_profiles || {};
  const normalized = {
    ctl: { ...defaults.ctl },
    pri: { ...defaults.pri },
    bulk: { ...defaults.bulk }
  };
  const aliasFor = {
    maxBytes: "max_bytes",
    maxFrames: "max_frames",
    holdMs: "hold_ms",
    padMin: "pad_min"
  };
  for (const lane of Object.keys(normalized)) {
    const override = configured[lane];
    if (!override || typeof override !== "object") {
      continue;
    }
    for (const key of Object.keys(aliasFor)) {
      const rawValue = override[key] ?? override[aliasFor[key]];
      if (rawValue === void 0 || rawValue === null) {
        continue;
      }
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric)) {
        continue;
      }
      const minimum = key === "maxBytes" || key === "maxFrames" ? 1 : 0;
      normalized[lane][key] = Math.max(minimum, Math.trunc(numeric));
    }
  }
  return normalized;
}
function runtimeLog(message) {
  if (!RUNTIME_LOG_PATH) {
    return;
  }
  appendRotatedLine(RUNTIME_LOG_PATH, RUNTIME_LOG_MAX_BYTES, RUNTIME_LOG_BACKUP_COUNT, `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`);
}
function jsonSafe(value) {
  if (value === null || value === void 0) {
    return value;
  }
  if (["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[String(key)] = jsonSafe(entry);
    }
    return result;
  }
  return String(value);
}
function trace(message) {
  if (!TRACE_ENABLED) {
    return;
  }
  const line = `[node-broker] ${message}
`;
  runtimeLog(message);
  process.stderr.write(line);
}
function nowMs() {
  return Date.now();
}
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function makeErrorPayload(message) {
  return Buffer.from(String(message || ""), "utf8");
}
function paddedPayload(payload, minimumSize) {
  let body = payload || Buffer.alloc(0);
  while (body.length < minimumSize) {
    body = Buffer.concat([body, encodeFrame({ typeId: FRAME_PING, flags: 0, streamId: 0, offset: nowMs(), payload: Buffer.alloc(0) })]);
  }
  return body;
}
function pingFramePayload() {
  return encodeFrame({ typeId: FRAME_PING, flags: 0, streamId: 0, offset: nowMs(), payload: Buffer.alloc(0) });
}
function encodeFrame(frame) {
  const payload = frame.payload || Buffer.alloc(0);
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header.writeUInt8(frame.typeId >>> 0, 0);
  header.writeUInt8(frame.flags >>> 0, 1);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(frame.streamId >>> 0, 4);
  header.writeBigUInt64BE(BigInt(frame.offset || 0), 8);
  header.writeUInt32BE(payload.length >>> 0, 16);
  return Buffer.concat([header, payload]);
}
var FrameDecoder = class {
  constructor(maxFramePayloadBytes = DEFAULT_MAX_FRAME_PAYLOAD_BYTES) {
    this.buffer = Buffer.alloc(0);
    this.maxFramePayloadBytes = Math.max(1, Number(maxFramePayloadBytes || DEFAULT_MAX_FRAME_PAYLOAD_BYTES));
  }
  feed(chunk) {
    if (!chunk || chunk.length === 0) {
      return [];
    }
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    while (this.buffer.length >= FRAME_HEADER_SIZE) {
      const typeId = this.buffer.readUInt8(0);
      const flags = this.buffer.readUInt8(1);
      const streamId = this.buffer.readUInt32BE(4);
      const offset = Number(this.buffer.readBigUInt64BE(8));
      const length = this.buffer.readUInt32BE(16);
      if (length > this.maxFramePayloadBytes) {
        const error = new Error(`frame payload too large: ${length} > ${this.maxFramePayloadBytes}`);
        error.statusCode = 413;
        throw error;
      }
      const total = FRAME_HEADER_SIZE + length;
      if (this.buffer.length < total) {
        break;
      }
      const payload = this.buffer.subarray(FRAME_HEADER_SIZE, total);
      frames.push({ typeId, flags, streamId, offset, payload });
      this.buffer = this.buffer.subarray(total);
    }
    return frames;
  }
};
var FrameQueue = class {
  constructor() {
    this.items = [];
    this.head = 0;
    this.bufferedBytes = 0;
  }
  push(payload) {
    this.items.push(payload);
    this.bufferedBytes += payload.length;
  }
  unshift(payload) {
    if (!payload) {
      return;
    }
    if (this.head > 0) {
      this.head -= 1;
      this.items[this.head] = payload;
    } else {
      this.items.unshift(payload);
    }
    this.bufferedBytes += payload.length;
  }
  shift() {
    if (this.head >= this.items.length) {
      this.items = [];
      this.head = 0;
      return null;
    }
    const payload = this.items[this.head] || null;
    this.items[this.head] = null;
    this.head += 1;
    if (payload) {
      this.bufferedBytes = Math.max(0, this.bufferedBytes - payload.length);
    }
    if (this.head > 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return payload;
  }
};
var PeerState = class {
  constructor(role, peerLabel, peerSessionId) {
    this.role = role;
    this.peerLabel = peerLabel;
    this.peerSessionId = peerSessionId;
    this.lastSeenMs = nowMs();
    this.channels = { ctl: null, data: null };
    this.flushScheduled = { ctl: false, data: false };
    this.ctlQueue = new FrameQueue();
    this.dataPriQueue = new FrameQueue();
    this.dataBulkQueue = new FrameQueue();
    this.dataReplay = { pri: [], bulk: [] };
    this.dataReplayByPayload = /* @__PURE__ */ new Map();
    this.waiters = { ctl: [], data: [] };
    this.activeStreams = 0;
    this.openEventsMs = [];
  }
  touch() {
    this.lastSeenMs = nowMs();
  }
  bufferedBytesTotal() {
    return this.ctlQueue.bufferedBytes + this.dataPriQueue.bufferedBytes + this.dataBulkQueue.bufferedBytes;
  }
  notifyWaiters(lane) {
    const waiters = this.waiters[lane];
    this.waiters[lane] = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
  waitForLane(lane, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(false);
      }, timeoutMs);
      this.waiters[lane].push(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
};
var StreamState = class {
  constructor(helperSessionId, helperPeerLabel, helperStreamId, agentSessionId, agentStreamId) {
    this.helperSessionId = helperSessionId;
    this.helperPeerLabel = helperPeerLabel;
    this.helperStreamId = Number(helperStreamId);
    this.agentSessionId = agentSessionId;
    this.agentStreamId = Number(agentStreamId);
    this.createdAtMs = nowMs();
    this.lastSeenMs = this.createdAtMs;
    this.helperAckOffset = 0;
    this.agentAckOffset = 0;
    this.helperFinSeen = false;
    this.agentFinSeen = false;
    this.helperFinOffset = null;
    this.agentFinOffset = null;
  }
  touch() {
    this.lastSeenMs = nowMs();
  }
};
var DnsQueryState = class {
  constructor(helperSessionId, helperPeerLabel, helperRequestId, agentSessionId, agentRequestId) {
    this.helperSessionId = helperSessionId;
    this.helperPeerLabel = helperPeerLabel;
    this.helperRequestId = Number(helperRequestId);
    this.agentSessionId = agentSessionId;
    this.agentRequestId = Number(agentRequestId);
    this.createdAtMs = nowMs();
    this.lastSeenMs = this.createdAtMs;
  }
  touch() {
    this.lastSeenMs = nowMs();
  }
};
var BrokerState = class {
  constructor(config) {
    this.config = config;
    this.baseUri = String(config.base_uri || process.env.TWOMAN_BASE_URI || "").replace(/\/+$/, "");
    this.clientTokens = new Set(config.client_tokens || []);
    this.agentTokens = new Set(config.agent_tokens || []);
    this.peerTtlMs = Number(config.peer_ttl_seconds || 90) * 1e3;
    this.streamTtlMs = Number(config.stream_ttl_seconds || 300) * 1e3;
    this.dnsQueryTtlMs = Number(config.dns_query_ttl_seconds || 30) * 1e3;
    this.maxLaneBytes = Number(config.max_lane_bytes || 16 * 1024 * 1024);
    this.maxPeerBufferedBytes = Number(
      config.max_peer_buffered_bytes || Math.min(this.maxLaneBytes * 2, 32 * 1024 * 1024)
    );
    this.maxFramePayloadBytes = Math.max(
      1,
      Number(config.max_frame_payload_bytes || process.env.TWOMAN_MAX_FRAME_PAYLOAD_BYTES || DEFAULT_MAX_FRAME_PAYLOAD_BYTES)
    );
    this.uploadProbeEventLimit = Math.max(
      0,
      Number(config.upload_probe_event_limit || process.env.TWOMAN_UPLOAD_PROBE_EVENT_LIMIT || DEFAULT_UPLOAD_PROBE_EVENT_LIMIT)
    );
    this.maxStreamsPerPeerSession = Math.max(1, Number(config.max_streams_per_peer_session || 256));
    this.maxOpenRatePerPeerSession = Math.max(1, Number(config.max_open_rate_per_peer_session || 120));
    this.openRateWindowMs = Math.max(1e3, Number(config.open_rate_window_seconds || 10) * 1e3);
    this.flushBackpressureBytes = Number(config.flush_backpressure_bytes || 512 * 1024);
    this.flushRetryDelayMs = Number(config.flush_retry_delay_ms || 5);
    this.dataReplayResendMs = Math.max(50, Number(config.data_replay_resend_ms || DEFAULT_DATA_REPLAY_RESEND_MS));
    this.downWaitMsByRole = this.normalizeRoleDownWaitMs(config);
    this.helperDownCombinedDataLane = Boolean(config.helper_down_combined_data_lane);
    this.agentDownCombinedDataLane = Boolean(config.agent_down_combined_data_lane);
    this.helperDataUpWorkers = coerceInt(config.helper_data_up_workers, 8);
    this.agentDataUpWorkers = coerceInt(config.agent_data_up_workers, 8);
    this.helperDataUploadProfile = {
      maxBatchBytes: coerceInt(config.helper_data_upload_max_batch_bytes, 524288),
      flushDelaySeconds: Math.max(0, Number(config.helper_data_upload_flush_delay_seconds ?? 6e-3))
    };
    this.agentDataUploadProfile = {
      maxBatchBytes: coerceInt(config.agent_data_upload_max_batch_bytes, 524288),
      flushDelaySeconds: Math.max(0, Number(config.agent_data_upload_flush_delay_seconds ?? 6e-3))
    };
    this.websocketPublicEnabled = Boolean(config.websocket_public_enabled);
    this.streamingCtlDownHelper = Boolean(config.streaming_ctl_down_helper);
    this.streamingDataDownHelper = Boolean(config.streaming_data_down_helper);
    this.streamingCtlDownAgent = Boolean(config.streaming_ctl_down_agent);
    this.streamingDataDownAgent = Boolean(config.streaming_data_down_agent);
    this.laneProfiles = normalizeLaneProfiles(config);
    this.preferredAgentPeerLabel = String(
      config.preferred_agent_peer_label || process.env.TWOMAN_PREFERRED_AGENT_PEER_LABEL || "agent-main"
    ).trim();
    this.peers = /* @__PURE__ */ new Map();
    this.streamsByHelper = /* @__PURE__ */ new Map();
    this.streamsByAgent = /* @__PURE__ */ new Map();
    this.dnsQueriesByHelper = /* @__PURE__ */ new Map();
    this.dnsQueriesByAgent = /* @__PURE__ */ new Map();
    this.agentSessionId = "";
    this.agentPeerLabel = "";
    this.nextAgentStreamId = 1;
    this.nextAgentDnsRequestId = 1;
    this.metrics = {
      peer_connects: 0,
      peer_disconnects: 0,
      ws_messages_in: { ctl: 0, data: 0 },
      ws_bytes_in: { ctl: 0, data: 0 },
      ws_messages_out: { ctl: 0, data: 0 },
      ws_bytes_out: { ctl: 0, data: 0 },
      frames_in: { ctl: 0, pri: 0, bulk: 0 },
      frames_out: { ctl: 0, pri: 0, bulk: 0 },
      connect_probe: { ok: 0, fail: 0 }
    };
    this.recentEvents = [];
  }
  normalizeDownWaitMs(rawConfig) {
    const ctl = Math.max(50, Number(rawConfig.ctl || rawConfig.control || 1e3));
    const data = Math.max(50, Number(rawConfig.data || 1e3));
    return { ctl, data };
  }
  normalizeRoleDownWaitMs(config) {
    const base = this.normalizeDownWaitMs(config.down_wait_ms || {});
    const values = {
      helper: { ...base },
      agent: { ...base }
    };
    const byRole = config && typeof config.down_wait_ms_by_role === "object" && config.down_wait_ms_by_role || {};
    for (const role of ["helper", "agent"]) {
      const override = byRole[role];
      if (!override || typeof override !== "object") {
        continue;
      }
      values[role] = this.normalizeDownWaitMs({ ...values[role], ...override });
    }
    return values;
  }
  downWaitMsForRole(role) {
    return this.downWaitMsByRole[role] || this.downWaitMsByRole.helper;
  }
  helperControlLane() {
    return this.helperDownCombinedDataLane ? "pri" : LANE_CTL;
  }
  targetLaneForRole(targetRole, inboundLane, frameTypeId) {
    if (targetRole === "agent" && this.agentDownCombinedDataLane) {
      return frameTypeId === FRAME_DATA ? inboundLane : "pri";
    }
    if (targetRole === "helper" && this.helperDownCombinedDataLane) {
      return frameTypeId === FRAME_DATA || DNS_FRAME_TYPES.has(frameTypeId) ? inboundLane : "pri";
    }
    return frameTypeId === FRAME_DATA || DNS_FRAME_TYPES.has(frameTypeId) ? inboundLane : null;
  }
  recordEvent(kind, details, options = {}) {
    const event = {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      kind,
      ...jsonSafe(details)
    };
    if (options.durable !== false && EVENT_LOG_PATH) {
      appendRotatedLine(
        EVENT_LOG_PATH,
        EVENT_LOG_MAX_BYTES,
        EVENT_LOG_BACKUP_COUNT,
        `${JSON.stringify(event)}
`
      );
    }
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_EVENT_LIMIT) {
      this.recentEvents.splice(0, this.recentEvents.length - RECENT_EVENT_LIMIT);
    }
  }
  peerKey(role, peerSessionId) {
    return `${role}:${peerSessionId}`;
  }
  streamHelperKey(peerSessionId, streamId) {
    return `${peerSessionId}:${streamId}`;
  }
  dnsHelperKey(peerSessionId, requestId) {
    return `${peerSessionId}:${requestId}`;
  }
  auth(role, token) {
    if (role === "helper") {
      return this.clientTokens.has(token);
    }
    if (role === "agent") {
      return this.agentTokens.has(token);
    }
    return false;
  }
  normalizePath(rawPath) {
    if (rawPath === "/health" || rawPath === "/pid" || rawPath === "/connect-probe") {
      return rawPath;
    }
    if (this.baseUri && rawPath.startsWith(this.baseUri)) {
      const suffix = rawPath.slice(this.baseUri.length);
      return suffix || "/";
    }
    return rawPath || "/";
  }
  ensurePeer(role, peerLabel, peerSessionId) {
    const key = this.peerKey(role, peerSessionId);
    let peer = this.peers.get(key);
    if (!peer) {
      for (const existingPeer of Array.from(this.peers.values())) {
        if (existingPeer.role === role && existingPeer.peerLabel === peerLabel && existingPeer.peerSessionId !== peerSessionId) {
          this.dropPeer(existingPeer, "peer-replaced");
        }
      }
      peer = new PeerState(role, peerLabel, peerSessionId);
      this.peers.set(key, peer);
      this.metrics.peer_connects += 1;
      trace(`peer online role=${role} label=${peerLabel} session=${peerSessionId}`);
      this.recordEvent("peer_online", {
        role,
        peer_label: peerLabel,
        peer_session_id: peerSessionId
      });
    }
    peer.touch();
    peer.peerLabel = peerLabel;
    if (role === "agent") {
      this.selectAgentPeer();
    }
    return peer;
  }
  dropPeer(peer, reason) {
    const staleStreams = [];
    for (const stream of this.streamsByAgent.values()) {
      if (stream.helperSessionId === peer.peerSessionId || stream.agentSessionId === peer.peerSessionId) {
        staleStreams.push(stream);
      }
    }
    for (const stream of staleStreams) {
      this.recordEvent("cleanup_peer_expired", {
        role: peer.role,
        peer_label: peer.peerLabel,
        peer_session_id: peer.peerSessionId,
        helper_session_id: stream.helperSessionId,
        helper_stream_id: stream.helperStreamId,
        agent_session_id: stream.agentSessionId,
        agent_stream_id: stream.agentStreamId,
        reason
      });
      if (peer.role === "helper" && stream.agentSessionId) {
        this.queueFrame("agent", stream.agentSessionId, {
          typeId: FRAME_RST,
          flags: 0,
          streamId: stream.agentStreamId,
          offset: 0,
          payload: makeErrorPayload(reason || "peer expired")
        });
      }
      if (peer.role === "agent" && stream.helperSessionId) {
        this.queueFrame("helper", stream.helperSessionId, {
          typeId: FRAME_RST,
          flags: 0,
          streamId: stream.helperStreamId,
          offset: 0,
          payload: makeErrorPayload(reason || "peer expired")
        }, this.helperControlLane());
      }
      this.dropStream(stream, reason);
    }
    const staleDnsQueries = [];
    for (const query of this.dnsQueriesByAgent.values()) {
      if (query.helperSessionId === peer.peerSessionId || query.agentSessionId === peer.peerSessionId) {
        staleDnsQueries.push(query);
      }
    }
    for (const query of staleDnsQueries) {
      if (peer.role === "agent") {
        this.queueFrame("helper", query.helperSessionId, {
          typeId: FRAME_DNS_FAIL,
          flags: 0,
          streamId: query.helperRequestId,
          offset: 0,
          payload: makeErrorPayload(reason || "peer expired")
        }, "pri");
      }
      this.dropDnsQuery(query, reason || "peer-expired");
    }
    this.peers.delete(this.peerKey(peer.role, peer.peerSessionId));
    if (peer.role === "agent" && this.agentSessionId === peer.peerSessionId) {
      this.selectAgentPeer();
    }
  }
  selectAgentPeer() {
    let fallbackPeer = null;
    const cutoffMs = nowMs() - this.peerTtlMs;
    for (const peer of this.peers.values()) {
      if (peer.role !== "agent" || peer.lastSeenMs < cutoffMs) {
        continue;
      }
      if (this.preferredAgentPeerLabel && peer.peerLabel === this.preferredAgentPeerLabel) {
        this.agentSessionId = peer.peerSessionId;
        this.agentPeerLabel = peer.peerLabel;
        return peer;
      }
      if (!fallbackPeer || peer.lastSeenMs > fallbackPeer.lastSeenMs) {
        fallbackPeer = peer;
      }
    }
    if (fallbackPeer) {
      this.agentSessionId = fallbackPeer.peerSessionId;
      this.agentPeerLabel = fallbackPeer.peerLabel;
      return fallbackPeer;
    }
    this.agentSessionId = "";
    this.agentPeerLabel = "";
    return null;
  }
  selectAgentSessionId() {
    const peer = this.selectAgentPeer();
    return peer ? peer.peerSessionId : "";
  }
  allocateAgentDnsRequestId() {
    let requestId = Number(this.nextAgentDnsRequestId) >>> 0;
    if (requestId <= 0) {
      requestId = 1;
    }
    const start = requestId;
    while (this.dnsQueriesByAgent.has(requestId)) {
      requestId = requestId >= 4294967295 ? 1 : requestId + 1;
      if (requestId === start) {
        throw new Error("no available agent dns request ids");
      }
    }
    this.nextAgentDnsRequestId = requestId >= 4294967295 ? 1 : requestId + 1;
    return requestId;
  }
  bindChannel(role, peerLabel, peerSessionId, lane, ws) {
    const peer = this.ensurePeer(role, peerLabel, peerSessionId);
    peer.channels[lane] = ws;
    ws._twomanPeerKey = this.peerKey(role, peerSessionId);
    ws._twomanLane = lane;
    ws.isAlive = true;
    this.scheduleFlush(peer, lane);
    return peer;
  }
  unbindChannel(peerKey, lane, ws) {
    const peer = this.peers.get(peerKey);
    if (!peer) {
      return;
    }
    if (peer.channels[lane] === ws) {
      peer.channels[lane] = null;
      this.metrics.peer_disconnects += 1;
      this.recordEvent("channel_closed", {
        role: peer.role,
        peer_label: peer.peerLabel,
        peer_session_id: peer.peerSessionId,
        lane
      });
    }
  }
  queueFrame(role, peerSessionId, frame, queueLane = null) {
    const peer = this.peers.get(this.peerKey(role, peerSessionId));
    if (!peer) {
      trace(`drop frame type=${frame.typeId} stream=${frame.streamId} role=${role} session=${peerSessionId} reason=no-peer`);
      this.recordEvent("queue_drop", {
        reason: "no-peer",
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return false;
    }
    const encoded = encodeFrame(frame);
    if (this.maxPeerBufferedBytes && peer.bufferedBytesTotal() + encoded.length > this.maxPeerBufferedBytes) {
      trace(`drop frame type=${frame.typeId} stream=${frame.streamId} role=${role} session=${peerSessionId} reason=peer-buffer-full`);
      this.recordEvent("queue_drop", {
        reason: "peer-buffer-full",
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return false;
    }
    if (frame.typeId === FRAME_DATA || queueLane === "pri" || queueLane === "bulk") {
      const dataLane = queueLane || (frame.flags & FLAG_DATA_BULK ? "bulk" : "pri");
      const targetQueue = dataLane === "bulk" ? peer.dataBulkQueue : peer.dataPriQueue;
      if (targetQueue.bufferedBytes + encoded.length > this.maxLaneBytes) {
        trace(`drop data stream=${frame.streamId} role=${role} session=${peerSessionId} reason=data-queue-full`);
        this.recordEvent("queue_drop", {
          reason: "data-queue-full",
          role,
          peer_session_id: peerSessionId,
          type_id: frame.typeId,
          stream_id: frame.streamId
        });
        return false;
      }
      targetQueue.push(encoded);
      if (frame.typeId === FRAME_DATA) {
        const entry = {
          encoded,
          streamId: frame.streamId,
          endOffset: Number(frame.offset || 0) + encoded.readUInt32BE(16),
          sentAtMs: 0,
          replayLane: dataLane
        };
        peer.dataReplay[dataLane].push(entry);
        peer.dataReplayByPayload.set(encoded, entry);
      } else {
        this.recordEvent("queue_ctl", {
          role,
          peer_session_id: peerSessionId,
          lane: dataLane,
          type_id: frame.typeId,
          stream_id: frame.streamId,
          payload_bytes: frame.payload ? frame.payload.length : 0
        }, { durable: false });
      }
      this.metrics.frames_out[dataLane] += 1;
      peer.notifyWaiters(LANE_DATA);
      this.scheduleFlush(peer, LANE_DATA);
      return true;
    }
    if (peer.ctlQueue.bufferedBytes + encoded.length > this.maxLaneBytes) {
      trace(`drop ctl type=${frame.typeId} stream=${frame.streamId} role=${role} session=${peerSessionId} reason=ctl-queue-full`);
      this.recordEvent("queue_drop", {
        reason: "ctl-queue-full",
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return false;
    }
    peer.ctlQueue.push(encoded);
    if (frame.typeId !== FRAME_PING) {
      this.recordEvent("queue_ctl", {
        role,
        peer_session_id: peerSessionId,
        type_id: frame.typeId,
        stream_id: frame.streamId,
        payload_bytes: frame.payload ? frame.payload.length : 0
      }, { durable: false });
    }
    this.metrics.frames_out.ctl += 1;
    peer.notifyWaiters(LANE_CTL);
    this.scheduleFlush(peer, LANE_CTL);
    return true;
  }
  laneProfile(lane) {
    return this.laneProfiles[lane] || this.laneProfiles.bulk;
  }
  async nextCtlPayload(peer, waitTimeoutMs) {
    let first = peer.ctlQueue.shift();
    if (!first) {
      const notified = await peer.waitForLane(LANE_CTL, waitTimeoutMs);
      if (!notified) {
        return pingFramePayload();
      }
      first = peer.ctlQueue.shift();
      if (!first) {
        return pingFramePayload();
      }
    }
    peer.touch();
    const firstTypeId = first.readUInt8(0);
    const firstStreamId = first.readUInt32BE(4);
    if (firstTypeId !== FRAME_PING) {
      this.recordEvent("dequeue_ctl", {
        role: peer.role,
        peer_session_id: peer.peerSessionId,
        type_id: firstTypeId,
        stream_id: firstStreamId,
        bytes: first.length
      }, { durable: false });
    }
    const profile = this.laneProfile(LANE_CTL);
    const payloads = [first];
    let total = first.length;
    let frames = 1;
    const deadline = Date.now() + profile.holdMs;
    while (total < profile.maxBytes && frames < profile.maxFrames && Date.now() < deadline) {
      const next = peer.ctlQueue.shift();
      if (!next) {
        break;
      }
      payloads.push(next);
      total += next.length;
      frames += 1;
    }
    this.metrics.ws_bytes_out.ctl += 0;
    return paddedPayload(Buffer.concat(payloads), profile.padMin);
  }
  async nextDataPayload(peer, waitTimeoutMs) {
    let first = peer.dataPriQueue.shift();
    let sourceLane = "pri";
    if (!first) {
      first = peer.dataBulkQueue.shift();
      sourceLane = "bulk";
    }
    if (!first) {
      const notified = await peer.waitForLane(LANE_DATA, waitTimeoutMs);
      if (!notified) {
        return pingFramePayload();
      }
      first = peer.dataPriQueue.shift();
      sourceLane = "pri";
      if (!first) {
        first = peer.dataBulkQueue.shift();
        sourceLane = "bulk";
      }
      if (!first) {
        first = this.nextReplayPayload(peer, "pri") || this.nextReplayPayload(peer, "bulk");
        sourceLane = first ? peer.dataReplayByPayload.get(first)?.replayLane || "bulk" : sourceLane;
        if (!first) {
          return pingFramePayload();
        }
      }
    }
    this.noteDataSent(peer, first);
    peer.touch();
    const profile = this.laneProfile(sourceLane);
    const queue = sourceLane === "pri" ? peer.dataPriQueue : peer.dataBulkQueue;
    const payloads = [first];
    let total = first.length;
    let frames = 1;
    const deadline = Date.now() + profile.holdMs;
    while (total < profile.maxBytes && frames < profile.maxFrames && Date.now() < deadline) {
      let next = queue.shift();
      if (!next) {
        next = this.nextReplayPayload(peer, sourceLane);
      }
      if (!next) {
        break;
      }
      this.noteDataSent(peer, next);
      payloads.push(next);
      total += next.length;
      frames += 1;
    }
    return profile.padMin > 0 ? paddedPayload(Buffer.concat(payloads), profile.padMin) : Buffer.concat(payloads);
  }
  noteDataSent(peer, payload) {
    const entry = peer.dataReplayByPayload.get(payload);
    if (!entry) {
      return;
    }
    entry.sentAtMs = nowMs();
  }
  nextReplayPayload(peer, lane) {
    const entries = peer.dataReplay[lane];
    const cutoff = nowMs() - this.dataReplayResendMs;
    for (const entry of entries) {
      if (entry.sentAtMs > 0 && entry.sentAtMs <= cutoff) {
        return entry.encoded;
      }
    }
    return null;
  }
  pruneAckedData(role, peerSessionId, streamId, ackOffset) {
    const peer = this.peers.get(this.peerKey(role, peerSessionId));
    if (!peer) {
      return;
    }
    for (const lane of ["pri", "bulk"]) {
      const retained = [];
      for (const entry of peer.dataReplay[lane]) {
        if (entry.streamId === streamId && entry.endOffset <= ackOffset) {
          peer.dataReplayByPayload.delete(entry.encoded);
          continue;
        }
        retained.push(entry);
      }
      peer.dataReplay[lane] = retained;
    }
  }
  clearStreamReplay(stream) {
    this.pruneAckedData("helper", stream.helperSessionId, stream.helperStreamId, Number.MAX_SAFE_INTEGER);
    this.pruneAckedData("agent", stream.agentSessionId, stream.agentStreamId, Number.MAX_SAFE_INTEGER);
  }
  scheduleFlush(peer, lane) {
    if (peer.flushScheduled[lane]) {
      return;
    }
    peer.flushScheduled[lane] = true;
    const loop = () => {
      const ws = peer.channels[lane];
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        peer.flushScheduled[lane] = false;
        return;
      }
      if (ws.bufferedAmount > this.flushBackpressureBytes) {
        setTimeout(loop, this.flushRetryDelayMs);
        return;
      }
      let payload = null;
      let sourceKind = lane;
      if (lane === LANE_CTL) {
        payload = peer.ctlQueue.shift();
      } else {
        payload = peer.dataPriQueue.shift();
        if (payload) {
          sourceKind = "pri";
        } else {
          payload = peer.dataBulkQueue.shift();
          sourceKind = "bulk";
        }
      }
      if (!payload) {
        peer.flushScheduled[lane] = false;
        return;
      }
      this.metrics.ws_messages_out[lane] += 1;
      this.metrics.ws_bytes_out[lane] += payload.length;
      ws.send(payload, { binary: true }, (error) => {
        if (error) {
          if (lane === LANE_CTL) {
            peer.ctlQueue.unshift(payload);
          } else if (sourceKind === "pri") {
            peer.dataPriQueue.unshift(payload);
          } else {
            peer.dataBulkQueue.unshift(payload);
          }
          peer.flushScheduled[lane] = false;
          trace(`flush error lane=${lane} peer=${peer.peerSessionId} error=${error}`);
          runtimeLog(`flush error lane=${lane} role=${peer.role} label=${peer.peerLabel} peer=${peer.peerSessionId} error=${error}`);
          this.recordEvent("flush_error", {
            lane,
            peer_role: peer.role,
            peer_label: peer.peerLabel,
            peer_session_id: peer.peerSessionId,
            error: String(error && error.message ? error.message : error)
          });
          return;
        }
        setImmediate(loop);
      });
    };
    setImmediate(loop);
  }
  handleFrame(senderRole, senderPeerSessionId, lane, frame) {
    if (frame.typeId === FRAME_PING) {
      return;
    }
    if (frame.typeId !== FRAME_DATA) {
      this.recordEvent("frame_in", {
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        lane,
        type_id: frame.typeId,
        stream_id: frame.streamId,
        payload_bytes: frame.payload ? frame.payload.length : 0
      }, { durable: false });
    }
    if (frame.typeId === FRAME_OPEN && senderRole === "helper") {
      this.handleOpen(senderPeerSessionId, frame);
      return;
    }
    if (frame.typeId === FRAME_DNS_QUERY && senderRole === "helper") {
      this.handleDnsQuery(senderPeerSessionId, lane, frame);
      return;
    }
    if (frame.typeId === FRAME_DNS_RESPONSE || frame.typeId === FRAME_DNS_FAIL) {
      this.handleDnsResult(senderRole, senderPeerSessionId, lane, frame);
      return;
    }
    const stream = senderRole === "helper" ? this.streamsByHelper.get(this.streamHelperKey(senderPeerSessionId, frame.streamId)) : this.streamsByAgent.get(frame.streamId);
    if (!stream) {
      trace(`drop frame type=${frame.typeId} stream=${frame.streamId} from=${senderRole}/${senderPeerSessionId} lane=${lane} reason=unknown-stream`);
      return;
    }
    stream.touch();
    if (frame.typeId === FRAME_WINDOW) {
      if (senderRole === "helper") {
        stream.helperAckOffset += Number(frame.offset || 0);
        this.pruneAckedData("helper", stream.helperSessionId, stream.helperStreamId, stream.helperAckOffset);
      } else {
        stream.agentAckOffset += Number(frame.offset || 0);
        this.pruneAckedData("agent", stream.agentSessionId, stream.agentStreamId, stream.agentAckOffset);
      }
    }
    if (frame.typeId === FRAME_FIN) {
      if (senderRole === "helper") {
        stream.helperFinSeen = true;
        stream.helperFinOffset = Number(frame.offset || 0);
      } else {
        stream.agentFinSeen = true;
        stream.agentFinOffset = Number(frame.offset || 0);
      }
    }
    let targetRole;
    let targetPeerSessionId;
    let outboundStreamId;
    if (senderRole === "helper") {
      targetRole = "agent";
      targetPeerSessionId = stream.agentSessionId;
      outboundStreamId = stream.agentStreamId;
    } else {
      targetRole = "helper";
      targetPeerSessionId = stream.helperSessionId;
      outboundStreamId = stream.helperStreamId;
    }
    const outboundFrame = {
      typeId: frame.typeId,
      flags: frame.flags,
      streamId: outboundStreamId,
      offset: frame.offset,
      payload: frame.payload
    };
    const targetLane = this.targetLaneForRole(targetRole, lane, frame.typeId);
    const queued = this.queueFrame(targetRole, targetPeerSessionId, outboundFrame, targetLane);
    if (queued) {
      this.recordEvent("frame_forward", {
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        target_role: targetRole,
        target_peer_session_id: targetPeerSessionId,
        type_id: frame.typeId,
        source_stream_id: frame.streamId,
        target_stream_id: outboundStreamId
      }, { durable: false });
    }
    if (!queued && senderRole === "helper") {
      this.queueFrame("helper", senderPeerSessionId, {
        typeId: FRAME_RST,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload("broker queue full")
      }, this.helperControlLane());
    }
    if (frame.typeId === FRAME_RST) {
      this.dropStream(stream);
      return;
    }
    if ((frame.typeId === FRAME_FIN || frame.typeId === FRAME_WINDOW) && this.streamDeliveryComplete(stream)) {
      this.dropStream(stream);
    }
  }
  handleDnsQuery(helperSessionId, lane, frame) {
    let openError = "";
    let agentSessionId = this.selectAgentSessionId();
    const helperPeer = this.peers.get(this.peerKey("helper", helperSessionId));
    const helperPeerLabel = helperPeer ? helperPeer.peerLabel : helperSessionId;
    if (!helperPeer) {
      openError = "helper session unavailable";
    }
    if (agentSessionId && !this.peers.has(this.peerKey("agent", agentSessionId))) {
      agentSessionId = "";
    }
    let agentRequestId = 0;
    if (agentSessionId && !openError) {
      agentRequestId = this.allocateAgentDnsRequestId();
      const query2 = new DnsQueryState(
        helperSessionId,
        helperPeerLabel,
        frame.streamId,
        agentSessionId,
        agentRequestId
      );
      this.dnsQueriesByHelper.set(this.dnsHelperKey(helperSessionId, frame.streamId), query2);
      this.dnsQueriesByAgent.set(agentRequestId, query2);
      this.recordEvent("dns_query_map", {
        helper_session_id: helperSessionId,
        helper_peer_label: helperPeerLabel,
        helper_request_id: frame.streamId,
        agent_session_id: agentSessionId,
        agent_request_id: agentRequestId
      });
    }
    if (openError) {
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_DNS_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload(openError)
      }, "pri");
      return;
    }
    if (!agentSessionId) {
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_DNS_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload("hidden agent unavailable")
      }, "pri");
      return;
    }
    const queued = this.queueFrame("agent", agentSessionId, {
      typeId: FRAME_DNS_QUERY,
      flags: frame.flags,
      streamId: agentRequestId,
      offset: frame.offset,
      payload: frame.payload
    }, lane === "bulk" ? "bulk" : "pri");
    if (queued) {
      return;
    }
    const query = this.dnsQueriesByHelper.get(this.dnsHelperKey(helperSessionId, frame.streamId));
    if (query) {
      this.dropDnsQuery(query, "agent-queue-failed");
    }
    this.queueFrame("helper", helperSessionId, {
      typeId: FRAME_DNS_FAIL,
      flags: 0,
      streamId: frame.streamId,
      offset: 0,
      payload: makeErrorPayload("hidden agent unavailable")
    }, "pri");
  }
  handleDnsResult(senderRole, senderPeerSessionId, lane, frame) {
    if (senderRole !== "agent") {
      this.recordEvent("frame_drop", {
        reason: "unexpected-dns-result-sender",
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        lane,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return;
    }
    const query = this.dnsQueriesByAgent.get(frame.streamId);
    if (!query) {
      this.recordEvent("frame_drop", {
        reason: "unknown-dns-query",
        sender_role: senderRole,
        sender_peer_session_id: senderPeerSessionId,
        lane,
        type_id: frame.typeId,
        stream_id: frame.streamId
      });
      return;
    }
    query.touch();
    this.queueFrame("helper", query.helperSessionId, {
      typeId: frame.typeId,
      flags: frame.flags,
      streamId: query.helperRequestId,
      offset: frame.offset,
      payload: frame.payload
    }, lane === "bulk" ? "bulk" : "pri");
    const liveQuery = this.dnsQueriesByAgent.get(frame.streamId);
    if (liveQuery) {
      this.dropDnsQuery(liveQuery, "completed");
    }
  }
  handleOpen(helperSessionId, frame) {
    let openError = "";
    let agentSessionId = this.selectAgentSessionId();
    const helperPeer = this.peers.get(this.peerKey("helper", helperSessionId));
    const helperPeerLabel = helperPeer ? helperPeer.peerLabel : helperSessionId;
    if (!helperPeer) {
      openError = "helper session unavailable";
    } else {
      openError = this.reserveHelperOpen(helperPeer);
    }
    if (agentSessionId && !this.peers.has(this.peerKey("agent", agentSessionId))) {
      agentSessionId = "";
    }
    if (openError) {
      this.recordEvent("open_fail", {
        helper_session_id: helperSessionId,
        helper_stream_id: frame.streamId,
        reason: openError
      });
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_OPEN_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload(openError)
      }, this.helperControlLane());
      return;
    }
    if (!agentSessionId) {
      this.recordEvent("open_fail", {
        helper_session_id: helperSessionId,
        helper_stream_id: frame.streamId,
        reason: "no-agent"
      });
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_OPEN_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload("hidden agent unavailable")
      }, this.helperControlLane());
      return;
    }
    const agentStreamId = this.nextAgentStreamId++;
    const stream = new StreamState(helperSessionId, helperPeerLabel, frame.streamId, agentSessionId, agentStreamId);
    this.streamsByHelper.set(this.streamHelperKey(helperSessionId, frame.streamId), stream);
    this.streamsByAgent.set(agentStreamId, stream);
    helperPeer.activeStreams += 1;
    const agentPeer = this.peers.get(this.peerKey("agent", agentSessionId));
    if (agentPeer) {
      agentPeer.activeStreams += 1;
    }
    trace(`open helper=${helperPeerLabel}/${helperSessionId} helper_stream=${frame.streamId} agent_session=${agentSessionId} agent_stream=${agentStreamId}`);
    this.recordEvent("open_map", {
      helper_session_id: helperSessionId,
      helper_stream_id: frame.streamId,
      agent_session_id: agentSessionId,
      agent_stream_id: agentStreamId,
      helper_peer_label: helperPeerLabel
    });
    const queued = this.queueFrame(
      "agent",
      agentSessionId,
      {
        typeId: FRAME_OPEN,
        flags: frame.flags,
        streamId: agentStreamId,
        offset: frame.offset,
        payload: frame.payload
      },
      this.agentDownCombinedDataLane ? "pri" : null
    );
    if (!queued) {
      this.recordEvent("open_fail", {
        helper_session_id: helperSessionId,
        helper_stream_id: frame.streamId,
        agent_session_id: agentSessionId,
        agent_stream_id: agentStreamId,
        reason: "agent-queue-full"
      });
      this.dropStream(stream, "agent-queue-full");
      this.queueFrame("helper", helperSessionId, {
        typeId: FRAME_OPEN_FAIL,
        flags: 0,
        streamId: frame.streamId,
        offset: 0,
        payload: makeErrorPayload("hidden agent queue unavailable")
      }, this.helperControlLane());
    }
  }
  reserveHelperOpen(peer) {
    const currentMs = nowMs();
    const windowStart = currentMs - this.openRateWindowMs;
    peer.openEventsMs = peer.openEventsMs.filter((value) => value >= windowStart);
    if (peer.activeStreams >= this.maxStreamsPerPeerSession) {
      return "too many concurrent streams";
    }
    if (peer.openEventsMs.length >= this.maxOpenRatePerPeerSession) {
      return "too many new streams";
    }
    peer.openEventsMs.push(currentMs);
    return "";
  }
  dropStream(stream, reason = "") {
    this.clearStreamReplay(stream);
    this.streamsByHelper.delete(this.streamHelperKey(stream.helperSessionId, stream.helperStreamId));
    this.streamsByAgent.delete(stream.agentStreamId);
    this.recordEvent("drop_stream", {
      helper_session_id: stream.helperSessionId,
      helper_stream_id: stream.helperStreamId,
      agent_session_id: stream.agentSessionId,
      agent_stream_id: stream.agentStreamId,
      helper_fin_seen: stream.helperFinSeen,
      agent_fin_seen: stream.agentFinSeen,
      helper_fin_offset: stream.helperFinOffset,
      agent_fin_offset: stream.agentFinOffset,
      helper_ack_offset: stream.helperAckOffset,
      agent_ack_offset: stream.agentAckOffset,
      reason
    });
    const helperPeer = this.peers.get(this.peerKey("helper", stream.helperSessionId));
    if (helperPeer && helperPeer.activeStreams > 0) {
      helperPeer.activeStreams -= 1;
    }
    const agentPeer = this.peers.get(this.peerKey("agent", stream.agentSessionId));
    if (agentPeer && agentPeer.activeStreams > 0) {
      agentPeer.activeStreams -= 1;
    }
  }
  dropDnsQuery(query, reason = "") {
    this.dnsQueriesByHelper.delete(this.dnsHelperKey(query.helperSessionId, query.helperRequestId));
    this.dnsQueriesByAgent.delete(query.agentRequestId);
    this.recordEvent("drop_dns_query", {
      helper_session_id: query.helperSessionId,
      helper_peer_label: query.helperPeerLabel,
      helper_request_id: query.helperRequestId,
      agent_session_id: query.agentSessionId,
      agent_request_id: query.agentRequestId,
      reason
    });
  }
  streamDeliveryComplete(stream) {
    if (!(stream.helperFinSeen && stream.agentFinSeen)) {
      return false;
    }
    const helperDone = stream.agentFinOffset !== null && stream.helperAckOffset >= Number(stream.agentFinOffset);
    const agentDone = stream.helperFinOffset !== null && stream.agentAckOffset >= Number(stream.helperFinOffset);
    return helperDone && agentDone;
  }
  cleanup() {
    const peerCutoff = nowMs() - this.peerTtlMs;
    const streamCutoff = nowMs() - this.streamTtlMs;
    const dnsQueryCutoff = nowMs() - this.dnsQueryTtlMs;
    for (const [key, peer] of this.peers.entries()) {
      if (peer.lastSeenMs >= peerCutoff) {
        continue;
      }
      const staleStreams = [];
      for (const stream of this.streamsByAgent.values()) {
        if (stream.helperSessionId === peer.peerSessionId || stream.agentSessionId === peer.peerSessionId) {
          staleStreams.push(stream);
        }
      }
      for (const stream of staleStreams) {
        this.recordEvent("cleanup_peer_expired", {
          role: peer.role,
          peer_label: peer.peerLabel,
          peer_session_id: peer.peerSessionId,
          helper_session_id: stream.helperSessionId,
          helper_stream_id: stream.helperStreamId,
          agent_session_id: stream.agentSessionId,
          agent_stream_id: stream.agentStreamId
        });
        if (peer.role === "helper" && stream.agentSessionId) {
          this.queueFrame("agent", stream.agentSessionId, {
            typeId: FRAME_RST,
            flags: 0,
            streamId: stream.agentStreamId,
            offset: 0,
            payload: makeErrorPayload("peer expired")
          });
        }
        if (peer.role === "agent" && stream.helperSessionId) {
          this.queueFrame("helper", stream.helperSessionId, {
            typeId: FRAME_RST,
            flags: 0,
            streamId: stream.helperStreamId,
            offset: 0,
            payload: makeErrorPayload("peer expired")
          }, this.helperControlLane());
        }
        this.dropStream(stream);
      }
      const staleDnsQueries = [];
      for (const query of this.dnsQueriesByAgent.values()) {
        if (query.helperSessionId === peer.peerSessionId || query.agentSessionId === peer.peerSessionId) {
          staleDnsQueries.push(query);
        }
      }
      for (const query of staleDnsQueries) {
        if (peer.role === "agent") {
          this.queueFrame("helper", query.helperSessionId, {
            typeId: FRAME_DNS_FAIL,
            flags: 0,
            streamId: query.helperRequestId,
            offset: 0,
            payload: makeErrorPayload("peer expired")
          }, "pri");
        }
        this.dropDnsQuery(query, "peer-expired");
      }
      this.peers.delete(key);
      if (peer.role === "agent" && this.agentSessionId === peer.peerSessionId) {
        this.selectAgentPeer();
      }
    }
    for (const stream of Array.from(this.streamsByAgent.values())) {
      if (stream.lastSeenMs >= streamCutoff) {
        continue;
      }
      this.recordEvent("cleanup_stream_expired", {
        helper_session_id: stream.helperSessionId,
        helper_stream_id: stream.helperStreamId,
        agent_session_id: stream.agentSessionId,
        agent_stream_id: stream.agentStreamId
      });
      this.queueFrame("helper", stream.helperSessionId, {
        typeId: FRAME_RST,
        flags: 0,
        streamId: stream.helperStreamId,
        offset: 0,
        payload: makeErrorPayload("stream expired")
      }, this.helperControlLane());
      this.queueFrame("agent", stream.agentSessionId, {
        typeId: FRAME_RST,
        flags: 0,
        streamId: stream.agentStreamId,
        offset: 0,
        payload: makeErrorPayload("stream expired")
      });
      this.dropStream(stream);
    }
    for (const query of Array.from(this.dnsQueriesByAgent.values())) {
      if (query.lastSeenMs >= dnsQueryCutoff) {
        continue;
      }
      this.recordEvent("cleanup_dns_query_expired", {
        helper_session_id: query.helperSessionId,
        helper_request_id: query.helperRequestId,
        agent_session_id: query.agentSessionId,
        agent_request_id: query.agentRequestId
      });
      this.queueFrame("helper", query.helperSessionId, {
        typeId: FRAME_DNS_FAIL,
        flags: 0,
        streamId: query.helperRequestId,
        offset: 0,
        payload: makeErrorPayload("dns query expired")
      }, "pri");
      this.dropDnsQuery(query, "query-expired");
    }
  }
  stats() {
    const buffered = { ctl: 0, pri: 0, bulk: 0 };
    const peers = [];
    for (const peer of this.peers.values()) {
      buffered.ctl += peer.ctlQueue.bufferedBytes;
      buffered.pri += peer.dataPriQueue.bufferedBytes;
      buffered.bulk += peer.dataBulkQueue.bufferedBytes;
      if (DEBUG_STATS_ENABLED) {
        peers.push({
          role: peer.role,
          peer_label: peer.peerLabel,
          peer_session_id: peer.peerSessionId,
          active_streams: peer.activeStreams,
          ctl_buffered_bytes: peer.ctlQueue.bufferedBytes,
          pri_buffered_bytes: peer.dataPriQueue.bufferedBytes,
          bulk_buffered_bytes: peer.dataBulkQueue.bufferedBytes,
          last_seen_age_ms: Math.max(0, nowMs() - peer.lastSeenMs),
          channel_open: {
            ctl: Boolean(peer.channels.ctl && peer.channels.ctl.readyState === WebSocket.OPEN),
            data: Boolean(peer.channels.data && peer.channels.data.readyState === WebSocket.OPEN)
          }
        });
      }
    }
    this.selectAgentPeer();
    const payload = {
      ok: true,
      pid: process.pid,
      peers: this.peers.size,
      streams: this.streamsByAgent.size,
      dns_queries: this.dnsQueriesByAgent.size,
      agent_peer_label: this.agentPeerLabel,
      agent_session_id: this.agentSessionId,
      base_uri: this.baseUri,
      log_paths: {
        runtime: RUNTIME_LOG_PATH,
        events: EVENT_LOG_PATH
      },
      buffered_ctl_bytes: buffered.ctl,
      buffered_pri_bytes: buffered.pri,
      buffered_bulk_bytes: buffered.bulk,
      capabilities: brokerCapabilities(),
      metrics: this.metrics,
      recent_event_count: this.recentEvents.length
    };
    if (DEBUG_STATS_ENABLED) {
      payload.peer_details = peers;
      payload.stream_details = Array.from(this.streamsByAgent.values()).slice(0, 32).map((stream) => ({
        helper_session_id: stream.helperSessionId,
        helper_stream_id: stream.helperStreamId,
        agent_session_id: stream.agentSessionId,
        agent_stream_id: stream.agentStreamId,
        age_ms: Math.max(0, nowMs() - stream.createdAtMs),
        last_seen_age_ms: Math.max(0, nowMs() - stream.lastSeenMs)
      }));
      payload.recent_events = this.recentEvents.slice(-64);
    }
    return payload;
  }
};
var loadedConfig = loadConfig();
if (!TRACE_ENABLED && loadedConfig.trace_enabled) {
  TRACE_ENABLED = true;
}
if (!DEBUG_STATS_ENABLED && loadedConfig.debug_stats_enabled) {
  DEBUG_STATS_ENABLED = true;
}
RUNTIME_LOG_PATH = resolveLogPath(
  loadedConfig.log_path,
  process.env.TWOMAN_RUNTIME_LOG_PATH || process.env.TWOMAN_LOG_PATH,
  "node-broker.log"
);
EVENT_LOG_PATH = resolveLogPath(
  loadedConfig.event_log_path,
  process.env.TWOMAN_EVENT_LOG_PATH,
  "node-broker-events.ndjson"
);
RUNTIME_LOG_MAX_BYTES = coerceInt(
  loadedConfig.log_max_bytes || process.env.TWOMAN_RUNTIME_LOG_MAX_BYTES,
  DEFAULT_RUNTIME_LOG_MAX_BYTES
);
RUNTIME_LOG_BACKUP_COUNT = coerceInt(
  loadedConfig.log_backup_count || process.env.TWOMAN_RUNTIME_LOG_BACKUP_COUNT,
  DEFAULT_RUNTIME_LOG_BACKUP_COUNT,
  0
);
EVENT_LOG_MAX_BYTES = coerceInt(
  loadedConfig.event_log_max_bytes || process.env.TWOMAN_EVENT_LOG_MAX_BYTES,
  DEFAULT_EVENT_LOG_MAX_BYTES
);
EVENT_LOG_BACKUP_COUNT = coerceInt(
  loadedConfig.event_log_backup_count || process.env.TWOMAN_EVENT_LOG_BACKUP_COUNT,
  DEFAULT_EVENT_LOG_BACKUP_COUNT,
  0
);
RECENT_EVENT_LIMIT = coerceInt(
  loadedConfig.recent_event_limit || process.env.TWOMAN_RECENT_EVENT_LIMIT,
  DEFAULT_RECENT_EVENT_LIMIT
);
BINARY_MEDIA_TYPE = String(
  loadedConfig.binary_media_type || process.env.TWOMAN_BINARY_MEDIA_TYPE || DEFAULT_BINARY_MEDIA_TYPE
).trim() || DEFAULT_BINARY_MEDIA_TYPE;
ensureLogDir(RUNTIME_LOG_PATH);
ensureLogDir(EVENT_LOG_PATH);
var state = new BrokerState(loadedConfig);
state.recordEvent("broker_loaded", {
  config_path: CONFIG_PATH,
  runtime_log_path: RUNTIME_LOG_PATH,
  event_log_path: EVENT_LOG_PATH
});
runtimeLog(`broker loaded config_path=${CONFIG_PATH} runtime_log_path=${RUNTIME_LOG_PATH} event_log_path=${EVENT_LOG_PATH}`);
function jsonResponse(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store"
  });
  res.end(body);
}
function parseCookieHeader(value) {
  const cookies = {};
  for (const chunk of String(value || "").split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    cookies[name] = decodeURIComponent(rawValue);
  }
  return cookies;
}
function normalizeMediaType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}
function validateBinaryMediaType(value) {
  const allowed = /* @__PURE__ */ new Set([BINARY_MEDIA_TYPE, "application/octet-stream"]);
  if (!allowed.has(normalizeMediaType(value))) {
    throw new Error(`invalid binary content type: ${value || "<missing>"}`);
  }
}
function isHealthRoute(route) {
  return route === "/health" || route.endsWith("/health");
}
function parseLaneRoute(route) {
  const parts = route.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return {
    lane: parts[parts.length - 2],
    direction: parts[parts.length - 1]
  };
}
function parseWebSocketLaneRoute(route) {
  const parts = route.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length < 1) {
    return "";
  }
  return parts[parts.length - 1];
}
function connectionHeaders(req) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const authorization = String(req.headers.authorization || "");
  const cipherSuite = String(cookies.twoman_cipher || req.headers["x-twoman-cipher"] || "").trim();
  let token = "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    token = authorization.slice(7).trim();
  }
  if (!token) {
    token = String(cookies._cfauth || cookies.twoman_auth || req.headers["x-relay-token"] || "");
  }
  return {
    token,
    cipherSuite: cipherSuite ? SUPPORTED_CIPHER_SUITES.has(cipherSuite) ? cipherSuite : "" : CIPHER_SUITE_HMAC_SHA256_CTR,
    role: String(cookies._cf_role || cookies.twoman_role || req.headers["x-cf-role"] || req.headers["x-twoman-role"] || ""),
    peer: String(cookies._cf_lspa || cookies.twoman_peer || req.headers["x-cf-lspa"] || req.headers["x-twoman-peer"] || ""),
    session: String(cookies._wp_syncId || cookies.twoman_session || req.headers["x-wp-syncid"] || req.headers["x-twoman-session"] || "")
  };
}
function tokenForAuthenticatedHeaders(headers) {
  return String(headers && headers.token ? headers.token : "twoman-default-key");
}
function isObserverAuthorized(req) {
  const identity = connectionHeaders(req);
  return state.auth("helper", identity.token) || state.auth("agent", identity.token);
}
async function handleConnectProbe(req, res, url) {
  const host = url.searchParams.get("host") || "";
  const port = Number(url.searchParams.get("port") || "0");
  if (!host || !port) {
    jsonResponse(res, 400, { error: "host and port are required" });
    return;
  }
  const started = Date.now();
  const socket = new net.Socket();
  socket.setTimeout(5e3);
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(payload);
    };
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: "timeout" }));
    socket.once("error", (error) => finish({ ok: false, error: String(error.message || error) }));
    socket.connect(port, host);
  });
  if (result.ok) {
    state.metrics.connect_probe.ok += 1;
  } else {
    state.metrics.connect_probe.fail += 1;
  }
  jsonResponse(res, 200, {
    host,
    port,
    ok: result.ok,
    error: result.error || "",
    time_ms: Date.now() - started
  });
}
function handleChunkStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
    "Transfer-Encoding": "chunked"
  });
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    res.write(`tick ${count} ${Date.now()}
`);
    if (count >= 30) {
      clearInterval(timer);
      res.end("done\n");
    }
  }, 1e3);
  res.on("close", () => clearInterval(timer));
}
async function handleUploadProbe(req, res) {
  const started = Date.now();
  const events = [];
  let totalBytes = 0;
  let totalChunks = 0;
  let omittedEvents = 0;
  const maxEvents = state ? state.uploadProbeEventLimit : DEFAULT_UPLOAD_PROBE_EVENT_LIMIT;
  for await (const chunk of req) {
    totalChunks += 1;
    totalBytes += chunk.length;
    if (events.length < maxEvents) {
      events.push({
        offset_ms: Date.now() - started,
        chunk_bytes: chunk.length,
        total_bytes: totalBytes
      });
    } else {
      omittedEvents += 1;
    }
  }
  jsonResponse(res, 200, {
    ok: true,
    total_bytes: totalBytes,
    chunks: totalChunks,
    omitted_events: omittedEvents,
    events
  });
}
function processInboundFrames(role, sessionId, externalLane, decoder, chunk) {
  const frames = decoder.feed(chunk);
  for (const frame of frames) {
    let logicalLane = externalLane;
    if (externalLane === LANE_DATA) {
      if (frame.typeId === FRAME_DATA) {
        logicalLane = frame.flags & FLAG_DATA_BULK ? "bulk" : "pri";
      } else if (DNS_FRAME_TYPES.has(frame.typeId)) {
        logicalLane = "pri";
      } else {
        logicalLane = LANE_CTL;
      }
    }
    state.metrics.frames_in[logicalLane] += 1;
    state.handleFrame(role, sessionId, logicalLane, frame);
  }
  return frames.length;
}
async function handleLaneDownStream(peer, lane, res, authToken, cipherSuite) {
  const started = Date.now();
  const maxDurationMs = 3e4;
  const waitTimeoutMs = lane === LANE_CTL ? 1e3 : 1e3;
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  res.writeHead(200, {
    "Content-Type": BINARY_MEDIA_TYPE,
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
    "Transfer-Encoding": "chunked"
  });
  try {
    const tokenStr = String(authToken || "twoman-default-key");
    const iv = crypto.randomBytes(16);
    const cipher = new TransportCipher(Buffer.from(tokenStr), iv, cipherSuite);
    if (!res.write(iv)) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
    while (!closed && !res.writableEnded && Date.now() - started < maxDurationMs) {
      const payload = lane === LANE_CTL ? await state.nextCtlPayload(peer, waitTimeoutMs) : await state.nextDataPayload(peer, waitTimeoutMs);
      if (!payload || payload.length === 0) {
        continue;
      }
      const ctPayload = cipher.process(payload);
      if (!res.write(ctPayload)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
      peer.touch();
    }
  } finally {
    if (!closed && !res.writableEnded) {
      res.end();
    }
  }
}
var server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = state.normalizePath(url.pathname);
  const healthPublic = Boolean(loadedConfig.health_public);
  if (isHealthRoute(route)) {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    jsonResponse(res, 200, state.stats());
    return;
  }
  if (route === "/pid") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    jsonResponse(res, 200, { pid: process.pid });
    return;
  }
  if (route === "/connect-probe") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    await handleConnectProbe(req, res, url);
    return;
  }
  if (route === "/stream") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    handleChunkStream(res);
    return;
  }
  if (route === "/upload_probe" && req.method === "POST") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      jsonResponse(res, 403, { error: "forbidden" });
      return;
    }
    await handleUploadProbe(req, res);
    return;
  }
  const parsedRoute = parseLaneRoute(route);
  if (parsedRoute && (parsedRoute.lane === LANE_CTL || parsedRoute.lane === LANE_DATA) && (parsedRoute.direction === "up" || parsedRoute.direction === "down")) {
    const lane = parsedRoute.lane;
    const direction = parsedRoute.direction;
    const headers = connectionHeaders(req);
    if (!headers.role || !headers.peer || !headers.session || !state.auth(headers.role, headers.token)) {
      jsonResponse(res, 403, { error: "invalid role or token" });
      return;
    }
    if (!headers.cipherSuite) {
      jsonResponse(res, 400, { error: "unsupported cipher suite" });
      return;
    }
    const peer = state.ensurePeer(headers.role, headers.peer, headers.session);
    if (req.method === "POST" && direction === "up") {
      try {
        validateBinaryMediaType(req.headers["content-type"]);
      } catch (error) {
        jsonResponse(res, 415, { error: error.message });
        return;
      }
      const decoder = new FrameDecoder(state.maxFramePayloadBytes);
      let frameCount = 0;
      let initCipher = null;
      let ivBuffer = Buffer.alloc(0);
      const tokenStr = tokenForAuthenticatedHeaders(headers);
      try {
        for await (let chunk of req) {
          if (!initCipher) {
            const needed = 16 - ivBuffer.length;
            if (chunk.length >= needed) {
              ivBuffer = Buffer.concat([ivBuffer, chunk.subarray(0, needed)]);
              chunk = chunk.subarray(needed);
              initCipher = new TransportCipher(Buffer.from(tokenStr), ivBuffer, headers.cipherSuite);
            } else {
              ivBuffer = Buffer.concat([ivBuffer, chunk]);
              continue;
            }
          }
          if (chunk.length > 0) {
            const ptChunk = initCipher.process(chunk);
            frameCount += processInboundFrames(headers.role, headers.session, lane, decoder, ptChunk);
          }
        }
      } catch (error) {
        jsonResponse(res, error.statusCode || 400, { error: String(error && error.message ? error.message : error) });
        return;
      }
      jsonResponse(res, 200, { ok: true, frames: frameCount });
      return;
    }
    if (req.method === "GET" && direction === "down") {
      const roleDownWaitMs = state.downWaitMsForRole(headers.role);
      if (lane === LANE_CTL && (headers.role === "helper" && state.streamingCtlDownHelper || headers.role === "agent" && state.streamingCtlDownAgent)) {
        await handleLaneDownStream(peer, lane, res, tokenForAuthenticatedHeaders(headers), headers.cipherSuite);
        return;
      }
      if (lane === LANE_DATA && (headers.role === "helper" && state.streamingDataDownHelper || headers.role === "agent" && state.streamingDataDownAgent)) {
        await handleLaneDownStream(peer, lane, res, tokenForAuthenticatedHeaders(headers), headers.cipherSuite);
        return;
      }
      const payload = lane === LANE_CTL ? await state.nextCtlPayload(peer, roleDownWaitMs.ctl) : await state.nextDataPayload(peer, roleDownWaitMs.data);
      const tokenStr = tokenForAuthenticatedHeaders(headers);
      const iv = crypto.randomBytes(16);
      const cipher = new TransportCipher(Buffer.from(tokenStr), iv, headers.cipherSuite);
      const encPayload = Buffer.concat([iv, cipher.process(payload)]);
      res.writeHead(200, {
        "Content-Type": BINARY_MEDIA_TYPE,
        "Content-Length": String(encPayload.length),
        "Cache-Control": "no-store"
      });
      res.end(encPayload);
      return;
    }
    jsonResponse(res, 405, { error: "method not allowed" });
    return;
  }
  jsonResponse(res, 404, { error: "not found", path: route });
});
var wss = new WebSocketServer({ noServer: true });
var echoWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  const route = state.normalizePath(url.pathname);
  const healthPublic = Boolean(loadedConfig.health_public);
  if (!state.websocketPublicEnabled) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (route === "/ws-echo") {
    if (!healthPublic && !isObserverAuthorized(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    echoWss.handleUpgrade(req, socket, head, (ws) => {
      echoWss.emit("connection", ws, req);
    });
    return;
  }
  const lane = parseWebSocketLaneRoute(route);
  if (lane !== LANE_CTL && lane !== LANE_DATA) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const headers = connectionHeaders(req);
  if (!headers.role || !headers.peer || !headers.session || !state.auth(headers.role, headers.token)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!headers.cipherSuite) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._twomanHeaders = headers;
    ws._twomanLane = lane;
    wss.emit("connection", ws, req);
  });
});
echoWss.on("connection", (ws) => {
  ws.on("message", (message, isBinary) => {
    ws.send(message, { binary: isBinary });
  });
});
wss.on("connection", (ws) => {
  const headers = ws._twomanHeaders;
  const lane = ws._twomanLane;
  const peer = state.bindChannel(headers.role, headers.peer, headers.session, lane, ws);
  const decoder = new FrameDecoder(state.maxFramePayloadBytes);
  const tokenStr = tokenForAuthenticatedHeaders(headers);
  const sendIv = crypto.randomBytes(16);
  const sendCipher = new TransportCipher(Buffer.from(tokenStr), sendIv, headers.cipherSuite);
  let recvCipher = null;
  let recvIvBuffer = Buffer.alloc(0);
  const originalSend = ws.send.bind(ws);
  let firstMsg = true;
  ws.send = (data, options, cb) => {
    const ctPayload = sendCipher.process(data);
    if (firstMsg) {
      firstMsg = false;
      return originalSend(Buffer.concat([sendIv, ctPayload]), options, cb);
    }
    return originalSend(ctPayload, options, cb);
  };
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (message) => {
    let data = Buffer.isBuffer(message) ? message : Buffer.from(message);
    if (!recvCipher) {
      const needed = 16 - recvIvBuffer.length;
      if (data.length >= needed) {
        recvIvBuffer = Buffer.concat([recvIvBuffer, data.subarray(0, needed)]);
        data = data.subarray(needed);
        recvCipher = new TransportCipher(Buffer.from(tokenStr), recvIvBuffer, headers.cipherSuite);
      } else {
        recvIvBuffer = Buffer.concat([recvIvBuffer, data]);
        return;
      }
    }
    if (data.length > 0) {
      const ptData = recvCipher.process(data);
      peer.touch();
      state.metrics.ws_messages_in[lane] += 1;
      state.metrics.ws_bytes_in[lane] += ptData.length;
      try {
        processInboundFrames(headers.role, headers.session, lane, decoder, ptData);
      } catch (error) {
        state.recordEvent("ws_frame_error", {
          role: headers.role,
          peer_label: headers.peer,
          peer_session_id: headers.session,
          lane,
          error: String(error && error.message ? error.message : error)
        });
        ws.close(1009, "frame rejected");
      }
    }
  });
  ws.on("close", () => {
    state.unbindChannel(ws._twomanPeerKey, lane, ws);
  });
  ws.on("error", (error) => {
    trace(`ws error role=${headers.role} session=${headers.session} lane=${lane} error=${error}`);
    runtimeLog(`ws error role=${headers.role} label=${headers.peer} session=${headers.session} lane=${lane} error=${error}`);
    state.recordEvent("ws_error", {
      role: headers.role,
      peer_label: headers.peer,
      peer_session_id: headers.session,
      lane,
      error: String(error && error.message ? error.message : error)
    });
  });
  trace(`channel open role=${headers.role} label=${headers.peer} session=${headers.session} lane=${lane}`);
  state.recordEvent("channel_open", {
    role: headers.role,
    peer_label: headers.peer,
    peer_session_id: headers.session,
    lane
  });
});
setInterval(() => {
  state.cleanup();
}, 1e4);
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);
server.listen(process.env.PORT || 3e3, () => {
  trace(`listening pid=${process.pid} base_uri=${state.baseUri || "/"}`);
  runtimeLog(`listening pid=${process.pid} base_uri=${state.baseUri || "/"} runtime_log_path=${RUNTIME_LOG_PATH} event_log_path=${EVENT_LOG_PATH}`);
  state.recordEvent("broker_started", {
    pid: process.pid,
    base_uri: state.baseUri || "/",
    runtime_log_path: RUNTIME_LOG_PATH,
    event_log_path: EVENT_LOG_PATH
  });
});
process.on("uncaughtException", (error) => {
  trace(`uncaughtException pid=${process.pid} error=${error && error.stack ? error.stack : error}`);
  runtimeLog(`uncaughtException pid=${process.pid} error=${error && error.stack ? error.stack : error}`);
  state.recordEvent("uncaught_exception", {
    pid: process.pid,
    error: String(error && error.stack ? error.stack : error)
  });
});
process.on("unhandledRejection", (reason) => {
  trace(`unhandledRejection pid=${process.pid} reason=${reason && reason.stack ? reason.stack : reason}`);
  runtimeLog(`unhandledRejection pid=${process.pid} reason=${reason && reason.stack ? reason.stack : reason}`);
  state.recordEvent("unhandled_rejection", {
    pid: process.pid,
    reason: String(reason && reason.stack ? reason.stack : reason)
  });
});
process.on("beforeExit", (code) => {
  trace(`beforeExit pid=${process.pid} code=${code}`);
  runtimeLog(`beforeExit pid=${process.pid} code=${code}`);
  state.recordEvent("before_exit", { pid: process.pid, code });
});
process.on("exit", (code) => {
  trace(`exit pid=${process.pid} code=${code}`);
  runtimeLog(`exit pid=${process.pid} code=${code}`);
  state.recordEvent("exit", { pid: process.pid, code });
});
process.on("SIGTERM", () => {
  trace(`signal pid=${process.pid} sig=SIGTERM`);
  runtimeLog(`signal pid=${process.pid} sig=SIGTERM`);
  state.recordEvent("signal", { pid: process.pid, signal: "SIGTERM" });
});
process.on("SIGINT", () => {
  trace(`signal pid=${process.pid} sig=SIGINT`);
  runtimeLog(`signal pid=${process.pid} sig=SIGINT`);
  state.recordEvent("signal", { pid: process.pid, signal: "SIGINT" });
});
