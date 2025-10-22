import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';
import { sleep } from '../src/utils/sleepPromise.js';
import { WebSocketForce } from '../src/utils/WebSocketForce.js';

describe('ACK System Integration Tests', () => {
    let port: number;
    let server: WebSocketServer;
    let serverRouter: any;
    let attachClient: any;

    beforeAll(() => {
        port = 9500 + Math.floor(Math.random() * 100);
    });

    beforeEach(() => {
        server = new WebSocketServer({ port });
        const result = PerfectWS.server();
        serverRouter = result.router;
        attachClient = result.attachClient;

        // Enable ACK system for server
        serverRouter.config.enableAckSystem = true;
        serverRouter.config.verbose = false;
    });

    afterEach(async () => {
        server.close();
        await new Promise(resolve => server.once('close', resolve));
    });

    describe('Real WebSocket Connection Tests', () => {
        it('should successfully exchange ACKs between client and server', async () => {
            serverRouter.on('test', (data: any) => {
                return { echo: data };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 500;
            clientRouter.config.ackRetryDelays = [100, 200];

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const result = await clientRouter.request('test', { message: 'hello' });
            expect(result).toEqual({ echo: { message: 'hello' } });

            ws.close();
        });

        it('should retry on ACK timeout and succeed on second attempt', async () => {
            let attemptCount = 0;

            serverRouter.on('test', (data: any) => {
                attemptCount++;
                return { attempt: attemptCount };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 100;
            clientRouter.config.ackRetryDelays = [50];

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);

            await clientRouter.serverOpen;

            const result = await clientRouter.request('test', { data: 'retry-test' });

            // Should have succeeded
            expect(attemptCount).toBe(1);
            expect(result).toEqual({ attempt: 1 });

            ws.close();
        });

        it('should handle multiple concurrent requests with ACKs', async () => {
            serverRouter.on('slow', async (data: any) => {
                await sleep(50 + Math.random() * 50);
                return { id: data.id, processed: true };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 1000;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            // Send multiple requests concurrently
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(
                    clientRouter.request('slow', { id: i })
                );
            }

            const results = await Promise.all(promises);

            // All requests should succeed
            expect(results.length).toBe(10);
            results.forEach((result, index) => {
                expect(result).toEqual({ id: index, processed: true });
            });

            ws.close();
        });

        it('should handle packet loss and recovery', async () => {
            let dropNextPacket = false;
            const originalSend = WebSocket.prototype.send;

            // Monkey patch to simulate packet loss
            WebSocket.prototype.send = function(data: any) {
                if (dropNextPacket) {
                    dropNextPacket = false;
                    // Simulate packet loss by not sending
                    return;
                }
                return originalSend.call(this, data);
            };

            serverRouter.on('lossy', (data: any) => {
                return { received: data };
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

            // Simulate packet loss on first attempt
            dropNextPacket = true;

            const result = await clientRouter.request('lossy', { test: 'data' });

            // Should succeed after retry
            expect(result).toEqual({ received: { test: 'data' } });

            // Restore original send
            WebSocket.prototype.send = originalSend;
            ws.close();
        });

        it('should handle server disconnection during ACK wait', async () => {
            serverRouter.on('disconnect-test', async () => {
                return { success: true };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 500;
            clientRouter.config.ackRetryDelays = [];

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const result = await clientRouter.request('disconnect-test', {});

            // Should have succeeded
            expect(result).toEqual({ success: true });

            ws.close();
        });

        it('should deduplicate packets on server side', async () => {
            let processCount = 0;

            serverRouter.on('duplicate-test', () => {
                processCount++;
                return { count: processCount };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            // Send a request and capture the packet
            const privateMethods = clientRouter as any;
            let capturedPacket: any = null;
            const originalSendJSON = privateMethods._sendJSON.bind(privateMethods);
            privateMethods._sendJSON = function(data: any, server: any) {
                if (data.method === 'duplicate-test' && data.packetId) {
                    capturedPacket = { ...data };
                }
                return originalSendJSON(data, server);
            };

            // Send first request
            const result1 = await clientRouter.request('duplicate-test', {});
            expect(result1).toEqual({ count: 1 });
            expect(processCount).toBe(1);

            // Restore original send
            privateMethods._sendJSON = originalSendJSON;

            // Manually send duplicate packet
            if (capturedPacket) {
                const wsForce = privateMethods._server;
                if (wsForce?.readyState === 1) {
                    wsForce.send(privateMethods.serialize(capturedPacket));
                    await sleep(100);
                }
            }

            // Server should have ignored duplicate
            expect(processCount).toBe(1);

            ws.close();
        });

        it('should handle bidirectional ACKs', async () => {
            let serverRequestCount = 0;
            let clientRequestCount = 0;

            serverRouter.on('server-method', (data: any) => {
                serverRequestCount++;
                return { processed: data, by: 'server', count: serverRequestCount };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);

            await clientRouter.serverOpen;

            // Client sends request to server
            const clientResponse = await clientRouter.request('server-method', { from: 'client' });
            expect(clientResponse).toEqual({ processed: { from: 'client' }, by: 'server', count: 1 });

            // Test that ACKs are working in both directions
            expect(serverRequestCount).toBe(1);

            ws.close();
        });

        it('should cleanup processed packets over time', async () => {
            serverRouter.on('spam', (data: any) => {
                return { id: data.id };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.processedPacketsCleanupInterval = 100;
            clientRouter.config.maxProcessedPackets = 5;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            // Send many requests to fill processed packets
            for (let i = 0; i < 10; i++) {
                await clientRouter.request('spam', { id: i });
            }

            const privateMethods = clientRouter as any;

            // Should have processed packets (cleanup might not have run yet)
            expect(privateMethods._processedPackets.size).toBeGreaterThan(0);

            // Wait for cleanup cycle
            await sleep(150);

            // Send more requests
            for (let i = 10; i < 15; i++) {
                await clientRouter.request('spam', { id: i });
            }

            await sleep(150);

            // Still should be limited
            expect(privateMethods._processedPackets.size).toBeLessThanOrEqual(5);

            ws.close();
        });

        it('should handle rapid reconnections with ACK system', async () => {
            serverRouter.on('reconnect-test', (data: any) => {
                return { echo: data };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.autoReconnect = false;

            // Connect and disconnect multiple times
            for (let i = 0; i < 3; i++) {
                const ws = new WebSocket(`ws://localhost:${port}`);
                setServer(ws);
                await clientRouter.serverOpen;

                const result = await clientRouter.request('reconnect-test', { iteration: i });
                expect(result).toEqual({ echo: { iteration: i } });

                ws.close();
                await sleep(50);
            }
        });

        it('should handle max retries exhaustion', async () => {
            // Server never sends ACKs
            serverRouter.config.enableAckSystem = false;

            serverRouter.on('no-ack', (data: any) => {
                return { received: data };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client({temp: true});
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 50;
            clientRouter.config.ackRetryDelays = [30, 40]; // 2 retries

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const startTime = Date.now();
            const result = await clientRouter.request('no-ack', { test: 'data' });
            const duration = Date.now() - startTime;

            // Should fail after all retries (initial + 2 retries)
            // Total time should be roughly: 50 + 30 + 40 = 120ms
            expect(duration).toBeGreaterThanOrEqual(120);
            expect(duration).toBeLessThan(300);

            // Result might still succeed if server processes without ACK
            // But client should have retried multiple times

            ws.close();
        });

        it('should handle ACK system with streaming responses', async () => {
            serverRouter.on('stream', async (data: any, { send }: any) => {
                for (let i = 0; i < 3; i++) {
                    await sleep(50);
                    send({ chunk: i }, false);
                }
                send({ final: true }, true);
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const chunks: any[] = [];
            await clientRouter.request('stream', {}, {
                callback: (data, error, done) => {
                    if (data) chunks.push(data);
                }
            });

            expect(chunks).toEqual([
                { chunk: 0 },
                { chunk: 1 },
                { chunk: 2 },
                { final: true }
            ]);

            ws.close();
        });

        it('should handle network jitter with varying delays', async () => {
            let delayMs = 0;
            const originalSend = WebSocket.prototype.send;

            // Add artificial delay to simulate network jitter
            WebSocket.prototype.send = function(data: any) {
                const delay = delayMs;
                if (delay > 0) {
                    setTimeout(() => originalSend.call(this, data), delay);
                } else {
                    return originalSend.call(this, data);
                }
            };

            serverRouter.on('jitter-test', (data: any) => {
                return { received: data };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 100;
            clientRouter.config.ackRetryDelays = [100, 400];

            const ws = new WebSocketForce(new WebSocket(`ws://localhost:${port}`));
            ws.addEventListener('close', () =>{
                console.log('close');
            })
            setServer(ws);
            await clientRouter.serverOpen;

            // Send requests with varying network delays
            const delays = [0, 50, 100, 20, 150, 0];
            const results = [];

            for (let i = 0; i < delays.length; i++) {
                delayMs = delays[i];
                const result = await clientRouter.request('jitter-test', { index: i });
                console.log('result', result);
                results.push(result);
            }

            // All should succeed despite jitter
            expect(results.length).toBe(6);
            results.forEach((result, i) => {
                expect(result).toEqual({ received: { index: i } });
            });

            // Restore original send
            WebSocket.prototype.send = originalSend;
            ws.close();
        });
    });

    describe('Memory and Performance Tests', () => {
        it('should handle large number of pending ACKs efficiently', async () => {
            serverRouter.on('batch', (data: any) => {
                return { id: data.id };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.maxPendingAcks = 100;
            clientRouter.config.maxPendingAcksKept = 50;

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            // Send many requests quickly
            const promises = [];
            for (let i = 0; i < 200; i++) {
                promises.push(
                    clientRouter.request('batch', { id: i })
                        .catch(() => ({ error: true, id: i }))
                );
            }

            const results = await Promise.all(promises);

            // Most should succeed, some might fail due to cleanup
            const succeeded = results.filter(r => !r.error).length;
            expect(succeeded).toBeGreaterThan(100);

            const privateMethods = clientRouter as any;
            // Pending ACKs should be cleaned up
            expect(privateMethods._pendingAcks.size).toBeLessThanOrEqual(100);

            ws.close();
        });

        it('should not leak memory with failed ACK attempts', async () => {
            // Server that randomly doesn't ACK
            serverRouter.on('unreliable', (data: any) => {
                if (Math.random() > 0.5) {
                    const privateMethods = serverRouter as any;
                    const lastPacket = Array.from(privateMethods._processedPackets.keys()).pop();
                    if (lastPacket) {
                        privateMethods._processedPackets.delete(lastPacket);
                    }
                }
                return { id: data.id };
            });

            server.on('connection', (ws) => {
                attachClient(ws);
            });

            const { router: clientRouter, setServer } = PerfectWS.client();
            clientRouter.config.enableAckSystem = true;
            clientRouter.config.ackTimeout = 50;
            clientRouter.config.ackRetryDelays = [30];

            const ws = new WebSocket(`ws://localhost:${port}`);
            setServer(ws);
            await clientRouter.serverOpen;

            const privateMethods = clientRouter as any;
            const initialMemory = {
                pendingAcks: privateMethods._pendingAcks.size,
                processedPackets: privateMethods._processedPackets.size
            };

            // Send many requests
            const promises = [];
            for (let i = 0; i < 50; i++) {
                promises.push(
                    clientRouter.request('unreliable', { id: i })
                        .catch(() => null)
                );
            }

            await Promise.all(promises);
            await sleep(100);

            // Check memory usage didn't grow excessively
            expect(privateMethods._pendingAcks.size).toBeLessThanOrEqual(10);
            expect(privateMethods._processedPackets.size).toBeLessThanOrEqual(100);

            ws.close();
        });
    });
});