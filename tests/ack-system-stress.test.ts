import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';
import { sleep } from '../src/utils/sleepPromise.js';
import { spawn } from 'child_process';
import * as os from 'os';
import { WebSocketForce } from '../src/index.js';

const originalWebSocketSend = WebSocket.prototype.send;

describe('ACK System Stress & Complex Tests', () => {
    let port: number;
    let server: WebSocketServer;
    let serverRouter: any;
    let attachClient: any;

    beforeEach(async () => {
        server = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('Missing WebSocket address');
        port = address.port;
        const result = PerfectWS.server();
        serverRouter = result.router;
        attachClient = result.attachClient;

        serverRouter.config.enableAckSystem = true;
        serverRouter.config.verbose = false;
    });

    afterEach(async () => {
        WebSocket.prototype.send = originalWebSocketSend;
        for (const client of server.clients) client.terminate();
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    describe('Client Termination Scenarios', () => {
        it('should handle client termination during ACK wait', async () => {
            let requestReceived = false;
            let requestCompleted = false;

            serverRouter.on('long-process', async (data: any) => {
                requestReceived = true;
                await sleep(200);
                requestCompleted = true;
                return { completed: true };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.runPingLoop = true;
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 100;
            clientRouter.config.ackRetryDelays = [50, 100];
            clientRouter.config.requestTimeout = 1000;
            clientRouter.config.reconnectTimeout = 1000;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            // Start request but terminate client before completion
            const requestPromise = clientRouter.request('long-process', {});

            // Wait for request to be sent
            await sleep(50);
            expect(requestReceived).toBe(true);

            // Forcefully close the client
            ws.terminate();

            // Request should fail
            await expect(requestPromise).rejects.toThrow();

            // Wait to see if server completes
            await sleep(200);
            expect(requestCompleted).toBe(true);
        });

        it('should handle server termination during client retry', async () => {
            let ws: WebSocketForce;
            serverRouter.on('terminate-test', async () => {
                ws.forceClose();
                await sleep(100);
                return { never: 'sent' };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 100;
            clientRouter.config.reconnectTimeout = 1000;
            clientRouter.config.ackRetryDelays = [100, 100];

            ws = new WebSocketForce(new WebSocket(`ws://localhost:${port}`));
            setServer(ws);
            await clientRouter.serverOpen;

            const requestPromise = clientRouter.request('terminate-test', {});
            await expect(requestPromise).rejects.toThrow();
        });
    });

    describe('Extreme Stress Tests', () => {
        it('should handle rapid fire requests with deterministic failures', async () => {
            serverRouter.on('chaos', (data: any) => {
                if (data.id % 20 === 0) {
                    const privateMethods = serverRouter as any;
                    const lastPacket = Array.from(privateMethods._processedPackets.keys()).pop();
                    if (lastPacket) {
                        privateMethods._processedPackets.delete(lastPacket);
                    }
                } else if (data.id % 20 === 1) {
                    throw new Error('Scheduled server error');
                } else if (data.id % 20 === 2) {
                    return { error: 'Scheduled failure' };
                }

                return { id: data.id, success: true };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 100;
            clientRouter.config.ackRetryDelays = [50, 100];

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const results = [];

            // Send requests in rapid succession
            for (let i = 0; i < 100; i++) {
                const promise = clientRouter.request('chaos', { id: i })
                    .then(r => ({ ...r, id: i }))
                    .catch(e => ({ error: e.message, id: i }));
                results.push(promise);

                if (i % 4 === 0) await sleep(1);
            }

            const allResults = await Promise.all(results);

            const successful = allResults.filter(r => r.success).length;
            const errors = allResults.filter(r => r.error).length;

            expect(successful).toBe(90);
            expect(errors).toBe(10);

            ws.close();
        });

        it('should handle memory pressure with continuous requests', async () => {
            let totalProcessed = 0;

            serverRouter.on('memory-test', (data: any) => {
                totalProcessed++;
                return {
                    id: data.id,
                    // Include some data to increase memory usage
                    payload: Buffer.alloc(1024).toString('base64')
                };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.processedPacketsCleanupInterval = 100;
            clientRouter.config.processedPacketsRetention = 100;
            serverRouter.config.processedPacketsCleanupInterval = 100;
            serverRouter.config.processedPacketsRetention = 100;
            clientRouter.config.maxProcessedPackets = 100;
            serverRouter.config.maxProcessedPackets = 100;
            clientRouter.config.maxPendingAcks = 50;
            clientRouter.config.maxPendingAcksKept = 25;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const privateMethods = clientRouter as any;
            const memorySnapshots = [];

            // Run continuous requests for 5 seconds
            const endTime = Date.now() + 5000;
            let requestId = 0;

            while (Date.now() < endTime) {
                // Send batch of requests
                const batch = [];
                for (let i = 0; i < 10; i++) {
                    batch.push(
                        clientRouter.request('memory-test', { id: requestId++ })
                            .catch(() => null)
                    );
                }

                await Promise.all(batch);

                // Take memory snapshot
                memorySnapshots.push({
                    time: Date.now(),
                    pendingAcks: privateMethods._pendingAcks.size,
                    processedPackets: privateMethods._processedPackets.size
                });

                await sleep(50);
            }

            // Memory should be bounded
            const maxPendingAcks = Math.max(...memorySnapshots.map(s => s.pendingAcks));
            const maxProcessedPackets = Math.max(...memorySnapshots.map(s => s.processedPackets));

            expect(maxPendingAcks).toBeLessThanOrEqual(100);
            expect(maxProcessedPackets).toBeLessThanOrEqual(200);
            expect(totalProcessed).toBeGreaterThan(100);

            ws.close();
        });
    });

    describe('Network Chaos Engineering', () => {
        it('should handle Byzantine network conditions', async () => {
            const originalSend = WebSocket.prototype.send;
            let chaosEnabled = true;
            let randomState = 0x12345678;
            const random = () => {
                randomState = (1664525 * randomState + 1013904223) >>> 0;
                return randomState / 0x100000000;
            };

            // Implement chaotic network behavior
            WebSocket.prototype.send = function(data: any) {
                if (!chaosEnabled) {
                    return originalSend.call(this, data);
                }

                const rand = random();
                const socket = this;
                const sendLater = (delay: number) => setTimeout(() => {
                    if (socket.readyState === WebSocket.OPEN) originalSend.call(socket, data);
                }, delay);

                if (rand < 0.1) {
                    // 10% drop packet
                    return;
                } else if (rand < 0.2) {
                    // 10% delay significantly
                    sendLater(200 + random() * 300);
                } else if (rand < 0.3) {
                    // 10% duplicate packet
                    originalSend.call(this, data);
                    sendLater(10);
                } else if (rand < 0.35) {
                    // 5% corrupt (will cause parse error)
                    try {
                        const corrupted = data.slice(0, -10);
                        originalSend.call(this, corrupted);
                    } catch {}
                } else {
                    // 65% normal
                    originalSend.call(this, data);
                }
            };

            serverRouter.on('byzantine', (data: any) => {
                return { id: data.id, received: true };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 200;
            clientRouter.config.reconnectTimeout = 200;
            clientRouter.config.ackRetryDelays = [100, 200, 300];

            let ws: WebSocketForce | undefined;
            try {
                ws = new WebSocketForce(new WebSocket(`ws://localhost:${port}`));
                setServer(ws);
                await clientRouter.serverOpen;

                const results = [];

                // Send requests under Byzantine conditions
                for (let i = 0; i < 50; i++) {
                    results.push(
                        clientRouter.request('byzantine', { id: i }, { timeout: 5000 })
                            .then(r => ({ ...r, id: i }))
                            .catch(e => ({ error: e.message, id: i }))
                    );
                }

                const allResults = await Promise.all(results);
                const successful = allResults.filter(r => r.received).length;

                // Should handle some Byzantine failures
                expect(successful).toBeGreaterThan(20);
            } finally {
                chaosEnabled = false;
                WebSocket.prototype.send = originalSend;
                ws?.close();
            }
        });

        it('should handle split-brain scenarios', async () => {
            const connections = new Map();

            serverRouter.on('split-brain', (data: any, { ws }: any) => {
                const clientId = data.clientId;

                if (!connections.has(clientId)) {
                    connections.set(clientId, { count: 0, ws });
                }

                const conn = connections.get(clientId);
                conn.count++;

                return {
                    clientId,
                    serverCount: conn.count,
                    requestId: data.requestId
                };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            // Create multiple clients
            const clients = [];

            for (let c = 0; c < 3; c++) {
                const { router: clientRouter, setServer } = PerfectWS.client();
                clientRouter.config.enableAckSystem = true;
                clientRouter.config.ackTimeout = 200;

                const ws = new WebSocket(`ws://localhost:${port}`);
                setServer(ws);
                await clientRouter.serverOpen;

                clients.push({ router: clientRouter, ws, id: `client-${c}` });
            }

            // Each client sends requests
            const allPromises = [];

            for (const client of clients) {
                for (let i = 0; i < 10; i++) {
                    allPromises.push(
                        client.router.request('split-brain', {
                            clientId: client.id,
                            requestId: i
                        })
                        .then(r => ({ ...r, success: true }))
                        .catch(e => ({ error: e.message, clientId: client.id, requestId: i }))
                    );
                }
            }

            const results = await Promise.all(allPromises);

            // Should handle split brain reasonably
            const successful = results.filter(r => r.success).length;
            expect(successful).toBeGreaterThan(20);

            // Cleanup
            clients.forEach(c => c.ws.close());
        });

        it('should survive connection flooding and recovery', async () => {
            serverRouter.on('flood', (data: any) => {
                return { id: data.id };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const clients = [];
            const results = [];

            // Create many clients rapidly
            for (let i = 0; i < 20; i++) {
                const { router: clientRouter, setServer } = PerfectWS.client();
                clientRouter.config.enableAckSystem = true;
                clientRouter.config.ackTimeout = 500;
                clientRouter.config.autoReconnect = false;

                const ws = new WebSocket(`ws://localhost:${port}`);
                setServer(ws);

                clients.push({ router: clientRouter, ws, id: i });

                // Start request immediately
                results.push(
                    clientRouter.serverOpen
                        .then(() => clientRouter.request('flood', { id: i }))
                        .catch(e => ({ error: e.message, id: i }))
                );

                if (i % 3 === 0) {
                    await sleep(10);
                }
            }

            // Wait for all results
            const allResults = await Promise.all(results);

            // Kill half the connections abruptly
            for (let i = 0; i < 10; i++) {
                if (clients[i]?.ws) {
                    clients[i].ws.terminate();
                }
            }

            // Remaining should still work
            const moreResults = [];
            for (let i = 10; i < 20; i++) {
                if (clients[i]?.router) {
                    moreResults.push(
                        clients[i].router.request('flood', { id: i + 100 })
                            .catch(e => ({ error: e.message }))
                    );
                }
            }

            await Promise.all(moreResults);

            // Cleanup remaining
            clients.forEach(c => {
                if (c.ws.readyState === WebSocket.OPEN) {
                    c.ws.close();
                }
            });

            const successful = allResults.filter(r => !r.error).length;
            expect(successful).toBeGreaterThan(10);
        });
    });

    describe('Complex Multi-Stage Scenarios', () => {
        it('should handle cascading failures with recovery', async () => {
            let stage = 'normal';
            let requestCount = 0;

            serverRouter.on('cascade', async (data: any) => {
                requestCount++;

                switch (stage) {
                    case 'normal':
                        if (requestCount > 10) stage = 'degraded';
                        return { stage: 'normal', id: data.id };

                    case 'degraded':
                        if (requestCount > 20) stage = 'failing';
                        if (requestCount % 2 === 0) {
                            const privateMethods = serverRouter as any;
                            const lastPacket = Array.from(privateMethods._processedPackets.keys()).pop();
                            if (lastPacket) privateMethods._processedPackets.delete(lastPacket);
                        }
                        await sleep(100);
                        return { stage: 'degraded', id: data.id };

                    case 'failing':
                        if (requestCount > 30) stage = 'recovery';
                        if (requestCount % 5 !== 0) {
                            throw new Error('System failing');
                        }
                        return { stage: 'failing', id: data.id };

                    case 'recovery':
                        if (requestCount > 40) stage = 'normal';
                        if (requestCount % 3 === 0) {
                            throw new Error('Still recovering');
                        }
                        return { stage: 'recovery', id: data.id };

                    default:
                        return { stage, id: data.id };
                }
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 300;
            clientRouter.config.ackRetryDelays = [100, 200];

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const stages = [];
            let failures = 0;
            let successes = 0;

            // Send requests through all stages
            for (let i = 0; i < 50; i++) {
                try {
                    const result = await clientRouter.request('cascade', { id: i });
                    stages.push(result.stage);
                    successes++;
                } catch (e) {
                    failures++;
                    stages.push('error');
                }

                // Small delay between requests
                await sleep(20);
            }

            // Should have gone through different stages
            expect(stages.includes('normal')).toBe(true);
            expect(stages.includes('degraded')).toBe(true);
            expect(failures).toBeGreaterThan(5);
            expect(successes).toBeGreaterThan(20);

            ws.close();
        });

        it('should handle request storms with backpressure', async () => {
            let processingDelay = 10;
            const queue = [];
            let processing = false;

            const processQueue = async () => {
                if (processing || queue.length === 0) return;
                processing = true;

                while (queue.length > 0) {
                    const { data, resolve } = queue.shift();
                    await sleep(processingDelay);

                    // Increase delay if queue is growing
                    if (queue.length > 20) {
                        processingDelay = Math.min(processingDelay + 5, 100);
                    } else if (queue.length < 5) {
                        processingDelay = Math.max(processingDelay - 2, 10);
                    }

                    resolve({
                        id: data.id,
                        queueSize: queue.length,
                        delay: processingDelay
                    });
                }

                processing = false;
            };

            serverRouter.on('storm', (data: any) => {
                return new Promise(resolve => {
                    queue.push({ data, resolve });
                    processQueue();
                });
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 5000;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const results = [];
            const sendTimes = [];

            // Create request storm
            for (let burst = 0; burst < 5; burst++) {
                const burstStart = Date.now();

                // Send burst of requests
                for (let i = 0; i < 20; i++) {
                    results.push(
                        clientRouter.request('storm', {
                            id: burst * 20 + i,
                            burst
                        })
                    );
                }

                sendTimes.push(Date.now() - burstStart);

                // Small gap between bursts
                await sleep(50);
            }

            const allResults = await Promise.all(results);

            // Should handle all requests despite backpressure
            expect(allResults.length).toBe(100);

            // Check that backpressure kicked in
            const maxQueueSize = Math.max(...allResults.map(r => r.queueSize));
            const maxDelay = Math.max(...allResults.map(r => r.delay));

            expect(maxQueueSize).toBeGreaterThan(10);
            expect(maxDelay).toBeGreaterThan(20);

            ws.close();
        });

        it('should handle asymmetric load patterns', async () => {
            const clientLoads = new Map();

            serverRouter.on('asymmetric', async (data: any) => {
                const clientId = data.clientId;
                const load = clientLoads.get(clientId) || 0;
                clientLoads.set(clientId, load + 1);

                // Different processing time based on client
                const delay = data.heavy ? 150 : 10;
                await sleep(delay);

                return {
                    clientId,
                    processed: true,
                    serverLoad: clientLoads.get(clientId)
                };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            // Create clients with different load patterns
            const clients = [];

            // Heavy client
            const heavyClient = PerfectWS.client();
            heavyClient.router.config.enableAckSystem = true;
            heavyClient.router.config.ackTimeout = 1000;
            const heavyWs = new WebSocket(`ws://localhost:${port}`);
            heavyClient.setServer(heavyWs);
            await heavyClient.router.serverOpen;
            clients.push({
                router: heavyClient.router,
                ws: heavyWs,
                type: 'heavy',
                id: 'heavy-client'
            });

            // Light clients
            for (let i = 0; i < 3; i++) {
                const lightClient = PerfectWS.client();
                lightClient.router.config.enableAckSystem = true;
                lightClient.router.config.ackTimeout = 200;
                const lightWs = new WebSocket(`ws://localhost:${port}`);
                lightClient.setServer(lightWs);
                await lightClient.router.serverOpen;
                clients.push({
                    router: lightClient.router,
                    ws: lightWs,
                    type: 'light',
                    id: `light-client-${i}`
                });
            }

            const allPromises = [];

            // Heavy client sends fewer but expensive requests
            for (let i = 0; i < 10; i++) {
                allPromises.push(
                    clients[0].router.request('asymmetric', {
                        clientId: clients[0].id,
                        heavy: true,
                        requestId: i
                    }).catch(e => ({ error: e.message }))
                );
            }

            // Light clients send many cheap requests
            for (let c = 1; c < clients.length; c++) {
                for (let i = 0; i < 30; i++) {
                    allPromises.push(
                        clients[c].router.request('asymmetric', {
                            clientId: clients[c].id,
                            heavy: false,
                            requestId: i
                        }).catch(e => ({ error: e.message }))
                    );
                }
            }

            const results = await Promise.all(allPromises);

            // Check load distribution
            const heavyLoad = clientLoads.get('heavy-client') || 0;
            const lightLoads = Array.from(clientLoads.entries())
                .filter(([id]) => id.startsWith('light-client'))
                .map(([, load]) => load);

            expect(heavyLoad).toBeGreaterThan(5);
            expect(Math.max(...lightLoads)).toBeGreaterThan(20);

            const successful = results.filter(r => r.processed).length;
            expect(successful).toBeGreaterThan(80);

            // Cleanup
            clients.forEach(c => c.ws.close());
        });
    });

    describe('Extreme Edge Cases', () => {
        it('should handle zero-timeout ACK with retries', async () => {
            serverRouter.on('zero-timeout', (data: any) => {
                return { id: data.id };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 0; // Immediate timeout
            clientRouter.config.ackRetryDelays = [10, 20, 30];

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const results = [];

            for (let i = 0; i < 20; i++) {
                results.push(
                    clientRouter.request('zero-timeout', { id: i }, { timeout: 3000 })
                        .then(r => ({ ...r, success: true }))
                        .catch(e => ({ error: e.message, id: i }))
                );
            }

            const allResults = await Promise.all(results);

            // Should retry and eventually succeed for most
            const successful = allResults.filter(r => r.success).length;
            expect(successful).toBeGreaterThan(10);

            ws.close();
        });

        it('should handle packet ID collisions gracefully', async () => {
            serverRouter.on('collision', (data: any) => {
                return { id: data.id };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            // Monkey-patch uuid to create collisions
            const privateMethods = clientRouter as any;
            let callCount = 0;
            const cryptoRef = (globalThis as any).crypto;
            const originalUuid = cryptoRef.randomUUID.bind(cryptoRef);
            cryptoRef.randomUUID = () => {
                callCount++;
                // Create collision every 5th call
                if (callCount % 5 === 0) {
                    return 'collision-id';
                }
                return originalUuid();
            };

            const results = [];

            for (let i = 0; i < 20; i++) {
                results.push(
                    // bound each request so a stolen packetId/requestId fails fast instead of
                    // waiting on the (15 minute default) request timeout
                    clientRouter.request('collision', { id: i }, { timeout: 2000 })
                        .then(r => ({ ...r, success: true }))
                        .catch(e => ({ error: e.message, id: i }))
                );
                await sleep(10);
            }

            const allResults = await Promise.all(results);

            // Restore original uuid
            (globalThis as any).crypto.randomUUID = originalUuid;

            // Should handle collisions gracefully (fail fast, no hang/crash), but a genuine
            // requestId/packetId collision is expected to be lost, so not every request succeeds
            const successful = allResults.filter(r => r.success).length;
            expect(successful).toBeGreaterThan(10);

            ws.close();
        });

        it('should handle server sending unsolicited ACKs', async () => {
            serverRouter.on('unsolicited', async (data: any, { ws }: any) => {
                // Send random ACKs for non-existent packets
                const privateMethods = serverRouter as any;
                const wsForce = privateMethods._clients?.get(ws);

                if (wsForce) {
                    for (let i = 0; i < 5; i++) {
                        privateMethods._sendJSON({
                            requestId: 'fake-' + i,
                            method: '___ack',
                            data: { ackFor: 'non-existent-' + i }
                        }, wsForce);
                    }
                }

                return { id: data.id };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            // Should not crash on unsolicited ACKs
            const result = await clientRouter.request('unsolicited', { id: 1 });
            expect(result.id).toBe(1);

            // Make more requests to ensure stability
            const moreResults = [];
            for (let i = 2; i <= 5; i++) {
                moreResults.push(
                    clientRouter.request('unsolicited', { id: i })
                );
            }

            const allResults = await Promise.all(moreResults);
            expect(allResults.length).toBe(4);

            ws.close();
        });
    });
});
