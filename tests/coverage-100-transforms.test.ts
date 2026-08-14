import { afterEach, describe, expect, it, vi } from 'vitest';
import { Binary } from 'bson';
import { TransformAbortSignal } from '../src/PerfectWSAdvanced/transform/TransformAbortSignal.js';
import { TransformBinaryData } from '../src/PerfectWSAdvanced/transform/TransformBinaryData.js';
import { TransformCallbacks } from '../src/PerfectWSAdvanced/transform/TransformCallbacks.js';
import { TransformCircularObjects } from '../src/PerfectWSAdvanced/transform/TransformCircularObjects.js';
import { TransformDescriptor } from '../src/PerfectWSAdvanced/transform/TransformDescriptor.js';
import { TransformEscapedMarkers } from '../src/PerfectWSAdvanced/transform/TransformEscapedMarkers.js';
import { TransformNativeTypes } from '../src/PerfectWSAdvanced/transform/TransformNativeTypes.js';
import { TransformPureRPC } from '../src/PerfectWSAdvanced/transform/TransformPureRPC.js';
import { TransformSymbols } from '../src/PerfectWSAdvanced/transform/TransformSymbols.js';
import { TransformAll } from '../src/PerfectWSAdvanced/TransformAll.js';
import { PrototypeTransform } from '../src/PerfectWSAdvanced/transform/BaseCustomTransformers/PrototypeTransform.js';
import { GeneratorTransform } from '../src/PerfectWSAdvanced/transform/BaseCustomTransformers/GeneratorTransform.js';
import { PureRPC } from '../src/PerfectWSAdvanced/PureRPC.js';
import { PureRPCRegistry } from '../src/PerfectWSAdvanced/transform/utils/PureRPCRegistry.js';
import { PureValueClone } from '../src/PerfectWSAdvanced/transform/utils/PureValueClone.js';
import { SerializationTransaction, transformReceivedRecursive, transformSendRecursive } from '../src/PerfectWSAdvanced/transform/utils/changeType.js';
import { createPureRPCProxy } from '../src/PerfectWSAdvanced/transform/utils/createPureRPCProxy.js';
import { encodePathKey, getProperty } from '../src/PerfectWSAdvanced/transform/utils/getProperty.js';
import { transformReceivedLookBackRecursive, transformSendLookBackRecursive } from '../src/PerfectWSAdvanced/transform/utils/lookBackChangeType.js';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.js';
import { WebSocketForce } from '../src/utils/WebSocketForce.js';
import { serializeWith } from './utils/serializeWith.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function callbackTransforms(events = new NetworkEventListener()) {
    const callbacks = new TransformCallbacks(events, 10);
    return { events, callbacks, signals: new TransformAbortSignal(callbacks, 10) };
}

describe('remaining transform safety paths', () => {
    it('runs the TransformAll convenience serializer and releases auxiliary state', () => {
        const transform = new TransformAll({ events: new NetworkEventListener() });
        expect(transform.serialize({ value: 1 })).toEqual({ value: 1 });
        transform.releaseAll();
    });

    it('forgets finalized inline aborted signals', () => {
        let finalize!: (id: string) => void;
        class CapturingFinalizationRegistry {
            constructor(callback: (id: string) => void) { finalize = callback; }
            register() { }
        }
        vi.stubGlobal('FinalizationRegistry', CapturingFinalizationRegistry);
        const { signals } = callbackTransforms();
        signals.deserialize({
            ___perfectWS: 1,
            ___type: 'abortSignal',
            aborted: true,
            abortId: 'dead',
        });
        (signals as any)._abortedSignals.set('dead', { deref: () => undefined });

        finalize('dead');

        expect((signals as any)._abortedSignals.has('dead')).toBe(false);
    });

    it('contains malformed callback protocol messages', async () => {
        const { events, callbacks } = callbackTransforms();
        const response = vi.fn();
        events.on('___callback.response', response);

        await expect((callbacks as any)._onCallbackRequest('remote', null)).resolves.toBeUndefined();
        await expect((callbacks as any)._onCallbackRequest('remote', {
            requestId: 'invalid', funcId: 'callback', args: 'not-an-array',
        })).resolves.toBeUndefined();
        expect(() => (callbacks as any)._onCallbackResponse('remote', null)).not.toThrow();
        expect(() => (callbacks as any)._onCallbackRelease('remote', null)).not.toThrow();

        expect(response).toHaveBeenCalledWith('local', {
            error: 'Invalid callback request',
            requestId: 'invalid',
        });
    });

    it('releases an inbound abort callback when its signal disappeared before delivery', () => {
        const originalWeakRef = WeakRef;
        class EmptyWeakRef<T extends WeakKey> {
            constructor(_target: T) { }
            deref(): T | undefined { return undefined; }
        }
        vi.stubGlobal('WeakRef', EmptyWeakRef);

        const { callbacks, signals } = callbackTransforms();
        const release = vi.spyOn(callbacks, 'releaseFunction');
        let onAbort!: (reason: unknown) => void;
        signals.deserialize({
            ___perfectWS: 1,
            ___type: 'abortSignal',
            subscribe(callback: typeof onAbort) { onAbort = callback; },
        });
        onAbort('late');

        expect(release).toHaveBeenCalledOnce();
        vi.stubGlobal('WeakRef', originalWeakRef);
    });

    it('cleans up when subscribing to an inbound signal throws synchronously', () => {
        const { callbacks, signals } = callbackTransforms();
        const release = vi.spyOn(callbacks, 'releaseFunction');

        expect(() => signals.deserialize({
            ___perfectWS: 1,
            ___type: 'abortSignal',
            subscribe() { throw new Error('subscribe failed'); },
        })).not.toThrow();
        expect(release).toHaveBeenCalledOnce();
    });

    it('handles duplicate subscribers and every owner-side abort cleanup branch', async () => {
        const { callbacks, signals } = callbackTransforms();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const marker = serializeWith(signals, controller.signal);
        serializeWith(callbacks, marker);

        const throwing = () => { throw new Error('receiver failed'); };
        await marker.subscribe(throwing);
        await marker.subscribe(throwing);
        await expect(marker.subscribe(() => undefined)).resolves.toBeUndefined();
        controller.abort('stop');
        await vi.waitFor(() => expect(callbacks.hasLiveState()).toBe(false));

        const second = new AbortController();
        const secondMarker = serializeWith(signals, second.signal);
        const encoded = serializeWith(callbacks, secondMarker);
        let listener!: () => void;
        vi.spyOn(second.signal, 'addEventListener').mockImplementation((_, callback) => {
            listener = callback as () => void;
        });
        await secondMarker.subscribe(() => undefined);
        const funcId = encoded.subscribe.funcId;
        (callbacks as any)._onCallbackRelease('remote', { funcId });
        listener();

        expect(remove).toHaveBeenCalled();
        expect(callbacks.hasLiveState()).toBe(false);
    });

    it('delivers a signal that aborts before the remote subscription begins', async () => {
        const { callbacks, signals } = callbackTransforms();
        const controller = new AbortController();
        const marker = serializeWith(signals, controller.signal);
        serializeWith(callbacks, marker);
        controller.abort('already stopped');
        const received = vi.fn();

        await marker.subscribe(received);

        expect(received).toHaveBeenCalledWith('already stopped');
        expect(callbacks.hasLiveState()).toBe(false);
    });

    it('covers malformed and browser-style binary representations', async () => {
        const transform = new TransformBinaryData();
        const anyTransform = transform as any;

        expect([...anyTransform._extractBytes({ buffer: new ArrayBuffer(2) })]).toEqual([0, 0]);
        expect([...anyTransform._extractBytes({ constructor: { name: 'Binary' }, buffer: new ArrayBuffer(2) })]).toEqual([0, 0]);
        expect([...anyTransform._extractBytes(new Uint8Array([1, 2]))]).toEqual([1, 2]);
        expect([...anyTransform._extractBytes(new Binary(new Uint8Array([2, 3])))]).toEqual([2, 3]);
        expect([...anyTransform._extractBytes(new ArrayBuffer(2))]).toEqual([0, 0]);
        expect([...anyTransform._extractBytes([3, 4])]).toEqual([3, 4]);
        expect(anyTransform._restoreType('UnknownBinaryType', new Uint8Array([5]))).toEqual(new Uint8Array([5]));

        class UnsupportedBinary { }
        const types = (TransformBinaryData as any).TYPES;
        types.UnsupportedBinary = UnsupportedBinary;
        expect(anyTransform._detectBinaryType(new UnsupportedBinary())).toBeNull();
        delete types.UnsupportedBinary;

        const originalBufferType = types.Buffer;
        types.Buffer = undefined;
        expect(anyTransform._detectBinaryType(new Uint8Array([7]))?.type).toBe('Uint8Array');
        types.Buffer = originalBufferType;

        const originalHasBuffer = (TransformBinaryData as any).HAS_BUFFER;
        (TransformBinaryData as any).HAS_BUFFER = false;
        try {
            expect(serializeWith(transform, new Uint8Array([8, 9])).data).toBeInstanceOf(Uint8Array);
            expect([...anyTransform._extractBytes(new Binary(new Uint8Array([2, 3])))]).toEqual([2, 3]);
            expect([...anyTransform._extractBytes([6, 7])]).toEqual([6, 7]);
            expect([...anyTransform._extractBytes({ constructor: { name: 'Binary' }, buffer: new Uint8Array([4]) })]).toEqual([4]);
        } finally {
            (TransformBinaryData as any).HAS_BUFFER = originalHasBuffer;
        }

        let bufferRead = 0;
        const bsonArrayBuffer = {
            constructor: { name: 'Binary' },
            get buffer() { return ++bufferRead === 1 ? undefined : new Uint8Array([10]).buffer; },
        };
        expect([...anyTransform._extractBytes(bsonArrayBuffer)]).toEqual([10]);

        const bsonArray: any = [11, 12];
        Object.defineProperty(bsonArray, 'constructor', { value: { name: 'Binary' } });
        expect([...anyTransform._extractBytes(bsonArray)]).toEqual([11, 12]);

        types.CustomBytes = Uint8Array;
        expect(anyTransform._restoreType('CustomBytes', new Uint8Array([13]))).toEqual(new Uint8Array([13]));
        delete types.CustomBytes;

        expect(() => anyTransform._restoreType('Uint16Array', new Uint8Array(3)))
            .toThrow('Invalid byte length');

    });

    it('leaves a binary marker intact if reconstruction unexpectedly fails', () => {
        const transform = new TransformBinaryData() as any;
        vi.spyOn(transform, '_restoreType').mockImplementation(() => {
            throw new Error('unsupported runtime');
        });
        const marker = {
            ___perfectWS: 1,
            ___type: 'binaryData',
            type: 'Uint8Array',
            data: new Uint8Array([1]),
        };

        expect(transform.deserialize(marker)).toBe(marker);
    });

    it('rejects active callbacks after a local transport failure', async () => {
        const { events, callbacks } = callbackTransforms();
        const remote = callbacks.deserialize({
            ___perfectWS: 1,
            ___type: 'callback',
            funcId: 'remote-failure',
            funcName: 'remoteFailure',
        });
        const pending = remote();

        events._emitWithSource('___request.sendFailed', 'remote', { message: 'ignored' });
        expect(callbacks.hasLiveState()).toBe(true);
        events._emitWithSource('___request.sendFailed', 'local', {});

        await expect(pending).rejects.toMatchObject({ code: 'callbackDisconnected' });
        expect((callbacks as any)._activeRequests).toBeUndefined();
    });

    it('rejects only the callback operation named by a transport failure', async () => {
        const { events, callbacks } = callbackTransforms();
        const remote = callbacks.deserialize({
            ___perfectWS: 1, ___type: 'callback', funcId: 'remote-targeted', funcName: 'remoteTargeted',
        });
        const first = remote();
        const firstId = [...(callbacks as any)._activeRequests.keys()][0];
        const second = remote();
        const secondId = [...(callbacks as any)._activeRequests.keys()][1];

        events._emitWithSource('___request.sendFailed', 'local', {
            eventName: '___callback.response', operationId: firstId, message: 'first failed',
        });
        events._emitWithSource('___callback.response', 'remote', { requestId: secondId, data: 'second' });

        await expect(first).rejects.toMatchObject({ code: 'callbackDisconnected' });
        await expect(second).resolves.toBe('second');
    });

    it('ignores an unrelated application-event send failure while a callback is pending', async () => {
        const { events, callbacks } = callbackTransforms();
        const remote = callbacks.deserialize({
            ___perfectWS: 1, ___type: 'callback', funcId: 'remote-unrelated', funcName: 'remoteUnrelated',
        });
        const pending = remote();
        const requestId = [...(callbacks as any)._activeRequests.keys()][0];

        events._emitWithSource('___request.sendFailed', 'local', {
            eventName: 'application.bad', message: 'unrelated failure',
        });
        expect((callbacks as any)._activeRequests.size).toBe(1);
        events._emitWithSource('___callback.response', 'remote', { requestId, data: 'ok' });

        await expect(pending).resolves.toBe('ok');
    });

    it('ignores unknown targeted callback failures and clears the final targeted call', async () => {
        const { events, callbacks } = callbackTransforms();
        const remote = callbacks.deserialize({
            ___perfectWS: 1, ___type: 'callback', funcId: 'remote-last', funcName: 'remoteLast',
        });
        const pending = remote();
        const requestId = [...(callbacks as any)._activeRequests.keys()][0];

        events._emitWithSource('___request.sendFailed', 'local', {
            eventName: '___callback.request', operationId: 'missing',
        });
        expect((callbacks as any)._activeRequests.size).toBe(1);
        events._emitWithSource('___request.sendFailed', 'local', {
            eventName: '___callback.request', operationId: requestId,
        });

        await expect(pending).rejects.toMatchObject({ code: 'callbackDisconnected' });
        expect((callbacks as any)._activeRequests).toBeUndefined();
    });

    it('rejects active callbacks when their channel is released', async () => {
        const { callbacks } = callbackTransforms();
        const remote = callbacks.deserialize({
            ___perfectWS: 1,
            ___type: 'callback',
            funcId: 'remote-release',
            funcName: 'remoteRelease',
        });
        const pending = remote();

        callbacks.releaseAll();

        await expect(pending).rejects.toMatchObject({ code: 'callbackReleased' });
        expect((callbacks as any)._activeRequests).toBeUndefined();
    });

    it('bounds callback operation state and clears delivered incoming results', async () => {
        const events = new NetworkEventListener();
        const callbacks = new TransformCallbacks(events, 10, () => { }, 1);
        const marker = serializeWith(callbacks, () => 'done');
        await (callbacks as any)._onCallbackRequest('remote', {
            args: [], funcId: marker.funcId, requestId: 'first', durable: true,
        });
        expect((callbacks as any)._incomingRequestResults.size).toBe(1);

        const response = vi.fn();
        events.on('___callback.response', response);
        await (callbacks as any)._onCallbackRequest('remote', {
            args: [], funcId: marker.funcId, requestId: 'overflow', durable: true,
        });
        expect(response).toHaveBeenCalledWith('local', expect.objectContaining({
            requestId: 'overflow', error: 'Too many callback operations',
        }));

        events.emit('___request.eventDelivered', { eventName: '___callback.response', operationId: 'first' });
        expect((callbacks as any)._incomingRequestResults.size).toBe(0);

        const remote = callbacks.deserialize({
            ___perfectWS: 1, ___type: 'callback', funcId: 'remote-cap', funcName: 'remoteCap',
        });
        const pending = remote();
        await expect(remote()).rejects.toMatchObject({ code: 'callbackCapacity' });
        callbacks.releaseAll();
        await expect(pending).rejects.toMatchObject({ code: 'callbackReleased' });
    });

    it('updates an existing callback entry and isolates a throwing release handler', () => {
        const { events, callbacks } = callbackTransforms();
        const callback = () => undefined;
        const marker = serializeWith(callbacks, callback);
        const release = vi.fn(() => { throw new Error('cleanup failed'); });

        callbacks.setFunctionReleaseHandler(callback, release);
        events._emitWithSource('___callback.release', 'remote', { funcId: marker.funcId });

        expect(release).toHaveBeenCalledOnce();
        expect(callbacks.hasLiveState()).toBe(false);
    });

    it('ignores a callback release from a future lease and an unknown direct release', () => {
        const { callbacks } = callbackTransforms();
        const callback = () => undefined;
        const marker = serializeWith(callbacks, callback);

        (callbacks as any)._onCallbackRelease('remote', {
            funcId: marker.funcId,
            lease: marker.lease + 1,
        });
        expect(callbacks.hasLiveState()).toBe(true);

        (callbacks as any)._releaseOwnedFunctionId('missing');
        callbacks.releaseAll();
    });

    it('constructs callback transforms when finalizers are unavailable', async () => {
        const original = globalThis.FinalizationRegistry;
        vi.stubGlobal('FinalizationRegistry', undefined);
        vi.resetModules();
        const module = await import('../src/PerfectWSAdvanced/transform/TransformCallbacks.js');
        const callbacks = new module.TransformCallbacks(new NetworkEventListener());

        expect(serializeWith(callbacks, () => undefined)).toMatchObject({ ___type: 'callback' });

        callbacks.releaseAll();
        vi.stubGlobal('FinalizationRegistry', original);
        vi.resetModules();
    });

    it('runs the received-callback finalizer cleanup hook', async () => {
        let finalize!: (held: any) => void;
        let held: any;
        class CapturingFinalizationRegistry {
            constructor(callback: (value: any) => void) { finalize = callback; }
            register(_target: object, value: any) { held = value; }
            unregister() { return true; }
        }
        vi.stubGlobal('FinalizationRegistry', CapturingFinalizationRegistry);
        vi.resetModules();
        const module = await import('../src/PerfectWSAdvanced/transform/TransformCallbacks.js');
        const callbacks = new module.TransformCallbacks(new NetworkEventListener());
        callbacks.deserialize({
            ___perfectWS: 1,
            ___type: 'callback',
            funcId: 'finalized',
            funcName: 'finalized',
        });

        finalize(held);

        expect(callbacks.hasLiveState()).toBe(false);
        vi.resetModules();
    });

    it('covers depth boundaries for native containers and malformed errors', () => {
        const transform = new TransformNativeTypes(1) as any;

        expect(transform._encode(1n, 2)).toBeNull();
        expect(transform._decode({ ___perfectWS: 1, ___type: 'bigint', value: '1' }, 2)).toBeNull();
        expect(transform._decodeChild([{ ___perfectWS: 1, ___type: 'bigint', value: '1' }], 1)).toEqual([{ ___perfectWS: 1, ___type: 'bigint', value: '1' }]);
        expect((new TransformNativeTypes(3) as any)._decodeChild([{ ___perfectWS: 1, ___type: 'bigint', value: '1' }], 0)).toEqual([1n]);

        const custom = transform.deserialize({
            ___perfectWS: 1, ___type: 'error', name: 'NotBuiltIn', message: 'bad', stack: 'stack', properties: undefined,
        });
        expect(custom).toBeInstanceOf(Error);
        expect(custom.name).toBe('NotBuiltIn');

        const originalURL = globalThis.URL;
        vi.stubGlobal('URL', undefined);
        expect(transform._encode({ value: 1 }, 0)).toBeNull();
        vi.stubGlobal('URL', originalURL);
    });

    it('leaves every malformed native marker untouched', () => {
        const transform = new TransformNativeTypes() as any;
        const malformed = [
            { ___perfectWS: 1, ___type: 'bigint', value: 1 },
            { ___perfectWS: 1, ___type: 'bigint', value: 'invalid' },
            { ___perfectWS: 1, ___type: 'map', entries: 'invalid' },
            { ___perfectWS: 1, ___type: 'set', values: 'invalid' },
            { ___perfectWS: 1, ___type: 'array', length: 1, lengthWritable: true, entries: [[{}, 1]] },
            { ___perfectWS: 1, ___type: 'nullObject', entries: [[{}, 1]] },
            { ___perfectWS: 1, ___type: 'url', href: 1 },
            { ___perfectWS: 1, ___type: 'url', href: 'not a valid absolute URL' },
            { ___perfectWS: 1, ___type: 'error', name: 1, message: 'bad' },
            { ___perfectWS: 1, ___type: 'array', length: 1, lengthWritable: true, entries: [[-1, 'bad']] },
            { ___perfectWS: 1, ___type: 'regexp', source: 'x', flags: '[', lastIndex: 0 },
            { ___perfectWS: 1, ___type: 'regexp', source: 'x', flags: 'g', lastIndex: 'invalid' },
            { ___perfectWS: 1, ___type: 'regexp', source: 'x', flags: 'g', lastIndex: -1 },
        ];

        expect(transform.deserialize(malformed)).toEqual(malformed);

        const originalURL = globalThis.URL;
        vi.stubGlobal('URL', undefined);
        expect(transform._decode({ ___perfectWS: 1, ___type: 'url', href: 'https://example.com' }, 0)).toBeNull();
        vi.stubGlobal('URL', originalURL);
    });

    it('skips accessor entries in native sparse arrays and null-prototype objects', () => {
        const transform = new TransformNativeTypes() as any;
        const array: any[] = [];
        Object.defineProperty(array, 'computed', { get: () => 1, enumerable: true });
        expect(transform._encode(array, 0, array).entries).toEqual([]);

        const nullObject = Object.create(null);
        Object.defineProperty(nullObject, 'computed', { get: () => 1, enumerable: true });
        expect(transform._encode(nullObject, 0, nullObject).entries).toEqual([]);
    });

    it('leaves circular and escaped markers intact when their targets cannot be rebuilt', () => {
        const circular = new TransformCircularObjects();
        const missing = { ___perfectWS: 1, ___type: 'circularRef', refPath: ['missing'] };
        expect(circular.deserialize(missing)).toBe(missing);

        const escaped = new TransformEscapedMarkers();
        const marker = {
            ___perfectWS: 1, ___type: 'escapedMarker', array: true, nullPrototype: false,
            descriptors: [['length', { value: 0, configurable: true }]],
        };
        expect(escaped.deserialize(marker)).toBe(marker);
    });

    it('covers escaped-marker ownership, array, null-prototype, accessor, and depth paths', () => {
        const escaped = new TransformEscapedMarkers() as any;
        const applicationMarker: any = { ___perfectWS: 1, ___type: 'bigint', value: '1' };
        const ownedClone = new PureValueClone(applicationMarker);
        ownedClone.cloneRoot.root = ownedClone.own(applicationMarker);
        escaped.serialize(ownedClone);
        expect(ownedClone.cloneRoot.root).toBe(applicationMarker);

        const nullResult = escaped.deserialize({
            ___perfectWS: 1, ___type: 'escapedMarker', array: false, nullPrototype: true,
            descriptors: [['value', { value: 3, enumerable: true, configurable: true, writable: true }]],
        });
        expect(Object.getPrototypeOf(nullResult)).toBeNull();

        const arrayResult = escaped.deserialize({
            ___perfectWS: 1, ___type: 'escapedMarker', array: true, nullPrototype: false,
            descriptors: [
                ['computed', { get: () => 4, configurable: true }],
                [Symbol.iterator, { value: Array.prototype[Symbol.iterator], configurable: true }],
                ['length', { value: 0, writable: true }],
            ],
        });
        expect(arrayResult.computed).toBe(4);
        expect(arrayResult).toHaveLength(0);

        const depthLimited = new TransformEscapedMarkers(0);
        const nested = { marker: applicationMarker };
        expect(depthLimited.deserialize(nested)).toBe(nested);
        const map = new Map([['value', applicationMarker]]);
        const set = new Set([applicationMarker]);
        expect(depthLimited.deserialize(map)).toBe(map);
        expect(depthLimited.deserialize(set)).toBe(set);

        const accessorRoot: any = {};
        Object.defineProperty(accessorRoot, 'computed', { get: () => applicationMarker, configurable: true });
        expect(escaped.deserialize(accessorRoot)).toBe(accessorRoot);

        const blocked: any = {};
        Object.defineProperty(blocked, 'marker', {
            value: { ___perfectWS: 1, ___type: 'escapedMarker', array: false, nullPrototype: false, descriptors: [] },
            writable: false,
            configurable: false,
        });
        expect(() => escaped.deserialize(blocked)).not.toThrow();
    });

    it('covers native own-property validation and legacy formats', () => {
        const transform = new TransformNativeTypes() as any;
        const local = Symbol('local');
        const source: any = new Map();
        Object.defineProperty(source, local, { value: 'local', configurable: true });
        Object.defineProperty(source, Symbol.iterator, { value: 'well-known', configurable: true });
        Object.defineProperty(source, 'setter', { set(_value: unknown) { }, configurable: true });
        const properties = transform._encodeProperties(source);
        expect(properties.some(([key]: [PropertyKey]) => key === local)).toBe(false);
        expect(properties.some(([key]: [PropertyKey]) => key === Symbol.iterator)).toBe(true);

        const ghost = new Proxy({}, {
            ownKeys: () => ['ghost'],
            getOwnPropertyDescriptor: () => undefined,
        });
        expect(transform._encodeProperties(ghost)).toEqual([]);
        expect(transform._restoreProperties({}, 'invalid', 0, new WeakMap())).toBe(false);
        expect(transform._restoreProperties(Object.preventExtensions({}), [['blocked', 1]], 0, new WeakMap())).toBe(false);

        const malformedProperties = [
            { ___perfectWS: 1, ___type: 'map', entries: [], properties: 'bad' },
            { ___perfectWS: 1, ___type: 'set', values: [], properties: 'bad' },
            { ___perfectWS: 1, ___type: 'url', href: 'https://example.com', properties: 'bad' },
            { ___perfectWS: 1, ___type: 'date', value: 1, properties: 'bad' },
            { ___perfectWS: 1, ___type: 'regexp', source: 'x', flags: 'g', lastIndex: 0, properties: 'bad' },
            { ___perfectWS: 1, ___type: 'error', name: 'Error', message: 'bad', properties: [{}] },
        ];
        expect(transform.deserialize(malformedProperties)).toEqual(malformedProperties);
        expect(transform.deserialize({ ___perfectWS: 1, ___type: 'date', value: 'bad' }))
            .toMatchObject({ ___type: 'date' });

        const fixedRegExp = transform.deserialize({
            ___perfectWS: 1, ___type: 'regexp', source: 'x', flags: 'g', lastIndex: 2,
            lastIndexWritable: false, properties: [],
        });
        expect(Object.getOwnPropertyDescriptor(fixedRegExp, 'lastIndex')?.writable).toBe(false);

        const legacyError = transform.deserialize({
            ___perfectWS: 1, ___type: 'error', name: 'Error', message: 'legacy', properties: { code: 'OLD' },
        });
        expect(legacyError.code).toBe('OLD');

        const unusualError = new Error('normal');
        Object.defineProperty(unusualError, 'message', { value: 3, configurable: true });
        Object.defineProperty(unusualError, 'stack', { value: 4, configurable: true });
        expect(transform._encode(unusualError, 0)).toMatchObject({ message: '', stack: undefined });
        Object.defineProperty(unusualError, 'stack', { value: 'explicit stack', configurable: true });
        expect(transform._encode(unusualError, 0)).toMatchObject({ stack: 'explicit stack' });
    });

    it('covers binary own-property validation and descriptor paths', () => {
        const transform = new TransformBinaryData() as any;
        const source: any = new Uint8Array([1]);
        const local = Symbol('local');
        Object.defineProperty(source, local, { value: 1, configurable: true });
        Object.defineProperty(source, Symbol.iterator, { value: () => [][Symbol.iterator](), configurable: true });
        Object.defineProperty(source, 'setter', { set(_value: unknown) { }, configurable: true });
        const properties = transform._encodeProperties(source);
        expect(properties.some(([key]: [PropertyKey]) => key === local)).toBe(false);
        expect(properties.some(([key]: [PropertyKey]) => key === Symbol.iterator)).toBe(true);

        const ghost = new Proxy({}, {
            ownKeys: () => ['ghost'],
            getOwnPropertyDescriptor: () => undefined,
        });
        expect(transform._encodeProperties(ghost)).toEqual([]);
        expect(transform._restoreProperties({}, 'invalid')).toBe(false);
        expect(transform._restoreProperties(Object.preventExtensions({}), [['blocked', 1]])).toBe(false);
    });

    it('does not invoke accessors in recursive walkers and rejects unknown symbol path keys', () => {
        const source: any = {};
        Object.defineProperty(source, 'computed', { get: () => 1, enumerable: true });
        const clone = new PureValueClone(source);
        transformSendRecursive(clone, { transformData: () => null });
        transformReceivedRecursive(source, { transformData: () => null });
        transformSendLookBackRecursive(new PureValueClone(source), { transformData: () => false, maxDepth: 10 });
        transformReceivedLookBackRecursive(source, { transformData: () => false, maxDepth: 10 });
        expect(getProperty(source, '!not-registered', new Map())).toBeUndefined();
        expect(new GeneratorTransform().check(null)).toBe(false);
        expect(new GeneratorTransform().check(1)).toBe(false);
    });

    it('round-trips a received signal without an owner abort id', () => {
        const { signals } = callbackTransforms();
        const signal = signals.deserialize({
            ___perfectWS: 1, ___type: 'abortSignal', subscribe() { },
        });
        const marker = serializeWith(signals, signal);
        expect(marker.abortId).toEqual(expect.any(String));
    });

    it('forgets an owner signal through its finalizer callback', () => {
        let finalize!: (id: string) => void;
        class CapturingFinalizationRegistry {
            constructor(callback: (id: string) => void) { finalize = callback; }
            register() { }
        }
        vi.stubGlobal('FinalizationRegistry', CapturingFinalizationRegistry);
        const { signals } = callbackTransforms();
        const marker = serializeWith(signals, new AbortController().signal);
        (signals as any)._abortedSignals.set(marker.abortId, { deref: () => undefined });

        finalize(marker.abortId);

        expect((signals as any)._abortedSignals.has(marker.abortId)).toBe(false);
    });

    it('contains a synchronously throwing remote descriptor setter', () => {
        const transform = new TransformDescriptor();
        const value: any = transform.deserialize({
            property: {
                ___perfectWS: 1,
                ___type: 'descriptor',
                descriptor: {
                    configurable: true,
                    enumerable: true,
                    set() { throw new Error('setter failed'); },
                },
            },
        });
        expect(() => { value.property = 1; }).not.toThrow();
    });

    it('reuses memoized errors and arrays while decoding native graphs', () => {
        const transform = new TransformNativeTypes() as any;
        const errorMarker = { ___perfectWS: 1, ___type: 'error', name: 'Error', message: 'bad' };
        const existingError = new Error('existing');
        const errorMemo = new WeakMap<object, any>([[errorMarker, existingError]]);
        expect(transform._decode(errorMarker, 0, errorMemo)).toBe(existingError);

        const array: any[] = [];
        const existingArray: any[] = [];
        const arrayMemo = new WeakMap<object, any>([[array, existingArray]]);
        expect(transform._decodeChild(array, 0, arrayMemo)).toBe(existingArray);
    });

    it('covers circular, descriptor, symbol, and look-back boundary paths', () => {
        const circular = new TransformCircularObjects(3);
        expect(serializeWith(circular, 1)).toBe(1);
        const localSymbol = Symbol('local');
        const symbolRoot: any = { [localSymbol]: { nested: true } };
        expect(serializeWith(circular, symbolRoot)[localSymbol]).toEqual({ nested: true });

        const descriptor = new TransformDescriptor();
        const ghost = new Proxy({}, {
            ownKeys: () => ['ghost'],
            getOwnPropertyDescriptor: () => undefined,
        });
        expect(() => serializeWith(descriptor, ghost)).not.toThrow();

        const symbols = new TransformSymbols();
        const restored = symbols.deserialize({ marker: { ___perfectWS: 1, ___type: 'symbol', value: 1 } });
        expect(restored[Symbol.for('marker')]).toBe(1);
        const registered = Symbol.for('covered');
        const withCollision: any = { ___symbol: 'occupied', [registered]: 2 };
        const encoded = serializeWith(symbols, withCollision);
        expect(encoded.___symbol_).toMatchObject({ ___type: 'symbol', symbolKey: 'covered', value: 2 });
        const localOnly = Symbol('local');
        expect(serializeWith(symbols, { [localOnly]: 3 })[localOnly]).toBe(3);
        expect(serializeWith(symbols, localOnly)).toBe(localOnly);
        expect(symbols.deserialize({ ___perfectWS: 1, ___type: 'symbolValue', kind: 'wellKnown', key: 'missing' }))
            .toMatchObject({ ___type: 'symbolValue' });
        expect(symbols.deserialize({ ___perfectWS: 1, ___type: 'symbolValue', kind: 'invalid', key: 'x' }))
            .toMatchObject({ ___type: 'symbolValue' });

        const cappedSymbols = new TransformSymbols() as any;
        for (let index = 0; index < 10_000; index++) cappedSymbols._receivedGlobalSymbols.set(`existing-${index}`, Symbol.iterator);
        expect(() => cappedSymbols.deserialize({ ___perfectWS: 1, ___type: 'symbolValue', kind: 'global', key: 'over-cap' }))
            .toThrow('Global symbol limit reached');
        expect(() => cappedSymbols.deserialize({ marker: { ___perfectWS: 1, ___type: 'symbol', symbolKey: 'over-cap', value: 1 } }))
            .toThrow('Global symbol limit reached');

        const inheritedRead = Symbol.for('inherited-read');
        const nonNormal: any = {};
        Object.defineProperty(nonNormal, inheritedRead, { configurable: false, value: 4 });
        expect(serializeWith(symbols, nonNormal).___symbol.value).toBe(4);

        const received = { nested: { value: 1 } };
        expect(transformReceivedLookBackRecursive(received, { maxDepth: 0, transformData: () => false })).toBe(received);
        const clone = new PureValueClone({ nested: { value: 1 } });
        transformSendLookBackRecursive(clone, { maxDepth: 0, transformData: () => false });
        expect(clone.cloneRoot.root).toEqual({ nested: { value: 1 } });

        const source = { nested: { value: 2 } };
        const withOwnedChild = new PureValueClone(source);
        const rootClone = withOwnedChild.clone(source);
        rootClone.nested = withOwnedChild.own({ marker: true });
        withOwnedChild.cloneRoot.root = rootClone;
        transformSendLookBackRecursive(withOwnedChild, { transformData: () => false });
        expect(withOwnedChild.cloneRoot.root.nested).toEqual({ marker: true });

        const throwingParent = new Proxy({ marker: { ___perfectWS: 1, ___type: 'descriptor', descriptor: { value: 1 } } }, {
            defineProperty: () => { throw new Error('blocked'); },
        });
        expect(() => descriptor.deserialize(throwingParent)).not.toThrow();

        const blockedTarget: any = {};
        Object.defineProperty(blockedTarget, 'blocked', {
            value: 1,
            writable: false,
            enumerable: true,
            configurable: true,
        });
        const blockedClone = new Proxy(blockedTarget, {
            defineProperty: () => { throw new Error('blocked'); },
        });
        const descriptorClone = new PureValueClone(blockedTarget);
        descriptorClone.cloneRoot.root = descriptorClone.own(blockedClone);
        expect(() => descriptor.serialize(descriptorClone)).not.toThrow();
    });

    it('settles serialization transactions once and isolates rollback failures', () => {
        const committed = vi.fn();
        const rolledBack = vi.fn();
        const transaction = new SerializationTransaction();
        transaction.add({ commit: committed, rollback: rolledBack });
        transaction.commit();
        transaction.commit();

        expect(committed).toHaveBeenCalledOnce();
        expect(rolledBack).not.toHaveBeenCalled();
        expect(() => transaction.add({})).toThrow(/already settled/);

        const safeRollback = new SerializationTransaction();
        safeRollback.add({ rollback: () => { throw new Error('cleanup failed'); } });
        safeRollback.add({ rollback: rolledBack });
        expect(() => safeRollback.rollback()).not.toThrow();
        expect(rolledBack).toHaveBeenCalledOnce();
    });

    it('covers prototype transform values and its identity deserializer', () => {
        class ExampleTransform extends PrototypeTransform<any> {
            serializePrototypes = ['method', 'value', 'missing'];
        }
        const transform = new ExampleTransform();
        const source = { method: (n: number) => n + 1, value: 2 };
        const serialized = transform.serialize(source);

        expect(serialized.method(2)).toBe(3);
        expect(serialized.value).toBe(2);
        expect(transform.deserialize(source)).toBe(source);
    });
});

describe('remaining PureRPC transform and registry paths', () => {
    function makePureRPC(options: Partial<ConstructorParameters<typeof TransformPureRPC>[0]> = {}) {
        const events = new NetworkEventListener();
        const callbacks = new TransformCallbacks(events);
        const transform = new TransformPureRPC({
            events,
            fullTrustedRPC: true,
            transformCallbacks: callbacks,
            ...options,
        });
        return { events, callbacks, transform };
    }

    it('rejects pending calls on transport failure and channel release', async () => {
        const first = makePureRPC();
        const firstPromise = (first.transform as any)._call('get', 'rpc', ['value']);
        first.events._emitWithSource('___request.sendFailed', 'remote', { message: 'ignored' });
        expect((first.transform as any)._pendingCalls.size).toBe(1);
        first.events._emitWithSource('___request.sendFailed', 'local', {});
        await expect(firstPromise).rejects.toMatchObject({ code: 'pureRPCDisconnected' });

        const second = makePureRPC();
        const secondPromise = (second.transform as any)._call('get', 'rpc', ['value']);
        (second.transform as any)._incomingCallResults.set('incoming', Promise.resolve({ callId: 'incoming', data: 1 }));
        (second.transform as any)._activeIncomingCalls = 1;
        second.transform.releaseAll();
        await expect(secondPromise).rejects.toMatchObject({ code: 'pureRPCReleased' });
        expect((second.transform as any)._incomingCallResults.size).toBe(0);
        expect((second.transform as any)._activeIncomingCalls).toBe(0);
        second.transform.releaseAll();

        second.events._emitWithSource('___pureRPC.response', 'remote', { callId: 'already-gone', data: 1 });
    });

    it('bounds PureRPC operation state and clears delivered incoming results', async () => {
        const { events, transform } = makePureRPC({ maxOperations: 1 });
        const marker = serializeWith(transform, new PureRPC({ value: 1 }));
        await (transform as any)._onPureRPCRequest('remote', {
            callId: 'first', op: 'get', rpcId: marker.rpcId, path: ['value'],
        });
        expect((transform as any)._incomingCallResults.size).toBe(1);
        const response = vi.fn();
        events.on('___pureRPC.response', response);
        await (transform as any)._onPureRPCRequest('remote', {
            callId: 'overflow', op: 'get', rpcId: marker.rpcId, path: ['value'],
        });
        expect(response).toHaveBeenCalledWith('local', {
            callId: 'overflow', error: 'Too many PureRPC operations',
        });
        events.emit('___request.eventDelivered', { eventName: '___pureRPC.response', operationId: 'first' });
        expect((transform as any)._incomingCallResults.size).toBe(0);

        const pending = (transform as any)._call('get', 'remote', ['value']);
        await expect((transform as any)._call('get', 'remote', ['other']))
            .rejects.toMatchObject({ code: 'pureRPCCapacity' });
        transform.releaseAll();
        await expect(pending).rejects.toMatchObject({ code: 'pureRPCReleased' });
    });

    it('rejects only the PureRPC operation named by a transport failure', async () => {
        const { events, transform } = makePureRPC();
        const first = (transform as any)._call('get', 'rpc', ['first']);
        const firstId = [...(transform as any)._pendingCalls.keys()][0];
        const second = (transform as any)._call('get', 'rpc', ['second']);
        const secondId = [...(transform as any)._pendingCalls.keys()][1];

        events._emitWithSource('___request.sendFailed', 'local', {
            eventName: '___pureRPC.response', operationId: firstId, message: 'first failed',
        });
        events._emitWithSource('___pureRPC.response', 'remote', { callId: secondId, data: 'second' });

        await expect(first).rejects.toMatchObject({ code: 'pureRPCDisconnected' });
        await expect(second).resolves.toBe('second');
    });

    it('covers disabled release, thrown non-errors, and default options', async () => {
        const disabled = makePureRPC({ fullTrustedRPC: false });
        const response = vi.fn();
        disabled.events.on('___pureRPC.response', response);
        disabled.events._emitWithSource('___pureRPC.request', 'remote', {
            callId: 'release', op: 'release', rpcId: 'missing', path: [],
        });
        await Promise.resolve();
        expect(response).not.toHaveBeenCalled();

        const enabled = makePureRPC({ maxDepth: undefined, maxHandles: undefined, autoWrapUnknownClasses: undefined, onLiveStateChanged: undefined });
        vi.spyOn(enabled.transform as any, '_handle').mockRejectedValueOnce(null);
        enabled.events._emitWithSource('___pureRPC.request', 'remote', {
            callId: 'bad', op: 'get', rpcId: 'missing', path: ['x'],
        });
        await Promise.resolve();
        expect(enabled.transform['_maxDepth']).toBe(100);
    });

    it('contains malformed and unknown PureRPC protocol messages', async () => {
        const { events, transform } = makePureRPC();
        const response = vi.fn();
        events.on('___pureRPC.response', response);

        await expect((transform as any)._onPureRPCRequest('remote', null)).resolves.toBeUndefined();
        await expect((transform as any)._onPureRPCRequest('remote', {
            callId: 'unknown-op', op: 'unknown', rpcId: 'rpc', path: [],
        })).resolves.toBeUndefined();
        for (const message of [
            { callId: 'bad-rpc-id', op: 'get', rpcId: 1, path: [] },
            { callId: 'bad-path', op: 'get', rpcId: 'rpc', path: 'not-an-array' },
            { callId: 'bad-key', op: 'get', rpcId: 'rpc', path: [{}] },
        ]) {
            await expect((transform as any)._onPureRPCRequest('remote', message)).resolves.toBeUndefined();
        }
        expect(() => (transform as any)._onPureRPCResponse('remote', null)).not.toThrow();

        const malformed = (transform as any)._call('get', 'rpc', ['value']);
        const callId = [...(transform as any)._pendingCalls.keys()][0];
        (transform as any)._onPureRPCResponse('remote', { callId, error: 7 });
        await expect(malformed).rejects.toMatchObject({ code: 'pureRPCError' });

        expect(response).toHaveBeenCalledWith('local', {
            callId: 'unknown-op',
            error: 'Invalid PureRPC request',
        });
    });

    it('covers invalid set containers, invalid receivers, pass-back, and proxy reuse', async () => {
        const { transform } = makePureRPC();
        const marker = serializeWith(transform, new PureRPC({ nested: 1 }));
        await expect((transform as any)._handle({ op: 'set', rpcId: marker.rpcId, path: ['missing', 'x'], value: 2 })).rejects.toMatchObject({ code: 'pureRPCNotFound' });
        expect(() => (transform as any)._getCallbackForwarder(marker.rpcId, null, () => undefined)).toThrow(/receiver/);
        expect(() => (transform as any)._getCallbackForwarder(marker.rpcId, 1, () => undefined)).toThrow(/receiver/);

        const remoteMarker = { ___perfectWS: 1, ___type: 'pureRPC', rpcId: 'remote' };
        const first = transform.deserialize(remoteMarker);
        expect(transform.deserialize({ ...remoteMarker })).toBe(first);
        expect(serializeWith(transform, first)).toEqual(remoteMarker);
        first[Symbol.dispose]();
        expect(serializeWith(transform, first)).toEqual(remoteMarker);
        transform.releaseAll();
        await expect(first.value).rejects.toThrow('released');
    });

    it('keeps a provisional handle when a non-transactional serialization commits it', () => {
        const { transform } = makePureRPC();
        const handle = new PureRPC({ value: 1 });
        const transaction = new SerializationTransaction();
        const provisionalClone = new PureValueClone(handle);
        transform.serialize(provisionalClone, transaction);
        const marker = serializeWith(transform, handle);

        transaction.rollback();

        expect((transform as any)._registry.resolve(marker.rpcId, ['value'])?.value).toBe(1);
        transform.releaseAll();
    });

    it('releases callback forwarders and accepts omitted apply arguments', async () => {
        const { events, transform } = makePureRPC();
        const marker = serializeWith(transform, new PureRPC({ method() { return 'ok'; } }));

        expect(await (transform as any)._handle({ op: 'apply', rpcId: marker.rpcId, path: ['method'] })).toBe('ok');
        expect(typeof await (transform as any)._handle({ op: 'get', rpcId: marker.rpcId, path: ['method'] })).toBe('function');
        events._emitWithSource('___pureRPC.request', 'remote', {
            callId: 'release', op: 'release', rpcId: marker.rpcId, path: [],
        });
        await Promise.resolve();

        expect((transform as any)._callbackForwarders.size).toBe(0);
        transform.releaseAll();
    });

    it('handles explicit release requests, unknown responses, and forwarders during releaseAll', async () => {
        const first = makePureRPC();
        const knownResponse = (first.transform as any)._call('get', 'known', ['value']);
        const knownCallId = [...(first.transform as any)._pendingCalls.keys()][0];
        (first.transform as any)._onPureRPCResponse('remote', { callId: knownCallId, data: 'received' });
        await expect(knownResponse).resolves.toBe('received');

        const pendingLookup = vi.spyOn((first.transform as any)._pendingCalls, 'get');
        first.events._emitWithSource('___pureRPC.response', 'remote', { callId: 'missing-event', data: 1 });
        (first.transform as any)._onPureRPCResponse('remote', { callId: 'missing-direct', data: 1 });
        expect(pendingLookup).toHaveBeenCalledWith('missing-event');
        expect(pendingLookup).toHaveReturnedWith(undefined);
        await (first.transform as any)._onPureRPCRequest('remote', {
            callId: 'release', op: 'release', rpcId: 'missing', path: [],
        });

        const failedRelease = makePureRPC();
        vi.spyOn(failedRelease.transform as any, '_handle').mockRejectedValue(new Error('release failed'));
        await (failedRelease.transform as any)._onPureRPCRequest('remote', {
            callId: 'failed-release', op: 'release', rpcId: 'missing', path: [],
        });

        const second = makePureRPC();
        const marker = serializeWith(second.transform, new PureRPC({ method() { return 1; } }));
        await (second.transform as any)._handle({ op: 'get', rpcId: marker.rpcId, path: ['method'] });
        expect((second.transform as any)._callbackForwarders.size).toBe(1);
        second.transform.releaseAll();
        expect((second.transform as any)._callbackForwarders.size).toBe(0);
    });

    it('ignores future PureRPC releases and applies a pending release after rollback', async () => {
        const { events, transform } = makePureRPC();
        const handle = new PureRPC({ value: 1 });
        const first = serializeWith(transform, handle);

        await (transform as any)._handle({ op: 'release', rpcId: first.rpcId, path: [], lease: first.lease + 1 });
        expect((transform as any)._registry.has(first.rpcId)).toBe(true);

        const transaction = new SerializationTransaction();
        const clone = new PureValueClone(handle);
        transform.serialize(clone, transaction);
        await (transform as any)._handle({ op: 'release', rpcId: first.rpcId, path: [], lease: first.lease });
        transaction.rollback();

        expect((transform as any)._registry.has(first.rpcId)).toBe(false);
        events.removeAllListeners();
    });

    it('applies a pending callback release after a newer lease rolls back', () => {
        const { callbacks } = callbackTransforms();
        const callback = () => 1;
        const first = serializeWith(callbacks, callback);
        const transaction = new SerializationTransaction();
        const clone = new PureValueClone(callback);
        callbacks.serialize(clone, transaction);

        (callbacks as any)._onCallbackRelease('remote', { funcId: first.funcId, lease: first.lease });
        transaction.rollback();

        expect(callbacks.hasLiveState()).toBe(false);
    });

    it('covers auto-wrap exclusions and constructor-less class-like objects', () => {
        const { transform } = makePureRPC({ autoWrapUnknownClasses: true });
        const ws = {
            url: '', readyState: 1, bufferedAmount: 0, extensions: '', protocol: '', binaryType: 'arraybuffer',
            onopen: null, onclose: null, onerror: null, onmessage: null,
            addEventListener() { }, removeEventListener() { }, close() { }, send() { },
        } as any;
        expect((transform as any)._isAutoWrappable(new WebSocketForce(ws))).toBe(false);

        const proto = Object.create(Object.prototype, { constructor: { value: undefined } });
        expect((transform as any)._isAutoWrappable(Object.create(proto))).toBe(true);
        const invalidConstructorProto = Object.create(Object.prototype, { constructor: { value: 3 } });
        expect((transform as any)._isAutoWrappable(Object.create(invalidConstructorProto))).toBe(false);

        const constructorRead = vi.fn();
        const hostile = Object.create(Object.create(Object.prototype));
        Object.defineProperty(hostile, 'constructor', { get: constructorRead });
        expect((transform as any)._isAutoWrappable(hostile)).toBe(false);
        expect(constructorRead).not.toHaveBeenCalled();
    });

    it('covers registry container validation and prototype ownership edges', () => {
        const registry = new PureRPCRegistry();
        const root = { primitive: 1, nested: {} };
        const rpcId = registry.register(root);

        expect(registry.resolveContainer(rpcId, 'nested' as any)).toBeUndefined();
        expect(registry.resolveContainer('missing', [])).toBeUndefined();
        expect(registry.resolveContainer(rpcId, ['primitive'])).toBeUndefined();
        expect(registry.resolveContainer(rpcId, ['nested'])?.container).toBe(root.nested);
    });

    it('covers clone ownership, repeated clones, non-cloneable values, and null prototypes', () => {
        const clone = new PureValueClone<any>({});
        const owned = clone.own({ value: 1 });
        expect(clone.clone(owned)).toBe(owned);

        const source = { value: 2 };
        const first = clone.clone(source);
        expect(clone.clone(source)).toBe(first);
        expect(clone.clone(first)).toBe(first);
        const date = new Date();
        expect(clone.clone(date)).toBe(date);

        const nullPrototype = Object.assign(Object.create(null), { value: 3 });
        expect(Object.getPrototypeOf(clone.clone(nullPrototype))).toBeNull();
    });

    it('covers proxy duplicate release, membership, and no-finalizer construction', async () => {
        const release = vi.fn();
        const remote = createPureRPCProxy({
            get: async () => 1,
            set: async () => undefined,
            apply: async () => 2,
            release,
        });
        expect('anything' in remote).toBe(true);
        await expect(remote()).resolves.toBe(2);
        remote[Symbol.dispose]();
        remote[Symbol.dispose]();
        expect(release).toHaveBeenCalledOnce();

        const original = globalThis.FinalizationRegistry;
        vi.stubGlobal('FinalizationRegistry', undefined);
        vi.resetModules();
        const withoutFinalizer = await import('../src/PerfectWSAdvanced/transform/utils/createPureRPCProxy.js');
        const plain = withoutFinalizer.createPureRPCProxy({ get: async () => 1, set: async () => undefined, apply: async () => 1 });
        expect(await plain.value).toBe(1);
        vi.stubGlobal('FinalizationRegistry', original);
        vi.resetModules();
    });

    it('releases a PureRPC proxy through its finalizer callback', async () => {
        let finalize!: (release: () => void) => void;
        let held!: () => void;
        class CapturingFinalizationRegistry {
            constructor(callback: (release: () => void) => void) { finalize = callback; }
            register(_target: object, value: () => void) { held = value; }
            unregister() { return true; }
        }
        vi.stubGlobal('FinalizationRegistry', CapturingFinalizationRegistry);
        vi.resetModules();
        const module = await import('../src/PerfectWSAdvanced/transform/utils/createPureRPCProxy.js');
        const release = vi.fn();
        module.createPureRPCProxy({
            get: async () => 1,
            set: async () => undefined,
            apply: async () => 1,
            release,
        });

        finalize(held);

        expect(release).toHaveBeenCalledOnce();
        vi.resetModules();
    });

    it('ignores a delayed finalizer from an older proxy generation', async () => {
        let finalizeOldProxy!: () => void;
        class CapturingFinalizationRegistry {
            register(_target: object, held: unknown) {
                if (typeof held === 'function' && finalizeOldProxy === undefined) {
                    finalizeOldProxy = held as () => void;
                }
            }
            unregister() { return true; }
        }
        vi.stubGlobal('FinalizationRegistry', CapturingFinalizationRegistry);
        vi.resetModules();
        const module = await import('../src/PerfectWSAdvanced/transform/TransformPureRPC.js');
        const callbacks = new TransformCallbacks(new NetworkEventListener());
        const transform = new module.TransformPureRPC({
            events: new NetworkEventListener(),
            fullTrustedRPC: true,
            transformCallbacks: callbacks,
        }) as any;
        const marker = { ___perfectWS: 1, ___type: 'pureRPC', rpcId: 'remote' };

        transform.deserialize(marker);
        transform._receivedProxies.get('remote').ref = { deref: () => undefined };
        const replacement = transform.deserialize(marker);
        finalizeOldProxy();

        expect(transform._receivedProxies.get('remote').ref.deref()).toBe(replacement);
        transform.releaseAll();
        callbacks.releaseAll();
        vi.resetModules();
    });

    it('covers encoded symbols, escaped path segments, and safe lookup failures', () => {
        const globalKey = Symbol.for('a.b!c\\d');
        const encoded = encodePathKey(globalKey)!;
        const object: any = { fn() { return 1; }, ['a.b!c\\d']: 2, [globalKey]: 3 };

        expect(getProperty(object, encoded, new Map([['a.b!c\\d', globalKey]]))).toBe(3);
        expect(getProperty({ 'a.b': 4 }, 'a\\.b')).toBe(4);
        expect(getProperty(object, 'missing')).toBeUndefined();
        expect(encodePathKey(Symbol('local'))).toBeNull();
    });
});
