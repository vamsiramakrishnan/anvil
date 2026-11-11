// jwa calls this to compare two Buffers in constant time. Node's own timingSafeEqual does the
// comparison; it throws on a length mismatch, so lengths are checked first, as the original did.
const { timingSafeEqual } = require("node:crypto");

module.exports = function bufferEqual(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);
};
