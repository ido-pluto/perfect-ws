import { describe, it, expect } from 'vitest';
import { serializeWith } from './utils/serializeWith.js';
import { getProperty } from '../src/PerfectWSAdvanced/transform/utils/getProperty.ts';
import { TransformCircularObjects } from '../src/PerfectWSAdvanced/transform/TransformCircularObjects.ts';

describe('getProperty', () => {
    it('reads a nested dot-path', () => {
        const obj = { a: { b: { c: 42 } } };
        expect(getProperty(obj, 'a.b.c')).toBe(42);
    });

    it('reads array entries via numeric-string segments', () => {
        const obj = { items: [{ name: 'first' }, { name: 'second' }] };
        expect(getProperty(obj, 'items.1.name')).toBe('second');
    });

    it('returns undefined for a path that does not exist', () => {
        const obj = { a: { b: 1 } };
        expect(getProperty(obj, 'a.missing')).toBeUndefined();
        expect(getProperty(obj, 'a.b.c')).toBeUndefined();
    });

    it('returns undefined when traversing through a non-object value', () => {
        const obj = { a: 5 };
        expect(getProperty(obj, 'a.b')).toBeUndefined();
    });

    it('returns undefined for the root object itself (empty-segment edge case) rather than throwing', () => {
        expect(getProperty(null, 'a')).toBeUndefined();
        expect(getProperty(undefined, 'a')).toBeUndefined();
    });

    describe('prototype pollution guard', () => {
        it('refuses to read __proto__ at any position in the path', () => {
            const obj: any = { a: { b: 1 } };

            expect(getProperty(obj, '__proto__')).toBeUndefined();
            expect(getProperty(obj, '__proto__.polluted')).toBeUndefined();
            expect(getProperty(obj, 'a.__proto__')).toBeUndefined();
            expect(getProperty(obj, 'a.__proto__.polluted')).toBeUndefined();
        });

        it('refuses to read "constructor" or "prototype" segments', () => {
            const obj = { a: { b: 1 } };

            expect(getProperty(obj, 'constructor')).toBeUndefined();
            expect(getProperty(obj, 'constructor.prototype')).toBeUndefined();
            expect(getProperty(obj, 'a.constructor')).toBeUndefined();
            expect(getProperty(obj, 'a.constructor.prototype.polluted')).toBeUndefined();
        });

        it('does not let a crafted path reach a real object own-property literally named __proto__', () => {
            // Own property (not the prototype link) - e.g. from JSON.parse of an
            // attacker-controlled payload. Still guarded, since traversal is refused
            // for the segment itself, independent of what it would resolve to.
            const obj = JSON.parse('{"a":{"__proto__":{"polluted":true}}}');
            expect(Object.prototype.hasOwnProperty.call(obj.a, '__proto__')).toBe(true);

            expect(getProperty(obj, 'a.__proto__')).toBeUndefined();
            expect(getProperty(obj, 'a.__proto__.polluted')).toBeUndefined();
        });
    });
});

describe('TransformCircularObjects.deserialize - refPath guard', () => {
    it('resolves a legitimate circular reference produced by serialize()', () => {
        const transform = new TransformCircularObjects();
        const original: any = { name: 'root', child: {} };
        original.child.parent = original;

        const serialized = serializeWith(transform, original);
        expect(serialized.child.parent).toEqual({ ___perfectWS: 1, ___type: 'circularRef', refPath: [] });

        const deserialized = transform.deserialize(serialized);

        expect(deserialized.name).toBe('root');
        expect(deserialized.child.parent).toBe(deserialized);
    });

    it('a crafted circularRef marker with a __proto__ refPath is left unresolved instead of polluting the prototype', () => {
        const transform = new TransformCircularObjects();

        // Simulates a tampered/malicious peer sending a circularRef marker directly,
        // bypassing this library's own serialize() entirely.
        const malicious = { name: 'x', ref: { ___perfectWS: 1, ___type: 'circularRef', refPath: '__proto__.polluted' } };
        const result = transform.deserialize(malicious);

        // getProperty's guard returns undefined for the forbidden segment, and
        // transformSendRecursive only swaps in a replacement when the resolver returns
        // a non-nullish value - so the raw, unresolved marker is left in place rather
        // than the prototype being touched.
        expect(result.ref).toEqual({ ___perfectWS: 1, ___type: 'circularRef', refPath: '__proto__.polluted' });
        expect(({} as any).polluted).toBeUndefined();
        expect((Object.prototype as any).polluted).toBeUndefined();
    });
});
