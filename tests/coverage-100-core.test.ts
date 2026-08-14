import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';
import { PerfectWSAdvanced } from '../src/PerfectWSAdvanced/PerfectWSAdvanced.js';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.js';
import { WebSocketForce, type WSLike } from '../src/utils/WebSocketForce.js';
import { createDuplexPair } from './utils/createDuplexPair.js';

type TestSocket = ReturnType<typeof testSocket>;

function testSocket(readyState = WebSocketForce.OPEN, send: (data: any) => void = vi.fn()) {
    const listeners = new Map<string, Set<Function>>();
    const socket: WSLike = {
        url: 'ws://coverage', protocol: '', extensions: '', binaryType: 'arraybuffer', bufferedAmount: 0,
        readyState, onopen: null, onclose: null, onerror: null, onmessage: null,
        send,
        close: vi.fn(),
        addEventListener(type, listener) {
            const entries = listeners.get(type) ?? new Set();
            entries.add(listener);
            listeners.set(type, entries);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
    };

    return {
        socket,
        emit(type: string, event: any = new Event(type)) {
            for (const listener of [...listeners.get(type) ?? []]) listener(event);
        },
        listeners,
    };
}

const cleanups: Array<() => void> = [];
const createPerfectWS = (PerfectWS as any)._newInstance;
const createPerfectWSAdvanced = (PerfectWSAdvanced as any)._newInstance;

beforeEach(() => {
    // The shared test setup disables ACKs by replacing these factories. Restore the
    // production factories in this coverage suite so their behavior is tested too.
    (PerfectWS as any)._newInstance = createPerfectWS;
    (PerfectWSAdvanced as any)._newInstance = createPerfectWSAdvanced;
});

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch { }
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function clientRouter(socket?: TestSocket) {
    const result = socket
        ? PerfectWS.client(socket.socket, { debugging: true })
        : PerfectWS.client({ debugging: true });
    cleanups.push(result.unregister);
    return result;
}

describe('PerfectWS factories, synchronization, and setup', () => {
    it('constructs both base and advanced routers through their factories', () => {
        expect((PerfectWS as any)._newInstance()).toBeInstanceOf(PerfectWS);
        expect((PerfectWSAdvanced as any)._newInstance()).toBeInstanceOf(PerfectWSAdvanced);

        const base = PerfectWS.client({ debugging: true });
        const advanced = PerfectWSAdvanced.client({ debugging: true });
        cleanups.push(base.unregister, advanced.unregister);
        expect(base.router).toBeInstanceOf(PerfectWS);
        expect(advanced.router).toBeInstanceOf(PerfectWSAdvanced);
    });

    it('notifies the peer when detaching a temporary client without closing its socket', async () => {
        const raw = testSocket();
        const client = PerfectWS.client(raw.socket, { debugging: true, temp: true, clientId: 'temporary' });
        await client.router.serverOpen;
        const send = raw.socket.send as ReturnType<typeof vi.fn>;
        send.mockClear();

        client.detachServer();

        expect(send).toHaveBeenCalledOnce();
        const message = (client.router as any).deserialize(send.mock.calls[0][0]);
        expect(message).toMatchObject({ clientId: 'temporary', event: { eventName: '___session.release' } });
        expect(raw.socket.close).not.toHaveBeenCalled();
    });

    it('rejects server-side synchronization and checks local server requests', async () => {
        const server = (PerfectWS as any)._newInstance();
        await expect(server._syncRequests()).rejects.toMatchObject({ code: 'invalidInstance' });

        server._activeResponses.set('response', { requestId: 'response' });
        server._activeResponses.set('legacy-response', {});
        await expect(server.hasRequest('response')).resolves.toBe(true);
        await expect(server.hasRequest('legacy-response')).resolves.toBe(true);
        await expect(server.hasRequest('missing')).resolves.toBe(false);
    });

    it('logs and releases only known unknown requests during synchronization', async () => {
        const { router } = clientRouter();
        router.config.verbose = true;
        const release = vi.fn();
        (router as any)._activeRequests.set('sent', { hasSent: true, release });
        (router as any)._activeRequests.set('unsent', { hasSent: false, release: vi.fn() });
        vi.spyOn(router, 'request').mockResolvedValue(['gone', 'sent'] as never);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await (router as any)._syncRequests();

        expect(release).toHaveBeenCalledWith({ message: 'Unknown request', code: 'unknownRequest' });
        expect(log).toHaveBeenCalledWith('[PerfectWS] _syncRequests: calling callback for requestId=', 'sent');
    });

    it('releases an ended response that the reconnecting client no longer owns', () => {
        const { router } = PerfectWS.server();
        const release = vi.fn();
        const client = new WebSocketForce(testSocket().socket);
        (router as any)._activeResponses.set('ended', {
            clientId: 'client', responseEnded: true, release,
            events: new NetworkEventListener(), clientRef: { ref: client }, updateTime: 0,
        });
        const syncHandler = (router as any)._listenForRequests.get('___syncRequests').callbacks[0];

        expect(syncHandler({ activeRequestsIds: [] }, { requestId: 'sync', ws: client, clientId: 'client' })).toEqual([]);
        expect(release).toHaveBeenCalledOnce();
    });

    it('isolates an old socket close failure and force-closes after a verbose ping failure', async () => {
        const next = testSocket();
        const { router, unregister } = PerfectWS.client({ debugging: true });
        cleanups.push(unregister);
        router.config.syncRequestsWhenServerOpen = false;
        router.config.runPingLoop = true;
        router.config.verbose = true;
        (router as any)._server = { forceClose: () => { throw new Error('old close failed'); } };
        vi.spyOn(router as any, '_ping').mockRejectedValue(new Error('ping failed'));
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        (router as any)._setServer(next.socket);
        await Promise.resolve();
        await Promise.resolve();

        expect((router as any)._server.readyState).toBe(WebSocketForce.CLOSED);
        expect(log).toHaveBeenCalledWith('[PerfectWS] Ping failed, force closing socket');
    });

    it('reports an already-open server as ready only after request synchronization', async () => {
        const raw = testSocket();
        const { router, setServer } = clientRouter();
        router.config.runPingLoop = false;
        const synchronized = Promise.withResolvers<void>();
        vi.spyOn(router as any, '_syncRequests').mockReturnValue(synchronized.promise);

        setServer(raw.socket);
        let ready = false;
        const serverOpen = router.serverOpen.then(value => {
            ready = true;
            return value;
        });
        await Promise.resolve();

        expect(ready).toBe(false);
        synchronized.resolve();
        await expect(serverOpen).resolves.toBe(true);

        (raw.socket as any).readyState = WebSocketForce.CLOSED;
        raw.emit('close');
        expect((router as any)._serverReady).toBe(false);
    });
});

describe('PerfectWS request failure and reconnect paths', () => {
    it('reports a request timeout without waiting for durable ACK cleanup to reconnect', async () => {
        const raw = testSocket();
        const result = PerfectWS.client(raw.socket, { debugging: true, temp: true });
        cleanups.push(result.unregister);
        result.router.config.ackTimeout = 5;
        result.router.config.ackRetryDelays = [];
        result.router.config.reconnectTimeout = 5_000;
        await result.router.serverOpen;

        const started = Date.now();
        await expect(result.router.request('never-acked', null, { timeout: 30 }))
            .rejects.toMatchObject({ code: 'timeout' });
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('settles a request when client-side serialization throws', async () => {
        const raw = testSocket();
        const { router } = clientRouter(raw);
        vi.spyOn(router as any, 'prepareRequestData').mockImplementation(() => {
            throw new Error('serialization failed');
        });

        await expect(router.request('serialization-failure')).rejects.toMatchObject({ code: 'sendFailed' });
    });

    it('preserves a transform PerfectWSError when an oversized request cannot be serialized', async () => {
        const raw = testSocket();
        const result = PerfectWSAdvanced.client(raw.socket, { debugging: true });
        cleanups.push(result.unregister);
        result.router.config.maxMessageSize = 2;

        await expect(result.router.request('oversized', new Uint8Array([1, 2, 3])))
            .rejects.toMatchObject({ code: 'messageTooLarge' });
    });

    it('rejects at the active-request cap', async () => {
        const { router } = clientRouter();
        router.config.maxActiveRequests = 0;
        await expect(router.request('limited')).rejects.toMatchObject({ code: 'tooManyRequests' });
    });

    it('rejects a request while it is waiting for its first server', async () => {
        const { router } = clientRouter();
        const controller = new AbortController();
        const pending = router.request('waiting', null, { abortSignal: controller.signal });
        controller.abort('cancelled');
        await expect(pending).rejects.toMatchObject({ code: 'abort' });
    });

    it('uses an already-ready replacement when a request-specific socket is stale', async () => {
        const current = testSocket();
        const stale = new WebSocketForce(testSocket(WebSocketForce.CLOSED).socket);
        const { router, setServer } = clientRouter();
        router.config.syncRequestsWhenServerOpen = false;
        setServer(current.socket);
        await router.serverOpen;
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);

        const pending = router.request('replacement-ready', null, {
            requestId: 'replacement-ready',
            useServer: stale,
        });
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        const active = (router as any)._activeRequests.get('replacement-ready');
        active.callback('done', null, true);

        await expect(pending).resolves.toBe('done');
        expect(send.mock.calls[0][1]).toBe((router as any)._server);
    });

    it('uses requestTimeout by default and supports longer or disabled per-request timeouts', async () => {
        vi.useFakeTimers();
        const raw = testSocket(WebSocketForce.CLOSED);
        const { router } = clientRouter(raw);
        router.config.requestTimeout = 20;
        router.config.clearOldRequestsDelay = 1000;

        const defaultRequest = router.request('default-timeout');
        const defaultTimeout = expect(defaultRequest).rejects.toMatchObject({ code: 'timeout' });
        await vi.advanceTimersByTimeAsync(20);
        await defaultTimeout;

        const longerRequest = router.request('longer-timeout', null, { timeout: 40 });
        let longerSettled = false;
        void longerRequest.then(() => { longerSettled = true; }, () => { longerSettled = true; });
        await vi.advanceTimersByTimeAsync(20);
        expect(longerSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(20);
        await expect(longerRequest).rejects.toMatchObject({ code: 'timeout' });

        const controller = new AbortController();
        const unlimitedRequest = router.request('unlimited-timeout', null, {
            timeout: 0,
            abortSignal: controller.signal,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect([...((router as any)._activeRequests as Map<string, any>).values()]
            .some(request => request.timeout === 0)).toBe(true);
        controller.abort('test complete');
        await expect(unlimitedRequest).rejects.toMatchObject({ code: 'abort' });
    });

    it('rejects invalid runtime timeout values before allocating request state', async () => {
        const { router } = clientRouter();
        const invalidValues = [NaN, -1, -Infinity, null, '100'];

        for (const [index, timeout] of invalidValues.entries()) {
            await expect(router.request(`invalid-timeout-${ index }`, null, { timeout: timeout as any }))
                .rejects.toMatchObject({ code: 'invalidTimeout' });
        }

        router.config.requestTimeout = NaN;
        await expect(router.request('invalid-config-timeout'))
            .rejects.toMatchObject({ code: 'invalidTimeout' });
        expect((router as any)._activeRequests.size).toBe(0);
        expect((router as any)._clearOldRequestActive).toBe(false);
    });

    it('cleans a finite request without repeatedly scanning an unlimited request', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const raw = testSocket(WebSocketForce.CLOSED);
        const { router } = clientRouter(raw);
        router.config.clearOldRequestsDelay = 5;

        const unlimited = router.request('unlimited-mixed', null, {
            timeout: Infinity,
            abortSignal: controller.signal,
        });
        const finite = router.request('finite-mixed', null, { timeout: 20 });
        const finiteRejection = expect(finite).rejects.toMatchObject({ code: 'timeout' });
        expect((router as any)._clearOldRequestActive).toBe(true);

        await vi.advanceTimersByTimeAsync(25);
        await finiteRejection;
        expect((router as any)._clearOldRequestActive).toBe(false);
        expect([...((router as any)._activeRequests as Map<string, any>).values()])
            .toEqual([expect.objectContaining({ timeout: Infinity })]);

        controller.abort('test complete');
        await expect(unlimited).rejects.toMatchObject({ code: 'abort' });
    });

    it('transmits Infinity to the owner as a disabled request deadline', async () => {
        const server = PerfectWS.server();
        const client = PerfectWS.client();
        cleanups.push(client.unregister, server.unregister);
        server.router.config.enableAckSystem = false;
        server.router.config.runPingLoop = false;
        server.router.config.requestTimeout = 5;
        client.router.config.enableAckSystem = false;
        client.router.config.runPingLoop = false;
        client.router.config.syncRequestsWhenServerOpen = false;

        const gate = Promise.withResolvers<string>();
        const entered = Promise.withResolvers<void>();
        server.router.on('infinite-timeout', async () => {
            entered.resolve();
            return await gate.promise;
        });

        const { clientWs, serverWs } = createDuplexPair();
        server.attachClient(serverWs as any);
        client.setServer(clientWs as any);
        await client.router.serverOpen;

        let settled = false;
        const pending = client.router.request<string>('infinite-timeout', null, { timeout: Infinity });
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await entered.promise;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(settled).toBe(false);
        expect((client.router as any)._clearOldRequestActive).toBe(false);

        gate.resolve('done');
        await expect(pending).resolves.toBe('done');
    });

    it('keeps a default Infinity deadline through reconnect without restarting the handler', async () => {
        const server = PerfectWS.server();
        const client = PerfectWS.client();
        cleanups.push(client.unregister, server.unregister);
        server.router.config.enableAckSystem = false;
        server.router.config.runPingLoop = false;
        server.router.config.requestTimeout = 5;
        client.router.config.enableAckSystem = false;
        client.router.config.runPingLoop = false;
        client.router.config.requestTimeout = Infinity;

        const gate = Promise.withResolvers<string>();
        const entered = Promise.withResolvers<void>();
        let ownerSignal: AbortSignal | undefined;
        let handlerCalls = 0;
        server.router.on('infinite-reconnect', async (_data, { abortSignal }) => {
            handlerCalls++;
            ownerSignal = abortSignal;
            entered.resolve();
            return await gate.promise;
        });

        const first = createDuplexPair();
        server.attachClient(first.serverWs as any);
        client.setServer(first.clientWs as any);
        await client.router.serverOpen;

        let settled = false;
        const pending = client.router.request<string>('infinite-reconnect');
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await entered.promise;
        first.clientWs.close(1006, 'test reconnect');
        await Promise.resolve();

        const second = createDuplexPair();
        server.attachClient(second.serverWs as any);
        client.setServer(second.clientWs as any);
        await client.router.serverOpen;
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(settled).toBe(false);
        expect(ownerSignal?.aborted).toBe(false);
        expect(handlerCalls).toBe(1);
        gate.resolve('reconnected');
        await expect(pending).resolves.toBe('reconnected');
    });

    it('lets a finite per-request deadline override Infinity defaults on both peers', async () => {
        const server = PerfectWS.server();
        const client = PerfectWS.client();
        cleanups.push(client.unregister, server.unregister);
        server.router.config.enableAckSystem = false;
        server.router.config.runPingLoop = false;
        server.router.config.requestTimeout = Infinity;
        client.router.config.enableAckSystem = false;
        client.router.config.runPingLoop = false;
        client.router.config.syncRequestsWhenServerOpen = false;
        client.router.config.requestTimeout = Infinity;

        const ownerAborted = Promise.withResolvers<unknown>();
        server.router.on('finite-override', async (_data, { abortSignal }) => {
            await new Promise<void>(resolve => abortSignal.addEventListener('abort', () => {
                ownerAborted.resolve(abortSignal.reason);
                resolve();
            }, { once: true }));
            return 'too late';
        });

        const { clientWs, serverWs } = createDuplexPair();
        server.attachClient(serverWs as any);
        client.setServer(clientWs as any);
        await client.router.serverOpen;

        await expect(client.router.request('finite-override', null, { timeout: 20 }))
            .rejects.toMatchObject({ code: 'timeout' });
        await expect(ownerAborted.promise).resolves.toBe('Request timeout');
        await vi.waitFor(() => expect((server.router as any)._activeResponses.size).toBe(0));
    });

    it('executes the detached callback and reports a live-channel send failure', async () => {
        const raw = testSocket();
        const { router } = clientRouter(raw);
        const events = new NetworkEventListener();
        vi.spyOn(router as any, 'shouldKeepResponseAlive').mockReturnValue(true);
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValueOnce(true).mockResolvedValue(false);
        const failure = vi.fn();
        events.on('___request.sendFailed', failure);

        const pending = router.request('live', null, { events, requestId: 'live' });
        await Promise.resolve();
        const active = (router as any)._activeRequests.get('live');
        const originalCallback = active.callback;
        originalCallback({ value: 1 }, null, true);
        await expect(pending).resolves.toEqual({ value: 1 });
        originalCallback({ ignored: true }, null, true);
        active.callback({ ignored: true }, null, true);
        events.emit('custom-event');
        await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());

        expect(send).toHaveBeenCalledTimes(3);
        expect(failure).toHaveBeenCalledWith('local', {
            message: 'Failed to send request event',
            code: 'sendFailed',
            eventName: 'custom-event',
            operationId: undefined,
        });
        active.release();
        active.release();
    });

    it('settles the request when a serialized callback error cannot be delivered', async () => {
        const raw = testSocket();
        const { router } = clientRouter(raw);
        const events = new NetworkEventListener();
        const send = vi.spyOn(router as any, '_sendWithAck')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);

        const pending = router.request('callback-fallback', null, {
            events,
            requestId: 'callback-fallback',
        });
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        vi.spyOn(router as any, 'prepareRequestData').mockImplementation(() => {
            throw new Error('callback response serialization failed');
        });

        events.emit('___callback.response', { requestId: 'callback-call' });

        await expect(pending).rejects.toMatchObject({ code: 'sendFailed' });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1][0]).toMatchObject({
            event: {
                eventName: '___callback.response',
                args: [{ requestId: 'callback-call', error: 'callback response serialization failed' }],
            },
        });
    });

    it.each([true, false])('settles and releases a request even when its observer callback throws (verbose=%s)', async (verbose) => {
        const raw = testSocket();
        const { router } = clientRouter(raw);
        router.config.verbose = verbose;
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const pending = router.request('throwing-observer', null, {
            requestId: 'throwing-observer',
            callback: () => { throw new Error('observer failed'); },
        });
        await Promise.resolve();

        (router as any)._activeRequests.get('throwing-observer').callback('done', null, true);

        await expect(pending).resolves.toBe('done');
        expect((router as any)._activeRequests.has('throwing-observer')).toBe(false);
        if (verbose) {
            expect(log).toHaveBeenCalledWith('[PerfectWS] Request callback threw:', expect.any(Error));
        } else {
            expect(log).not.toHaveBeenCalled();
        }
    });

    it('reconnects and retries durable control state after send retries fail on an open socket', async () => {
        const first = testSocket();
        const replacement = new WebSocketForce(testSocket().socket);
        const { router, setServer } = clientRouter();
        router.config.syncRequestsWhenServerOpen = false;
        setServer(first.socket);
        router.config.sendRequestRetries = 1;
        const events = new NetworkEventListener();
        vi.spyOn(router as any, 'shouldKeepResponseAlive').mockReturnValue(true);
        const send = vi.spyOn(router as any, '_sendWithAck')
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const forceClose = vi.spyOn((router as any)._server, 'forceClose');

        const pending = router.request('durable-retry', null, {
            events,
            requestId: 'durable-retry',
        });
        await Promise.resolve();
        const active = (router as any)._activeRequests.get('durable-retry');
        active.callback('ready', null, true);
        await expect(pending).resolves.toBe('ready');

        let replaced = false;
        events.on('___request.disconnected', () => {
            if (replaced) return;
            replaced = true;
            queueMicrotask(() => {
                (router as any)._server = replacement;
                const resolveServerWait = [...(router as any)._waitForNewServer][0] as () => void;
                resolveServerWait();
            });
        });
        events.emit('___callback.release', { funcId: 'released-function' });

        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
        expect(forceClose).toHaveBeenCalledOnce();
        active.release();
    });

    it('ignores a captured event relay after its request is released', async () => {
        const raw = testSocket();
        const { router } = clientRouter(raw);
        const events = new NetworkEventListener();
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);

        const pending = router.request('released-relay', null, {
            events,
            requestId: 'released-relay',
        });
        await Promise.resolve();
        const relay = (events as any)._anyListeners[0];
        const active = (router as any)._activeRequests.get('released-relay');

        active.callback('done', null, true);
        await expect(pending).resolves.toBe('done');

        const callsBeforeLateEvent = send.mock.calls.length;
        relay('local', 'late-event', 1);
        await Promise.resolve();

        expect(send).toHaveBeenCalledTimes(callsBeforeLateEvent);
    });

    it('rejects the initial server wait when its request was removed before abort', async () => {
        const { router } = clientRouter();
        const controller = new AbortController();
        const pending = router.request('removed-wait', null, {
            requestId: 'removed-wait', abortSignal: controller.signal,
        });
        const active = (router as any)._activeRequests.get('removed-wait');
        (router as any)._activeRequests.delete('removed-wait');

        controller.abort('removed');
        await Promise.resolve();
        active.callback(null, { message: 'removed', code: 'abort' }, true);

        await expect(pending).rejects.toMatchObject({ code: 'abort' });
    });

    it('ignores a second initial-wait completion signal', async () => {
        const { router } = clientRouter();
        const events = new NetworkEventListener();
        const pending = router.request('double-finish', null, { requestId: 'double-finish', events });
        const active = (router as any)._activeRequests.get('double-finish');
        const onFinished = events.listeners('___request.finished')[0];

        active.callback(null, { message: 'done', code: 'abort' }, true);
        onFinished('local');

        await expect(pending).rejects.toMatchObject({ code: 'abort' });
    });

    it('fails after the reconnect wait times out', async () => {
        const raw = testSocket();
        const { router } = clientRouter(raw);
        router.config.reconnectTimeout = 0;
        vi.spyOn(router as any, '_sendWithAck').mockImplementation(async () => {
            (raw.socket as any).readyState = WebSocketForce.CLOSED;
            return false;
        });

        await expect(router.request('retry-timeout')).rejects.toMatchObject({ code: 'sendFailed' });
    });

    it('stops retrying when aborted just after a replacement server arrives', async () => {
        const first = testSocket();
        const { router } = clientRouter(first);
        const events = new NetworkEventListener();
        let abortedReads: ReturnType<typeof vi.spyOn> | undefined;
        vi.spyOn(router as any, '_sendWithAck').mockImplementation(async () => {
            (first.socket as any).readyState = WebSocketForce.CLOSED;
            return false;
        });
        events.on('___request.disconnected', () => queueMicrotask(() => {
            const active = (router as any)._activeRequests.get('retry-abort');
            abortedReads = vi.spyOn(active.abortController.signal, 'aborted', 'get');
            const resolveServerWait = [...(router as any)._waitForNewServer][0] as () => void;
            resolveServerWait();
            active.abortController.abort('stop retry');
        }));

        await expect(router.request('retry-abort', null, { events, requestId: 'retry-abort' })).rejects.toMatchObject({ code: 'abort' });
        expect(abortedReads?.mock.results.map(result => result.value)).toEqual([false, true]);
    });

    it('retries delivery on the replacement server when reconnect is still active', async () => {
        const first = testSocket();
        const second = new WebSocketForce(testSocket().socket);
        const { router } = clientRouter(first);
        const events = new NetworkEventListener();
        vi.spyOn(router as any, '_sendWithAck')
            .mockImplementationOnce(async () => {
                (first.socket as any).readyState = WebSocketForce.CLOSED;
                return false;
            })
            .mockResolvedValue(true);
        events.on('___request.disconnected', () => queueMicrotask(() => {
            (router as any)._server = second;
            const resolveServerWait = [...(router as any)._waitForNewServer][0] as () => void;
            resolveServerWait();
        }));
        events.on('___request.connected', () => queueMicrotask(() => {
            (router as any)._activeRequests.get('retry-connected').callback('connected', null, true);
        }));

        await expect(router.request('retry-connected', null, { events, requestId: 'retry-connected' })).resolves.toBe('connected');
    });

    it('replays a resumed request that the replacement server does not know', async () => {
        const first = testSocket();
        const second = testSocket();
        const { router, setServer } = clientRouter();
        router.config.syncRequestsWhenServerOpen = false;
        setServer(first.socket);
        const send = vi.spyOn(router as any, '_sendWithAck').mockImplementation(async (...args: any[]) => {
            args[3]?.();
            return true;
        });
        vi.spyOn(router as any, 'hasRequest').mockResolvedValue(false);

        const pending = router.request('lost', null, { requestId: 'lost' });
        await vi.waitFor(() => expect((router as any)._activeRequests.get('lost')?.hasSent).toBe(true));
        (router as any)._activeRequests.get('lost').deliveryConfirmed = false;
        (first.socket as any).readyState = WebSocketForce.CLOSED;
        first.emit('close', { code: 1006 });
        setServer(second.socket);

        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        (router as any)._activeRequests.get('lost').callback('replayed', null, true);
        await expect(pending).resolves.toBe('replayed');
    });

    it('rejects a confirmed request that the replacement server no longer knows', async () => {
        const first = testSocket();
        const second = testSocket();
        const { router, setServer } = clientRouter();
        router.config.syncRequestsWhenServerOpen = false;
        setServer(first.socket);
        vi.spyOn(router as any, '_sendWithAck').mockImplementation(async (...args: any[]) => {
            args[3]?.();
            return true;
        });
        vi.spyOn(router as any, 'hasRequest').mockResolvedValue(false);

        const pending = router.request('confirmed-lost', null, { requestId: 'confirmed-lost' });
        await vi.waitFor(() => expect((router as any)._activeRequests.get('confirmed-lost')?.deliveryConfirmed).toBe(true));
        (first.socket as any).readyState = WebSocketForce.CLOSED;
        first.emit('close', { code: 1006 });
        setServer(second.socket);

        await expect(pending).rejects.toMatchObject({ code: 'unknownRequest' });
    });

    it('rejects deterministically when the reconnect status check fails', async () => {
        const first = testSocket();
        const second = testSocket();
        const { router, setServer } = clientRouter();
        router.config.syncRequestsWhenServerOpen = false;
        setServer(first.socket);
        vi.spyOn(router as any, '_sendWithAck').mockImplementation(async (...args: any[]) => {
            args[3]?.();
            return true;
        });
        vi.spyOn(router as any, 'hasRequest').mockRejectedValue(new Error('status unavailable'));

        const pending = router.request('status-failure', null, { requestId: 'status-failure' });
        await vi.waitFor(() => expect((router as any)._activeRequests.get('status-failure')?.hasSent).toBe(true));
        (first.socket as any).readyState = WebSocketForce.CLOSED;
        first.emit('close', { code: 1006 });
        setServer(second.socket);

        await expect(pending).rejects.toMatchObject({ code: 'reconnectFailed' });
    });

    it('does not reconnect a request that finishes during the status check', async () => {
        const first = testSocket();
        const second = testSocket();
        const { router, setServer } = clientRouter();
        router.config.syncRequestsWhenServerOpen = false;
        setServer(first.socket);
        vi.spyOn(router as any, '_sendWithAck').mockImplementation(async (...args: any[]) => {
            args[3]?.();
            return true;
        });
        vi.spyOn(router as any, 'hasRequest').mockImplementation(async (requestId: string) => {
            (router as any)._activeRequests.get(requestId).callback('finished', null, true);
            return true;
        });

        const pending = router.request('finishing', null, { requestId: 'finishing' });
        await vi.waitFor(() => expect((router as any)._activeRequests.get('finishing')?.hasSent).toBe(true));
        (first.socket as any).readyState = WebSocketForce.CLOSED;
        first.emit('close', { code: 1006 });
        setServer(second.socket);

        await expect(pending).resolves.toBe('finished');
    });
});

describe('PerfectWS ACK and packet handling paths', () => {
    it('cancels an outstanding ACK immediately when the request is aborted', async () => {
        const raw = testSocket();
        const { router, unregister } = clientRouter(raw);
        router.config.syncRequestsWhenServerOpen = false;
        router.config.enableAckSystem = true;
        router.config.ackTimeout = 60_000;
        router.config.ackRetryDelays = [];
        const controller = new AbortController();

        const pending = router.request('abort-ack', null, { abortSignal: controller.signal });
        await vi.waitFor(() => expect((router as any)._pendingAcks.size).toBe(1));
        controller.abort('cancelled');

        await expect(pending).rejects.toMatchObject({ code: 'abort' });
        // The caller settles immediately, while the durable abort stays queued
        // until the peer acknowledges it or the router is explicitly released.
        expect((router as any)._pendingAcks.size).toBe(1);
        expect(raw.listeners.get('close')?.size ?? 0).toBe(1);
        unregister();
        expect((router as any)._pendingAcks.size).toBe(0);
    });

    it('cancels ACKs and serverOpen waiters when the router is unregistered', async () => {
        const raw = testSocket();
        const result = clientRouter(raw);
        result.router.config.syncRequestsWhenServerOpen = false;
        result.router.config.enableAckSystem = true;
        result.router.config.ackTimeout = 60_000;
        result.router.config.ackRetryDelays = [];
        const pending = result.router.request('unregister-ack');
        await vi.waitFor(() => expect((result.router as any)._pendingAcks.size).toBe(1));

        result.unregister();

        await expect(pending).rejects.toMatchObject({ code: 'unregistered' });
        await expect(result.router.serverOpen).rejects.toMatchObject({ code: 'unregistered' });
        expect((result.router as any)._pendingAcks.size).toBe(0);
    });

    it('logs direct-send failures for closed and throwing sockets', () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = true;
        router.config.verbose = true;
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const closed = new WebSocketForce(testSocket(WebSocketForce.CLOSED).socket);
        const throwing = new WebSocketForce(testSocket(WebSocketForce.OPEN, () => { throw new Error('send failed'); }).socket);

        expect(router._sendData(new Uint8Array(), closed)).toBe(false);
        expect(router._sendData(new Uint8Array(), throwing)).toBe(false);
        expect(log).toHaveBeenCalled();
    });

    it('logs when ACK delivery starts without an open server', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = true;
        router.config.verbose = true;
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const closed = new WebSocketForce(testSocket(WebSocketForce.CLOSED).socket);

        await expect(router._sendWithAck({ value: 1 }, closed)).resolves.toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('server not OPEN'));
    });

    it('resolves an ACK once and ignores repeated resolution and timeout', async () => {
        vi.useFakeTimers();
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        router.config.ackRetryDelays = [];
        router.config.ackTimeout = 10;
        const force = new WebSocketForce(testSocket().socket);
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
        const sent = vi.fn();

        const pending = router._sendWithAck({ value: 1 }, force, false, sent, undefined, false, () => {
            throw new Error('delivery observer failed');
        });
        const handler = [...router._pendingAcks.values()][0];
        const closeListener = (force as any)._virtualCloseListeners[0].listener;
        handler.resolve();
        handler.resolve();
        closeListener();
        await vi.advanceTimersByTimeAsync(10);

        await expect(pending).resolves.toBe(true);
        expect(sent).toHaveBeenCalledOnce();
        clearTimeoutSpy.mockRestore();
    });

    it('ignores an abort that arrives after an ACK has already settled', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = true;
        router.config.ackRetryDelays = [];
        const force = new WebSocketForce(testSocket().socket);
        const controller = new AbortController();
        let abortListener: EventListener | undefined;
        vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener) => {
            if (type === 'abort') abortListener = listener as EventListener;
        });
        const pending = router._sendWithAck({ value: 1 }, force, false, undefined, controller.signal);
        const handler = [...router._pendingAcks.values()][0];

        handler.resolve();
        abortListener!(new Event('abort'));

        await expect(pending).resolves.toBe(true);
    });

    it('rejects ACKs once and covers a packet that cannot be sent', async () => {
        const rejectedRouter = (PerfectWS as any)._newInstance();
        rejectedRouter.config.enableAckSystem = true;
        rejectedRouter.config.verbose = true;
        rejectedRouter.config.ackRetryDelays = [];
        const rejectedSocket = new WebSocketForce(testSocket().socket);
        const rejected = rejectedRouter._sendWithAck({ value: 1 }, rejectedSocket);
        const handler = [...rejectedRouter._pendingAcks.values()][0];
        handler.reject('');
        handler.reject('ignored rejection');
        await expect(rejected).resolves.toBe(false);

        const failedRouter = (PerfectWS as any)._newInstance();
        failedRouter.config.enableAckSystem = true;
        failedRouter.config.verbose = true;
        failedRouter.config.ackRetryDelays = [];
        const failedSocket = new WebSocketForce(testSocket(WebSocketForce.OPEN, () => { throw new Error('send failed'); }).socket);
        await expect(failedRouter._sendWithAck({ value: 1 }, failedSocket)).resolves.toBe(false);
    });

    it('times out all ACK attempts and force closes the socket', async () => {
        vi.useFakeTimers();
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = true;
        router.config.verbose = true;
        router.config.ackRetryDelays = [1];
        router.config.ackTimeout = 1;
        const force = new WebSocketForce(testSocket().socket);
        const pending = router._sendWithAck({ value: 1 }, force);

        await vi.runAllTimersAsync();

        await expect(pending).resolves.toBe(false);
        expect(force.readyState).toBe(WebSocketForce.CLOSED);
    });

    it('stops waiting for an ACK as soon as its socket closes', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = true;
        router.config.ackRetryDelays = [10_000];
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket);
        const pending = router._sendWithAck({ value: 1 }, force);

        (raw.socket as any).readyState = WebSocketForce.CLOSED;
        raw.emit('close');

        await expect(pending).resolves.toBe(false);
        expect(router._pendingAcks.size).toBe(0);
        expect(raw.listeners.get('close')?.size ?? 0).toBe(0);
    });

    it('logs ACK, duplicate, unknown, and throwing response-event paths', () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        const force = new WebSocketForce(testSocket().socket);
        const ack = { resolve: vi.fn(), reject: vi.fn() };
        router._pendingAcks.set('ack', ack);
        router._onServerResponse({ method: '___ack', data: { ackFor: 'ack' } }, force);

        router._processedPackets.set('duplicate', Date.now());
        router._onServerResponse({ requestId: 'missing', packetId: 'duplicate' }, force);
        router._onServerResponse({ requestId: 'missing', down: false }, force);

        const events = new NetworkEventListener();
        events.on('throwing', () => { throw new Error('listener failed'); });
        router._activeRequests.set('active', {
            events, updateTime: 0, callback: vi.fn(), requestId: 'active',
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        router._onServerResponse({ requestId: 'active', event: { eventName: 'throwing', args: [] } }, force);

        expect(ack.resolve).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalled();
    });

    it('closes instead of evicting an unexpired packet id at capacity', () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.maxProcessedPackets = 0;
        const socket = new WebSocketForce(testSocket().socket);
        const close = vi.spyOn(socket, 'forceClose');

        expect(router._acceptPacket('packet', 'request', socket)).toBe(false);
        expect(close).toHaveBeenCalledWith(1013, 'ACK deduplication capacity reached');
    });

    it('enforces router-wide ACK and dedupe-client capacity', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = true;
        router.config.maxPendingAcks = 10;
        router.config.maxTotalPendingAcks = 1;
        router.config.maxProcessedPackets = 10;
        router.config.maxProcessedPacketClients = 1;
        const first = new WebSocketForce(testSocket().socket);
        const second = new WebSocketForce(testSocket().socket);
        const firstClose = vi.spyOn(first, 'forceClose');
        const secondClose = vi.spyOn(second, 'forceClose');
        router._pendingAcks.set('occupied', { server: first, resolve: vi.fn(), reject: vi.fn() });

        await expect(router._sendWithAck({ requestId: 'blocked' }, second)).resolves.toBe(false);
        expect(firstClose).toHaveBeenCalledWith(1013, 'Global pending ACK capacity reached');

        router._processedPacketsByClient.set('first-client', new Map([['first-packet', Date.now()]]));
        expect(router._acceptPacket('second-packet', 'request', second, 'second-client')).toBe(false);
        expect(secondClose).toHaveBeenCalledWith(1013, 'ACK deduplication client capacity reached');
    });

    it('globally bounds ACK deduplication state across client identities', () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.maxProcessedPackets = 1;
        router.config.maxTotalProcessedPackets = 1;
        const first = new WebSocketForce(testSocket().socket);
        const second = new WebSocketForce(testSocket().socket);
        const closeSecond = vi.spyOn(second, 'forceClose');

        expect(router._acceptPacket('first', 'request-a', first, 'client-a')).toBe(true);
        expect(router._acceptPacket('second', 'request-b', second, 'client-b')).toBe(false);
        expect(router._processedPacketsByClient.get('client-a').size).toBe(1);
        expect(router._processedPacketsByClient.has('client-b')).toBe(false);
        expect(closeSecond).toHaveBeenCalledWith(1013, 'Global ACK deduplication capacity reached');
    });

    it('logs ACK, duplicate, throwing event, and reconnect request paths on the server', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        const ack = { resolve: vi.fn(), reject: vi.fn() };
        router._pendingAcks.set('ack', ack);
        await router._onRequest({ method: '___ack', data: { ackFor: 'ack' } }, force);

        router._processedPacketsByClient.set('client', new Map([['duplicate', Date.now()]]));
        await router._onRequest({ requestId: 'duplicate', packetId: 'duplicate', clientId: 'client' }, force);

        const events = new NetworkEventListener();
        events.on('throwing', () => { throw new Error('listener failed'); });
        const activeResponse = {
            events, clientId: 'client', responseEnded: false, updateTime: 0,
            clientRef: { ref: null }, release: vi.fn(),
        };
        router._activeResponses.set('active', activeResponse);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await router._onRequest({ requestId: 'active', clientId: 'client', event: { eventName: 'throwing', args: [] } }, force);
        await router._onRequest({ requestId: 'active', clientId: 'client' }, force);

        expect(ack.resolve).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalled();
        expect(activeResponse.clientRef.ref).toBe(force);
    });
});

describe('PerfectWS server delivery and cleanup paths', () => {
    it('keeps request deadlines beyond the native timer limit instead of clamping them to 1ms', async () => {
        const client = PerfectWS.client();
        client.router.config.requestTimeout = Infinity;
        const infinite = client.router.request('infinite-deadline');
        let settled = false;
        const pending = client.router.request('long-deadline', null, { timeout: 3_000_000_000 })
            .finally(() => { settled = true; });

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(settled).toBe(false);

        client.unregister();
        await expect(infinite).rejects.toMatchObject({ code: 'unregistered' });
        await expect(pending).rejects.toMatchObject({ code: 'unregistered' });
    });

    it('logs malformed BSON input', () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        expect(router.deserialize(new Uint8Array([1, 2, 3]))).toBeNull();
        expect(log).toHaveBeenCalled();
    });

    it('handles an early abort before invoking the request handler', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        router.config.enableAckSystem = false;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        const handler = vi.fn();
        router.on('early', handler);
        const key = JSON.stringify(['client', 'early']);
        router._pendingAborts.set(key, { clientId: 'client', requestId: 'early', timestamp: Date.now() });
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);

        await router._onRequest({ method: 'early', requestId: 'early', clientId: 'client' }, force);

        expect(handler).not.toHaveBeenCalled();
        expect(router._pendingAborts.has(key)).toBe(false);
    });

    it('replaces the same client response and contains a legacy fatal event decode', async () => {
        const router = (PerfectWS as any)._newInstance();
        const response = { requestId: 'same', clientId: 'client' };
        const replacement = { requestId: 'same', clientId: 'client' };
        router._setActiveResponse(response);
        router._setActiveResponse(replacement);
        expect(router._activeResponses.get('same')).toBe(replacement);

        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        const release = vi.fn();
        router._activeResponses.set('legacy', {
            requestId: 'legacy', clientId: 'client', events: new NetworkEventListener(), release,
            clientRef: { ref: force }, responseEnded: true, detachClient: vi.fn(), internal: false, method: 'legacy',
        });
        vi.spyOn(router as any, 'deserializeRequestData').mockImplementation(() => { throw new Error('bad event'); });
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);
        await router._onRequest({
            requestId: 'legacy', clientId: 'client', event: { eventName: 'bad', args: [] },
        }, force);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ channelError: true }), force,
            false, undefined, undefined, true);
        expect(release).toHaveBeenCalledOnce();
    });

    it('does not apply one client early abort to another client request id', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        const first = new WebSocketForce(testSocket().socket) as any;
        const second = new WebSocketForce(testSocket().socket) as any;
        first.clientId = 'client-a';
        second.clientId = 'client-b';
        const handler = vi.fn(() => 'ok');
        router.on('work', handler);
        vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);

        await router._onRequest({
            requestId: 'shared', clientId: 'client-a',
            event: { eventName: '___abort', args: [] },
        }, first);
        await router._onRequest({ method: 'work', requestId: 'shared', clientId: 'client-b' }, second);

        expect(handler).toHaveBeenCalledOnce();
        expect(router._pendingAborts.has(JSON.stringify(['client-a', 'shared']))).toBe(true);
    });

    it('strictly bounds and expires aborts received before their requests', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.maxPendingAborts = 2;
        router.config.pendingAbortsMinAge = 1;
        router.config.clearOldRequestsDelay = 1;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        const forceClose = vi.spyOn(force, 'forceClose');

        for (let index = 0; index < 3; index++) {
            await router._onRequest({
                requestId: `missing-${index}`,
                clientId: 'client',
                event: { eventName: '___abort', args: [] },
            }, force);
        }

        expect([...router._pendingAborts.values()].map((entry: any) => entry.requestId)).toEqual(['missing-0', 'missing-1']);
        expect(forceClose).toHaveBeenCalledWith(1013, 'Pending abort capacity reached');
        await vi.waitFor(() => expect(router._pendingAborts.size).toBe(0));
    });

    it('enforces maxActiveRequests on owner-side response channels', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.maxActiveRequests = 1;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        router.on('hold', async (_data, { abortSignal }) => {
            await new Promise<void>(resolve => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
        });
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);

        const first = router._onRequest({ method: 'hold', requestId: 'first', clientId: 'client', timeout: 0 }, force);
        await vi.waitFor(() => expect(router._activeResponses.size).toBe(1));
        await router._onRequest({ method: 'hold', requestId: 'second', clientId: 'client', timeout: 0 }, force);

        expect(router._activeResponses.size).toBe(1);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'second',
            error: expect.objectContaining({ code: 'tooManyRequests' }),
        }), force, false, expect.any(Function), expect.anything(), false, undefined);

        router._activeResponses.get('first').release();
        await first;
    });

    it('keeps internal synchronization available while response capacity is full', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.maxActiveRequests = 0;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);

        await router._onRequest({
            method: '___hasRequest', requestId: 'status', clientId: 'client', data: { requestId: 'missing' },
        }, force);

        expect(send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'status', data: false }), force, false, expect.any(Function), expect.anything(), true, undefined);
    });

    it('aborts pending handler work when its response channel is released directly', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        let ownerSignal: AbortSignal | undefined;
        router.on('releasePending', async (_data, { abortSignal }) => {
            ownerSignal = abortSignal;
            await new Promise<void>(resolve => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
        });

        const handling = router._onRequest({
            method: 'releasePending', requestId: 'release-pending', clientId: 'client', timeout: 10_000,
        }, force);
        await vi.waitFor(() => expect(router._activeResponses.has('release-pending')).toBe(true));

        router._activeResponses.get('release-pending').release();
        await handling;

        expect(ownerSignal?.aborted).toBe(true);
        expect(router._activeResponses.has('release-pending')).toBe(false);
    });

    it('sends the owner-side timeout error while the requesting socket is open', async () => {
        const raw = testSocket();
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);
        router.on('ownerTimeout', async (_data, { abortSignal }) => {
            await new Promise<void>(resolve => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
        });

        await router._onRequest({
            method: 'ownerTimeout', requestId: 'owner-timeout', clientId: 'client', timeout: 1,
        }, force);

        expect(send).toHaveBeenCalled();
        await vi.waitFor(() => expect(router._activeResponses.has('owner-timeout')).toBe(false));
    });

    it('rejects malformed wire deadlines and accepts an omitted deadline with an Infinity owner default', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        const handler = vi.fn(() => 'done');
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);
        router.on('wire-timeout', handler);

        const invalidValues = [NaN, -1, -Infinity, null, '100'];
        for (const [index, timeout] of invalidValues.entries()) {
            await router._onRequest({
                method: 'wire-timeout', requestId: `invalid-wire-timeout-${ index }`, clientId: 'client', timeout,
            }, force);
        }

        router.config.requestTimeout = NaN;
        await router._onRequest({
            method: 'wire-timeout', requestId: 'invalid-owner-config', clientId: 'client',
        }, force);
        expect(handler).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(invalidValues.length + 1);
        for (const [message] of send.mock.calls) {
            expect(message).toMatchObject({ error: { code: 'invalidTimeout' }, down: true });
        }
        expect(router._activeResponses.size).toBe(0);

        send.mockClear();
        router.config.requestTimeout = Infinity;
        await router._onRequest({
            method: 'wire-timeout', requestId: 'infinite-owner-config', clientId: 'client',
        }, force);
        expect(handler).toHaveBeenCalledOnce();
        expect(send.mock.calls[0][0]).toMatchObject({ data: 'done', down: true });
        expect(router._activeResponses.size).toBe(0);
    });

    it('keeps a timed-out terminal response until it can be delivered or explicitly released', async () => {
        const raw = testSocket();
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.sendRequestRetries = 1;
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        router.on('offline-send-timeout', async (_data, options) => {
            (raw.socket as any).readyState = WebSocketForce.CLOSED;
            raw.emit('close', { code: 1006 });
            await options.send('cannot-deliver');
            return 'too late';
        });

        await router._onRequest({
            method: 'offline-send-timeout', requestId: 'offline-send-timeout', clientId: 'client', timeout: 5,
        }, force);

        expect(raw.socket.send).not.toHaveBeenCalled();
        expect(router._activeResponses.has('offline-send-timeout')).toBe(true);
        router._activeResponses.get('offline-send-timeout').release(true);
        expect(router._activeResponses.has('offline-send-timeout')).toBe(false);
    });

    it('stops a retry when its response is released during the previous send', async () => {
        const raw = testSocket();
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.sendRequestRetries = 2;
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        router.on('release-during-send', async (_data, options) => {
            await options.send('chunk');
        });
        vi.spyOn(router as any, '_sendWithAck').mockImplementation(async () => {
            router._activeResponses.get('release-during-send').release();
            return false;
        });

        await router._onRequest({
            method: 'release-during-send', requestId: 'release-during-send', clientId: 'client', timeout: 100,
        }, force);

        expect(router._activeResponses.has('release-during-send')).toBe(false);
    });

    it('stops a disconnected retry after the request is aborted but its live channel remains', async () => {
        const raw = testSocket();
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.sendRequestRetries = 2;
        vi.spyOn(router as any, 'shouldKeepResponseAlive').mockReturnValue(true);
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        router.on('abort-during-send', async (_data, options) => {
            await options.send('chunk');
        });
        vi.spyOn(router as any, '_sendWithAck').mockImplementationOnce(async () => {
            const active = router._activeResponses.get('abort-during-send');
            active.events._emitWithSource('___abort', 'remote', 'stop');
            (raw.socket as any).readyState = WebSocketForce.CLOSED;
            raw.emit('close', { code: 1006 });
            return false;
        });

        await router._onRequest({
            method: 'abort-during-send', requestId: 'abort-during-send', clientId: 'client', timeout: 100,
        }, force);

        expect(router._activeResponses.has('abort-during-send')).toBe(true);
        router._activeResponses.get('abort-during-send').release();
    });

    it('ignores an owner timeout callback that was already queued when the response ended', async () => {
        const raw = testSocket();
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        const send = vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);
        router.on('quickResponse', () => 'done');

        let queuedTimeout!: () => void;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
            queuedTimeout = callback;
            return 1 as any;
        }) as any);

        await router._onRequest({
            method: 'quickResponse', requestId: 'quick-response', clientId: 'client', timeout: 10_000,
        }, force);
        expect(send).toHaveBeenCalledOnce();

        queuedTimeout();

        expect(send).toHaveBeenCalledOnce();
        expect(router._activeResponses.has('quick-response')).toBe(false);
    });

    it('skips a lossy send after the client disconnects', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        router.config.enableAckSystem = false;
        router.config.requestTimeout = 0;
        router.config.sendRequestRetries = 1;
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        router.on('lossy', async (_data: any, options: any) => {
            (raw.socket as any).readyState = WebSocketForce.CLOSED;
            raw.emit('close', { code: 1006 });
            await options.send('dropped', false, true);
            return 'done';
        });

        const pending = router._onRequest({ method: 'lossy', requestId: 'lossy', clientId: 'client' }, force);
        await vi.waitFor(() => expect(router._activeResponses.has('lossy')).toBe(true));
        router._activeResponses.get('lossy').release();
        await pending;

        expect(router._activeResponses.has('lossy')).toBe(false);
    });

    it('handles duplicate reconnect settlement and a missing client after reconnect', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        router.config.enableAckSystem = false;
        router.config.requestTimeout = 100;
        router.config.sendRequestRetries = 1;
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        router.on('missing-after-connect', async (_data: any, options: any) => {
            (raw.socket as any).readyState = WebSocketForce.CLOSED;
            raw.emit('close', { code: 1006 });
            queueMicrotask(() => {
                const listener = options.events.listeners('___request.connected')[0];
                listener('local');
                listener('local');
            });
            await options.send('cannot-send');
        });

        await router._onRequest({ method: 'missing-after-connect', requestId: 'missing-after-connect', clientId: 'client' }, force);

        expect(router._activeResponses.has('missing-after-connect')).toBe(false);
    });

    it('logs thrown handlers and isolates serialization failures in error responses', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        router.config.enableAckSystem = false;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        router.on('throws', () => { throw new Error('handler failed'); });

        await router._onRequest({ method: 'throws', requestId: 'throws', clientId: 'client' }, force);
        vi.spyOn(router as any, 'serializeRequestData').mockImplementation(() => { throw new Error('serialize failed'); });
        await router._onRequest({ method: 'missing', requestId: 'serialize', clientId: 'client' }, force);
        await Promise.resolve();

        expect(log).toHaveBeenCalledWith('[PerfectWS] _onRequest: caught error:', 'handler failed');
    });

    it('terminates an intermediate response after its payload cannot be serialized', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        const force = new WebSocketForce(testSocket().socket) as any;
        force.clientId = 'client';
        let ownerSignal: AbortSignal | undefined;
        router.on('bad-progress', async (_data: unknown, options: any) => {
            ownerSignal = options.abortSignal;
            await options.send('bad');
            return 'too late';
        });
        vi.spyOn(router as any, 'prepareRequestData').mockImplementation((value: unknown) => {
            if (value === 'bad') throw new Error('cannot serialize progress');
            return { data: value, commit: () => { }, rollback: () => { } };
        });
        vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(true);

        await router._onRequest({ method: 'bad-progress', requestId: 'bad-progress', clientId: 'client', timeout: 0 }, force);
        expect(ownerSignal?.aborted).toBe(true);
        expect(router._activeResponses.has('bad-progress')).toBe(false);
    });

    it('cleans every stale request and bounds pending aborts', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        router.config.requestTimeout = 1;
        router.config.clearOldRequestsDelay = 0;
        router.config.pendingAbortsMinAge = 10;
        router.config.maxPendingAborts = 0;
        router.config.maxTotalPendingAborts = 0;
        const open = new WebSocketForce(testSocket().socket);
        const closed = new WebSocketForce(testSocket(WebSocketForce.CLOSED).socket);
        const requests = router._activeRequests as Map<string, any>;
        const remove = (id: string) => () => requests.delete(id);

        const finishedClosedRelease = vi.fn();
        const finishedOpenRelease = vi.fn();
        requests.set('finished-closed', { finished: true, updateTime: 0, server: closed, release: finishedClosedRelease });
        requests.set('finished-open', { finished: true, updateTime: 0, server: open, release: finishedOpenRelease });
        requests.set('sync-throw', { updateTime: 0, server: open, callback: remove('sync-throw') });
        requests.set('closed', {
            updateTime: 0, server: closed,
            callback: remove('closed'),
        });
        requests.set('open-false', { updateTime: 0, server: open, callback: remove('open-false') });
        requests.set('open-reject', { updateTime: 0, server: open, callback: remove('open-reject') });
        vi.spyOn(router as any, 'hasRequest').mockImplementation((id: string) => {
            if (id === 'sync-throw') throw new Error('sync failure');
            if (id === 'open-reject') return Promise.reject(new Error('status failure'));
            return Promise.resolve(false);
        });

        const now = Date.now();
        router._pendingAborts.set(JSON.stringify(['client', 'orphan']), { clientId: 'client', requestId: 'orphan', timestamp: now - 100 });
        router._pendingAborts.set(JSON.stringify(['client', 'active-response']), { clientId: 'client', requestId: 'active-response', timestamp: now - 100 });
        router._pendingAborts.set(JSON.stringify(['client', 'young']), { clientId: 'client', requestId: 'young', timestamp: now });
        router._activeResponses.set('active-response', { clientId: 'client' });

        router._clearOldRequestActive = true;
        await router._clearOldRequests();
        router._clearOldRequestActive = false;
        const cleanupPromise = router._clearOldRequests();

        await vi.waitFor(() => {
            expect([...requests.keys()]).toEqual(['finished-closed', 'finished-open']);
            expect([...router._pendingAborts.values()].some((entry: any) => entry.requestId === 'orphan')).toBe(false);
        });

        expect(finishedClosedRelease).not.toHaveBeenCalled();
        expect(finishedOpenRelease).not.toHaveBeenCalled();
        expect([...router._pendingAborts.values()].map((entry: any) => entry.requestId)).toEqual(['active-response']);

        router._requestCleanupAbortController.abort('test complete');
        await cleanupPromise;
    });

    it('bounds packet and ACK maps without expiring completed responses', async () => {
        const router = (PerfectWS as any)._newInstance();
        router.config.verbose = true;
        router.config.processedPacketsCleanupInterval = 0;
        router.config.maxProcessedPackets = 1;
        router.config.processedPacketsRetention = 50;
        router.config.maxPendingAcks = 2;
        router.config.maxTotalPendingAcks = 2;
        router.config.maxPendingAcksKept = 1;
        router.config.requestTimeout = 0;
        router._processedPackets.set('old', Date.now() - 100);
        router._processedPackets.set('new', Date.now());
        router._processedPacketsByClient.set('old-client', new Map([['old-client-packet', Date.now() - 100]]));
        router._processedPacketsByClient.set('live-client', new Map([['live-client-packet', Date.now()]]));
        const abortController = new AbortController();
        const firstReject = vi.fn(() => {
            router._pendingAcks.delete('second');
            abortController.abort('complete');
        });
        router._pendingAcks.set('first', { resolve: vi.fn(), reject: firstReject });
        router._pendingAcks.set('second', { resolve: vi.fn(), reject: vi.fn() });
        router._pendingAcks.set('kept', { resolve: vi.fn(), reject: vi.fn() });
        const release = vi.fn();
        router._activeResponses.set('stale', {
            responseEnded: true, clientRef: { ref: null }, updateTime: 0, release,
        });
        const closedResponseRelease = vi.fn();
        router._activeResponses.set('stale-closed', {
            responseEnded: true,
            clientRef: { ref: new WebSocketForce(testSocket(WebSocketForce.CLOSED).socket) },
            updateTime: 0,
            release: closedResponseRelease,
        });

        await router._startAckCleanupLoop(abortController);

        expect([...router._processedPackets.keys()]).toEqual(['new']);
        expect(router._processedPacketsByClient.has('old-client')).toBe(false);
        expect([...router._processedPacketsByClient.get('live-client').keys()]).toEqual(['live-client-packet']);
        expect(firstReject).toHaveBeenCalledWith('ACK cleanup - too many pending');
        expect([...router._pendingAcks.keys()]).toEqual(['kept']);
        expect(release).not.toHaveBeenCalled();
        expect(closedResponseRelease).not.toHaveBeenCalled();
    });

    it('closes a client that never opens and ignores the timeout after attachment cleanup', async () => {
        const first = testSocket(WebSocketForce.CONNECTING);
        const server = PerfectWS.server();
        server.router.config.connectionTimeout = 0;
        server.router.config.runPingLoop = true;
        const unregisterFirst = server.attachClient(first.socket);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(first.socket.close).toHaveBeenCalledWith(1000, 'Connection timeout');
        unregisterFirst();
        server.unregister();

        const second = testSocket(WebSocketForce.CONNECTING);
        const stopped = PerfectWS.server();
        stopped.router.config.connectionTimeout = 0;
        stopped.router.config.runPingLoop = true;
        const detach = stopped.attachClient(second.socket);
        detach();
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(second.socket.close).not.toHaveBeenCalled();
        stopped.unregister();
    });

    it('keeps socket detach functions idempotent without dropping another client cleanup', () => {
        const first = testSocket();
        const second = testSocket();
        const server = PerfectWS.server();
        server.router.config.runPingLoop = false;
        const detachFirst = server.attachClient(first.socket);
        server.attachClient(second.socket);

        detachFirst();
        detachFirst();
        server.unregister();

        expect(first.listeners.get('message')?.size ?? 0).toBe(0);
        expect(second.listeners.get('message')?.size ?? 0).toBe(0);
    });

    it('automatically detaches a closed socket instead of retaining it for server lifetime', () => {
        const raw = testSocket();
        const server = PerfectWS.server();
        server.router.config.runPingLoop = false;
        server.attachClient(raw.socket);
        expect(raw.listeners.get('message')?.size).toBe(1);

        raw.emit('close', { code: 1000 });

        expect(raw.listeners.get('message')?.size ?? 0).toBe(0);
        expect(raw.listeners.get('close')?.size ?? 0).toBe(0);
        server.unregister();
    });

    it('uses channel-error defaults when a finished live request receives a fatal terminal frame', () => {
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket);
        const { router } = clientRouter(raw);
        const release = vi.fn();
        (router as any)._activeRequests.set('fatal', {
            finished: true,
            release,
            events: new NetworkEventListener(),
        });

        (router as any)._onServerResponse({ requestId: 'fatal', down: true, channelError: true }, force);

        expect(release).toHaveBeenCalledWith({ message: 'Live RPC channel failed', code: 'channelError' });
    });

    it('reports a failed event send on an already-finished live response', async () => {
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        const router = (PerfectWSAdvanced as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.sendRequestRetries = 1;
        router.config.reconnectTimeout = 0;
        let events!: NetworkEventListener;
        router.on('live', (_data: unknown, options: any) => {
            events = options.events;
            return () => 1;
        });

        const initialSend = vi.spyOn(router as any, '_sendWithAck').mockImplementation(async (...args: any[]) => {
            args[3]?.();
            return true;
        });
        await router._onRequest({ method: 'live', requestId: 'live', clientId: 'client' }, force);
        initialSend.mockRestore();
        expect(router._activeResponses.has('live')).toBe(true);
        expect((events as any)._anyListeners.length).toBeGreaterThan(0);
        const emit = vi.spyOn(events, 'emit');
        router.config.enableAckSystem = true;
        router.config.maxPendingAcks = 0;
        events.emit('application-event', { value: 1 });
        await vi.waitFor(() => {
            expect(emit).toHaveBeenCalledWith('___request.sendFailed', expect.objectContaining({ eventName: 'application-event' }));
        });
        router._releaseAllChannels();
    });

    it('force-closes an open socket when a durable live-channel event exhausts its send attempts', async () => {
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        const router = (PerfectWSAdvanced as any)._newInstance();
        router.config.enableAckSystem = false;
        let events!: NetworkEventListener;
        router.on('live-durable', (_data: unknown, options: any) => {
            events = options.events;
            return () => 1;
        });
        const initialSend = vi.spyOn(router as any, '_sendWithAck').mockImplementation(async (...args: any[]) => {
            args[3]?.();
            return true;
        });
        await router._onRequest({ method: 'live-durable', requestId: 'live-durable', clientId: 'client' }, force);
        initialSend.mockRestore();

        router.config.enableAckSystem = true;
        router.config.sendRequestRetries = 1;
        vi.spyOn(router as any, '_sendWithAck').mockResolvedValue(false);
        events.emit('___callback.response', { requestId: 'missing', data: 'result' });
        await vi.waitFor(() => expect(raw.socket.close).toHaveBeenCalled());

        expect(router._pendingAcks.size).toBe(0);
        router._activeResponses.get('live-durable')?.release(true);
        router._releaseAllChannels();
    });

    it('observes a reconnect that occurs while a response send installs its waiter', async () => {
        const closedRaw = testSocket(WebSocketForce.CLOSED);
        const closed = new WebSocketForce(closedRaw.socket) as any;
        closed.clientId = 'client';
        const replacementRaw = testSocket();
        const replacement = new WebSocketForce(replacementRaw.socket) as any;
        replacement.clientId = 'client';
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.sendRequestRetries = 1;
        vi.spyOn(router as any, '_sendWithAck').mockImplementation(async (data: any, server: any, _loss: any, onSent: any) => {
            const sent = router._sendJSON(data, server);
            if (sent) onSent?.();
            return sent;
        });
        router.on('connect-race', async (_data: unknown, options: any) => {
            const response = router._activeResponses.get('connect-race');
            const originalOn = options.events.on.bind(options.events);
            options.events.on = (eventName: string, listener: Function) => {
                originalOn(eventName, listener);
                if (eventName === '___request.connected') response.clientRef.ref = replacement;
            };
            await options.send({ connected: true });
            return 'done';
        });

        await router._onRequest({ method: 'connect-race', requestId: 'connect-race', clientId: 'client' }, closed);

        expect(replacementRaw.socket.send).toHaveBeenCalled();
        router._releaseAllChannels();
    });

    it('times out a socket whose ping timestamp was never initialized', async () => {
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket);
        const server = PerfectWS.server();
        server.router.config.runPingLoop = true;
        server.router.config.pingIntervalMs = 1;
        server.router.config.pingReceiveTimeout = 0;
        server.attachClient(force);
        (server.router as any)._lastPingTimes.delete(force);

        await new Promise(resolve => setTimeout(resolve, 5));

        expect(raw.socket.close).toHaveBeenCalledWith(1000, 'Ping timeout');
        server.unregister();
    });

    it('tracks ping liveness per attached socket', async () => {
        const first = testSocket();
        const second = testSocket();
        const firstForce = new WebSocketForce(first.socket);
        const secondForce = new WebSocketForce(second.socket);
        const server = PerfectWS.server();
        server.router.config.runPingLoop = true;
        server.router.config.pingIntervalMs = 5;
        server.router.config.pingReceiveTimeout = 20;
        server.attachClient(firstForce);
        server.attachClient(secondForce);
        const ping = (server.router as any)._listenForRequests.get('___ping').callbacks[0];
        const keepSecondAlive = setInterval(() => void ping(null, { ws: secondForce }), 5);

        await new Promise(resolve => setTimeout(resolve, 45));
        clearInterval(keepSecondAlive);

        expect(first.socket.close).toHaveBeenCalledWith(1000, 'Ping timeout');
        expect(second.socket.close).not.toHaveBeenCalled();
        server.unregister();
    });

    it('bounds each internal method independently', async () => {
        const raw = testSocket();
        const force = new WebSocketForce(raw.socket) as any;
        force.clientId = 'client';
        const router = (PerfectWS as any)._newInstance();
        router.config.enableAckSystem = false;
        router.config.maxInternalRequests = 1;
        router._activeResponses.set('held-ping', {
            events: new NetworkEventListener(),
            clientRef: { ref: force },
            clientId: 'client',
            responseEnded: false,
            internal: true,
            method: '___ping',
            detachClient: vi.fn(),
            release: vi.fn(),
        });

        await router._onRequest({ method: '___ping', requestId: 'second-ping', clientId: 'client' }, force);
        expect(router._activeResponses.has('second-ping')).toBe(false);
        const staleSyncRelease = vi.fn();
        router._activeResponses.set('stale-sync', {
            events: new NetworkEventListener(), clientRef: { ref: force }, clientId: 'client',
            responseEnded: true, internal: true, method: '___syncRequests', release: staleSyncRelease,
        });
        await router._onRequest({ method: '___syncRequests', requestId: 'sync', clientId: 'client' }, force);
        expect(staleSyncRelease).toHaveBeenCalledWith(true);
        expect(raw.socket.send).toHaveBeenCalled();
    });

    it('stops an offline callback retry as soon as its response settles', async () => {
        const raw = testSocket();
        const result = PerfectWSAdvanced.client(raw.socket, { debugging: true, temp: true });
        cleanups.push(result.unregister);
        await result.router.serverOpen;
        const pendingRequest = result.router.request('callback-result');
        const [requestId, request] = [...(result.router as any)._activeRequests.entries()][0];
        (result.router as any)._onServerResponse({
            requestId,
            data: { ___perfectWS: 1, ___type: 'callback', funcId: 'remote-callback', funcName: 'remoteCallback' },
            down: true,
        }, (result.router as any)._server);
        const callback: any = await pendingRequest;

        (raw.socket as any).readyState = WebSocketForce.CLOSED;
        raw.emit('close');
        const call = callback();
        await vi.waitFor(() => expect((result.router as any)._waitForNewServer.size).toBe(1));
        const transforms = (result.router as any)._callbacks.get(request.events);
        const operationId = [...transforms._callbacks._activeRequests.keys()][0];
        request.events._emitWithSource('___callback.response', 'remote', { requestId: operationId, data: 'settled' });

        await expect(call).resolves.toBe('settled');
        await vi.waitFor(() => expect((result.router as any)._waitForNewServer.size).toBe(0));
    });

    it('logs and retries a synchronously failing autoReconnect constructor', async () => {
        const server = PerfectWS.server();
        server.router.config.verbose = true;
        server.router.config.delayBeforeReconnect = 1;
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let attempts = 0;
        class ThrowingSocket {
            constructor() {
                attempts++;
                throw new Error('constructor failed');
            }
        }

        const stop = server.autoReconnect('ws://invalid', ThrowingSocket as any);
        await vi.waitFor(() => expect(attempts).toBeGreaterThan(1));
        stop();
        server.unregister();

        expect(error).toHaveBeenCalledWith('[PerfectWS] autoReconnect attempt failed:', expect.any(Error));
    });

    it('makes unregister terminal for requests and socket attachment', async () => {
        const clientSocket = testSocket();
        const client = PerfectWS.client(clientSocket.socket);
        client.unregister();
        await expect(client.router.request('after-unregister')).rejects.toMatchObject({ code: 'unregistered' });
        expect(() => client.setServer(testSocket().socket)).toThrow(/unregistered/i);

        const server = PerfectWS.server();
        server.unregister();
        expect(() => server.attachClient(testSocket().socket)).toThrow(/unregistered/i);
    });
});
