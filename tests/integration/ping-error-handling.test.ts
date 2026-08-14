import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { PerfectWS } from '../../src/index.js';

describe('ping failure handling', () => {
    let wss: WebSocketServer;
    const cleanups: (() => void)[] = [];

    beforeEach(async () => {
        wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await new Promise<void>((resolve, reject) => {
            wss.once('listening', resolve);
            wss.once('error', reject);
        });
    });

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>(resolve => wss.close(() => resolve()));
    });

    const url = () => {
        const address = wss.address();
        if (address === null || typeof address === 'string') throw new Error('Missing WebSocket address');
        return `ws://127.0.0.1:${address.port}`;
    };

    it('closes and reconnects a server-role socket that stops sending pings', async () => {
        let connections = 0;
        wss.on('connection', () => { connections++; });

        const result = PerfectWS.server();
        result.router.config.runPingLoop = true;
        result.router.config.pingIntervalMs = 5;
        result.router.config.pingReceiveTimeout = 20;
        result.router.config.delayBeforeReconnect = 5;
        result.router.config.connectionTimeout = 100;
        const stop = result.autoReconnect(url(), WebSocket as any);
        cleanups.push(stop, result.unregister);

        await vi.waitFor(() => expect(connections).toBeGreaterThanOrEqual(2), { timeout: 500 });
    });

    it('closes a client-role socket when its ping request receives no response', async () => {
        const ownerSocket = Promise.withResolvers<WebSocket>();
        wss.once('connection', socket => ownerSocket.resolve(socket));

        const result = PerfectWS.client();
        result.router.config.enableAckSystem = false;
        result.router.config.syncRequestsWhenServerOpen = false;
        result.router.config.runPingLoop = true;
        result.router.config.pingIntervalMs = 5;
        result.router.config.pingRequestTimeout = 20;
        const socket = new WebSocket(url());
        result.setServer(socket);
        cleanups.push(result.unregister);

        await result.router.serverOpen;
        const owner = await ownerSocket.promise;
        const waitForClose = (ws: WebSocket) => ws.readyState === WebSocket.CLOSED
            ? Promise.resolve()
            : new Promise<void>(resolve => ws.once('close', () => resolve()));
        await Promise.all([waitForClose(owner), waitForClose(socket)]);

        expect(socket.readyState).toBe(WebSocket.CLOSED);
    });
});
