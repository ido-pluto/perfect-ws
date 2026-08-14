import { describe, it, expect, beforeEach } from 'vitest';
import { serializeWith } from './utils/serializeWith.js';
import { TransformPureRPC } from '../src/PerfectWSAdvanced/transform/TransformPureRPC.js';
import { PureRPC } from '../src/PerfectWSAdvanced/PureRPC.js';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.js';
import { TransformCallbacks } from '../src/PerfectWSAdvanced/transform/TransformCallbacks.js';

class Counter extends PureRPC {
    count = 5;
    increment() { return ++this.count; }
}

/**
 * Registers the response listener *before* emitting the request - some responder paths
 * (notably the `fullTrustedRPC: false` refusal) answer fully synchronously, within the same
 * call stack as the emit, so a listener registered on the line *after* the emit can miss it
 * entirely and hang the test. Every other path happens to have an `await` before it responds,
 * which accidentally hides the same race - so this helper is used uniformly, not just for the
 * cases that would otherwise fail.
 */
function sendRequest(events: NetworkEventListener, message: { callId: string;[key: string]: any; }): Promise<any> {
    const response = new Promise<any>((resolve) => {
        events.on('___pureRPC.response', (source, data: any) => {
            if (source === 'local' && data.callId === message.callId) resolve(data);
        });
    });

    events._emitWithSource('___pureRPC.request', 'remote', message);
    return response;
}

async function sendRelease(events: NetworkEventListener, message: { callId: string;[key: string]: any; }): Promise<void> {
    events._emitWithSource('___pureRPC.request', 'remote', message);
    await Promise.resolve();
}

describe('TransformPureRPC', () => {
    let events: NetworkEventListener;
    let transform: TransformPureRPC;
    let callbacks: TransformCallbacks;

    const createTransform = (
        targetEvents: NetworkEventListener,
        fullTrustedRPC: boolean,
        autoWrapUnknownClasses = false
    ) => {
        const transformCallbacks = new TransformCallbacks(targetEvents, 10);
        return {
            callbacks: transformCallbacks,
            transform: new TransformPureRPC({
                events: targetEvents,
                fullTrustedRPC,
                maxDepth: 10,
                maxHandles: 10_000,
                autoWrapUnknownClasses,
                transformCallbacks
            })
        };
    };

    beforeEach(() => {
        events = new NetworkEventListener();
        ({ transform, callbacks } = createTransform(events, true));
    });

    describe('serialize', () => {
        it('registers a PureRPC instance and produces a marker', () => {
            const serialized = serializeWith(transform, new Counter());
            expect(serialized).toHaveProperty('___type', 'pureRPC');
            expect(typeof serialized.rpcId).toBe('string');
        });

        it('leaves a non-PureRPC class instance untouched', () => {
            class Plain { x = 1; }
            expect(serializeWith(transform, new Plain())).toBeInstanceOf(Plain);
        });

        it('the same instance registered twice gets the same rpcId', () => {
            const counter = new Counter();
            const a = serializeWith(transform, { counter });
            const b = serializeWith(transform, { counter });
            expect(a.counter.rpcId).toBe(b.counter.rpcId);
        });
    });

    describe('___pureRPC.request handling (responder side)', () => {
        it('get resolves an exposed property', async () => {
            const { rpcId } = serializeWith(transform, new Counter());

            const response = await sendRequest(events, { callId: 'c1', op: 'get', rpcId, path: ['count'] });

            expect(response.data).toBe(5);
            expect(response.error).toBeUndefined();
        });

        it('apply calls the real method and returns its result', async () => {
            const { rpcId } = serializeWith(transform, new Counter());

            const response = await sendRequest(events, { callId: 'c2', op: 'apply', rpcId, path: ['increment'], args: [] });

            expect(response.data).toBe(6);
        });

        it('apply calls a function wrapped at the PureRPC root', async () => {
            const { rpcId } = serializeWith(transform, new PureRPC((value: number) => value * 2));

            const response = await sendRequest(events, { callId: 'c2-root', op: 'apply', rpcId, path: [], args: [4] });

            expect(response.data).toBe(8);

            const withoutArgs = await sendRequest(events, { callId: 'c2-root-no-args', op: 'apply', rpcId, path: [] });
            expect(withoutArgs.data).toBeNaN();
        });

        it('apply rejects an object at the PureRPC root', async () => {
            const { rpcId } = serializeWith(transform, new Counter());

            const response = await sendRequest(events, { callId: 'c2-object-root', op: 'apply', rpcId, path: [], args: [] });

            expect(response.error).toMatch(/not found/i);
        });

        it('set writes to the real object', async () => {
            const counter = new Counter();
            const { rpcId } = serializeWith(transform, counter);

            await sendRequest(events, { callId: 'c3', op: 'set', rpcId, path: ['count'], value: 100 });

            expect(counter.count).toBe(100);
        });

        it('get on an unknown rpcId errors instead of hanging', async () => {
            const response = await sendRequest(events, { callId: 'c4', op: 'get', rpcId: 'unknown', path: ['x'] });

            expect(response.error).toBeTruthy();
            expect(response.data).toBeUndefined();
        });

        it('get on a method returns a callable reference bound to its receiver', async () => {
            const counter = new Counter();
            const { rpcId } = serializeWith(transform, counter);

            const response = await sendRequest(events, { callId: 'c5', op: 'get', rpcId, path: ['increment'] });

            expect(typeof response.data).toBe('function');
            expect(await response.data()).toBe(6);
            expect(counter.count).toBe(6);
        });

        it('does not confuse the same prototype method on two receivers', async () => {
            class Pair extends PureRPC {
                first = new Counter();
                second = new Counter();
            }
            const pair = new Pair();
            const { rpcId } = serializeWith(transform, pair);

            const first = await sendRequest(events, { callId: 'c5a', op: 'get', rpcId, path: ['first', 'increment'] });
            const second = await sendRequest(events, { callId: 'c5b', op: 'get', rpcId, path: ['second', 'increment'] });

            expect(await first.data()).toBe(6);
            expect(await second.data()).toBe(6);
            expect(pair.first.count).toBe(6);
            expect(pair.second.count).toBe(6);
        });

        it('keeps an extracted forwarded function independent from its parent handle', async () => {
            const { rpcId } = serializeWith(transform, new Counter());
            const first = await sendRequest(events, { callId: 'c5c', op: 'get', rpcId, path: ['increment'] });
            const second = await sendRequest(events, { callId: 'c5d', op: 'get', rpcId, path: ['increment'] });

            expect(first.data).toBe(second.data);
            serializeWith(callbacks, first.data);
            expect(callbacks['_functions'].size).toBe(1);

            await sendRelease(events, { callId: 'c5e', op: 'release', rpcId, path: [] });
            expect(callbacks['_functions'].size).toBe(1);
            expect(await first.data()).toBe(6);
        });

        it('apply on a non-function property errors', async () => {
            const { rpcId } = serializeWith(transform, new Counter());

            const response = await sendRequest(events, { callId: 'c6', op: 'apply', rpcId, path: ['count'], args: [] });

            expect(response.error).toBeTruthy();
        });

        it('set refuses a forbidden key (__proto__)', async () => {
            const { rpcId } = serializeWith(transform, new Counter());

            const response = await sendRequest(events, { callId: 'c7', op: 'set', rpcId, path: ['__proto__'], value: { polluted: true } });

            expect(response.error).toBeTruthy();
            expect(({} as any).polluted).toBeUndefined();
        });

        it('set on the root itself (empty path) errors', async () => {
            const { rpcId } = serializeWith(transform, new Counter());

            const response = await sendRequest(events, { callId: 'c8', op: 'set', rpcId, path: [], value: 1 });

            expect(response.error).toBeTruthy();
        });

        it('ignores a locally-sourced request instead of answering its own emit', async () => {
            const { rpcId } = serializeWith(transform, new Counter());
            let handled = false;
            events.on('___pureRPC.response', () => { handled = true; });

            events.emit('___pureRPC.request', { callId: 'c9', op: 'get', rpcId, path: ['count'] });
            await new Promise(resolve => setTimeout(resolve, 20));

            expect(handled).toBe(false);
        });

        it('release forgets the handle - a later get on the same rpcId then fails', async () => {
            const { rpcId } = serializeWith(transform, new Counter());

            await sendRelease(events, { callId: 'c10', op: 'release', rpcId, path: [] });
            const response = await sendRequest(events, { callId: 'c11', op: 'get', rpcId, path: ['count'] });

            expect(response.error).toBeTruthy();
        });

        it('release on an already-unknown rpcId is a harmless one-way notification', async () => {
            await expect(sendRelease(events, {
                callId: 'c12',
                op: 'release',
                rpcId: 'never-registered',
                path: []
            })).resolves.toBeUndefined();
        });
    });

    describe('A1 - responder-side enforcement (fullTrustedRPC: false)', () => {
        it('refuses a get regardless of what the peer sends, even for a real registered rpcId', async () => {
            const disabledEvents = new NetworkEventListener();
            const { transform: disabledTransform } = createTransform(disabledEvents, false);
            const { rpcId } = serializeWith(disabledTransform, new Counter());

            const response = await sendRequest(disabledEvents, { callId: 'd1', op: 'get', rpcId, path: ['count'] });

            expect(response.error).toMatch(/fullTrustedRPC/);
            expect(response.data).toBeUndefined();
        });

        it('does not register a PureRPC instance when serializing with the flag off', () => {
            const disabledEvents = new NetworkEventListener();
            const { transform: disabledTransform } = createTransform(disabledEvents, false);

            const serialized = serializeWith(disabledTransform, new Counter());

            expect(serialized).not.toHaveProperty('___type', 'pureRPC');
            expect(serialized).toBeInstanceOf(Counter);
        });
    });

    describe('phase 6 - autoWrapUnknownClasses (A4/A9)', () => {
        class UnknownWidget {
            label = 'widget';
            shout() { return this.label.toUpperCase(); }
        }

        it('leaves an unknown class instance untouched when the flag is off (default)', () => {
            const serialized = serializeWith(transform, new UnknownWidget());
            expect(serialized).not.toHaveProperty('___type', 'pureRPC');
            expect(serialized).toBeInstanceOf(UnknownWidget);
        });

        it('wraps an unknown class instance in a live PureRPC marker when the flag is on', () => {
            const autoWrapEvents = new NetworkEventListener();
            const { transform: autoWrapTransform } = createTransform(autoWrapEvents, true, true);

            const serialized = serializeWith(autoWrapTransform, new UnknownWidget());

            expect(serialized).toHaveProperty('___type', 'pureRPC');
            expect(typeof serialized.rpcId).toBe('string');
        });

        it('a real PureRPC subclass still registers normally when the flag is on (no double-wrap)', () => {
            const autoWrapEvents = new NetworkEventListener();
            const { transform: autoWrapTransform } = createTransform(autoWrapEvents, true, true);

            const counter = new Counter();
            const serialized = serializeWith(autoWrapTransform, counter);

            expect(serialized).toHaveProperty('___type', 'pureRPC');
            // Registered exactly once - the same object serialized again gets the same id,
            // which would only hold if the PureRPC branch (not a second auto-wrap pass) claimed it.
            expect(serializeWith(autoWrapTransform, counter).rpcId).toBe(serialized.rpcId);
        });

        it('still leaves a plain object/array untouched with the flag on', () => {
            const autoWrapEvents = new NetworkEventListener();
            const { transform: autoWrapTransform } = createTransform(autoWrapEvents, true, true);

            expect(serializeWith(autoWrapTransform, { a: 1 })).not.toHaveProperty('___type', 'pureRPC');
            expect(serializeWith(autoWrapTransform, [1, 2, 3])).toEqual([1, 2, 3]);
        });

        it('never wraps a Date, RegExp, or Promise even with the flag on - BSON already handles them (audit finding)', () => {
            const autoWrapEvents = new NetworkEventListener();
            const { transform: autoWrapTransform } = createTransform(autoWrapEvents, true, true);

            expect(serializeWith(autoWrapTransform, new Date('2024-01-01'))).toBeInstanceOf(Date);
            expect(serializeWith(autoWrapTransform, /abc/gi)).toBeInstanceOf(RegExp);
            expect(serializeWith(autoWrapTransform, Promise.resolve(1))).toBeInstanceOf(Promise);
        });

        it('never wraps a denylisted host-object shape even with the flag on (A4 backstop)', () => {
            const autoWrapEvents = new NetworkEventListener();
            const { transform: autoWrapTransform } = createTransform(autoWrapEvents, true, true);

            class Socket { write() { } }
            const fakeSocket = new Socket();

            const serialized = serializeWith(autoWrapTransform, fakeSocket);

            expect(serialized).not.toHaveProperty('___type', 'pureRPC');
            expect(serialized).toBeInstanceOf(Socket);
        });

        it('does not wrap anything when fullTrustedRPC is off, regardless of the flag', () => {
            const disabledEvents = new NetworkEventListener();
            const { transform: disabledTransform } = createTransform(disabledEvents, false, true);

            const serialized = serializeWith(disabledTransform, new UnknownWidget());

            expect(serialized).not.toHaveProperty('___type', 'pureRPC');
        });
    });

    describe('hasLiveState', () => {
        it('is false with nothing registered and nothing pending', () => {
            expect(transform.hasLiveState()).toBe(false);
        });

        it('is true once something has been registered via serialize', () => {
            serializeWith(transform, new Counter());
            expect(transform.hasLiveState()).toBe(true);
        });

        it('releaseAll removes protocol listeners and makes received handles fail immediately', async () => {
            const remote: any = transform.deserialize({ ___perfectWS: 1, ___type: 'pureRPC', rpcId: 'remote-id' });

            expect(events.listenerCount('___pureRPC.request')).toBe(1);
            expect(events.listenerCount('___pureRPC.response')).toBe(1);

            transform.releaseAll();
            transform.releaseAll();

            expect(events.listenerCount('___pureRPC.request')).toBe(0);
            expect(events.listenerCount('___pureRPC.response')).toBe(0);
            await expect((async () => await remote.value)()).rejects.toMatchObject({ code: 'pureRPCReleased' });
        });
    });
});
