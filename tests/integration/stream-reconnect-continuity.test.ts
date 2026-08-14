import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PerfectWS } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { sleep } from '../../src/utils/sleepPromise.js';

/**
 * Covers the reconnect-aware streaming behavior added alongside per-client `clientId`:
 * when a client disconnects mid-request and reconnects (new socket, same `clientId`),
 * the still-running server-side handler is rewired onto the new socket via
 * `___syncRequests` (see PerfectWS.ts `_connectWSToOnRequestResponse`) instead of the
 * request being lost, duplicated, or silently restarted.
 */
describe('Streaming request continuity across client reconnect', () => {
    let wss: WebSocketServer;
    let serverPort: number;
    const openSockets: WebSocket[] = [];

    beforeEach(async () => {
        wss = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve, reject) => {
            wss.once('listening', resolve);
            wss.once('error', reject);
        });
        const address = wss.address();
        if (address === null || typeof address === 'string') throw new Error('Missing WebSocket address');
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

    it('resumes a streaming response on a new socket after a silent disconnect (same clientId)', async () => {
        const { router: server, attachClient } = PerfectWS.server();
        wss.on('connection', (ws) => attachClient(ws));

        const TOTAL_CHUNKS = 6;
        server.on('stream', async (_data, { send }) => {
            for (let i = 0; i < TOTAL_CHUNKS; i++) {
                await sleep(120);
                send({ i }, false);
            }
            return { total: TOTAL_CHUNKS, done: true };
        });

        const { router: client, setServer } = PerfectWS.client();
        const ws1 = await connect();
        setServer(ws1);
        await client.serverOpen;

        const received: number[] = [];
        const resultPromise = client.request('stream', {}, {
            callback: (data, _error, down) => {
                if (!down && data) received.push(data.i);
            },
            timeout: 10000,
        });

        // Let a couple of chunks arrive over the first connection, then kill it hard
        // (not a graceful close) to simulate a real network drop mid-stream.
        while (received.length < 2) {
            await sleep(20);
        }
        (ws1 as any)._socket?.destroy?.() ?? ws1.terminate();

        // While disconnected, the server keeps running the SAME handler loop; any
        // send() calls made during this window should be delayed, not dropped.
        await sleep(250);

        const ws2 = await connect();
        setServer(ws2);

        const result = await resultPromise;

        expect(received).toEqual([0, 1, 2, 3, 4, 5]);
        expect(result).toEqual({ total: TOTAL_CHUNKS, done: true });
    }, 15000);

    it('a fresh client instance sharing the same explicit clientId gets recognized, and aborts (not silently resumes) a stream it has no memory of', async () => {
        // This documents what "clientId is for resuming a previous session" actually means
        // in practice: reconnect-continuity (the previous test) only works because the SAME
        // in-memory client instance still lists the requestId as active when it resyncs.
        // A genuinely new instance (e.g. after a real page reload) starts with an empty
        // active-request list, so its first ___syncRequests correctly tells the server the
        // old, now-orphaned stream is unknown - the server aborts it rather than leaking the
        // handler forever. This is a safety property of clientId-based identity, not a
        // "transparently continues" guarantee across a full process restart.
        const { router: server, attachClient } = PerfectWS.server();
        wss.on('connection', (ws) => attachClient(ws));

        let handlerRanToCompletion = false;
        server.on('stream', async (_data, { send, abortSignal }) => {
            for (let i = 0; i < 6; i++) {
                if (abortSignal.aborted) return { aborted: true };
                await sleep(120);
                send({ i }, false);
            }
            handlerRanToCompletion = true;
            return { total: 6, done: true };
        });

        const sharedClientId = 'resumable-session-integration';

        const oldClient = PerfectWS.client({ clientId: sharedClientId });
        expect(oldClient.router.config.clientId).toBe(sharedClientId);

        const ws1 = await connect();
        oldClient.setServer(ws1);
        await oldClient.router.serverOpen;

        const received: number[] = [];
        const oldResultPromise = oldClient.router.request('stream', {}, {
            callback: (data, _error, down) => {
                if (!down && data) received.push(data.i);
            },
            timeout: 3000,
        });

        while (received.length < 1) {
            await sleep(20);
        }

        // The old instance goes away without a clean unregister (simulating a page reload).
        (ws1 as any)._socket?.destroy?.() ?? ws1.terminate();
        await sleep(150);

        // A brand-new instance takes over the SAME clientId but has no memory of 'stream'.
        const newClient = PerfectWS.client({ clientId: sharedClientId });
        const ws2 = await connect();
        newClient.setServer(ws2);
        await newClient.router.serverOpen;

        await sleep(400);
        expect(handlerRanToCompletion).toBe(false);
        expect(received.length).toBeLessThan(6);

        // The (still in-process, for test purposes) old instance independently reconnects
        // and asks about its own request again; the server now correctly reports it as
        // unknown instead of continuing to stream stale data to whoever asks.
        const ws1b = await connect();
        oldClient.setServer(ws1b);

        await expect(oldResultPromise).rejects.toMatchObject({ code: 'unknownRequest' });

        newClient.unregister();
        oldClient.unregister();
    }, 15000);

    it('keeps two concurrent clients with independent streams isolated across a reconnect', async () => {
        const { router: server, attachClient } = PerfectWS.server();
        wss.on('connection', (ws) => attachClient(ws));

        const seenClientIds: string[] = [];
        server.on('stream', async (data: { tag: string }, { send, clientId }) => {
            seenClientIds.push(clientId);
            for (let i = 0; i < 4; i++) {
                await sleep(100);
                send({ tag: data.tag, i }, false);
            }
            return { tag: data.tag, done: true };
        });

        const clientA = PerfectWS.client();
        const clientB = PerfectWS.client();

        const wsA1 = await connect();
        clientA.setServer(wsA1);
        await clientA.router.serverOpen;

        const wsB1 = await connect();
        clientB.setServer(wsB1);
        await clientB.router.serverOpen;

        const receivedA: number[] = [];
        const receivedB: number[] = [];

        const resultA = clientA.router.request('stream', { tag: 'A' }, {
            callback: (data, _error, down) => { if (!down && data) receivedA.push(data.i); },
            timeout: 10000,
        });
        const resultB = clientB.router.request('stream', { tag: 'B' }, {
            callback: (data, _error, down) => { if (!down && data) receivedB.push(data.i); },
            timeout: 10000,
        });

        while (receivedA.length < 1 || receivedB.length < 1) {
            await sleep(20);
        }

        // Only client A drops and reconnects; client B's socket and stream must be
        // completely unaffected (no cross-talk between clientIds in ___syncRequests).
        (wsA1 as any)._socket?.destroy?.() ?? wsA1.terminate();
        await sleep(200);

        const wsA2 = await connect();
        clientA.setServer(wsA2);

        const [finalA, finalB] = await Promise.all([resultA, resultB]);

        expect(receivedA).toEqual([0, 1, 2, 3]);
        expect(receivedB).toEqual([0, 1, 2, 3]);
        expect(finalA).toEqual({ tag: 'A', done: true });
        expect(finalB).toEqual({ tag: 'B', done: true });

        // Two distinct, stable clientIds - one per handler invocation, matching the
        // requesting client each time.
        expect(new Set(seenClientIds).size).toBe(2);
        expect(seenClientIds).toContain(clientA.router.config.clientId);
        expect(seenClientIds).toContain(clientB.router.config.clientId);

        clientA.unregister();
        clientB.unregister();
    }, 15000);
});
