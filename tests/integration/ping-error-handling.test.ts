import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerfectWS } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

const getAvailablePort = () => 8095 + Math.floor(Math.random() * 1000);

describe('Ping Error Handling - No Unhandled Rejections', () => {
    let server: WebSocketServer;
    let rejectionHandler: any;
    let unhandledRejections: any[] = [];
    let PORT: number;

    beforeEach(() => {
        PORT = getAvailablePort();
        unhandledRejections = [];
        rejectionHandler = (reason: any) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', rejectionHandler);
    });

    afterEach(async () => {
        process.removeListener('unhandledRejection', rejectionHandler);
        if (server) {
            server.clients.forEach((client) => {
                client.close();
            });
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        }
    });

    it('should not cause unhandled rejection when ping fails', async () => {
        server = new WebSocketServer({ port: PORT });

        const { router, autoReconnect } = PerfectWS.server();
        router.config.connectionTimeout = 500;
        router.config.pingRequestTimeout = 100;
        router.config.pingIntervalMs = 50;
        router.config.verbose = false;

        const stopAutoReconnect = autoReconnect(`ws://localhost:${PORT}`, WebSocket as any);

        await new Promise<void>((resolve) => {
            server.on('connection', (ws) => {
                resolve();
            });
        });

        await new Promise(resolve => setTimeout(resolve, 200));

        expect(unhandledRejections).toHaveLength(0);

        stopAutoReconnect();
    });

    it('should not cause unhandled rejection when connection opens and ping immediately fails', async () => {
        server = new WebSocketServer({ port: PORT });

        const { router, autoReconnect } = PerfectWS.server();
        router.config.connectionTimeout = 500;
        router.config.pingRequestTimeout = 50;
        router.config.pingIntervalMs = 200;
        router.config.verbose = false;

        server.on('connection', (ws) => {
            ws.close();
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${PORT}`, WebSocket as any);

        await new Promise(resolve => setTimeout(resolve, 300));

        expect(unhandledRejections).toHaveLength(0);

        stopAutoReconnect();
    });

    it('should not cause unhandled rejection when ping times out', async () => {
        server = new WebSocketServer({ port: PORT });

        const { router, autoReconnect } = PerfectWS.server();
        router.config.connectionTimeout = 500;
        router.config.pingRequestTimeout = 100;
        router.config.pingIntervalMs = 50;
        router.config.verbose = false;

        server.on('connection', (ws) => {
            ws.on('message', () => {
                // Ignore ping requests - let them timeout
            });
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${PORT}`, WebSocket as any);

        await new Promise(resolve => setTimeout(resolve, 500));

        expect(unhandledRejections).toHaveLength(0);

        stopAutoReconnect();
    });

    it('should not cause unhandled rejection when syncRequests is enabled and ping fails', async () => {
        server = new WebSocketServer({ port: PORT });

        const { router, autoReconnect } = PerfectWS.server();
        router.config.connectionTimeout = 500;
        router.config.pingRequestTimeout = 100;
        router.config.pingIntervalMs = 50;
        router.config.syncRequestsWhenServerOpen = true;
        router.config.verbose = false;

        server.on('connection', (ws) => {
            ws.on('message', (data) => {
                const parsed = JSON.parse(data.toString());
                if (parsed.method === '___syncRequests') {
                    ws.send(JSON.stringify({
                        requestId: parsed.requestId,
                        data: null
                    }));
                }
            });
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${PORT}`, WebSocket as any);

        await new Promise(resolve => setTimeout(resolve, 400));

        expect(unhandledRejections).toHaveLength(0);

        stopAutoReconnect();
    });

    it('should handle multiple rapid connection failures without unhandled rejections', async () => {
        server = new WebSocketServer({ port: PORT });

        const { router, autoReconnect } = PerfectWS.server();
        router.config.connectionTimeout = 200;
        router.config.pingRequestTimeout = 50;
        router.config.pingIntervalMs = 100;
        router.config.delayBeforeReconnect = 100;
        router.config.verbose = false;

        let connectionCount = 0;
        server.on('connection', (ws) => {
            connectionCount++;
            if (connectionCount <= 3) {
                ws.close();
            }
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${PORT}`, WebSocket as any);

        await new Promise(resolve => setTimeout(resolve, 800));

        expect(unhandledRejections).toHaveLength(0);
        expect(connectionCount).toBeGreaterThan(2);

        stopAutoReconnect();
    });

    it('should not cause unhandled rejection with verbose logging enabled', async () => {
        server = new WebSocketServer({ port: PORT });

        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

        const { router, autoReconnect } = PerfectWS.server();
        router.config.connectionTimeout = 500;
        router.config.pingRequestTimeout = 100;
        router.config.pingIntervalMs = 50;
        router.config.verbose = true;

        server.on('connection', (ws) => {
            ws.close();
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${PORT}`, WebSocket as any);

        await new Promise(resolve => setTimeout(resolve, 300));

        expect(unhandledRejections).toHaveLength(0);

        stopAutoReconnect();
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
    });

    it('should not cause unhandled rejection when server closes during ping loop', async () => {
        server = new WebSocketServer({ port: PORT });

        const { router, autoReconnect } = PerfectWS.server();
        router.config.connectionTimeout = 500;
        router.config.pingRequestTimeout = 100;
        router.config.pingIntervalMs = 50;
        router.config.verbose = false;

        let ws: WebSocket | undefined;
        server.on('connection', (socket) => {
            ws = socket;
            ws.on('message', (data) => {
                const parsed = JSON.parse(data.toString());
                if (parsed.method === '___ping') {
                    ws!.send(JSON.stringify({
                        requestId: parsed.requestId,
                        data: null
                    }));
                }
            });
        });

        const stopAutoReconnect = autoReconnect(`ws://localhost:${PORT}`, WebSocket as any);

        await new Promise(resolve => setTimeout(resolve, 150));

        if (ws) {
            ws.close();
        }

        await new Promise(resolve => setTimeout(resolve, 200));

        expect(unhandledRejections).toHaveLength(0);

        stopAutoReconnect();
    });

    it('should handle onOpen error when already connected', async () => {
        server = new WebSocketServer({ port: PORT });

        const { router, attachClient } = PerfectWS.server();
        router.config.connectionTimeout = 500;
        router.config.pingRequestTimeout = 100;
        router.config.pingIntervalMs = 50;
        router.config.verbose = false;

        server.on('connection', (ws) => {
            ws.on('message', (data) => {
                const parsed = JSON.parse(data.toString());
                if (parsed.method === '___ping') {
                    ws.send(JSON.stringify({
                        requestId: parsed.requestId,
                        data: null
                    }));
                }
            });
        });

        const ws = new WebSocket(`ws://localhost:${PORT}`);

        await new Promise<void>((resolve) => {
            ws.on('open', () => resolve());
        });

        const unregister = attachClient(ws as any);

        await new Promise(resolve => setTimeout(resolve, 200));

        expect(unhandledRejections).toHaveLength(0);

        unregister();
    });
});

