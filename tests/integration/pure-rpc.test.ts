import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWSAdvanced, PureRPC, NetworkEventListener } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { sleep } from '../../src/utils/sleepPromise.js';

class Counter extends PureRPC {
    count = 0;
    increment() { return ++this.count; }
    add(n: number) { this.count += n; return this.count; }
    private secret = 'top-secret';
    check(this: Counter) { return this.secret === 'top-secret'; }
}

describe('PureRPC end to end', () => {
    let wss: WebSocketServer;
    let serverPort: number;
    const openSockets: WebSocket[] = [];

    beforeEach(async () => {
        wss = new WebSocketServer({ port: 0 });
        await new Promise<void>(resolve => wss.once('listening', () => resolve()));
        const address = wss.address();
        if (typeof address === 'string' || address === null) throw new Error('Missing WebSocket address');
        serverPort = address.port;
    });

    afterEach(async () => {
        for (const ws of openSockets) {
            try { ws.close(); } catch { }
        }
        openSockets.length = 0;
        await new Promise((resolve) => wss.close(resolve));
        await sleep(20);
    });

    const connect = () => new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${serverPort}`);
        openSockets.push(ws);
        ws.once('open', () => resolve(ws));
    });

    const setUpTrustedPair = async () => {
        const { router: server, attachClient } = PerfectWSAdvanced.server();
        server.config.fullTrustedRPC = true;
        wss.on('connection', (ws) => attachClient(ws));

        const { router: client, setServer } = PerfectWSAdvanced.client();
        client.config.fullTrustedRPC = true;
        const clientSocket = await connect();
        setServer(clientSocket);
        await client.serverOpen;

        return { server, client, setServer, clientSocket };
    };

    it('a returned PureRPC instance arrives as a live handle, not a plain object', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');

        expect(typeof remote).toBe('function');
        expect(await remote.count).toBe(0);
    });

    it('keeps a live handle channel while the returned value is referenced', async () => {
        const { server, client } = await setUpTrustedPair();
        server.on('getCounter', () => new Counter());
        const counter: any = await client.request('getCounter');

        expect(await counter.increment()).toBe(1);
        expect((client as any)['_activeRequests'].size).toBe(1);
        expect((server as any)['_activeResponses'].size).toBe(1);
    });

    it('finishes an in-flight method after the handle is disposed', async () => {
        const { server, client } = await setUpTrustedPair();
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<number>();
        server.on('getSlowHandle', () => new PureRPC({
            async slow() {
                started.resolve();
                return await finish.promise;
            },
        }));

        const remote: any = await client.request('getSlowHandle');
        const result = remote.slow();
        await started.promise;
        remote[Symbol.dispose]();
        finish.resolve(9);

        await expect(result).resolves.toBe(9);
        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
    });

    it('an explicit PureRPC wrapper exposes an existing object', async () => {
        const { server, client } = await setUpTrustedPair();
        const service = {
            value: 3,
            multiply(this: any, amount: number) {
                this.value *= amount;
                return this.value;
            }
        };
        server.on('getService', () => new PureRPC(service));

        const remote = await client.request('getService');

        expect(await (remote as any).multiply(4)).toBe(12);
        expect(service.value).toBe(12);
    });

    it('an explicit PureRPC wrapper can expose a callable root', async () => {
        const { server, client } = await setUpTrustedPair();
        server.on('getMultiplier', () => new PureRPC((value: number) => value * 3));

        const multiply: any = await client.request('getMultiplier');

        expect(await multiply(4)).toBe(12);
    });

    it('a client-owned PureRPC value works in request data', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('useClientCounter', async (remote: any) => {
            return {
                incremented: await remote.increment(),
                current: await remote.count,
            };
        });

        await expect(client.request('useClientCounter', counter)).resolves.toEqual({
            incremented: 1,
            current: 1,
        });
        expect(counter.count).toBe(1);

        // Its automatic cross-peer collection is covered by rpc-gc.test.ts under --expose-gc.
    });

    it('rejects and releases a response whose custom transform is unknown to the client', async () => {
        class ServerOnlyValue {
            constructor(readonly value: string) { }
        }
        const { server, client } = await setUpTrustedPair();
        server.transformers.push({
            uniqueId: 'server-only-value',
            check: (value: any): value is ServerOnlyValue => value instanceof ServerOnlyValue,
            serialize: value => value.value,
            deserialize: value => new ServerOnlyValue(value),
        });
        server.on('getServerOnlyValue', () => new ServerOnlyValue('secret'));

        await expect(client.request('getServerOnlyValue')).rejects.toMatchObject({
            code: 'deserializeFailed',
            message: 'Transform instruction not found: server-only-value',
        });
        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
    });

    it('contains an unknown custom transform received in a response event', async () => {
        class ServerOnlyEvent {
            constructor(readonly value: string) { }
        }
        const { server, client } = await setUpTrustedPair();
        server.transformers.push({
            uniqueId: 'server-only-event',
            check: (value: any): value is ServerOnlyEvent => value instanceof ServerOnlyEvent,
            serialize: value => value.value,
            deserialize: value => new ServerOnlyEvent(value),
        });
        let ownerObservedAbort = false;
        server.on('sendServerOnlyEvent', async (_data, options) => {
            options.events.emit('serverOnlyEvent', new ServerOnlyEvent('event'));
            await new Promise<void>(resolve => {
                options.abortSignal.addEventListener('abort', () => {
                    ownerObservedAbort = true;
                    resolve();
                }, { once: true });
            });
        });

        await expect(client.request('sendServerOnlyEvent')).rejects.toMatchObject({
            code: 'deserializeFailed',
        });
        await vi.waitFor(() => {
            expect(ownerObservedAbort).toBe(true);
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
    });

    it('releases a completed live channel if a later event cannot be deserialized', async () => {
        class LateServerOnlyEvent {
            constructor(readonly value: string) { }
        }
        const { server, client } = await setUpTrustedPair();
        server.transformers.push({
            uniqueId: 'late-server-only-event',
            check: (value: any): value is LateServerOnlyEvent => value instanceof LateServerOnlyEvent,
            serialize: value => value.value,
            deserialize: value => new LateServerOnlyEvent(value),
        });
        let responseEvents: NetworkEventListener | undefined;
        server.on('getLateEventCallback', (_data, options) => {
            responseEvents = options.events;
            return (value: string) => value;
        });
        const callback: any = await client.request('getLateEventCallback');

        responseEvents!.emit('lateServerOnlyEvent', new LateServerOnlyEvent('event'));

        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
        await expect(callback('after release')).rejects.toMatchObject({ code: 'callbackReleased' });
    });

    it('releases both sides when a live-channel event contains an unknown transform', async () => {
        class ClientOnlyEvent {
            constructor(readonly value: string) { }
        }
        const { server, client } = await setUpTrustedPair();
        client.transformers.push({
            uniqueId: 'client-only-event',
            check: (value: any): value is ClientOnlyEvent => value instanceof ClientOnlyEvent,
            serialize: value => value.value,
            deserialize: value => new ClientOnlyEvent(value),
        });
        server.on('getLiveCallback', () => (value: string) => value);
        const events = new NetworkEventListener();
        const callback: any = await client.request('getLiveCallback', null, { events });

        events.emit('clientOnlyEvent', new ClientOnlyEvent('event'));

        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
        await expect(callback('after release')).rejects.toMatchObject({ code: 'callbackReleased' });
    });

    it('get always fetches fresh - reflects a change the server made after the handle was obtained', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');
        expect(await remote.count).toBe(0);

        counter.count = 42;

        expect(await remote.count).toBe(42);
    });

    it('explicit disposal releases the handle on the server (Symbol.dispose)', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');
        expect(await remote.count).toBe(0);

        remote[Symbol.dispose]();
        await sleep(50);

        expect((client as any)['_activeRequests'].size).toBe(0);
        expect((server as any)['_activeResponses'].size).toBe(0);
        await expect((async () => await remote.count)()).rejects.toThrow();
    });

    it('supports using declarations for deterministic scope cleanup', async () => {
        const { server, client } = await setUpTrustedPair();
        server.on('getCounter', () => new Counter());

        {
            using remote: any = await client.request('getCounter');
            expect(await remote.increment()).toBe(1);
            expect((client as any)._activeRequests.size).toBe(1);
            expect((server as any)._activeResponses.size).toBe(1);
        }

        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
    });

    it('apply calls the real method and mutates real server-side state', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');

        expect(await remote.increment()).toBe(1);
        expect(await remote.increment()).toBe(2);
        expect(counter.count).toBe(2);

        expect(await remote.add(10)).toBe(12);
        expect(counter.count).toBe(12);
    });

    it('calls methods inherited through user-defined base classes', async () => {
        class BaseService extends PureRPC {
            baseValue() { return 'from base'; }
        }
        class DerivedService extends BaseService {
            derivedValue() { return 'from derived'; }
        }

        const { server, client } = await setUpTrustedPair();
        server.on('getDerivedService', () => new DerivedService());
        const remote: any = await client.request('getDerivedService');

        await expect(remote.baseValue()).resolves.toBe('from base');
        await expect(remote.derivedValue()).resolves.toBe('from derived');
        await expect(remote.toString()).rejects.toMatchObject({ code: 'pureRPCError' });
    });

    it('a fetched method is a callable callback and preserves its primitive result', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');
        const increment = await remote.increment;

        expect(typeof increment).toBe('function');
        expect(await increment()).toBe(1);
        expect(counter.count).toBe(1);

        remote[Symbol.dispose]();
        await expect(increment()).resolves.toBe(2);
    });

    it('set writes through to the real server-side object, fire and forget', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');

        remote.count = 100;
        await sleep(50);

        expect(counter.count).toBe(100);
        expect(await remote.count).toBe(100);
    });

    it('a get immediately after a set observes the written value (A2 ordering)', async () => {
        const { server, client } = await setUpTrustedPair();
        const counter = new Counter();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');

        remote.count = 55;
        // No sleep - the get is issued immediately after the fire-and-forget set.
        expect(await remote.count).toBe(55);
    });

    it('a set that fails on the server surfaces on ___pureRPC.setError (A3) instead of vanishing silently', async () => {
        class Locked extends PureRPC {
            get frozen() { return 1; }
            set frozen(_v: number) { throw new Error('read-only'); }
        }

        const { server, client } = await setUpTrustedPair();
        server.on('getLocked', async () => new Locked());

        const events = new NetworkEventListener();
        const remote: any = await client.request('getLocked', null, { events });

        const setErrorPromise = new Promise<any>(resolve => {
            events.on('___pureRPC.setError', (source, message: any) => {
                if (source === 'local') resolve(message);
            });
        });

        // Fire and forget from the caller's side - no throw here, no await needed for the
        // write itself.
        expect(() => { remote.frozen = 99; }).not.toThrow();

        const errorEvent = await setErrorPromise;
        expect(errorEvent.error).toContain('read-only');
        expect(errorEvent.path).toEqual(['frozen']);
    });

    it('chained property access resolves nested state', async () => {
        class Holder extends PureRPC {
            inner = { deep: { value: 'found' } };
        }

        const { server, client } = await setUpTrustedPair();
        const holder = new Holder();
        server.on('getHolder', async () => holder);

        const remote: any = await client.request('getHolder');

        expect(await remote.inner.deep.value).toBe('found');
    });

    it('passing a received handle back to its own owner unwraps to the real object (audit A6)', async () => {
        class Counter2 extends PureRPC {
            count = 0;
            increment() { return ++this.count; }
            describe(this: Counter2, other: any) {
                return other === this;
            }
        }

        const { server, client } = await setUpTrustedPair();
        const counter = new Counter2();
        server.on('getCounter', async () => counter);

        const remote: any = await client.request('getCounter');

        // Passing `remote` back to its own owner must resolve `other` on the server side to
        // the real, original `counter` instance - not a proxy that talks back over the wire
        // to itself, and not a mangled callback stub (both were confirmed bugs before A6).
        expect(await remote.describe(remote)).toBe(true);
    });

    it('a nested PureRPC instance returned from a method becomes its own live handle', async () => {
        class Item extends PureRPC {
            constructor(public label: string) { super(); }
        }
        class Basket extends PureRPC {
            getItem(label: string) { return new Item(label); }
        }

        const { server, client } = await setUpTrustedPair();
        const basket = new Basket();
        server.on('getBasket', async () => basket);

        const remote: any = await client.request('getBasket');
        const item: any = await remote.getItem('apple');

        expect(await item.label).toBe('apple');
    });

    it('a separately returned nested handle can be disposed without releasing its parent', async () => {
        class Item extends PureRPC {
            constructor(public label: string) { super(); }
        }
        class Basket extends PureRPC {
            name = 'basket';
            getItem(label: string) { return new Item(label); }
        }

        const { server, client } = await setUpTrustedPair();
        server.on('getBasket', () => new Basket());
        const basket = await client.request('getBasket');
        const releasedItem: any = await (basket as any).getItem('pear');
        expect(await releasedItem.label).toBe('pear');
        releasedItem[Symbol.dispose]();

        await expect((async () => await releasedItem.label)()).rejects.toThrow();
        expect(await (basket as any).name).toBe('basket');
    });

    describe('errors', () => {
        it('getting a missing property rejects cleanly instead of hanging', async () => {
            const { server, client } = await setUpTrustedPair();
            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const remote: any = await client.request('getCounter');

            await expect((async () => await remote.doesNotExist)()).rejects.toThrow();
        });

        it('calling a missing method rejects cleanly instead of hanging', async () => {
            const { server, client } = await setUpTrustedPair();
            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const remote: any = await client.request('getCounter');

            await expect(remote.doesNotExist()).rejects.toThrow();
        });

        it('a thrown error inside the real method surfaces to the caller', async () => {
            class Thrower extends PureRPC {
                boom() { throw new Error('deliberate failure'); }
            }

            const { server, client } = await setUpTrustedPair();
            server.on('getThrower', async () => new Thrower());

            const remote: any = await client.request('getThrower');

            await expect(remote.boom()).rejects.toThrow('deliberate failure');
        });
    });

    describe('security - the wire protocol enforces the same guards as PureRPCRegistry directly', () => {
        it('cannot reach Function.prototype through a resolved method (confirmed exploit, end-to-end regression)', async () => {
            const { server, client } = await setUpTrustedPair();
            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const remote: any = await client.request('getCounter');

            await expect((async () => await remote.check.apply)()).rejects.toThrow();
        });

        it('cannot set __proto__ through the wire', async () => {
            const { server, client } = await setUpTrustedPair();
            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const remote: any = await client.request('getCounter');

            remote.__proto__ = { polluted: true };
            await sleep(50);

            expect(({} as any).polluted).toBeUndefined();
        });

        it('getting a private field mangled onto the instance is not reachable by name manipulation of forbidden keys', async () => {
            const { server, client } = await setUpTrustedPair();
            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const remote: any = await client.request('getCounter');

            // `secret` itself isn't forbidden - it's a real own property, and "remote by
            // default" (decision 3) means it IS reachable. This documents that intentional
            // scope, not a bug: only __proto__/constructor/prototype and the prototype-escape
            // are blocked, not "privacy" in the general sense.
            expect(await remote.secret).toBe('top-secret');
        });
    });

    describe('fullTrustedRPC gating', () => {
        it('a marker received by a side with fullTrustedRPC off is left inert, not wired to a live proxy', async () => {
            const { router: server, attachClient } = PerfectWSAdvanced.server();
            server.config.fullTrustedRPC = true;
            wss.on('connection', (ws) => attachClient(ws));

            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const { router: client, setServer } = PerfectWSAdvanced.client();
            // Deliberately NOT setting fullTrustedRPC on the client.
            setServer(await connect());
            await client.serverOpen;

            const result: any = await client.request('getCounter', null);

            // Left as the raw marker object rather than a live proxy - using it as a proxy
            // would mean this side acting on PureRPC despite not opting in.
            expect(result).toHaveProperty('___type', 'pureRPC');
            expect(typeof result).toBe('object');
        });

        it('a PureRPC instance from a side with fullTrustedRPC off is not treated specially at all', async () => {
            const { router: server, attachClient } = PerfectWSAdvanced.server();
            // Deliberately NOT setting fullTrustedRPC on the server.
            wss.on('connection', (ws) => attachClient(ws));

            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const { router: client, setServer } = PerfectWSAdvanced.client();
            client.config.fullTrustedRPC = true;
            setServer(await connect());
            await client.serverOpen;

            const result: any = await client.request('getCounter', null);

            expect(result).not.toHaveProperty('___type', 'pureRPC');
        });

        // `fullTrustedRPC` is captured once per connection at construction (same as `verbose`/
        // `debugging`), not re-checked live - see `tests/TransformPureRPC.test.ts` for A1's
        // responder-side enforcement tested directly against a `false`-constructed instance.
    });

    describe('reconnect survival (A7)', () => {
        it('a handle keeps working across a real disconnect/reconnect (new socket, same client instance)', async () => {
            const { router: server, attachClient } = PerfectWSAdvanced.server();
            server.config.fullTrustedRPC = true;
            wss.on('connection', (ws) => attachClient(ws));

            const counter = new Counter();
            server.on('getCounter', async () => counter);

            const { router: client, setServer } = PerfectWSAdvanced.client();
            client.config.fullTrustedRPC = true;
            const ws1 = await connect();
            setServer(ws1);
            await client.serverOpen;

            const remote: any = await client.request('getCounter');
            expect(await remote.increment()).toBe(1);

            // Kill the socket hard (not a graceful close) to simulate a real network drop, then
            // reconnect the SAME client instance on a new socket - `___syncRequests` re-links the
            // still-open response to the new socket (phase 1c) and `sendRequestRetry` no longer
            // bails out early for this post-completion channel (Correction #4), so a handle handed
            // out before the drop keeps working rather than hanging or erroring after reconnect.
            // This is the case the original A7 write-up worried an "epoch" mechanism would be
            // needed for - verified empirically that it already isn't, once those two fixes landed.
            (ws1 as any)._socket?.destroy?.() ?? ws1.terminate();
            await sleep(250);

            setServer(await connect());

            expect(await remote.increment()).toBe(2);
            expect(counter.count).toBe(2);
        }, 15000);

        it('a handle call started while disconnected waits for the replacement socket', async () => {
            const { router: server, attachClient } = PerfectWSAdvanced.server();
            server.config.fullTrustedRPC = true;
            wss.on('connection', (ws) => attachClient(ws));

            const counter = new Counter();
            server.on('getCounter', () => counter);

            const { router: client, setServer } = PerfectWSAdvanced.client();
            client.config.fullTrustedRPC = true;
            client.config.reconnectTimeout = 3000;
            const ws1 = await connect();
            setServer(ws1);
            await client.serverOpen;

            const remote = await client.request('getCounter');
            const closed = new Promise<void>(resolve => ws1.once('close', () => resolve()));
            ws1.terminate();
            await closed;

            const result = (remote as any).increment();
            await sleep(30);
            setServer(await connect());

            await expect(result).resolves.toBe(1);
            expect(counter.count).toBe(1);
        }, 15000);

        it('reconnects a live handle when maxActiveRequests is already full', async () => {
            const { server, client, setServer, clientSocket } = await setUpTrustedPair();
            server.on('capacityHandle', () => new Counter());
            const remote: any = await client.request('capacityHandle');
            client.config.maxActiveRequests = 1;
            server.config.maxActiveRequests = 1;

            const closed = new Promise<void>(resolve => clientSocket.once('close', resolve));
            clientSocket.terminate();
            await closed;
            setServer(await connect());
            await client.serverOpen;

            await expect(remote.increment()).resolves.toBe(1);
        }, 15000);

        it('delivers a handle release after a disconnect longer than reconnectTimeout while sibling resources stay live', async () => {
            const { server, client, setServer, clientSocket } = await setUpTrustedPair();
            client.config.reconnectTimeout = 20;
            server.on('getMixedResources', () => ({
                handle: new Counter(),
                keep: (value: number) => value + 1,
            }));

            const resources: any = await client.request('getMixedResources');
            const serverResponse = [...(server as any)._activeResponses.values()]
                .find((response: any) => response.method === 'getMixedResources');
            const serverTransforms = (server as any)._callbacks.get(serverResponse.events);
            expect(serverTransforms._pureRPC._registry.size).toBe(1);

            const closed = new Promise<void>(resolve => clientSocket.once('close', resolve));
            clientSocket.terminate();
            await closed;
            resources.handle[Symbol.dispose]();
            await sleep(80);

            expect(serverTransforms._pureRPC._registry.size).toBe(1);
            setServer(await connect());
            await client.serverOpen;

            await vi.waitFor(() => expect(serverTransforms._pureRPC._registry.size).toBe(0));
            await expect(resources.keep(4)).resolves.toBe(5);
            expect((server as any)._activeResponses.size).toBe(1);
        }, 15000);

        it('does not expire a completed live handle after requestTimeout while disconnected', async () => {
            const { router: server, attachClient } = PerfectWSAdvanced.server();
            server.config.fullTrustedRPC = true;
            server.config.requestTimeout = 30;
            wss.on('connection', ws => attachClient(ws));

            const counter = new Counter();
            server.on('getCounter', () => counter);

            const { router: client, setServer } = PerfectWSAdvanced.client();
            client.config.fullTrustedRPC = true;
            client.config.requestTimeout = 30;
            client.config.clearOldRequestsDelay = 5;
            const firstSocket = await connect();
            setServer(firstSocket);
            await client.serverOpen;

            const remote: any = await client.request('getCounter');
            expect(await remote.increment()).toBe(1);
            const activeClientRequest = [...(client as any)._activeRequests.values()][0];
            const activeServerResponse = [...(server as any)._activeResponses.values()][0];

            const closed = new Promise<void>(resolve => firstSocket.once('close', resolve));
            firstSocket.terminate();
            await closed;
            await sleep(100);

            expect((client as any)._activeRequests.size).toBe(1);
            expect((server as any)._activeResponses.size).toBe(1);
            expect(activeClientRequest.server).toBeUndefined();
            expect(activeServerResponse.clientRef.ref).toBeNull();

            setServer(await connect());
            await client.serverOpen;
            expect(await remote.increment()).toBe(2);
        }, 15000);
    });

    describe('client isolation', () => {
        it('scopes an explicit request id independently for each client', async () => {
            const { router: server, attachClient } = PerfectWSAdvanced.server();
            server.config.fullTrustedRPC = true;
            wss.on('connection', (ws) => attachClient(ws));
            server.on('getCounter', () => new Counter());

            const first = PerfectWSAdvanced.client({ clientId: 'client-a' });
            const second = PerfectWSAdvanced.client({ clientId: 'client-b' });
            first.router.config.fullTrustedRPC = true;
            second.router.config.fullTrustedRPC = true;
            first.setServer(await connect());
            second.setServer(await connect());
            await Promise.all([first.router.serverOpen, second.router.serverOpen]);

            const counter = await first.router.request('getCounter', null, {
                requestId: 'shared-request-id',
            });

            const secondCounter = await second.router.request('getCounter', null, {
                requestId: 'shared-request-id',
            });
            expect(await (counter as any).increment()).toBe(1);
            expect(await (secondCounter as any).increment()).toBe(1);
            (counter as any)[Symbol.dispose]();
            (secondCounter as any)[Symbol.dispose]();
        });
    });

    describe('autoWrapUnknownClasses (phase 6, A4/A9)', () => {
        class UnknownWidget {
            label = 'widget';
            shout(this: UnknownWidget) { return this.label.toUpperCase(); }
        }

        const setUpAutoWrapPair = async () => {
            const { router: server, attachClient } = PerfectWSAdvanced.server();
            server.config.fullTrustedRPC = true;
            server.config.autoWrapUnknownClasses = true;
            wss.on('connection', (ws) => attachClient(ws));

            const { router: client, setServer } = PerfectWSAdvanced.client();
            client.config.fullTrustedRPC = true;
            setServer(await connect());
            await client.serverOpen;

            return { server, client };
        };

        it('an unknown class instance becomes a live handle end to end when the flag is on', async () => {
            const { server, client } = await setUpAutoWrapPair();
            const widget = new UnknownWidget();
            server.on('getWidget', async () => widget);

            const remote: any = await client.request('getWidget');

            expect(await remote.label).toBe('widget');
            expect(await remote.shout()).toBe('WIDGET');
        });

        it('a Date/RegExp reached anywhere on the wire is never auto-wrapped, even nested behind a real handle (audit finding)', async () => {
            class Holder extends PureRPC {
                createdAt = new Date('2024-01-01T00:00:00Z');
                pattern = /abc/gi;
            }

            const { server, client } = await setUpAutoWrapPair();
            const holder = new Holder();
            server.on('getHolder', async () => holder);
            // Also returned directly (not nested behind a PureRPC instance) to cover the
            // top-level handler-return path, not just a `get` through an existing handle.
            server.on('getDate', async () => new Date('2024-01-01T00:00:00Z'));

            const remote: any = await client.request('getHolder');

            const createdAt = await remote.createdAt;
            expect(createdAt).toBeInstanceOf(Date);
            expect(createdAt.getTime()).toBe(new Date('2024-01-01T00:00:00Z').getTime());

            const pattern = await remote.pattern;
            expect(pattern).toBeInstanceOf(RegExp);
            expect(pattern.source).toBe('abc');

            const topLevelDate = await client.request('getDate', null);
            expect(topLevelDate).toBeInstanceOf(Date);
        });

        it('an unknown class instance is mangled as before when the flag is off (default, unchanged behavior)', async () => {
            const { server, client } = await setUpTrustedPair();
            const widget = new UnknownWidget();
            server.on('getWidget', async () => widget);

            const result: any = await client.request('getWidget', null);

            expect(result).not.toHaveProperty('___type', 'pureRPC');
            // Not a live handle - whatever BSON does with an unrecognized class, it is not
            // "a UnknownWidget with a working shout() method" on the other side.
            expect(typeof result?.shout).not.toBe('function');
        });
    });
});
