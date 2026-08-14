import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from '../src/utils/randomUUID.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUUID', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('produces a v4 uuid', () => {
        expect(randomUUID()).toMatch(UUID_V4);
    });

    it('does not repeat', () => {
        const ids = new Set(Array.from({ length: 500 }, () => randomUUID()));
        expect(ids.size).toBe(500);
    });

    // A browser on plain http has `crypto` but no `randomUUID` - it is secure context only.
    it('falls back to getRandomValues when randomUUID is missing', () => {
        const getRandomValues = vi.fn((bytes: Uint8Array) => {
            bytes.fill(0xab);
            return bytes;
        });
        vi.stubGlobal('crypto', { getRandomValues });

        const id = randomUUID();

        expect(getRandomValues).toHaveBeenCalledOnce();
        expect(id).toMatch(UUID_V4);
    });

    it('falls back to Math.random when no crypto is reachable at all', () => {
        vi.stubGlobal('crypto', undefined);

        expect(randomUUID()).toMatch(UUID_V4);
        expect(new Set(Array.from({ length: 200 }, () => randomUUID())).size).toBe(200);
    });

    it('pins the version and variant bits even on the fallback path', () => {
        // All-zero bytes would give a nil uuid if the bits were not forced.
        vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });

        const id = randomUUID();

        expect(id).toBe('00000000-0000-4000-8000-000000000000');
        expect(id).toMatch(UUID_V4);
    });
});
