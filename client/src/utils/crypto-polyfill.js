/**
 * Polyfill crypto.randomUUID for non-secure contexts (HTTP via IP, older browsers).
 * Privy SDK requires this at module load time.
 */
(function polyfillRandomUUID() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.randomUUID === 'function') {
    return;
  }

  cryptoObj.randomUUID = function randomUUID() {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
})();

export {};
