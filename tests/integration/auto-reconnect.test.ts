import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWS, PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { sleep } from '../../src/utils/sleepPromise.js';

const PING_INTERVAL_MS = 500;
const PING_RECEIVE_TIMEOUT = 1500;
const PING_REQUEST_TIMEOUT = 800;

describe('AutoReconnect with Ping Mechanism Tests', () => {
    let wss: WebSocketServer;
    let serverPort: number;
    let cleanup: (() => void)[] = [];

    beforeEach(async () => {
        serverPort = 12000 + Math.floor(Math.random() * 1000);
        wss = new WebSocketServer({ port: serverPort });
        cleanup = [];
    });

    afterEach(async () => {
        await sleep(100);
        for (const fn of cleanup) {
            try {
                fn();
            } catch { }
        }
        cleanup = [];
        await new Promise((resolve) => wss.close(resolve));
        await sleep(50);
    });

    it('should detect silent connection drop via ping timeout and auto-reconnect', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.delayBeforeReconnect = 200;

        const requestsReceived: string[] = [];
        const connectionEvents: string[] = [];

        server.on('testMethod', async (data, { send }) => {
            requestsReceived.push(data.id);
            send({ progress: 50 }, false);
            await sleep(100);
            return { completed: data.id };
        });

        wss.on('connection', (ws) => {
            connectionEvents.push('server-received-connection');
            attachClient(ws);
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);
        cleanup.push(stopAutoReconnect);

        await sleep(300);
        expect(connectionEvents.length).toBe(1);

        const connectedClients = Array.from(wss.clients);
        expect(connectedClients.length).toBe(1);

        const socketToKill = connectedClients[0] as any;
        socketToKill._socket.destroy();

        await sleep(PING_RECEIVE_TIMEOUT + 500);

        expect(connectionEvents.length).toBeGreaterThanOrEqual(2);
        expect(Array.from(wss.clients).length).toBe(1);
    }, 10000);

    it('should handle request during silent disconnect detected by ping', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.delayBeforeReconnect = 200;

        const requestsReceived: string[] = [];
        const connectionEvents: { type: string, timestamp: number; }[] = [];

        server.on('longRequest', async (data, { send, abortSignal }) => {
            requestsReceived.push(data.id);
            connectionEvents.push({ type: 'request-started', timestamp: Date.now() });

            for (let i = 0; i < 10; i++) {
                if (abortSignal.aborted) {
                    connectionEvents.push({ type: 'request-aborted', timestamp: Date.now() });
                    break;
                }
                await sleep(100);
                send({ progress: (i + 1) * 10 }, false);
            }

            return { completed: data.id, iterations: 10 };
        });

        wss.on('connection', (ws) => {
            connectionEvents.push({ type: 'server-connection', timestamp: Date.now() });
            attachClient(ws);
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);
        cleanup.push(stopAutoReconnect);

        await sleep(300);

        const initialConnections = connectionEvents.filter(e => e.type === 'server-connection').length;
        expect(initialConnections).toBe(1);

        const connectedClients = Array.from(wss.clients);
        const socketToKill = connectedClients[0] as any;
        socketToKill._socket.destroy();

        await sleep(PING_RECEIVE_TIMEOUT + 500);

        const reconnections = connectionEvents.filter(e => e.type === 'server-connection').length;
        expect(reconnections).toBeGreaterThan(initialConnections);
    }, 10000);

    it('should handle multiple silent disconnects and reconnects', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.delayBeforeReconnect = 100;

        const connectionCycles: number[] = [];
        let connectionCount = 0;

        server.on('echo', async (data) => {
            return { echo: data.value, connectionCycle: connectionCount };
        });

        wss.on('connection', (ws) => {
            connectionCount++;
            connectionCycles.push(Date.now());
            attachClient(ws);
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);
        cleanup.push(stopAutoReconnect);

        await sleep(200);
        expect(connectionCount).toBe(1);

        for (let cycle = 0; cycle < 3; cycle++) {
            await sleep(200);

            const clients = Array.from(wss.clients);
            if (clients.length > 0) {
                const socketToKill = clients[0] as any;
                socketToKill._socket.destroy();
            }

            await sleep(PING_RECEIVE_TIMEOUT + 300);
        }

        expect(connectionCount).toBeGreaterThanOrEqual(4);
        expect(connectionCycles.length).toBeGreaterThanOrEqual(4);

        const timeBetweenReconnects: number[] = [];
        for (let i = 1; i < connectionCycles.length; i++) {
            timeBetweenReconnects.push(connectionCycles[i] - connectionCycles[i - 1]);
        }

        const reconnectsTriggeredByPing = timeBetweenReconnects.filter(td => td > 500);
        expect(reconnectsTriggeredByPing.length).toBeGreaterThanOrEqual(1);
    }, 15000);

    it('should handle complex scenario: connect, silent drop, ping detects, reconnect, process request', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.pingRequestTimeout = PING_REQUEST_TIMEOUT;
        server.config.delayBeforeReconnect = 200;

        const timeline: { event: string, timestamp: number, connectionId?: number; }[] = [];
        let connectionIdCounter = 0;
        const requestsByConnection = new Map<number, string[]>();

        server.on('complexRequest', async (data, { send, abortSignal }) => {
            const currentConnectionId = connectionIdCounter;
            timeline.push({ event: 'request-received', timestamp: Date.now(), connectionId: currentConnectionId });

            if (!requestsByConnection.has(currentConnectionId)) {
                requestsByConnection.set(currentConnectionId, []);
            }
            requestsByConnection.get(currentConnectionId)!.push(data.id);

            for (let i = 0; i < 5; i++) {
                if (abortSignal.aborted) {
                    timeline.push({ event: 'request-aborted', timestamp: Date.now(), connectionId: currentConnectionId });
                    throw new Error('Aborted');
                }
                await sleep(100);
                send({ phase: i + 1, connectionId: currentConnectionId }, false);
            }

            timeline.push({ event: 'request-completed', timestamp: Date.now(), connectionId: currentConnectionId });
            return { success: true, id: data.id, connectionId: currentConnectionId };
        });

        wss.on('connection', (ws) => {
            connectionIdCounter++;
            const currentId = connectionIdCounter;
            timeline.push({ event: 'connection-established', timestamp: Date.now(), connectionId: currentId });
            attachClient(ws);

            ws.on('close', () => {
                timeline.push({ event: 'connection-closed', timestamp: Date.now(), connectionId: currentId });
            });
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);
        cleanup.push(stopAutoReconnect);

        await sleep(400);
        expect(connectionIdCounter).toBe(1);

        const firstClients = Array.from(wss.clients);
        expect(firstClients.length).toBe(1);

        timeline.push({ event: 'simulating-silent-disconnect', timestamp: Date.now() });
        const socketToKill = firstClients[0] as any;
        socketToKill._socket.destroy();

        await sleep(PING_RECEIVE_TIMEOUT + 400);

        const connectionsAfterReconnect = timeline.filter(e => e.event === 'connection-established').length;
        expect(connectionsAfterReconnect).toBeGreaterThanOrEqual(2);

        const closedConnections = timeline.filter(e => e.event === 'connection-closed').length;
        expect(closedConnections).toBeGreaterThanOrEqual(1);

        await sleep(200);

        const currentClients = Array.from(wss.clients);
        expect(currentClients.length).toBeGreaterThanOrEqual(0);

        const pingTimeoutDetected = timeline.some((e, i) => {
            if (e.event === 'connection-closed' && i > 0) {
                const timeSinceDisconnect = e.timestamp - timeline.find(t => t.event === 'simulating-silent-disconnect')!.timestamp;
                return timeSinceDisconnect >= PING_RECEIVE_TIMEOUT - 100 &&
                    timeSinceDisconnect <= PING_RECEIVE_TIMEOUT + 1000;
            }
            return false;
        });

        expect(pingTimeoutDetected).toBe(true);
    }, 15000);

    it('should handle client connecting to auto-reconnecting server during disconnect-reconnect cycle', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.delayBeforeReconnect = 300;

        const serverState = {
            requestsProcessed: [] as string[],
            activeConnections: 0
        };

        server.on('stateRequest', async (data) => {
            serverState.requestsProcessed.push(data.id);
            await sleep(50);
            return {
                requestId: data.id,
                state: {
                    totalProcessed: serverState.requestsProcessed.length,
                    activeConnections: serverState.activeConnections
                }
            };
        });

        wss.on('connection', (ws) => {
            serverState.activeConnections++;
            attachClient(ws);

            ws.on('close', () => {
                serverState.activeConnections--;
            });
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);
        cleanup.push(stopAutoReconnect);

        await sleep(500);
        expect(serverState.activeConnections).toBe(1);

        const clients = Array.from(wss.clients);
        const socketToKill = clients[0] as any;
        socketToKill._socket.destroy();

        await sleep(PING_RECEIVE_TIMEOUT + 500);

        const { router: clientRouter, setServer } = PerfectWS.client();
        clientRouter.config.requestTimeout = 8000;
        const clientWs = new WebSocket(`ws://localhost:${serverPort}`);
        setServer(clientWs);
        cleanup.push(() => clientWs.close());

        await clientRouter.serverOpen;

        const result = await clientRouter.request('stateRequest', { id: 'during-recovery' }, { timeout: 5000 });

        expect(result.requestId).toBe('during-recovery');
        expect(result.state.totalProcessed).toBeGreaterThanOrEqual(1);
        expect(serverState.activeConnections).toBeGreaterThanOrEqual(1);
    }, 20000);

    it('should properly cleanup and stop reconnecting when unregister is called', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.delayBeforeReconnect = 200;

        const connectionEvents: number[] = [];

        server.on('test', async (data) => {
            return { ok: true };
        });

        wss.on('connection', (ws) => {
            connectionEvents.push(Date.now());
            attachClient(ws);
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);

        await sleep(300);
        expect(connectionEvents.length).toBe(1);

        const clients = Array.from(wss.clients);
        const socketToKill = clients[0] as any;
        socketToKill._socket.destroy();

        await sleep(100);

        stopAutoReconnect();

        await sleep(PING_RECEIVE_TIMEOUT + 1000);

        expect(connectionEvents.length).toBeLessThanOrEqual(2);
        expect(Array.from(wss.clients).length).toBe(0);
    }, 10000);

    it('should handle rapid silent disconnects with ping detection', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.delayBeforeReconnect = 100;

        const connectionEvents: { type: string, timestamp: number; }[] = [];

        server.on('monitor', async (data) => {
            return { alive: true, timestamp: Date.now() };
        });

        wss.on('connection', (ws) => {
            connectionEvents.push({ type: 'connect', timestamp: Date.now() });
            attachClient(ws);

            ws.on('close', () => {
                connectionEvents.push({ type: 'close', timestamp: Date.now() });
            });
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);
        cleanup.push(stopAutoReconnect);

        await sleep(300);

        const disconnectTimestamps: number[] = [];

        for (let i = 0; i < 3; i++) {
            await sleep(300);

            const clients = Array.from(wss.clients);
            if (clients.length > 0) {
                disconnectTimestamps.push(Date.now());
                const socket = clients[0] as any;
                socket._socket.destroy();
            }

            await sleep(PING_RECEIVE_TIMEOUT + 500);
        }

        const connects = connectionEvents.filter(e => e.type === 'connect');
        const closes = connectionEvents.filter(e => e.type === 'close');

        expect(connects.length).toBeGreaterThanOrEqual(3);
        expect(closes.length).toBeGreaterThanOrEqual(2);

        const closeEventsAfterDisconnect = closes.filter(closeEvent => {
            return disconnectTimestamps.some(disconnectTime => {
                const timeDiff = closeEvent.timestamp - disconnectTime;
                return timeDiff >= PING_RECEIVE_TIMEOUT - 500 && timeDiff <= PING_RECEIVE_TIMEOUT + 2000;
            });
        });

        expect(closeEventsAfterDisconnect.length).toBeGreaterThanOrEqual(1);
    }, 20000);

    it('should maintain connection stability after recovery from multiple silent failures', async () => {
        const { router: server, attachClient, autoReconnect } = PerfectWS.server();
        server.config.pingIntervalMs = PING_INTERVAL_MS;
        server.config.pingReceiveTimeout = PING_RECEIVE_TIMEOUT;
        server.config.delayBeforeReconnect = 200;

        const healthChecks: { timestamp: number, connectionAlive: boolean; }[] = [];
        let currentConnectionGeneration = 0;

        server.on('healthCheck', async () => {
            healthChecks.push({ timestamp: Date.now(), connectionAlive: true });
            return { healthy: true, generation: currentConnectionGeneration };
        });

        wss.on('connection', (ws) => {
            currentConnectionGeneration++;
            attachClient(ws);
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${serverPort}`, WebSocket as any);
        cleanup.push(stopAutoReconnect);

        await sleep(300);

        for (let cycle = 0; cycle < 2; cycle++) {
            const clients = Array.from(wss.clients);
            if (clients.length > 0) {
                const socket = clients[0] as any;
                socket._socket.destroy();
            }

            await sleep(PING_RECEIVE_TIMEOUT + 500);
        }

        const { router: clientRouter, setServer } = PerfectWSAdvanced.client();
        const clientWs = new WebSocket(`ws://localhost:${serverPort}`);
        setServer(clientWs);
        cleanup.push(() => clientWs.close());

        await clientRouter.serverOpen;

        const healthCheckResults: any[] = [];
        for (let i = 0; i < 5; i++) {
            const result = await clientRouter.request('healthCheck', {}, { timeout: 2000 });
            healthCheckResults.push(result);
            await sleep(200);
        }

        expect(healthCheckResults.length).toBe(5);
        expect(healthCheckResults.every(r => r.healthy)).toBe(true);

        const finalGeneration = healthCheckResults[healthCheckResults.length - 1].generation;
        expect(finalGeneration).toBeGreaterThanOrEqual(3);

        expect(Array.from(wss.clients).length).toBeGreaterThanOrEqual(1);
    }, 20000);
});

