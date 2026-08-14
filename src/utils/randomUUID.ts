/**
 * `crypto.randomUUID()` is only exposed in secure contexts, so a browser client served over
 * plain http - a LAN tool, a device on the local network, an intranet page - has a `crypto`
 * object but no `randomUUID` on it, and calling it throws.
 *
 * These ids only have to be unique within a connection (request ids, packet ids, callback
 * ids); they are not secrets and nothing authenticates against them, so degrading to
 * `Math.random` when no CSPRNG is reachable is safe.
 */
export function randomUUID(): string {
    const webCrypto: Crypto | undefined = typeof globalThis.crypto === 'undefined' ? undefined : globalThis.crypto;

    if (typeof webCrypto?.randomUUID === 'function') {
        return webCrypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (typeof webCrypto?.getRandomValues === 'function') {
        webCrypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }

    // RFC 4122 section 4.4 - pin the version (4) and variant bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
    return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join('')
    ].join('-');
}
