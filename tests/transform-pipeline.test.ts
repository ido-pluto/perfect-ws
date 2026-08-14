import { describe, it, expect } from 'vitest';
import { BSON } from 'bson';
import { TransformAll } from '../src/PerfectWSAdvanced/TransformAll.js';
import { TransformBinaryData } from '../src/PerfectWSAdvanced/transform/TransformBinaryData.js';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.js';
import { PerfectWSError } from '../src/PerfectWSError.js';
import { PureRPC } from '../src/PerfectWSAdvanced/PureRPC.js';
import { serializeWith } from './utils/serializeWith.js';
import { PureValueClone } from '../src/PerfectWSAdvanced/transform/utils/PureValueClone.js';
import { SerializationTransaction } from '../src/PerfectWSAdvanced/transform/utils/changeType.js';
import { TransformInstruction } from '../src/PerfectWSAdvanced/transform/CustomTransformers.js';

const newTransformAll = (maxDepth = 100, maxMessageSize?: number) =>
    new TransformAll({ events: new NetworkEventListener(), maxDepth, maxMessageSize });

/** Serialize on one peer, cross BSON, and deserialize on the other peer. */
function roundTrip(value: any, sender = newTransformAll(), receiver = newTransformAll()) {
    const serialized = sender.serialize(value);
    return receiver.deserialize(BSON.deserialize(BSON.serialize(serialized)));
}

describe('transform pipeline', () => {
    describe('transforms compose instead of overwriting each other', () => {
        it('preserves repeated transformed values and mutual Map/Set cycles', () => {
            class Box { constructor(public value: number) { } }
            class BoxTransform extends TransformInstruction<Box> {
                uniqueId = 'box';
                check(value: unknown): value is Box { return value instanceof Box; }
                serialize(value: Box) { return value.value; }
                deserialize(value: number) { return new Box(value); }
            }

            const sharedSet = new Set([1]);
            const sharedBytes = new Uint8Array([4, 5]);
            const sharedBox = new Box(6);
            const mutualMap = new Map<string, unknown>();
            const mutualSet = new Set<unknown>();
            mutualMap.set('set', mutualSet);
            mutualSet.add(mutualMap);
            const sender = new TransformAll({ events: new NetworkEventListener(), transformers: [new BoxTransform()] });
            const receiver = new TransformAll({ events: new NetworkEventListener(), transformers: [new BoxTransform()] });

            const result = roundTrip({
                values: new Map([
                    ['set-1', sharedSet], ['set-2', sharedSet], ['set-3', sharedSet],
                    ['bytes-1', sharedBytes], ['bytes-2', sharedBytes],
                    ['box-1', sharedBox], ['box-2', sharedBox],
                ]),
                mutualMap,
                mutualSet,
            }, sender, receiver);

            expect(result.values.get('set-1')).toBe(result.values.get('set-2'));
            expect(result.values.get('set-2')).toBe(result.values.get('set-3'));
            expect(result.values.get('bytes-1')).toBe(result.values.get('bytes-2'));
            expect(result.values.get('box-1')).toBe(result.values.get('box-2'));
            expect(result.values.get('box-1')).toBeInstanceOf(Box);
            expect(result.mutualMap.get('set')).toBe(result.mutualSet);
            expect(result.mutualSet.has(result.mutualMap)).toBe(true);
        });

        it('preserves shared identity for native object values', () => {
            const sparse: any[] = [];
            sparse[2] = 'sparse';
            const named: any = [1];
            named.extra = true;
            const nullObject = Object.assign(Object.create(null), { value: 1 });
            for (const value of [new Date(123), new URL('https://example.com/a'), /shared/giy, sparse, named, nullObject]) {
                const result = roundTrip({ first: value, second: value });
                expect(result.first).toBe(result.second);
            }
        });

        it('keeps decimal array properties beyond the JavaScript index range', () => {
            const value: any[] = ['zero'];
            value[4_294_967_294] = 'last index';
            value['4294967295' as any] = 'named max';
            value['4294967296' as any] = 'named over';

            const result: any[] = roundTrip(value);
            expect(result[0]).toBe('zero');
            expect(result[4_294_967_294]).toBe('last index');
            expect((result as any)['4294967295']).toBe('named max');
            expect((result as any)['4294967296']).toBe('named over');
        });

        // A later pass used to rebuild the clone tree from the original and wipe the markers
        // earlier passes had written, which silently dropped nested binary data.
        it('keeps a nested binary marker through every later pass', () => {
            const serialized = newTransformAll().serialize({ data: { buf: new Uint8Array([1, 2, 3]) } });

            expect(serialized.data.buf).toHaveProperty('___type', 'binaryData');
            expect(serialized.data.buf).toHaveProperty('type', 'Uint8Array');
        });

        it('round trips nested binary data back to the same bytes', () => {
            const result = roundTrip({ level1: { level2: { buf: new Uint8Array([9, 8, 7]) } } });

            expect(result.level1.level2.buf).toBeInstanceOf(Uint8Array);
            expect([...result.level1.level2.buf]).toEqual([9, 8, 7]);
        });

        // A later transform walks into an earlier transform's marker, so values that only
        // exist inside one - a Map's entries, a custom transformer's payload - still convert.
        it('converts a Buffer stored inside a Map', () => {
            const result = roundTrip({ files: new Map([['a.bin', new Uint8Array([1, 2, 3])]]) });

            expect(result.files).toBeInstanceOf(Map);
            expect(result.files.get('a.bin')).toBeInstanceOf(Uint8Array);
            expect([...result.files.get('a.bin')]).toEqual([1, 2, 3]);
        });

        it('converts a function stored inside a Map', () => {
            const serialized = newTransformAll().serialize({ handlers: new Map([['onDone', () => 'hi']]) });

            expect(serialized.handlers).toHaveProperty('___type', 'map');
            expect(serialized.handlers.entries[0][1]).toHaveProperty('___type', 'callback');
        });

        it('converts an AbortSignal stored inside a Set', () => {
            const serialized = newTransformAll().serialize({ signals: new Set([new AbortController().signal]) });

            expect(serialized.signals.values[0]).toHaveProperty('___type', 'abortSignal');
        });

        it('fully transforms the reason of an already-aborted signal', () => {
            const reason: any = { values: new Map([[2, new Uint8Array([7, 8])]]) };
            reason.self = reason;
            Object.defineProperty(reason, 'locked', {
                value: 4,
                writable: false,
                enumerable: true,
                configurable: true,
            });
            const controller = new AbortController();
            controller.abort(reason);

            const result = roundTrip(controller.signal) as AbortSignal;

            expect(result.aborted).toBe(true);
            expect(result.reason.self).toBe(result.reason);
            expect(result.reason.values).toBeInstanceOf(Map);
            expect(result.reason.values.get(2)).toEqual(new Uint8Array([7, 8]));
            expect(Object.getOwnPropertyDescriptor(result.reason, 'locked')?.writable).toBe(false);
        });

        it('reuses the same already-aborted signal across retained transform calls', () => {
            const sender = newTransformAll();
            const receiver = newTransformAll();
            const controller = new AbortController();
            controller.abort('done');
            const transfer = () => receiver.deserialize(BSON.deserialize(BSON.serialize(sender.serialize(controller.signal))));

            expect(transfer()).toBe(transfer());
        });

        it('does not mutate a class instance stored inside a Map', () => {
            class Holder {
                buf = new Uint8Array([1, 2]);
            }

            const holder = new Holder();
            newTransformAll().serialize({ m: new Map([['h', holder]]) });

            expect(holder.buf).toBeInstanceOf(Uint8Array);
        });

        it('converts a symbol key on an object stored inside a Map', () => {
            const key = Symbol.for('tag');
            const result = roundTrip({ m: new Map([['k', { [key]: 'v', plain: 2 }]]) });

            expect(result.m.get('k')[key]).toBe('v');
            expect(result.m.get('k').plain).toBe(2);
        });

        it('converts a symbol key inside a descriptor marker\'s captured value', () => {
            const key = Symbol.for('deep');
            const outer: any = {};
            Object.defineProperty(outer, 'locked', {
                value: { [key]: 9 },
                writable: false,
                enumerable: true,
                configurable: true
            });

            const serialized = newTransformAll().serialize({ o: outer });

            expect(serialized.o.locked.descriptor.value.___symbol).toEqual({
                ___perfectWS: 1,
                ___type: 'symbol',
                symbolKey: 'deep',
                value: 9,
            });
        });

        it('converts a Buffer stored inside a Set', () => {
            const result = roundTrip({ blobs: new Set([new Uint8Array([7])]) });

            expect([...result.blobs][0]).toBeInstanceOf(Uint8Array);
            expect([...[...result.blobs][0]]).toEqual([7]);
        });

        it('keeps binary and callback markers side by side at different depths', () => {
            const serialized = newTransformAll().serialize({
                a: { buf: new Uint8Array([1]) },
                b: { fn: () => 'x' }
            });

            expect(serialized.a.buf).toHaveProperty('___type', 'binaryData');
            expect(serialized.b.fn).toHaveProperty('___type', 'callback');
        });
    });

    describe('does not mutate the caller\'s data', () => {
        it('does not execute an own constructor property while cloning', () => {
            let calls = 0;
            const value = {
                constructor() {
                    calls++;
                },
                nested: { value: 1 },
            };

            const serialized = newTransformAll().serialize(value);

            expect(calls).toBe(0);
            expect(serialized.nested).toEqual({ value: 1 });
        });

        it('leaves a plain object untouched', () => {
            const original = { data: { buf: new Uint8Array([1, 2, 3]), keep: 'me' } };
            const buf = original.data.buf;

            newTransformAll().serialize(original);

            expect(original.data.buf).toBe(buf);
            expect(original.data.buf).toBeInstanceOf(Uint8Array);
            expect(original.data.keep).toBe('me');
        });

        // A class instance cannot be cloned, so the walker has to pass it through rather than
        // write markers into the caller's own object.
        it('leaves a class instance untouched', () => {
            class Holder {
                buf = new Uint8Array([4, 5]);
                nested = { deep: true };
            }

            const holder = new Holder();
            newTransformAll().serialize({ holder });

            expect(holder.buf).toBeInstanceOf(Uint8Array);
            expect(holder.nested).toEqual({ deep: true });
        });

        it('leaves an AbortSignal\'s internals untouched', () => {
            const controller = new AbortController();
            newTransformAll().serialize({ signal: controller.signal });

            let fired = false;
            controller.signal.addEventListener('abort', () => { fired = true; });
            controller.abort();

            expect(fired).toBe(true);
        });
    });

    describe('primitive roots', () => {
        // Response payloads are deserialized on their own, so the root is regularly a
        // primitive rather than an object.
        it('passes primitives straight through deserialize', () => {
            const transformAll = newTransformAll();

            expect(transformAll.deserialize(null)).toBeNull();
            expect(transformAll.deserialize(undefined)).toBeUndefined();
            expect(transformAll.deserialize('hello')).toBe('hello');
            expect(transformAll.deserialize(42)).toBe(42);
            expect(transformAll.deserialize(false)).toBe(false);
            expect(transformAll.deserialize(0)).toBe(0);
        });

        it('passes an array root through deserialize', () => {
            expect(newTransformAll().deserialize([1, 'a', null])).toEqual([1, 'a', null]);
        });
    });

    describe('deserialize ordering', () => {
        // Symbols have to be restored before circular refs resolve, otherwise a ref path
        // addressing a symbol key points at a key that does not exist yet.
        it('resolves a circular ref that points through a registered symbol key', () => {
            const key = Symbol.for('branch');
            const root: any = { name: 'root' };
            root[key] = { back: root };

            const result = roundTrip(root);

            expect(result[key].back).toBe(result);
        });

        it('restores a registered symbol key', () => {
            const result = roundTrip({ [Symbol.for('tag')]: 'value', plain: 1 });

            expect(result[Symbol.for('tag')]).toBe('value');
            expect(result.plain).toBe(1);
        });

        it('does not overwrite a string property with the same name as a symbol key', () => {
            const result = roundTrip({
                tag: 'string value',
                [Symbol.for('tag')]: 'symbol value'
            });

            expect(result.tag).toBe('string value');
            expect(result[Symbol.for('tag')]).toBe('symbol value');
        });

        it('resolves a plain circular reference', () => {
            const root: any = { name: 'root', child: {} };
            root.child.parent = root;

            const result = roundTrip(root);

            expect(result.child.parent).toBe(result);
            expect(result.name).toBe('root');
        });

        it('preserves self-references in Maps and Sets', () => {
            const map = new Map<string, any>();
            map.set('self', map);
            const set = new Set<any>();
            set.add(set);

            const result = roundTrip({ map, set });

            expect(result.map.get('self')).toBe(result.map);
            expect(result.set.has(result.set)).toBe(true);
        });

        it('preserves shared identity across objects, Maps, and Sets', () => {
            const shared = { value: 1 };
            const result = roundTrip({
                shared,
                map: new Map([['shared', shared]]),
                set: new Set([shared]),
            });

            expect(result.map.get('shared')).toBe(result.shared);
            expect([...result.set][0]).toBe(result.shared);
        });

        it('preserves an empty-string root property separately from the root sentinel', () => {
            const child: any = { value: 1 };
            child.self = child;
            const result = roundTrip({ '': child, again: child });

            expect(result[''].self).toBe(result['']);
            expect(result.again).toBe(result['']);
        });

        it('preserves undefined and registered or well-known symbol values through BSON', () => {
            const global = Symbol.for('value-symbol');
            const result = roundTrip({
                missing: undefined,
                array: [undefined],
                map: new Map<any, any>([[undefined, 'undefined'], [null, 'null'], [global, Symbol.iterator]]),
                set: new Set<any>([undefined, null, global, Symbol.iterator]),
            });

            expect(Object.hasOwn(result, 'missing')).toBe(true);
            expect(result.missing).toBeUndefined();
            expect(result.array).toEqual([undefined]);
            expect(result.map.get(undefined)).toBe('undefined');
            expect(result.map.get(null)).toBe('null');
            expect(result.map.get(global)).toBe(Symbol.iterator);
            expect(result.set).toEqual(new Set([undefined, null, global, Symbol.iterator]));
        });

        it('preserves every RegExp flag and lastIndex', () => {
            const source = /abc/dgimsuy;
            source.lastIndex = 3;

            const result = roundTrip(source) as RegExp;

            expect(result.source).toBe(source.source);
            expect(result.flags).toBe(source.flags);
            expect(result.lastIndex).toBe(3);

            const unicodeSets = roundTrip(new RegExp('x', 'v')) as RegExp;
            expect(unicodeSets.flags).toContain('v');
        });

        it('preserves own properties and accessors on built-in values without invoking getters', () => {
            const getter = vi.fn(() => 7);
            const values: any[] = [
                new Map([['key', 'value']]),
                new Set([1]),
                /built-in/gi,
                new URL('https://example.com/path'),
                new Date(1_700_000_000_000),
                new TypeError('problem'),
                new Uint16Array([3, 4]),
                new DataView(new Uint8Array([5, 6]).buffer),
            ];
            for (const value of values) {
                value.extra = 'visible';
                Object.defineProperty(value, 'hidden', { value: 9, enumerable: false, writable: false, configurable: true });
                Object.defineProperty(value, 'computed', { get: getter, enumerable: true, configurable: true });
            }

            const result = roundTrip({ values }).values;

            expect(getter).not.toHaveBeenCalled();
            expect(result[0]).toBeInstanceOf(Map);
            expect(result[1]).toBeInstanceOf(Set);
            expect(result[2]).toBeInstanceOf(RegExp);
            expect(result[3]).toBeInstanceOf(URL);
            expect(result[4]).toBeInstanceOf(Date);
            expect(result[5]).toBeInstanceOf(TypeError);
            expect(result[6]).toBeInstanceOf(Uint16Array);
            expect(result[7]).toBeInstanceOf(DataView);
            for (const value of result) {
                expect(value.extra).toBe('visible');
                expect(Object.getOwnPropertyDescriptor(value, 'hidden')).toMatchObject({ value: 9, enumerable: false, writable: false });
                expect(Object.getOwnPropertyDescriptor(value, 'computed')?.get).toBeTypeOf('function');
            }
        });
    });

    describe('wire marker safety', () => {
        it('escapes valid marker-shaped application objects instead of activating them', () => {
            const values = [
                { ___perfectWS: 1, ___type: 'bigint', value: '123' },
                { ___perfectWS: 1, ___type: 'map', entries: [[1, 2]] },
                { ___perfectWS: 1, ___type: 'callback', funcId: 'application-id', funcName: 'plain' },
            ];

            const result = roundTrip({ values }).values;

            expect(result).toEqual(values);
            expect(typeof result[0]).toBe('object');
            expect(result[1]).not.toBeInstanceOf(Map);
            expect(typeof result[2]).not.toBe('function');
        });

        it('escapes marker-shaped values introduced by containers and later transforms', () => {
            class MarkerBox { }
            const marker = { ___perfectWS: 1, ___type: 'bigint', value: '123' };
            const error = new Error('marker');
            (error as any).payload = marker;
            const controller = new AbortController();
            controller.abort(marker);
            class MarkerTransform extends TransformInstruction<MarkerBox> {
                uniqueId = 'marker-box';
                check(value: unknown): value is MarkerBox { return value instanceof MarkerBox; }
                serialize() { return marker; }
                deserialize(value: any) { return value; }
            }
            const sender = new TransformAll({ events: new NetworkEventListener(), transformers: [new MarkerTransform()] });
            const receiver = new TransformAll({ events: new NetworkEventListener(), transformers: [new MarkerTransform()] });

            const result = roundTrip({
                map: new Map([['value', marker]]),
                set: new Set([marker]),
                error,
                signal: controller.signal,
                custom: new MarkerBox(),
            }, sender, receiver);

            expect(result.map.get('value')).toEqual(marker);
            expect([...result.set]).toEqual([marker]);
            expect(result.error.payload).toEqual(marker);
            expect(result.signal.reason).toEqual(marker);
            expect(result.custom).toEqual(marker);
        });

        it('escapes marker-shaped Map values at the configured depth boundary', () => {
            const marker = { ___perfectWS: 1, ___type: 'bigint', value: '123' };
            const result = roundTrip(
                { map: new Map([['value', marker]]) },
                newTransformAll(3),
                newTransformAll(3),
            );

            expect(result.map.get('value')).toEqual(marker);
            expect(typeof result.map.get('value')).toBe('object');
        });

        it('does not invoke shadowed Map or Set methods while decoding markers', () => {
            const marker = { ___perfectWS: 1, ___type: 'bigint', value: '123' };
            const map: any = new Map([['value', marker]]);
            const set: any = new Set([marker]);
            for (const key of ['clear', 'set']) Object.defineProperty(map, key, { value: 'blocked', enumerable: true });
            for (const key of ['clear', 'add']) Object.defineProperty(set, key, { value: 'blocked', enumerable: true });

            const result = roundTrip({ map, set });
            expect(Map.prototype.get.call(result.map, 'value')).toEqual(marker);
            expect([...Set.prototype.values.call(result.set)]).toEqual([marker]);
        });

        it('preserves marker-shaped aliases and self cycles', () => {
            const marker: any = { ___perfectWS: 1, ___type: 'bigint', value: '123' };
            marker.self = marker;
            const result = roundTrip({ marker, alias: marker });

            expect(result.marker).toBe(result.alias);
            expect(result.marker.self).toBe(result.marker);
            expect(typeof result.marker).toBe('object');
        });

        it('bounds hostile marker decoding and keeps a root descriptor marker inert', () => {
            const receiver = new TransformAll({ events: new NetworkEventListener(), maxDepth: 10 });
            let deep: any = { value: true };
            for (let index = 0; index < 5_000; index++) deep = { child: deep };
            expect(() => receiver.deserialize(deep)).not.toThrow();

            const rootDescriptor = {
                ___perfectWS: 1,
                ___type: 'descriptor',
                descriptor: { configurable: true, enumerable: true, get: () => 'unexpected' },
            };
            expect(receiver.deserialize(rootDescriptor)).toBe(rootDescriptor);
        });

        it('leaves ordinary objects with marker-like ___type fields untouched', () => {
            const values = [
                { ___type: 'map', entries: null },
                { ___type: 'set', values: ['ordinary'] },
                { ___type: 'bigint', value: 'not-a-bigint' },
            ];

            expect(roundTrip({ values }).values).toEqual(values);
        });

        it('leaves malformed namespaced markers untouched instead of throwing', () => {
            const values = [
                { ___perfectWS: 1, ___type: 'map', entries: null },
                { ___perfectWS: 1, ___type: 'set', values: null },
                { ___perfectWS: 1, ___type: 'bigint', value: 'invalid' },
                { ___perfectWS: 1, ___type: 'descriptor', descriptor: null },
            ];

            expect(() => roundTrip({ values })).not.toThrow();
            expect(roundTrip({ values }).values).toEqual(values);
        });
    });

    describe('serialization transactions', () => {
        const liveTransform = () => new TransformAll({
            events: new NetworkEventListener(),
            fullTrustedRPC: true,
        });

        it('rolls back callbacks, signals, and handles from an unsent message', () => {
            const transform = liveTransform() as any;
            const prepared = transform.prepareSerialize({
                callback: () => undefined,
                signal: new AbortController().signal,
                handle: new PureRPC({ value: 1 }),
            });

            expect(transform._callbacks._functions.size).toBe(2);
            expect(transform._pureRPC._registry.size).toBe(1);

            prepared.rollback();
            prepared.rollback();

            expect(transform._callbacks._functions).toBeUndefined();
            expect(transform._pureRPC._registry.size).toBe(0);
            expect(transform.hasLiveState()).toBe(false);
        });

        it('does not roll back a shared callback committed by another message', () => {
            const transform = liveTransform() as any;
            const callback = () => undefined;
            const first = transform.prepareSerialize(callback);
            const second = transform.prepareSerialize(callback);

            second.commit();
            second.commit();
            first.rollback();

            expect(transform._callbacks._functions.size).toBe(1);
            transform.releaseAll();
        });

        it('keeps the newest committed lease when one message contains callback aliases', () => {
            const events = new NetworkEventListener();
            const transform = new TransformAll({ events }) as any;
            const callback = () => undefined;
            const committed = transform.prepareSerialize({ first: callback, second: callback });
            const funcId = committed.data.first.funcId;

            expect(committed.data.second.funcId).toBe(funcId);
            const newestLease = Math.max(committed.data.first.lease, committed.data.second.lease);
            expect(newestLease).toBeGreaterThan(Math.min(committed.data.first.lease, committed.data.second.lease));
            committed.commit();

            const rolledBack = transform.prepareSerialize(callback);
            rolledBack.rollback();
            events._emitWithSource('___callback.release', 'remote', {
                funcId,
                lease: newestLease,
            });

            expect(transform._callbacks.hasLiveState()).toBe(false);
            transform.releaseAll();
        });

        it('does not revive a callback released before a stale transaction commits', () => {
            const events = new NetworkEventListener();
            const transform = new TransformAll({ events }) as any;
            const callback = () => undefined;
            const transaction = new SerializationTransaction();
            const clone = new PureValueClone(callback);
            transform._callbacks.serialize(clone, transaction);
            const funcId = clone.cloneRoot.root.funcId;

            events._emitWithSource('___callback.release', 'remote', { funcId });
            transaction.commit();

            expect(transform._callbacks.hasLiveState()).toBe(false);
            transform.releaseAll();
        });
    });

    describe('accessors', () => {
        it('does not invoke accessors while serializing or deserializing', () => {
            const getter = vi.fn(() => 7);
            const source: any = {};
            Object.defineProperty(source, 'value', { get: getter, enumerable: true, configurable: true });

            const result = roundTrip({ source });

            expect(getter).not.toHaveBeenCalled();
            expect(Object.getOwnPropertyDescriptor(result.source, 'value')?.get).toBeTypeOf('function');
        });

        // TransformDescriptor packs the get/set into its marker as raw functions, and
        // TransformCallbacks - which runs later and walks into markers - converts them, so
        // the accessor stays live rather than being flattened to a snapshot value.
        it('sub-serializes a descriptor\'s get/set into callbacks', () => {
            const withAccessor: any = { plain: 1 };
            Object.defineProperty(withAccessor, 'computed', {
                get: () => 'evaluated',
                set: () => { },
                enumerable: true,
                configurable: true
            });

            const serialized = newTransformAll().serialize({ data: withAccessor });

            expect(serialized.data.computed).toHaveProperty('___type', 'descriptor');
            expect(serialized.data.computed.descriptor.get).toHaveProperty('___type', 'callback');
            expect(serialized.data.computed.descriptor.set).toHaveProperty('___type', 'callback');
            expect(typeof serialized.data.computed.descriptor.get).not.toBe('function');
        });

        it('leaves no raw function anywhere in the serialized output', () => {
            const withAccessor: any = {};
            Object.defineProperty(withAccessor, 'computed', { get: () => 1, enumerable: true, configurable: true });

            const seen: string[] = [];
            JSON.stringify(newTransformAll().serialize({ data: withAccessor }), (key, value) => {
                if (typeof value === 'function') seen.push(key);
                return value;
            });

            expect(seen).toEqual([]);
        });

        it('rebuilds a live accessor on the receiving side', () => {
            const withAccessor: any = {};
            Object.defineProperty(withAccessor, 'computed', {
                get: () => 'evaluated',
                enumerable: true,
                configurable: true
            });

            const result = roundTrip({ data: withAccessor });
            const descriptor = Object.getOwnPropertyDescriptor(result.data, 'computed');

            // Still an accessor, and its getter is the callback stub - reading it goes back
            // over the wire, so it resolves to a promise rather than the value directly.
            expect(typeof descriptor?.get).toBe('function');
            expect(result.data.computed).toBeInstanceOf(Promise);
        });

        it('binds accessor callbacks to their original receiver', async () => {
            const source: any = { base: 2 };
            Object.defineProperty(source, 'computed', {
                get() { return this.base * 2; },
                set(value: number) { this.base = value; },
                enumerable: true,
                configurable: true,
            });
            const clone = new PureValueClone({ source });
            new (await import('../src/PerfectWSAdvanced/transform/TransformDescriptor.js')).TransformDescriptor().serialize(clone);
            const descriptor = clone.cloneRoot.root.source.computed.descriptor;

            expect(descriptor.get()).toBe(4);
            descriptor.set(7);
            expect(source.base).toBe(7);
        });

        it('reuses accessor callback identity without reading a spoofed bind property', () => {
            const events = new NetworkEventListener();
            const transform = new TransformAll({ events });
            const getter = function (this: any) { return this.base; };
            const bindRead = vi.fn();
            Object.defineProperty(getter, 'bind', { get: bindRead });
            const source: any = { base: 3 };
            for (const key of ['first', 'second']) {
                Object.defineProperty(source, key, { get: getter, configurable: true, enumerable: true });
            }

            const first = transform.serialize({ source });
            const second = transform.serialize({ source });
            expect(bindRead).not.toHaveBeenCalled();
            expect(first.source.first.descriptor.get.funcId).toBe(first.source.second.descriptor.get.funcId);
            expect(second.source.first.descriptor.get.funcId).toBe(first.source.first.descriptor.get.funcId);
        });

        it('consumes rejected remote setter promises', async () => {
            const transform = new (await import('../src/PerfectWSAdvanced/transform/TransformDescriptor.js')).TransformDescriptor();
            const target: any = { property: {
                ___perfectWS: 1,
                ___type: 'descriptor',
                descriptor: {
                    configurable: true,
                    enumerable: true,
                    set: () => Promise.reject(new Error('setter failed')),
                },
            } };

            transform.deserialize(target);
            expect(() => { target.property = 1; }).not.toThrow();
            await Promise.resolve();
            await Promise.resolve();
        });

        it('preserves shared remote setter wrapper identity', async () => {
            const transform = new (await import('../src/PerfectWSAdvanced/transform/TransformDescriptor.js')).TransformDescriptor();
            const setter = () => Promise.resolve();
            const marker = () => ({
                ___perfectWS: 1,
                ___type: 'descriptor',
                descriptor: { configurable: true, enumerable: true, set: setter },
            });
            const result = transform.deserialize({ first: marker(), second: marker() });
            expect(Object.getOwnPropertyDescriptor(result, 'first')?.set)
                .toBe(Object.getOwnPropertyDescriptor(result, 'second')?.set);
        });

        it('still carries a non-writable data property as a descriptor', () => {
            const frozen: any = {};
            Object.defineProperty(frozen, 'locked', { value: 7, writable: false, enumerable: true, configurable: true });

            const result = roundTrip({ data: frozen });

            expect(result.data.locked).toBe(7);
            expect(Object.getOwnPropertyDescriptor(result.data, 'locked')?.writable).toBe(false);
        });

        it('preserves writable properties whose other descriptor flags are unusual', () => {
            const source: any = {};
            Object.defineProperty(source, 'hidden', {
                value: 3,
                writable: true,
                enumerable: false,
                configurable: true,
            });
            Object.defineProperty(source, 'fixed', {
                value: 4,
                writable: true,
                enumerable: true,
                configurable: false,
            });

            const result = roundTrip({ source }).source;

            expect(Object.getOwnPropertyDescriptor(result, 'hidden')).toEqual({
                value: 3,
                writable: true,
                enumerable: false,
                configurable: true,
            });
            expect(Object.getOwnPropertyDescriptor(result, 'fixed')).toEqual({
                value: 4,
                writable: true,
                enumerable: true,
                configurable: false,
            });
        });

        it('preserves sparse array length while walking descriptors', () => {
            const source = new Array(5);
            source[1] = 'one';

            const result = roundTrip({ source }).source;

            expect(result).toHaveLength(5);
            expect(result[1]).toBe('one');
            expect(0 in result).toBe(false);
        });

        it('preserves a non-writable array length', () => {
            const source = [1, 2];
            Object.defineProperty(source, 'length', { writable: false });

            const result = roundTrip({ source }).source;

            expect(Object.getOwnPropertyDescriptor(result, 'length')?.writable).toBe(false);
            expect(() => result.push(3)).toThrow();
        });

        it('preserves named, symbol, and non-enumerable array properties', () => {
            const tag = Symbol.for('array-tag');
            const source: any[] & Record<PropertyKey, any> = [1, 2];
            source.extra = 'visible';
            source[tag] = 'symbol';
            Object.defineProperty(source, 'hidden', { value: 9, enumerable: false, writable: false });

            const result = roundTrip({ source }).source;

            expect(result.extra).toBe('visible');
            expect(result[tag]).toBe('symbol');
            expect(Object.getOwnPropertyDescriptor(result, 'hidden')).toMatchObject({ value: 9, enumerable: false, writable: false });
        });

        it('preserves null prototypes and encodes huge sparse arrays in bounded work', () => {
            const nullObject = Object.assign(Object.create(null), { value: 3 });
            const sparse: any[] = new Array(0xffff_ffff);
            sparse[7] = 'seven';

            const result = roundTrip({ nullObject, sparse });

            expect(Object.getPrototypeOf(result.nullObject)).toBeNull();
            expect(result.nullObject.value).toBe(3);
            expect(result.sparse.length).toBe(0xffff_ffff);
            expect(result.sparse[7]).toBe('seven');
            expect(8 in result.sparse).toBe(false);
        });

        it.each([-1, 1.5, Number.NaN])('preserves legal RegExp.lastIndex value %s', lastIndex => {
            const source = /x/g;
            source.lastIndex = lastIndex;
            const result = roundTrip({ source }).source as RegExp;
            expect(Object.is(result.lastIndex, lastIndex)).toBe(true);
        });

        it('preserves circular aliases under every awkward property name', () => {
            for (const key of ['#', 'constructor', 'prototype', '__proto__']) {
                const child = { key };
                const source: any = {};
                Object.defineProperty(source, key, { value: child, enumerable: true, writable: true, configurable: true });
                source.alias = child;

                const result = roundTrip({ source }).source;
                expect(result.alias, key).toBe(Object.getOwnPropertyDescriptor(result, key)?.value);
            }
        });

        it('copies typed views into exact backing stores and treats overlapping views independently', () => {
            const backing = new ArrayBuffer(6);
            const first = new Uint8Array(backing, 1, 3);
            const second = new Uint8Array(backing, 2, 3);
            first.set([11, 22, 33]);

            const result = roundTrip({ first, second });

            expect([...result.first]).toEqual([11, 22, 33]);
            expect(result.first.byteOffset).toBe(0);
            expect(result.first.buffer.byteLength).toBe(3);
            expect(result.second.buffer.byteLength).toBe(3);
            expect(result.first.buffer).not.toBe(result.second.buffer);
        });

        it('uses typed-array intrinsics instead of spoofable own accessors', () => {
            const source = new Uint16Array([1, 2]);
            const getter = vi.fn(() => new ArrayBuffer(4));
            Object.defineProperty(source, 'buffer', { get: getter, configurable: true });

            const result = roundTrip({ source }).source as Uint16Array;

            expect(getter).not.toHaveBeenCalled();
            expect([...result]).toEqual([1, 2]);
            expect(Object.getOwnPropertyDescriptor(result, 'buffer')?.get).toBeTypeOf('function');
        });

        it('round trips every available typed-array constructor', () => {
            const constructors = [
                Uint8ClampedArray,
                BigInt64Array,
                BigUint64Array,
                Reflect.get(globalThis, 'Float16Array'),
            ].filter((value): value is new (values: any[]) => ArrayBufferView => typeof value === 'function');

            for (const Constructor of constructors) {
                const isBigInt = Constructor === BigInt64Array || Constructor === BigUint64Array;
                const values = isBigInt ? [1n, 2n] : [1, 2];
                const result = roundTrip({ value: new Constructor(values) }).value;
                expect(result).toBeInstanceOf(Constructor);
                expect([...result]).toEqual(values);
            }
        });

        it('does not invoke shadow Error or RegExp intrinsic accessors', () => {
            const error = new Error('problem');
            const stack = vi.fn(() => 'spoofed');
            Object.defineProperty(error, 'stack', { get: stack, configurable: true });
            const regexp = /actual/gi;
            const source = vi.fn(() => 'spoofed');
            const flags = vi.fn(() => '');
            Object.defineProperty(regexp, 'source', { get: source, configurable: true });
            Object.defineProperty(regexp, 'flags', { get: flags, configurable: true });

            const result = roundTrip({ error, regexp });

            expect(stack).not.toHaveBeenCalled();
            expect(source).not.toHaveBeenCalled();
            expect(flags).not.toHaveBeenCalled();
            expect(result.error.message).toBe('problem');
            expect(Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!.call(result.regexp)).toBe('actual');
            expect(RegExp.prototype.exec.call(result.regexp, 'ACTUAL')?.[0]).toBe('ACTUAL');
            expect(Object.getOwnPropertyDescriptor(result.error, 'stack')?.get).toBeTypeOf('function');
            expect(Object.getOwnPropertyDescriptor(result.regexp, 'source')?.get).toBeTypeOf('function');
            expect(Object.getOwnPropertyDescriptor(result.regexp, 'flags')?.get).toBeTypeOf('function');
        });
    });

    describe('maxMessageSize', () => {
        it('rejects a binary value larger than the limit', () => {
            const transform = new TransformBinaryData(100, 8);

            expect(() => serializeWith(transform, { buf: new Uint8Array(9) }))
                .toThrow(PerfectWSError);
            expect(() => serializeWith(transform, { buf: new Uint8Array(9) }))
                .toThrow(/exceeds the maxMessageSize limit of 8 bytes/);
        });

        it('allows a binary value exactly at the limit', () => {
            const serialized = serializeWith(new TransformBinaryData(100, 8), { buf: new Uint8Array(8) });
            expect(serialized.buf).toHaveProperty('___type', 'binaryData');
        });

        it('is unlimited by default', () => {
            const serialized = serializeWith(new TransformBinaryData(100), { buf: new Uint8Array(5_000) });
            expect(serialized.buf).toHaveProperty('___type', 'binaryData');
        });

        it('is threaded through from TransformAll', () => {
            expect(() => newTransformAll(100, 4).serialize({ buf: new Uint8Array(10) }))
                .toThrow(/maxMessageSize/);
        });
    });
});
