import { describe, it, expect } from 'vitest';
import { BSON } from 'bson';
import { TransformNativeTypes } from '../src/PerfectWSAdvanced/transform/TransformNativeTypes.js';
import { serializeWith } from './utils/serializeWith.js';

/** Round trip through BSON, the way the protocol actually ships a payload. */
function roundTrip(value: any, transform = new TransformNativeTypes()) {
    const serialized = serializeWith(transform, { payload: value });
    const overTheWire = BSON.deserialize(BSON.serialize(serialized));
    return transform.deserialize(overTheWire).payload;
}

describe('TransformNativeTypes', () => {
    describe('Set', () => {
        it('survives BSON, which otherwise flattens a Set to {}', () => {
            expect(BSON.deserialize(BSON.serialize({ payload: new Set([1, 2]) })).payload).toEqual({});

            const result = roundTrip(new Set([1, 'two', true]));
            expect(result).toBeInstanceOf(Set);
            expect([...result]).toEqual([1, 'two', true]);
        });

        it('handles an empty Set', () => {
            const result = roundTrip(new Set());
            expect(result).toBeInstanceOf(Set);
            expect(result.size).toBe(0);
        });

        it('handles a Set nested inside an object', () => {
            const result = roundTrip({ tags: new Set(['a', 'b']) });
            expect(result.tags).toBeInstanceOf(Set);
            expect([...result.tags]).toEqual(['a', 'b']);
        });
    });

    describe('Map', () => {
        it('keeps non-string keys that BSON would drop', () => {
            const result = roundTrip(new Map<any, any>([['a', 1], [2, 'b'], [true, 'c']]));

            expect(result).toBeInstanceOf(Map);
            expect(result.get('a')).toBe(1);
            expect(result.get(2)).toBe('b');
            expect(result.get(true)).toBe('c');
        });

        it('handles an empty Map', () => {
            const result = roundTrip(new Map());
            expect(result).toBeInstanceOf(Map);
            expect(result.size).toBe(0);
        });

        it('handles a Map holding object values', () => {
            const result = roundTrip(new Map([['user', { name: 'ada', age: 36 }]]));
            expect(result.get('user')).toEqual({ name: 'ada', age: 36 });
        });
    });

    describe('BigInt', () => {
        it('stays a bigint, where BSON hands back a Long instance', () => {
            const big = 9007199254740993n;
            expect(BSON.deserialize(BSON.serialize({ payload: big })).payload).not.toBe(big);

            expect(roundTrip({ big }).big).toBe(big);
            expect(typeof roundTrip({ big }).big).toBe('bigint');
        });

        it('handles zero and negative values', () => {
            expect(roundTrip({ a: 0n, b: -42n })).toEqual({ a: 0n, b: -42n });
        });

        it('handles a BigInt at the top of the payload', () => {
            expect(roundTrip(123n)).toBe(123n);
        });
    });

    describe('Error', () => {
        it('carries name, message and stack across', () => {
            const original = new Error('something broke');
            const result = roundTrip(original);

            expect(result).toBeInstanceOf(Error);
            expect(result.name).toBe('Error');
            expect(result.message).toBe('something broke');
            expect(result.stack).toBe(original.stack);
        });

        it('restores the original error subclass', () => {
            expect(roundTrip(new TypeError('bad type'))).toBeInstanceOf(TypeError);
            expect(roundTrip(new RangeError('out of range'))).toBeInstanceOf(RangeError);
        });

        it('carries own enumerable properties such as code', () => {
            const result = roundTrip(Object.assign(new Error('nope'), { code: 'ENOENT', status: 404 }));
            expect(result.code).toBe('ENOENT');
            expect(result.status).toBe(404);
        });

        it('falls back to Error for an unknown error name', () => {
            class CustomError extends Error {
                override name = 'CustomError';
            }

            const result = roundTrip(new CustomError('custom'));
            expect(result).toBeInstanceOf(Error);
            expect(result.name).toBe('CustomError');
            expect(result.message).toBe('custom');
        });
    });

    describe('numbers', () => {
        // BSON already carries these as doubles, so this transform deliberately stays out of
        // the way rather than paying to visit every number in a payload.
        it('leaves NaN and the infinities to BSON, which handles them', () => {
            const result = roundTrip({ a: NaN, b: Infinity, c: -Infinity });

            expect(result.a).toBeNaN();
            expect(result.b).toBe(Infinity);
            expect(result.c).toBe(-Infinity);
        });

        it('leaves ordinary numbers alone', () => {
            expect(roundTrip({ a: 0, b: -1.5, c: 42 })).toEqual({ a: 0, b: -1.5, c: 42 });
        });
    });

    describe('URL', () => {
        it('round trips as a URL rather than {}', () => {
            const result = roundTrip(new URL('https://example.com/a/b?c=1#d'));
            expect(result).toBeInstanceOf(URL);
            expect(result.href).toBe('https://example.com/a/b?c=1#d');
        });
    });

    describe('nesting', () => {
        it('handles native types inside each other', () => {
            const result = roundTrip(new Map<any, any>([
                ['set', new Set([1n, NaN])],
                ['err', new TypeError('inner')]
            ]));

            const set = [...result.get('set')];
            expect(set[0]).toBe(1n);
            expect(set[1]).toBeNaN();
            expect(result.get('err')).toBeInstanceOf(TypeError);
        });

        it('handles a Map inside a plain object inside a Set', () => {
            const result = roundTrip(new Set([{ inner: new Map([['k', 1n]]) }]));
            expect([...result][0].inner.get('k')).toBe(1n);
        });
    });

    describe('pass through', () => {
        it('leaves values it does not own untouched', () => {
            const date = new Date(0);
            const result = roundTrip({ date, s: 'x', n: 1, b: true, nil: null, arr: [1, 2] });

            expect(result.date).toEqual(date);
            expect(result.s).toBe('x');
            expect(result.arr).toEqual([1, 2]);
            expect(result.nil).toBeNull();
        });

        it('does not mutate the value it was given', () => {
            const original = { set: new Set([1]) };
            serializeWith(new TransformNativeTypes(), { payload: original });

            expect(original.set).toBeInstanceOf(Set);
        });

        it('returns primitive roots from deserialize untouched', () => {
            const transform = new TransformNativeTypes();

            expect(transform.deserialize(null)).toBeNull();
            expect(transform.deserialize(undefined)).toBeUndefined();
            expect(transform.deserialize('hello')).toBe('hello');
            expect(transform.deserialize(42)).toBe(42);
        });
    });
});
