import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { BSON } from 'bson';
import { NetworkEventListener, PerfectWSAdvanced, PureRPC } from '../../src/index.js';
import { sleep } from '../../src/utils/sleepPromise.js';

describe('automatic live-response lifetime', () => {
    let wss: WebSocketServer;
    const sockets: WebSocket[] = [];
    const cleanups: (() => void)[] = [];

    beforeEach(async () => {
        wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await new Promise<void>(resolve => wss.once('listening', () => resolve()));
    });

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const socket of sockets.splice(0)) {
            try { socket.terminate(); } catch { }
        }
        await new Promise<void>(resolve => wss.close(() => resolve()));
    });

    const connect = async () => {
        const address = wss.address();
        if (typeof address === 'string' || address === null) throw new Error('Missing WebSocket address');

        const url = `ws://127.0.0.1:${address.port}`;
        const socket = new WebSocket(url);
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', error => reject(new Error(`Failed to connect ${ url } (server=${ JSON.stringify(wss.address()) }): ${ error.message }`)));
        });
        return socket;
    };

    const createPair = async () => {
        const serverResult = PerfectWSAdvanced.server();
        wss.on('connection', socket => serverResult.attachClient(socket));

        const clientResult = PerfectWSAdvanced.client();
        clientResult.setServer(await connect());
        await clientResult.router.serverOpen;

        cleanups.push(clientResult.unregister, serverResult.unregister);
        return { client: clientResult.router, server: serverResult.router, clientResult };
    };

    it('keeps a callback passed to the server callable after the response completes', async () => {
        const { client, server } = await createPair();
        let invokeLater: (() => Promise<string>) | undefined;

        server.on('registerLogger', ({ onLog }: { onLog: (message: string) => Promise<string>; }) => {
            invokeLater = () => onLog('delayed message');
            return 'registered';
        });

        const seen: string[] = [];
        expect(await client.request('registerLogger', {
            onLog: (message: string) => {
                seen.push(message);
                return 'ack';
            }
        })).toBe('registered');

        await expect(invokeLater!()).resolves.toBe('ack');
        expect(seen).toEqual(['delayed message']);
        expect((client as any)._activeRequests.size).toBeGreaterThanOrEqual(1);
        expect((server as any)._activeResponses.size).toBeGreaterThanOrEqual(1);
    });

    it('keeps a returned callback callable without using or Symbol.dispose', async () => {
        const { client, server } = await createPair();
        server.on('getGreeter', () => (name: string) => `hello ${name}`);

        const greeter: any = await client.request('getGreeter');

        expect(typeof greeter).toBe('function');
        expect(greeter[Symbol.dispose]).toBeUndefined();
        await expect(greeter('world')).resolves.toBe('hello world');
    });

    it('allows immediate sequential callback calls at maxRPCOperations one', async () => {
        const { client, server } = await createPair();
        server.config.maxRPCOperations = 1;
        let calls = 0;
        server.on('oneCallback', () => () => ++calls);

        const callback: any = await client.request('oneCallback');
        expect(await callback()).toBe(1);
        expect(await callback()).toBe(2);
        expect(await callback()).toBe(3);
    });

    it('allows immediate sequential PureRPC calls at maxRPCOperations one', async () => {
        const { client, server } = await createPair();
        client.config.fullTrustedRPC = true;
        server.config.fullTrustedRPC = true;
        server.config.maxRPCOperations = 1;
        let calls = 0;
        server.on('onePureRPC', () => new PureRPC({ next: () => ++calls }));

        const remote: any = await client.request('onePureRPC');
        expect(await remote.next()).toBe(1);
        expect(await remote.next()).toBe(2);
        expect(await remote.next()).toBe(3);
        remote[Symbol.dispose]();
    });

    it('passes a callback back to its owner without changing identity', async () => {
        const { client, server } = await createPair();
        const identity = (value: unknown) => value;
        server.on('getCallbackIdentity', () => identity);

        const remote: any = await client.request('getCallbackIdentity');
        const echoed = await remote(remote);

        expect(echoed).toBe(remote);

        const clientRequest = [...(client as any)._activeRequests.values()][0];
        const serverResponse = [...(server as any)._activeResponses.values()][0];
        const clientTransforms = (client as any)._callbacks.get(clientRequest.events);
        const serverTransforms = (server as any)._callbacks.get(serverResponse.events);
        expect(clientTransforms._callbacks._functions?.size ?? 0).toBe(0);
        expect(clientTransforms._callbacks._receivedFunctions?.size ?? 0).toBe(1);
        expect(serverTransforms._callbacks._functions?.size ?? 0).toBe(1);
        expect(serverTransforms._callbacks._receivedFunctions?.size ?? 0).toBe(0);
    });

    it('preserves callbacks nested in Maps in both directions', async () => {
        const { client, server } = await createPair();
        server.on('getOperations', () => new Map([
            ['double', (value: number) => value * 2],
            ['triple', (value: number) => value * 3],
        ]));
        server.on('useOperations', async (operations: Map<string, (value: number) => Promise<number>>) => ({
            doubled: await operations.get('double')!(4),
            tripled: await operations.get('triple')!(4),
        }));

        const returned = await client.request<Map<string, (value: number) => Promise<number>>>('getOperations');
        expect(returned).toBeInstanceOf(Map);
        await expect(returned.get('double')!(5)).resolves.toBe(10);

        await expect(client.request('useOperations', new Map([
            ['double', (value: number) => value * 2],
            ['triple', (value: number) => value * 3],
        ]))).resolves.toEqual({ doubled: 8, tripled: 12 });
    });

    it('keeps a transferred AbortSignal active after a primitive response', async () => {
        const { client, server } = await createPair();
        let receivedSignal: AbortSignal | undefined;

        server.on('watchSignal', ({ signal }: { signal: AbortSignal; }) => {
            receivedSignal = signal;
            return 'watching';
        });

        const controller = new AbortController();
        expect(await client.request('watchSignal', { signal: controller.signal })).toBe('watching');
        expect(receivedSignal?.aborted).toBe(false);

        controller.abort('cancelled later');
        await sleep(20);

        expect(receivedSignal?.aborted).toBe(true);
        expect(receivedSignal?.reason).toBe('cancelled later');
        expect((client as any)._activeRequests.size).toBe(0);
        expect((server as any)._activeResponses.size).toBe(0);
    });

    it('keeps a returned AbortSignal active after the response', async () => {
        const { client, server } = await createPair();
        const controller = new AbortController();
        server.on('getSignal', () => controller.signal);

        const receivedSignal = await client.request<AbortSignal>('getSignal');
        controller.abort('owner cancelled');
        await sleep(20);

        expect(receivedSignal.aborted).toBe(true);
        expect(receivedSignal.reason).toBe('owner cancelled');
        expect((client as any)._activeRequests.size).toBe(0);
        expect((server as any)._activeResponses.size).toBe(0);
    });

    it('delivers an owner-side AbortSignal change after an offline wait exceeds requestTimeout', async () => {
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.ackTimeout = 30;
        server.config.ackTimeout = 30;
        client.config.ackRetryDelays = [];
        server.config.ackRetryDelays = [];
        server.config.requestTimeout = 20;
        const controller = new AbortController();
        server.on('getOfflineSignal', () => controller.signal);

        const receivedSignal = await client.request<AbortSignal>('getOfflineSignal');
        const originalSocket = sockets.at(-1)!;
        const closed = new Promise<void>(resolve => originalSocket.once('close', resolve));
        originalSocket.terminate();
        await closed;

        controller.abort('aborted while offline');
        await sleep(80);
        expect(receivedSignal.aborted).toBe(false);

        clientResult.setServer(await connect());
        await client.serverOpen;
        await vi.waitFor(() => expect(receivedSignal.aborted).toBe(true), { timeout: 3000 });

        expect(receivedSignal.reason).toBe('aborted while offline');
        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
    });

    it('does not expire completed callbacks or signals after requestTimeout', async () => {
        const { client, server } = await createPair();
        client.config.requestTimeout = 20;
        client.config.clearOldRequestsDelay = 5;
        server.config.requestTimeout = 20;
        const controller = new AbortController();
        server.on('getLiveResources', () => ({
            callback: (value: number) => value * 2,
            signal: controller.signal,
        }));

        const resources = await client.request<{
            callback: (value: number) => Promise<number>;
            signal: AbortSignal;
        }>('getLiveResources');

        await sleep(80);

        expect((client as any)._activeRequests.size).toBe(1);
        expect((server as any)._activeResponses.size).toBe(1);
        await expect(resources.callback(6)).resolves.toBe(12);

        controller.abort('finished later');
        await sleep(20);
        expect(resources.signal.aborted).toBe(true);
        expect(resources.signal.reason).toBe('finished later');
        await expect(resources.callback(7)).resolves.toBe(14);
    });

    it('deduplicates repeated references to the same AbortSignal', async () => {
        const { client, server } = await createPair();
        const controller = new AbortController();
        server.on('getRepeatedSignal', () => ({
            first: controller.signal,
            second: controller.signal,
        }));

        const received = await client.request<{ first: AbortSignal; second: AbortSignal; }>('getRepeatedSignal');
        await sleep(20);

        expect(received.second).toBe(received.first);

        const clientRequest = [...(client as any)._activeRequests.values()][0];
        const serverResponse = [...(server as any)._activeResponses.values()][0];
        const clientTransforms = (client as any)._callbacks.get(clientRequest.events);
        const serverTransforms = (server as any)._callbacks.get(serverResponse.events);
        expect(clientTransforms._callbacks._functions.size).toBe(1);
        expect(clientTransforms._callbacks._receivedFunctions.size).toBe(1);
        expect(serverTransforms._callbacks._functions.size).toBe(1);
        expect(serverTransforms._callbacks._receivedFunctions.size).toBe(1);

        controller.abort('shared cancellation');
        await sleep(20);

        expect(received.first.aborted).toBe(true);
        expect(received.second.reason).toBe('shared cancellation');
        expect((client as any)._activeRequests.size).toBe(0);
        expect((server as any)._activeResponses.size).toBe(0);
    });

    it('resubscribes the same live AbortSignal after an old receiver is collected', async () => {
        const { client, server } = await createPair();
        const controller = new AbortController();
        server.on('getResubscribedSignal', () => ({
            signal: controller.signal,
            again: () => controller.signal,
        }));

        const received: any = await client.request('getResubscribedSignal');
        const clientRequest = [...(client as any)._activeRequests.values()][0];
        const transforms = (client as any)._callbacks.get(clientRequest.events);
        const state = transforms._abortSignal._inboundStates.get(received.signal);
        transforms._abortSignal._inboundSignals.set(state.subscribe, { deref: () => undefined });

        const replacement = await received.again();
        expect(replacement).not.toBe(received.signal);

        controller.abort('resubscribed');
        await vi.waitFor(() => expect(replacement.aborted).toBe(true));
        expect(replacement.reason).toBe('resubscribed');
    });

    it('passes a received AbortSignal back to its owner without creating another signal', async () => {
        const { client, server } = await createPair();
        const controller = new AbortController();
        let ownerReceivedOriginal = false;
        const echo = (signal: AbortSignal) => {
            ownerReceivedOriginal = signal === controller.signal;
            return signal;
        };
        server.on('getSignalEcho', () => ({ signal: controller.signal, echo }));

        const received: any = await client.request('getSignalEcho');
        const echoed = await received.echo(received.signal);

        expect(ownerReceivedOriginal).toBe(true);
        expect(echoed).toBe(received.signal);
    });

    it('delivers a transferred AbortSignal abort after an offline wait longer than reconnectTimeout', async () => {
        const { client, server, clientResult } = await createPair();
        client.config.reconnectTimeout = 20;
        let receivedSignal: AbortSignal | undefined;

        server.on('watchReconnectSignal', ({ signal }: { signal: AbortSignal; }) => {
            receivedSignal = signal;
            return 'watching';
        });

        const controller = new AbortController();
        await client.request('watchReconnectSignal', { signal: controller.signal });

        const originalSocket = sockets.at(-1)!;
        const closed = new Promise<void>(resolve => originalSocket.once('close', () => resolve()));
        originalSocket.terminate();
        await closed;

        controller.abort('cancelled while offline');
        await sleep(80);
        expect(receivedSignal?.aborted).toBe(false);

        clientResult.setServer(await connect());
        await client.serverOpen;

        await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));

        expect(receivedSignal?.aborted).toBe(true);
        expect(receivedSignal?.reason).toBe('cancelled while offline');
        expect((client as any)._activeRequests.size).toBe(0);
        expect((server as any)._activeResponses.size).toBe(0);
    });

    it('transfers an already-aborted signal without retaining a live channel', async () => {
        const { client, server } = await createPair();
        let receivedSignal: AbortSignal | undefined;

        server.on('readSignal', ({ signal }: { signal: AbortSignal; }) => {
            receivedSignal = signal;
            return 'read';
        });

        const controller = new AbortController();
        controller.abort('already cancelled');

        await expect(client.request('readSignal', { signal: controller.signal })).resolves.toBe('read');
        await sleep(20);

        expect(receivedSignal?.aborted).toBe(true);
        expect(receivedSignal?.reason).toBe('already cancelled');
        expect((client as any)._activeRequests.size).toBe(0);
        expect((server as any)._activeResponses.size).toBe(0);
    });

    it('releases ordinary responses immediately when serialization created no live resources', async () => {
        const { client, server } = await createPair();
        server.on('plain', () => ({ status: 'ok', values: [1, 2, 3] }));

        await expect(client.request('plain')).resolves.toEqual({ status: 'ok', values: [1, 2, 3] });
        await sleep(20);

        expect((client as any)._activeRequests.size).toBe(0);
        expect((server as any)._activeResponses.size).toBe(0);
    });

    it('detaches internal event relays after an ordinary response', async () => {
        const { client, server } = await createPair();
        const clientEvents = new NetworkEventListener();
        let serverEvents: any;
        server.on('eventCleanup', (_data, { events }) => {
            serverEvents = events;
            return 'done';
        });

        await expect(client.request('eventCleanup', null, { events: clientEvents })).resolves.toBe('done');
        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });

        expect((clientEvents as any)._anyListeners).toHaveLength(0);
        expect((serverEvents as any)._anyListeners).toHaveLength(0);
        expect(serverEvents.eventNames()).toEqual([]);
    });

    it('enforces the owner-side timeout and detaches its socket after disconnection', async () => {
        const { client, server, clientResult } = await createPair();
        let ownerSignal: AbortSignal | undefined;
        let ownerSocket: any;
        const started = Promise.withResolvers<void>();
        server.on('timeoutOffline', async (_data, { abortSignal, ws }) => {
            ownerSignal = abortSignal;
            ownerSocket = ws;
            started.resolve();
            await new Promise<void>(resolve => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
        });

        const pending = client.request('timeoutOffline', null, { timeout: 50 });
        await started.promise;
        const socket = sockets.at(-1)!;
        const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
        socket.terminate();
        await closed;

        await expect(pending).rejects.toMatchObject({ code: 'timeout' });
        await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true));
        expect((client as any)._activeRequests.size).toBe(1);
        expect([...(server as any)._activeResponses.values()].filter((response: any) => !response.internal)).toHaveLength(1);

        clientResult.setServer(await connect());
        await client.serverOpen;
        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
            expect(ownerSocket._virtualCloseListeners).toHaveLength(0);
        });
    });

    it('releases both sides when a handler fails after receiving a callback', async () => {
        const { client, server } = await createPair();
        server.on('fail', (_data: { callback: () => void; }) => {
            throw new Error('failed');
        });

        await expect(client.request('fail', { callback: () => undefined })).rejects.toThrow('failed');
        await sleep(20);

        expect((client as any)._activeRequests.size).toBe(0);
        expect((server as any)._activeResponses.size).toBe(0);
    });

    it('delivers a final response that becomes ready while disconnected', async () => {
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.runPingLoop = false;
        client.config.ackTimeout = 50;
        server.config.ackTimeout = 50;
        client.config.ackRetryDelays = [];
        server.config.ackRetryDelays = [];
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<string>();
        server.on('finishOffline', async () => {
            started.resolve();
            return await finish.promise;
        });

        const pending = client.request('finishOffline');
        await started.promise;
        const first = sockets.at(-1)!;
        const closed = new Promise<void>(resolve => first.once('close', resolve));
        first.terminate();
        await closed;
        finish.resolve('delivered');

        const requestId = [...(client as any)._activeRequests.keys()]
            .find((id: string) => id.startsWith('finishOffline'));
        expect(requestId).toBeTypeOf('string');
        await vi.waitFor(() => expect((server as any)._activeResponses.has(requestId)).toBe(true));
        clientResult.setServer(await connect());
        await client.serverOpen;

        await expect(pending).resolves.toBe('delivered');
        await vi.waitFor(() => expect((server as any)._activeResponses.has(requestId)).toBe(false));
    });

    it('replays an initial request when its first packet never reached the owner', async () => {
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.runPingLoop = false;
        client.config.ackTimeout = 30;
        client.config.ackRetryDelays = [];
        let calls = 0;
        server.on('replayInitial', () => ++calls);

        const first = sockets.at(-1)!;
        vi.spyOn(first, 'send').mockImplementation(() => undefined);
        const closed = new Promise<void>(resolve => first.once('close', resolve));
        const pending = client.request('replayInitial');
        await closed;

        clientResult.setServer(await connect());
        await client.serverOpen;

        await expect(pending).resolves.toBe(1);
        expect(calls).toBe(1);
    });

    it('delivers a serialization error produced while the caller is offline', async () => {
        class Unserializable { }
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.runPingLoop = false;
        client.config.ackTimeout = 30;
        server.config.ackTimeout = 30;
        client.config.ackRetryDelays = [];
        server.config.ackRetryDelays = [];
        server.transformers.push({
            uniqueId: 'offline-serialization-error',
            check: (value: unknown): value is Unserializable => value instanceof Unserializable,
            serialize: () => { throw new Error('offline serialization failed'); },
            deserialize: value => value,
        });
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        server.on('offlineBadResponse', async () => {
            started.resolve();
            await finish.promise;
            return new Unserializable();
        });

        const pending = client.request('offlineBadResponse');
        await started.promise;
        const first = sockets.at(-1)!;
        const closed = new Promise<void>(resolve => first.once('close', resolve));
        first.terminate();
        await closed;
        finish.resolve();

        clientResult.setServer(await connect());
        await client.serverOpen;

        await expect(pending).rejects.toMatchObject({
            code: 'serializeFailed',
            message: 'offline serialization failed',
        });
    });

    it('delivers a user abort to the owner before releasing both request channels', async () => {
        const { client, server } = await createPair();
        const controller = new AbortController();
        let ownerSignal!: AbortSignal;
        const started = Promise.withResolvers<void>();
        server.on('waitForAbort', async (_data, { abortSignal }) => {
            ownerSignal = abortSignal;
            started.resolve();
            await new Promise<void>(resolve => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
        });

        const pending = client.request('waitForAbort', null, { abortSignal: controller.signal, timeout: 0 });
        await started.promise;
        controller.abort('cancel from caller');

        await expect(pending).rejects.toMatchObject({ code: 'abort' });
        await vi.waitFor(() => expect(ownerSignal.aborted).toBe(true));
        expect(ownerSignal.reason).toBe('cancel from caller');
        await vi.waitFor(() => {
            expect((client as any)._activeRequests.size).toBe(0);
            expect((server as any)._activeResponses.size).toBe(0);
        });
    });

    it('ignores a retried final response without releasing its live callback', async () => {
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.runPingLoop = false;
        server.config.runPingLoop = false;
        client.config.ackTimeout = 25;
        client.config.ackRetryDelays = [];
        server.config.ackTimeout = 25;
        server.config.ackRetryDelays = [];
        server.config.sendRequestRetries = 1;
        server.on('callbackWithLostAck', () => (value: number) => value + 1);

        const first = sockets.at(-1)!;
        const originalSend = first.send.bind(first) as any;
        let dropped = false;
        vi.spyOn(first, 'send').mockImplementation(((data: any, ...args: any[]) => {
            const packet = BSON.deserialize(new Uint8Array(data));
            if (!dropped && packet.method === '___ack' && String(packet.requestId).startsWith('callbackWithLostAck')) {
                dropped = true;
                return;
            }
            return originalSend(data, ...args);
        }) as any);

        const closed = new Promise<void>(resolve => first.once('close', resolve));
        const callback: any = await client.request('callbackWithLostAck');
        await closed;
        clientResult.setServer(await connect());
        await client.serverOpen;

        await expect(callback(4)).resolves.toBe(5);
        expect(dropped).toBe(true);
    });

    it('keeps a healthy connection open when a callback settles before its request ACK', async () => {
        let ownerSocket!: WebSocket;
        wss.once('connection', socket => { ownerSocket = socket; });
        const { client, server } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.runPingLoop = false;
        server.config.runPingLoop = false;
        client.config.ackTimeout = 25;
        server.config.ackTimeout = 25;
        client.config.ackRetryDelays = [];
        server.config.ackRetryDelays = [];
        client.config.sendRequestRetries = 1;
        server.config.sendRequestRetries = 1;
        let calls = 0;
        server.on('callbackWithLateAck', () => () => ++calls);

        const callback: any = await client.request('callbackWithLateAck');
        const originalSend = ownerSocket.send.bind(ownerSocket) as any;
        let dropped = false;
        vi.spyOn(ownerSocket, 'send').mockImplementation(((data: any, ...args: any[]) => {
            const packet = BSON.deserialize(new Uint8Array(data));
            if (!dropped && packet.method === '___ack'
                && String(packet.requestId).startsWith('callbackWithLateAck')) {
                dropped = true;
                return;
            }
            return originalSend(data, ...args);
        }) as any);

        await expect(callback()).resolves.toBe(1);
        await sleep(75);

        expect(dropped).toBe(true);
        expect(calls).toBe(1);
        expect(ownerSocket.readyState).toBe(WebSocket.OPEN);
        expect(sockets.at(-1)?.readyState).toBe(WebSocket.OPEN);
    });

    it('does not run a handler twice when its initial ACK and final response are lost', async () => {
        let ownerSocket!: WebSocket;
        wss.once('connection', socket => { ownerSocket = socket; });
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.runPingLoop = false;
        server.config.runPingLoop = false;
        client.config.ackTimeout = 25;
        server.config.ackTimeout = 25;
        client.config.ackRetryDelays = [];
        server.config.ackRetryDelays = [];
        client.config.sendRequestRetries = 1;
        server.config.sendRequestRetries = 1;
        let calls = 0;
        server.on('onceOnly', () => ++calls);

        const originalSend = ownerSocket.send.bind(ownerSocket) as any;
        vi.spyOn(ownerSocket, 'send').mockImplementation(((data: any, ...args: any[]) => {
            const packet = BSON.deserialize(new Uint8Array(data));
            if (String(packet.requestId).startsWith('onceOnly') && (packet.method === '___ack' || packet.down === true)) return;
            return originalSend(data, ...args);
        }) as any);
        const closed = new Promise<void>(resolve => ownerSocket.once('close', resolve));
        const pending = client.request('onceOnly');
        await closed;

        clientResult.setServer(await connect());
        await client.serverOpen;
        await expect(pending).resolves.toBe(1);
        expect(calls).toBe(1);
    });

    it('deduplicates a PureRPC operation replayed after its ACK and response are lost', async () => {
        let ownerSocket!: WebSocket;
        wss.once('connection', socket => { ownerSocket = socket; });
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.fullTrustedRPC = true;
        server.config.fullTrustedRPC = true;
        client.config.runPingLoop = false;
        server.config.runPingLoop = false;
        client.config.ackTimeout = 25;
        server.config.ackTimeout = 25;
        client.config.ackRetryDelays = [];
        server.config.ackRetryDelays = [];
        client.config.sendRequestRetries = 1;
        server.config.sendRequestRetries = 1;
        server.config.processedPacketsRetention = 20;
        const owner = { count: 0, increment() { return ++this.count; } };
        server.on('counterForReplay', () => new PureRPC(owner));
        const counter: any = await client.request('counterForReplay');

        const originalSend = ownerSocket.send.bind(ownerSocket) as any;
        let dropOperationTraffic = true;
        vi.spyOn(ownerSocket, 'send').mockImplementation(((data: any, ...args: any[]) => {
            const packet = BSON.deserialize(new Uint8Array(data));
            if (dropOperationTraffic && String(packet.requestId).startsWith('counterForReplay')
                && (packet.method === '___ack' || packet.event?.eventName === '___pureRPC.response')) return;
            return originalSend(data, ...args);
        }) as any);
        const closed = new Promise<void>(resolve => ownerSocket.once('close', resolve));
        const pending = counter.increment();
        await closed;
        dropOperationTraffic = false;
        await sleep(60);

        clientResult.setServer(await connect());
        await client.serverOpen;
        await expect(pending).resolves.toBe(1);
        expect(owner.count).toBe(1);
    });

    it('delivers callback and PureRPC results that become ready after reconnectTimeout while offline', async () => {
        const { client, server, clientResult } = await createPair();
        client.config.enableAckSystem = true;
        server.config.enableAckSystem = true;
        client.config.fullTrustedRPC = true;
        server.config.fullTrustedRPC = true;
        client.config.runPingLoop = false;
        server.config.runPingLoop = false;
        client.config.reconnectTimeout = 20;
        server.config.reconnectTimeout = 20;
        client.config.ackTimeout = 25;
        server.config.ackTimeout = 25;
        client.config.ackRetryDelays = [];
        server.config.ackRetryDelays = [];

        let remoteCallback!: () => Promise<string>;
        server.on('registerSlowCallback', ({ callback }: { callback: () => Promise<string>; }) => {
            remoteCallback = callback;
            return 'registered';
        });
        const callbackStarted = Promise.withResolvers<void>();
        const callbackFinish = Promise.withResolvers<string>();
        await client.request('registerSlowCallback', {
            callback: async () => {
                callbackStarted.resolve();
                return await callbackFinish.promise;
            },
        });

        const callbackResult = remoteCallback();
        await callbackStarted.promise;
        let first = sockets.at(-1)!;
        let closed = new Promise<void>(resolve => first.once('close', resolve));
        first.terminate();
        await closed;
        callbackFinish.resolve('callback-result');
        await sleep(60);
        clientResult.setServer(await connect());
        await client.serverOpen;
        await expect(callbackResult).resolves.toBe('callback-result');

        const methodStarted = Promise.withResolvers<void>();
        const methodFinish = Promise.withResolvers<string>();
        server.on('slowHandle', () => new PureRPC({
            async run() {
                methodStarted.resolve();
                return await methodFinish.promise;
            },
        }));
        const handle: any = await client.request('slowHandle');
        const methodResult = handle.run();
        await methodStarted.promise;
        first = sockets.at(-1)!;
        closed = new Promise<void>(resolve => first.once('close', resolve));
        first.terminate();
        await closed;
        methodFinish.resolve('method-result');
        await sleep(60);
        clientResult.setServer(await connect());
        await client.serverOpen;
        await expect(methodResult).resolves.toBe('method-result');
    });
});
