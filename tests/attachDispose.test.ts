import { describe, expect, it, vi } from 'vitest';
import { attachDispose } from '../src/utils/attachDispose.js';

describe('attachDispose', () => {
    it('adds an idempotent disposer to a plain object and preserves its data', () => {
        const existing = vi.fn();
        const release = vi.fn();
        const source = { value: 42, [Symbol.dispose]: existing };

        const result = attachDispose(source, release);
        result[Symbol.dispose]();
        result[Symbol.dispose]();

        expect(result).not.toBe(source);
        expect(result.value).toBe(42);
        expect(existing).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
    });

    it('awaits an existing async disposer before releasing the request', async () => {
        const order: string[] = [];
        const source = Object.assign([], {
            [Symbol.asyncDispose]: async () => {
                await Promise.resolve();
                order.push('existing');
            }
        });

        const result = attachDispose(source, () => { order.push('request'); });
        await result[Symbol.asyncDispose]();

        expect(result).toBe(source);
        expect(order).toEqual(['existing', 'request']);
    });

    it('releases the request even when the existing disposer throws', () => {
        const release = vi.fn();
        const source = Object.assign([], {
            [Symbol.dispose]: () => { throw new Error('dispose failed'); }
        });
        const result = attachDispose(source, release);

        expect(() => result[Symbol.dispose]()).toThrow('dispose failed');
        expect(release).toHaveBeenCalledOnce();
    });

    it.each([null, undefined, 1, 'value', true])('rejects non-disposable primitive response %p', (value) => {
        expect(() => attachDispose(value, vi.fn())).toThrow(/object or function response/);
    });

    it('fails clearly instead of returning an object without a disposer when properties cannot be defined', () => {
        const frozen: any[] = Object.freeze([]);
        expect(() => attachDispose(frozen, vi.fn())).toThrow(/Could not attach Symbol\.dispose/);
    });
});
