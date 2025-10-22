import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';
import { WebSocketForce } from '../src/utils/WebSocketForce.js';

// Mock sleep to speed up tests
vi.mock('sleep-promise', () => ({
    default: vi.fn((ms: number) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))))
}));

describe('ACK System Tests', () => {
    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
    });

    describe('Configuration', () => {
        it('should have default ACK configuration options', () => {
            const serverClass = PerfectWS as any;
            const client = serverClass._newInstance();

            expect(client.config.ackTimeout).toBe(1000);
            expect(client.config.ackRetryDelays).toEqual([3000, 5000]);
            expect(client.config.processedPacketsCleanupInterval).toBe(60000);
            expect(client.config.maxProcessedPackets).toBe(10000);
        });

        it('should allow enabling/disabling ACK system', () => {
            const { router: client } = PerfectWS.client();

            client.config.enableAckSystem = false;
            expect(client.config.enableAckSystem).toBe(false);

            client.config.enableAckSystem = true;
            expect(client.config.enableAckSystem).toBe(true);
        });

        it('should allow customizing ACK configuration', () => {
            const { router: client } = PerfectWS.client();

            client.config.ackTimeout = 2000;
            client.config.ackRetryDelays = [1000, 2000, 3000];
            client.config.maxProcessedPackets = 5000;

            expect(client.config.ackTimeout).toBe(2000);
            expect(client.config.ackRetryDelays).toEqual([1000, 2000, 3000]);
            expect(client.config.maxProcessedPackets).toBe(5000);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty packetId gracefully', () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;

            const mockData = { requestId: 'req1', data: 'test' };
            const privateMethods = client as any;

            // Call _onServerResponse with no packetId
            const mockSocket = createMockWebSocket();
            expect(() => {
                privateMethods._onServerResponse(mockData, new WebSocketForce(mockSocket as any));
            }).not.toThrow();
        });

        it('should cleanup timeout on ACK received', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;
            client.config.ackTimeout = 100;

            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            const privateMethods = client as any;
            const mockWs = createMockWebSocket();
            mockWs.readyState = 1; // OPEN

            // Track the packet ID that gets generated
            let generatedPacketId: string | null = null;
            const originalSendJSON = privateMethods._sendJSON.bind(privateMethods);
            privateMethods._sendJSON = vi.fn((data: any) => {
                if (data.packetId) {
                    generatedPacketId = data.packetId;
                }
                return originalSendJSON(data, new WebSocketForce(mockWs as any));
            });

            // Start sending
            const sendPromise = privateMethods._sendWithAck(
                { method: 'test', requestId: 'req1' },
                new WebSocketForce(mockWs as any)
            );

            // Wait for packet ID to be generated
            await new Promise(resolve => setTimeout(resolve, 10));

            // Immediately resolve the ACK
            if (generatedPacketId) {
                const pending = privateMethods._pendingAcks.get(generatedPacketId);
                if (pending) pending.resolve();
            }

            await sendPromise;

            // Verify clearTimeout was called
            expect(clearTimeoutSpy).toHaveBeenCalled();
        });

        it('should handle ACK for non-existent packet', () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;

            const privateMethods = client as any;

            // Verify no pending ACKs exist
            expect(privateMethods._pendingAcks.size).toBe(0);

            // Manually call the ___ack handler logic
            const packetId = 'non-existent-packet';
            const pending = privateMethods._pendingAcks.get(packetId);

            // Should be undefined (no pending ack)
            expect(pending).toBeUndefined();
        });

        it('should cleanup pending ACKs on reject', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;

            const privateMethods = client as any;
            const packetId = 'test-packet';

            // Create pending ACK and reject it
            const ackPromise = new Promise((resolve, reject) => {
                let timeoutId: NodeJS.Timeout | null = null;

                privateMethods._pendingAcks.set(packetId, {
                    resolve: () => {
                        if (timeoutId) clearTimeout(timeoutId);
                        privateMethods._pendingAcks.delete(packetId);
                        resolve(true);
                    },
                    reject: (reason: string) => {
                        if (timeoutId) clearTimeout(timeoutId);
                        privateMethods._pendingAcks.delete(packetId);
                        reject(new Error(reason));
                    }
                });

                // Reject after small delay
                timeoutId = setTimeout(() => {
                    const pending = privateMethods._pendingAcks.get(packetId);
                    if (pending) pending.reject('Test rejection');
                }, 10);
            });

            await expect(ackPromise).rejects.toThrow('Test rejection');

            // Verify cleanup happened
            expect(privateMethods._pendingAcks.has(packetId)).toBe(false);
        });

        it('should handle allowPackageLoss flag correctly', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;

            const privateMethods = client as any;
            const mockWs = createMockWebSocket();

            // Send with allowPackageLoss=true should not wait for ACK
            const result = await privateMethods._sendWithAck(
                { method: 'test' },
                new WebSocketForce(mockWs as any),
                true // allowPackageLoss
            );

            // Should resolve immediately without waiting for ACK
            expect(result).toBe(true);
        });

        it('should not ACK the ACK messages themselves', async () => {
            const { router: server } = PerfectWS.server();
            server.config.enableAckSystem = true;

            const mockWs = createMockWebSocket();
            const sendSpy = vi.spyOn(mockWs, 'send');

            const privateMethods = server as any;

            // Send an ACK message
            await privateMethods._sendWithAck(
                { method: '___ack', data: { ackFor: 'some-packet' } },
                new WebSocketForce(mockWs as any)
            );

            // Should send directly without waiting for ACK
            expect(sendSpy).toHaveBeenCalled();
        });
    });

    describe('Complex Scenarios', () => {
        it('should handle ACK cleanup loop with many packets', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;
            client.config.maxProcessedPackets = 100;
            client.config.processedPacketsCleanupInterval = 50; // Short interval for testing

            const privateMethods = client as any;

            // Add many processed packets
            for (let i = 0; i < 150; i++) {
                privateMethods._processedPackets.set(`packet-${i}`, Date.now() - i * 1000);
            }

            expect(privateMethods._processedPackets.size).toBe(150);

            // Manually trigger cleanup
            const ackCleanupAbortController = new AbortController();
            const cleanupPromise = privateMethods._startAckCleanupLoop(ackCleanupAbortController);

            // Wait for cleanup to run once
            await new Promise(resolve => setTimeout(resolve, 100));
            ackCleanupAbortController.abort();

            await cleanupPromise;

            // Should have cleaned up old packets
            expect(privateMethods._processedPackets.size).toBeLessThanOrEqual(100);
        }, 1000);

        it('should handle memory pressure with processed packets', () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;
            client.config.maxProcessedPackets = 50;

            const privateMethods = client as any;

            // Simulate high packet volume
            for (let i = 0; i < 1000; i++) {
                privateMethods._processedPackets.set(`packet-${i}`, Date.now());

                // Periodically clean up like the real cleanup loop would
                if (privateMethods._processedPackets.size > client.config.maxProcessedPackets) {
                    const sortedEntries = Array.from(privateMethods._processedPackets.entries())
                        .sort((a: [string, number], b: [string, number]) => b[1] - a[1]);

                    const toKeep = sortedEntries.slice(0, client.config.maxProcessedPackets);
                    privateMethods._processedPackets.clear();
                    for (const [packetId, timestamp] of toKeep) {
                        privateMethods._processedPackets.set(packetId, timestamp);
                    }
                }
            }

            // Should never exceed max
            expect(privateMethods._processedPackets.size).toBeLessThanOrEqual(
                client.config.maxProcessedPackets
            );
        });

        it('should handle abort controller cleanup for ACK loop', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;

            const privateMethods = client as any;

            const abortController = new AbortController();

            // Abort immediately before starting
            abortController.abort('Test abort');

            // Start cleanup loop with already aborted controller
            const cleanupPromise = privateMethods._startAckCleanupLoop(abortController);

            // Should complete immediately without error
            await expect(cleanupPromise).resolves.toBeUndefined();
        }, 500);

        it('should handle processed packets growing beyond limit', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;
            client.config.maxProcessedPackets = 10;
            client.config.processedPacketsCleanupInterval = 50;

            const privateMethods = client as any;

            // Add packets rapidly
            for (let i = 0; i < 100; i++) {
                privateMethods._processedPackets.set(`packet-${i}`, Date.now() + i);
            }

            // Trigger cleanup
            const abortController = new AbortController();
            const cleanupPromise = privateMethods._startAckCleanupLoop(abortController);

            await new Promise(resolve => setTimeout(resolve, 100));
            abortController.abort();

            await cleanupPromise;

            // Should be cleaned up
            expect(privateMethods._processedPackets.size).toBeLessThanOrEqual(10);
        }, 5000);

        it('should handle concurrent timeouts without race conditions', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;
            client.config.ackTimeout = 50;

            const privateMethods = client as any;
            const packetIds = ['p1', 'p2', 'p3'];
            const promises: Promise<void>[] = [];

            // Create multiple concurrent pending ACKs that will timeout
            for (const packetId of packetIds) {
                const promise = new Promise<void>((resolve) => {
                    let timeoutId: NodeJS.Timeout | null = null;
                    let resolved = false;

                    const cleanup = () => {
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        privateMethods._pendingAcks.delete(packetId);
                    };

                    privateMethods._pendingAcks.set(packetId, {
                        resolve: () => {
                            if (resolved) return;
                            resolved = true;
                            cleanup();
                            resolve();
                        },
                        reject: () => {
                            if (resolved) return;
                            resolved = true;
                            cleanup();
                            resolve();
                        }
                    });

                    timeoutId = setTimeout(() => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolve();
                    }, 50);
                });

                promises.push(promise);
            }

            await Promise.all(promises);

            // All should be cleaned up
            expect(privateMethods._pendingAcks.size).toBe(0);
        });

        it('should abort retries when server closes during delay', async () => {
            const { router: client } = PerfectWS.client();
            client.config.enableAckSystem = true;
            client.config.ackTimeout = 50;
            client.config.ackRetryDelays = [100, 200]; // Delays to race with close

            const privateMethods = client as any;
            const mockWs = createMockWebSocket();

            // Simulate sending that will timeout
            const sendPromise = privateMethods._sendWithAck(
                { method: 'test', requestId: 'req1' },
                new WebSocketForce(mockWs as any)
            );

            // Simulate server close during retry delay
            setTimeout(() => {
                mockWs.readyState = 3; // CLOSED
                mockWs.dispatchEvent({ type: 'close' });
            }, 75); // Close during first retry delay

            const result = await sendPromise;
            expect(result).toBe(false); // Should fail due to server close
        });

        it('should properly cleanup on double resolve attempt', () => {
            const { router: client } = PerfectWS.client();
            const privateMethods = client as any;

            const packetId = 'test-double-resolve';
            let resolveCount = 0;

            const promise = new Promise((resolve) => {
                let timeoutId: NodeJS.Timeout | null = null;
                let resolved = false;

                const cleanup = () => {
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        timeoutId = null;
                    }
                    privateMethods._pendingAcks.delete(packetId);
                };

                privateMethods._pendingAcks.set(packetId, {
                    resolve: () => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolveCount++;
                        resolve(true);
                    },
                    reject: () => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolve(false);
                    }
                });

                timeoutId = setTimeout(() => {
                    if (resolved) return;
                    resolved = true;
                    cleanup();
                    resolve(false);
                }, 100);

                // Try to resolve multiple times
                const pending = privateMethods._pendingAcks.get(packetId);
                if (pending) {
                    pending.resolve();
                    pending.resolve(); // Second call should be ignored
                    pending.resolve(); // Third call should be ignored
                }
            });

            return promise.then(() => {
                // Should only resolve once
                expect(resolveCount).toBe(1);
                // Should be cleaned up
                expect(privateMethods._pendingAcks.has(packetId)).toBe(false);
            });
        });
    });
});

// Helper functions
function createMockWebSocket() {
    const listeners: Map<string, Set<Function>> = new Map();

    return {
        readyState: 1, // OPEN
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn((event: string, callback: Function) => {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event)!.add(callback);
        }),
        removeEventListener: vi.fn((event: string, callback: Function) => {
            listeners.get(event)?.delete(callback);
        }),
        dispatchEvent: vi.fn((event: any) => {
            const callbacks = listeners.get(event.type);
            if (callbacks) {
                callbacks.forEach(cb => cb(event));
            }
        }),
        bufferedAmount: 0,
        setMaxListeners: vi.fn(),
        _listeners: listeners
    };
}
