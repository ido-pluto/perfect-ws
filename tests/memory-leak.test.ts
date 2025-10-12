import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';
import { WebSocketForce } from '../src/utils/WebSocketForce.js';
import { WebSocket, WebSocketServer } from 'ws';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.js';

describe('Memory Leak Tests', () => {
    let server: WebSocketServer;
    let port: number;

    beforeEach((ctx) => {
        port = 30000 + Number(ctx.task.id.split('').reduce((a, b) => a + b.charCodeAt(0), 0) % 10000);
        server = new WebSocketServer({ port });
    });

    afterEach(() => {
        server.close();
    });

    describe('WebSocketForce - Event Listener Leaks', () => {
        it('should remove close listeners when removeEventListener is called', async () => {
            const ws = new WebSocket(`ws://localhost:${port}`);
            const wsForce = new WebSocketForce(ws);

            await wsForce.once('open');

            const listener1 = vi.fn();
            const listener2 = vi.fn();
            const listener3 = vi.fn();

            wsForce.addEventListener('close', listener1);
            wsForce.addEventListener('close', listener2);
            wsForce.addEventListener('close', listener3);

            expect((wsForce as any)._closeListeners.size).toBe(3);
            expect((wsForce as any)._virtualCloseListeners.length).toBe(3);

            wsForce.removeEventListener('close', listener1);
            expect((wsForce as any)._closeListeners.size).toBe(2);
            expect((wsForce as any)._virtualCloseListeners.length).toBe(2);

            wsForce.removeEventListener('close', listener2);
            expect((wsForce as any)._closeListeners.size).toBe(1);
            expect((wsForce as any)._virtualCloseListeners.length).toBe(1);

            wsForce.removeEventListener('close', listener3);
            expect((wsForce as any)._closeListeners.size).toBe(0);
            expect((wsForce as any)._virtualCloseListeners.length).toBe(0);
        });

        it('should unregister native close handler when last virtual listener removed', async () => {
            const ws = new WebSocket(`ws://localhost:${port}`);
            const wsForce = new WebSocketForce(ws);

            await wsForce.once('open');

            const listener1 = vi.fn();
            const listener2 = vi.fn();

            wsForce.addEventListener('close', listener1);
            expect((wsForce as any)._nativeCloseHandler).not.toBeNull();

            wsForce.addEventListener('close', listener2);
            expect((wsForce as any)._nativeCloseHandler).not.toBeNull();

            wsForce.removeEventListener('close', listener1);
            expect((wsForce as any)._nativeCloseHandler).not.toBeNull();

            wsForce.removeEventListener('close', listener2);
            expect((wsForce as any)._nativeCloseHandler).toBeNull();
        });

        it('should handle once listeners without leaking', async () => {
            const ws = new WebSocket(`ws://localhost:${port}`);
            const wsForce = new WebSocketForce(ws);

            await wsForce.once('open');

            const listener1 = vi.fn();
            const listener2 = vi.fn();

            wsForce.addEventListener('close', listener1, { once: true });
            wsForce.addEventListener('close', listener2, { once: true });

            expect((wsForce as any)._closeListeners.size).toBe(2);
            expect((wsForce as any)._virtualCloseListeners.length).toBe(2);

            wsForce.close();
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(1);
            expect((wsForce as any)._closeListeners.size).toBe(0);
            expect((wsForce as any)._virtualCloseListeners.length).toBe(0);
        });

        it('should handle forceClose without leaking listeners', async () => {
            const ws = new WebSocket(`ws://localhost:${port}`);
            const wsForce = new WebSocketForce(ws);

            await wsForce.once('open');

            const listener1 = vi.fn();
            const listener2 = vi.fn();

            wsForce.addEventListener('close', listener1);
            wsForce.addEventListener('close', listener2);

            expect((wsForce as any)._closeListeners.size).toBe(2);

            wsForce.forceClose();

            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(1);
        });

        it('should not accumulate listeners on multiple once() calls', async () => {
            const ws = new WebSocket(`ws://localhost:${port}`);
            const wsForce = new WebSocketForce(ws);

            await wsForce.once('open');

            expect((wsForce as any)._virtualCloseListeners.length).toBe(0);

            wsForce.once('close');
            expect((wsForce as any)._virtualCloseListeners.length).toBe(1);

            wsForce.once('close');
            expect((wsForce as any)._virtualCloseListeners.length).toBe(2);

            wsForce.once('close');
            expect((wsForce as any)._virtualCloseListeners.length).toBe(3);

            wsForce.forceClose();

            await new Promise(resolve => setTimeout(resolve, 100));

            expect((wsForce as any)._virtualCloseListeners.length).toBe(0);
            expect((wsForce as any)._closeListeners.size).toBe(0);
        });

        it('should handle rapid add/remove without leaking', async () => {
            const ws = new WebSocket(`ws://localhost:${port}`);
            const wsForce = new WebSocketForce(ws);

            await wsForce.once('open');

            for (let i = 0; i < 100; i++) {
                const listener = vi.fn();
                wsForce.addEventListener('close', listener);
                wsForce.removeEventListener('close', listener);
            }

            expect((wsForce as any)._closeListeners.size).toBe(0);
            expect((wsForce as any)._virtualCloseListeners.length).toBe(0);
            expect((wsForce as any)._nativeCloseHandler).toBeNull();
        });
    });

    describe('PerfectWS Client - Event Listener Leaks', () => {
        it('should clean up listeners when unregister is called', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router, unregister } = PerfectWS.client();
            router.config.runPingLoop = false;

            const ws = new WebSocket(`ws://localhost:${port}`);
            router['_setServer'](ws);

            await router.serverOpen;

            const wsServer = router['_server'];
            const messageListenersBefore = (wsServer as any)._ws.listeners('message').length;

            unregister();

            const messageListenersAfter = (wsServer as any)._ws.listeners('message').length;
            expect(messageListenersAfter).toBeLessThan(messageListenersBefore);
        });

        it('should clean up abort listeners when request completes', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('test', () => 'response');

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const abortController = new AbortController();
            const response = await clientRouter.request('test', null, {
                abortSignal: abortController.signal
            });

            expect(response).toBe('response');
        });

        it('should clean up abort listeners when request is aborted', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const abortController = new AbortController();
            const requestPromise = clientRouter.request('test', null, {
                abortSignal: abortController.signal,
                timeout: 5000
            });

            abortController.abort('User cancelled');

            await expect(requestPromise).rejects.toThrow();
        });

        it('should clean up event listeners when request times out', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.requestTimeout = 100;
            clientRouter.config.runPingLoop = false;

            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const requestPromise = clientRouter.request('nonexistent', null, {
                timeout: 100
            });

            await expect(requestPromise).rejects.toThrow();
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(clientRouter['_activeRequests'].size).toBe(0);
        });

        it('should clean up waitForNewServer listeners', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            expect(clientRouter['_waitForNewServer'].size).toBe(0);

            const serverOpenPromise = clientRouter.serverOpen;

            expect(clientRouter['_waitForNewServer'].size).toBe(1);

            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await serverOpenPromise;

            expect(clientRouter['_waitForNewServer'].size).toBe(0);
        });

        it('should clean up retryOnClose listeners', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            let resolveHandler: any;
            serverRouter.on('test', () => new Promise(resolve => {
                resolveHandler = resolve;
            }));

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const requestPromise = clientRouter.request('test', null);

            await new Promise(resolve => setTimeout(resolve, 100));

            const activeRequest = Array.from(clientRouter['_activeRequests'].values())[0];
            const serverWs = activeRequest?.server;

            const closeListenersBefore = serverWs ? (serverWs as any)._virtualCloseListeners.length : 0;

            resolveHandler('done');
            await requestPromise;

            const closeListenersAfter = serverWs ? (serverWs as any)._virtualCloseListeners.length : 0;
            expect(closeListenersAfter).toBeLessThanOrEqual(closeListenersBefore);
        });

        it('should not accumulate listeners on multiple setServer calls', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            for (let i = 0; i < 5; i++) {
                const ws = new WebSocket(`ws://localhost:${port}`);
                clientRouter['_setServer'](ws);
                await clientRouter.serverOpen;

                const wsServer = clientRouter['_server'];
                const messageListeners = (wsServer as any)._ws.listeners('message').length;
                const openListeners = (wsServer as any)._ws.listeners('open').length;

                expect(messageListeners).toBeLessThanOrEqual(2);
                expect(openListeners).toBeLessThanOrEqual(2);

                await new Promise(resolve => setTimeout(resolve, 50));
            }
        });

        it('should clean up ping loop abort controller', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('___ping', () => 'pong');

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = true;

            const ws1 = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws1);
            await clientRouter.serverOpen;

            const abortController1 = clientRouter['_pingLoopAbortController'];
            expect(abortController1).toBeDefined();
            expect(abortController1?.signal.aborted).toBe(false);

            const ws2 = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws2);

            expect(abortController1?.signal.aborted).toBe(true);
        });

        it('should clean up NetworkEventListener on request completion', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('test', () => 'response');

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const events = new NetworkEventListener();
            const listener = vi.fn();
            events.on('custom', listener);

            await clientRouter.request('test', null, { events });

            events.emit('custom');
            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    describe('PerfectWS Server - Event Listener Leaks', () => {
        it('should clean up client listeners when unregister is called', async () => {
            const { router: serverRouter, attachClient, unregister } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            const ws = new WebSocket(`ws://localhost:${port}`);
            await new Promise<void>((resolve) => {
                ws.addEventListener('open', () => resolve());
            });

            const cleanup = attachClient(ws);

            const messageListenersBefore = (ws as any).listeners('message').length;
            expect(messageListenersBefore).toBeGreaterThan(0);

            cleanup();

            const messageListenersAfter = (ws as any).listeners('message').length;
            expect(messageListenersAfter).toBeLessThan(messageListenersBefore);
        });

        it('should clean up client close listeners in _onRequest', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            let resolveHandler: any;
            serverRouter.on('test', () => new Promise(resolve => {
                resolveHandler = resolve;
            }));

            let clientWs: any;
            server.on('connection', (ws) => {
                clientWs = ws;
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const requestPromise = clientRouter.request('test', null);
            await new Promise(resolve => setTimeout(resolve, 100));

            const closeListenersBefore = clientWs.listeners('close').length;

            resolveHandler('done');
            await requestPromise;

            await new Promise(resolve => setTimeout(resolve, 100));

            const closeListenersAfter = clientWs.listeners('close').length;
            expect(closeListenersAfter).toBeLessThanOrEqual(closeListenersBefore);
        });

        it('should clean up active responses when request finishes', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('test', () => 'response');

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            expect(serverRouter['_activeResponses'].size).toBe(0);

            await clientRouter.request('test', null);

            expect(serverRouter['_activeResponses'].size).toBe(0);
        });

        it('should clean up active responses when request is aborted', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('test', async (_, { abortSignal }) => {
                await new Promise((resolve, reject) => {
                    abortSignal.addEventListener('abort', () => reject(new Error('Aborted')));
                    setTimeout(resolve, 5000);
                });
                return 'response';
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const abortController = new AbortController();
            const requestPromise = clientRouter.request('test', null, {
                abortSignal: abortController.signal
            });

            await new Promise(resolve => setTimeout(resolve, 100));

            abortController.abort();

            await expect(requestPromise).rejects.toThrow();
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(serverRouter['_activeResponses'].size).toBe(0);
        });

        it('should not accumulate listeners on autoReconnect', async () => {
            const { router: serverRouter, autoReconnect } = PerfectWS.server();
            serverRouter.config.delayBeforeReconnect = 100;

            server.on('connection', (ws) => {
                serverRouter['attachClient'](ws);
            });

            const stopReconnect = autoReconnect(`ws://localhost:${port}`);

            await new Promise(resolve => setTimeout(resolve, 500));

            stopReconnect();
        });

        it('should clean up attachClient listeners on multiple connections', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            const cleanups: (() => void)[] = [];

            for (let i = 0; i < 5; i++) {
                const ws = new WebSocket(`ws://localhost:${port}`);
                await new Promise<void>((resolve) => {
                    ws.addEventListener('open', () => resolve());
                });

                const cleanup = attachClient(ws);
                cleanups.push(cleanup);
            }

            for (const cleanup of cleanups) {
                cleanup();
            }
        });

        it('should handle pending aborts without leaking', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('test', async () => {
                await new Promise(resolve => setTimeout(resolve, 200));
                return 'response';
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const abortController = new AbortController();
            const requestPromise = clientRouter.request('test', null, {
                abortSignal: abortController.signal
            });

            abortController.abort();

            await expect(requestPromise).rejects.toThrow();
            await new Promise(resolve => setTimeout(resolve, 300));

            expect(serverRouter['_pendingAborts'].size).toBe(0);
        });
    });

    describe('NetworkEventListener - Event Listener Leaks', () => {
        it('should clean up listeners when off is called', () => {
            const events = new NetworkEventListener();
            const listener1 = vi.fn();
            const listener2 = vi.fn();

            events.on('test', listener1);
            events.on('test', listener2);

            events.emit('test');
            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(1);

            events.off('test', listener1);

            events.emit('test');
            expect(listener1).toHaveBeenCalledTimes(1);
            expect(listener2).toHaveBeenCalledTimes(2);
        });

        it('should clean up onAny listeners', () => {
            const events = new NetworkEventListener();
            const listener1 = vi.fn();
            const listener2 = vi.fn();

            events.onAny(listener1);
            events.onAny(listener2);

            events.emit('test1');
            events.emit('test2');

            expect(listener1).toHaveBeenCalledTimes(2);
            expect(listener2).toHaveBeenCalledTimes(2);

            events.offAny(listener1);

            events.emit('test3');

            expect(listener1).toHaveBeenCalledTimes(2);
            expect(listener2).toHaveBeenCalledTimes(3);
        });
    });

    describe('Edge Cases - Complex Scenarios', () => {
        it('should handle rapid connect/disconnect without leaking', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('test', () => 'response');

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            for (let i = 0; i < 10; i++) {
                const ws = new WebSocket(`ws://localhost:${port}`);
                clientRouter['_setServer'](ws);
                await clientRouter.serverOpen;

                try {
                    await clientRouter.request('test', null, { timeout: 1000 });
                } catch { }

                ws.close();
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(clientRouter['_waitForNewServer'].size).toBe(0);
        });

        it('should handle multiple simultaneous requests without leaking', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;
            serverRouter.on('test', async (data) => {
                await new Promise(resolve => setTimeout(resolve, 50));
                return `response-${data}`;
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const requests = [];
            for (let i = 0; i < 20; i++) {
                requests.push(clientRouter.request('test', i));
            }

            await Promise.all(requests);

            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);
        });
    });

    describe('Complex Stress Tests', () => {
        it('should handle rapid bidirectional requests for 30 seconds without memory leaks', { timeout: 35000 }, async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            serverRouter.on('echo', (data) => `server-echo-${data}`);
            serverRouter.on('compute', async (num: number) => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return num * 2;
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: client1Router } = PerfectWS.client();
            client1Router.config.runPingLoop = false;
            const ws1 = new WebSocket(`ws://localhost:${port}`);
            client1Router['_setServer'](ws1);

            const { router: client2Router } = PerfectWS.client();
            client2Router.config.runPingLoop = false;
            const ws2 = new WebSocket(`ws://localhost:${port}`);
            client2Router['_setServer'](ws2);

            await Promise.all([client1Router.serverOpen, client2Router.serverOpen]);

            const startTime = Date.now();
            const duration = 30000;

            let client1Sent = 0;
            let client1Received = 0;
            let client2Sent = 0;
            let client2Received = 0;

            const errors: Error[] = [];

            const client1Worker = async () => {
                while (Date.now() - startTime < duration) {
                    try {
                        const response = await client1Router.request('echo', `msg-${client1Sent}`);
                        expect(response).toBe(`server-echo-msg-${client1Sent}`);
                        client1Sent++;
                        client1Received++;
                    } catch (error) {
                        errors.push(error as Error);
                    }
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
                }
            };

            const client2Worker = async () => {
                while (Date.now() - startTime < duration) {
                    try {
                        const response = await client2Router.request('compute', client2Sent);
                        expect(response).toBe(client2Sent * 2);
                        client2Sent++;
                        client2Received++;
                    } catch (error) {
                        errors.push(error as Error);
                    }
                    await new Promise(resolve => setTimeout(resolve, Math.random() * 30));
                }
            };

            await Promise.all([client1Worker(), client2Worker()]);

            expect(errors.length).toBe(0);
            expect(client1Sent).toBeGreaterThan(0);
            expect(client1Received).toBe(client1Sent);
            expect(client2Sent).toBeGreaterThan(0);
            expect(client2Received).toBe(client2Sent);

            expect(client1Router['_activeRequests'].size).toBe(0);
            expect(client2Router['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);

            const client1MessageListeners = (client1Router['_server'] as any)._virtualCloseListeners.length;
            const client2MessageListeners = (client2Router['_server'] as any)._virtualCloseListeners.length;

            expect(client1MessageListeners).toBeLessThanOrEqual(5);
            expect(client2MessageListeners).toBeLessThanOrEqual(5);
        });

        it('should keep connection open for extended period without unhandled rejections', { timeout: 35000 }, async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            serverRouter.on('ping', () => 'pong');

            const unhandledRejections: any[] = [];
            const rejectionHandler = (reason: any) => {
                unhandledRejections.push(reason);
            };
            process.on('unhandledRejection', rejectionHandler);

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: client1Router } = PerfectWS.client();
            client1Router.config.runPingLoop = false;
            const ws1 = new WebSocket(`ws://localhost:${port}`);
            client1Router['_setServer'](ws1);

            const { router: client2Router } = PerfectWS.client();
            client2Router.config.runPingLoop = false;
            const ws2 = new WebSocket(`ws://localhost:${port}`);
            client2Router['_setServer'](ws2);

            const { router: client3Router } = PerfectWS.client();
            client3Router.config.runPingLoop = false;
            const ws3 = new WebSocket(`ws://localhost:${port}`);
            client3Router['_setServer'](ws3);

            await Promise.all([
                client1Router.serverOpen,
                client2Router.serverOpen,
                client3Router.serverOpen
            ]);

            let pingsSent = 0;
            const pingInterval = setInterval(async () => {
                try {
                    const results = await Promise.all([
                        client1Router.request('ping', null),
                        client2Router.request('ping', null),
                        client3Router.request('ping', null)
                    ]);
                    results.forEach(result => expect(result).toBe('pong'));
                    pingsSent++;
                } catch (error) {
                    unhandledRejections.push(error);
                }
            }, 1000);

            await new Promise(resolve => setTimeout(resolve, 30000));

            clearInterval(pingInterval);
            process.off('unhandledRejection', rejectionHandler);

            expect(unhandledRejections.length).toBe(0);
            expect(pingsSent).toBeGreaterThan(25);

            expect(client1Router['_activeRequests'].size).toBe(0);
            expect(client2Router['_activeRequests'].size).toBe(0);
            expect(client3Router['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);

            expect(client1Router['_waitForNewServer'].size).toBe(0);
            expect(client2Router['_waitForNewServer'].size).toBe(0);
            expect(client3Router['_waitForNewServer'].size).toBe(0);
        });

        it('should handle burst traffic without listener accumulation', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            serverRouter.on('burst', (data) => data);

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;
            const ws = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws);

            await clientRouter.serverOpen;

            const burstSizes = [10, 50, 100, 200, 100, 50, 10];

            for (const burstSize of burstSizes) {
                const requests = [];
                for (let i = 0; i < burstSize; i++) {
                    requests.push(clientRouter.request('burst', i));
                }
                await Promise.all(requests);

                expect(clientRouter['_activeRequests'].size).toBe(0);
                expect(serverRouter['_activeResponses'].size).toBe(0);

                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const finalMessageListeners = (clientRouter['_server'] as any)._ws.listeners('message').length;
            expect(finalMessageListeners).toBeLessThanOrEqual(2);
        });

        it('should recover from connection drops without leaking', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            serverRouter.on('test', (data) => `echo-${data}`);

            let currentClientWs: any;
            server.on('connection', (ws) => {
                currentClientWs = ws;
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            for (let cycle = 0; cycle < 5; cycle++) {
                const ws = new WebSocket(`ws://localhost:${port}`);
                clientRouter['_setServer'](ws);
                await clientRouter.serverOpen;

                for (let i = 0; i < 10; i++) {
                    const response = await clientRouter.request('test', `${cycle}-${i}`);
                    expect(response).toBe(`echo-${cycle}-${i}`);
                }

                currentClientWs?.close();
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);
            expect(clientRouter['_waitForNewServer'].size).toBe(0);
        });
    });

    describe('Rapid Reconnection with Request Continuity', () => {
        it('should handle requests that complete before disconnection', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            let requestCount = 0;
            serverRouter.on('fast', (data) => {
                requestCount++;
                return `processed-${data}`;
            });

            let currentClientWs: any;
            server.on('connection', (ws) => {
                currentClientWs = ws;
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            for (let cycle = 0; cycle < 5; cycle++) {
                const ws = new WebSocket(`ws://localhost:${port}`);
                clientRouter['_setServer'](ws);
                await clientRouter.serverOpen;

                const result = await clientRouter.request('fast', cycle);
                expect(result).toBe(`processed-${cycle}`);

                currentClientWs?.close();
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            expect(requestCount).toBe(5);
            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);
        });

        it('should handle request timeouts and cleanup properly', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            serverRouter.on('quickTask', () => 'completed');

            let currentClientWs: any;
            server.on('connection', (ws) => {
                currentClientWs = ws;
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            const ws1 = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws1);
            await clientRouter.serverOpen;

            const result = await clientRouter.request('quickTask', null);
            expect(result).toBe('completed');

            currentClientWs?.close();
            await new Promise(resolve => setTimeout(resolve, 300));

            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);
        });

        it('should handle requests across sequential reconnections', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            let requestNumber = 0;
            serverRouter.on('process', (data) => {
                requestNumber++;
                return { number: requestNumber, data };
            });

            let currentClientWs: any;
            server.on('connection', (ws) => {
                currentClientWs = ws;
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            const ws1 = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws1);
            await clientRouter.serverOpen;

            const result1 = await clientRouter.request('process', 'first');
            expect(result1.number).toBe(1);

            currentClientWs?.close();
            await new Promise(resolve => setTimeout(resolve, 100));

            const ws2 = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws2);
            await clientRouter.serverOpen;

            const result2 = await clientRouter.request('process', 'second');
            expect(result2.number).toBe(2);

            currentClientWs?.close();
            await new Promise(resolve => setTimeout(resolve, 100));

            const ws3 = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws3);
            await clientRouter.serverOpen;

            const result3 = await clientRouter.request('process', 'third');
            expect(result3.number).toBe(3);

            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);
        });

        it('should not leak listeners during rapid reconnection cycles', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            serverRouter.on('echo', (data) => data);

            let currentClientWs: any;
            server.on('connection', (ws) => {
                currentClientWs = ws;
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            const ws1 = new WebSocket(`ws://localhost:${port}`);
            clientRouter['_setServer'](ws1);
            await clientRouter.serverOpen;

            for (let cycle = 0; cycle < 10; cycle++) {
                const response = await clientRouter.request('echo', `msg-${cycle}`);
                expect(response).toBe(`msg-${cycle}`);

                if (cycle < 9) {
                    currentClientWs?.close();
                    await new Promise(resolve => setTimeout(resolve, 50));

                    const newWs = new WebSocket(`ws://localhost:${port}`);
                    clientRouter['_setServer'](newWs);
                    await clientRouter.serverOpen;
                }
            }

            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);
            expect(clientRouter['_waitForNewServer'].size).toBe(0);

            const wsServer = clientRouter['_server'];
            const messageListeners = (wsServer as any)._ws.listeners('message').length;
            const closeListeners = (wsServer as any)._virtualCloseListeners.length;

            expect(messageListeners).toBeLessThanOrEqual(2);
            expect(closeListeners).toBeLessThanOrEqual(5);
        });


        it('should handle multiple reconnections with memory cleanup verification', async () => {
            const { router: serverRouter, attachClient } = PerfectWS.server();
            serverRouter.config.runPingLoop = false;

            let requestCount = 0;
            serverRouter.on('ping', () => {
                requestCount++;
                return 'pong';
            });

            let currentClientWs: any;
            server.on('connection', (ws) => {
                currentClientWs = ws;
                attachClient(ws);
            });

            const { router: clientRouter } = PerfectWS.client();
            clientRouter.config.runPingLoop = false;

            for (let cycle = 0; cycle < 10; cycle++) {
                const ws = new WebSocket(`ws://localhost:${port}`);
                clientRouter['_setServer'](ws);
                await clientRouter.serverOpen;

                const response = await clientRouter.request('ping', null);
                expect(response).toBe('pong');

                if (cycle < 9) {
                    currentClientWs?.close();
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }

            expect(requestCount).toBe(10);
            expect(clientRouter['_activeRequests'].size).toBe(0);
            expect(serverRouter['_activeResponses'].size).toBe(0);
            expect(clientRouter['_waitForNewServer'].size).toBe(0);

            const wsServer = clientRouter['_server'];
            const messageListeners = (wsServer as any)._ws.listeners('message').length;
            expect(messageListeners).toBeLessThanOrEqual(2);
        });
    });
});

