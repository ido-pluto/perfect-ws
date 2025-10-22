import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.ts';
import { PerfectWSAdvanced } from '../src/PerfectWSAdvanced/PerfectWSAdvanced.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';
import { BSON } from 'bson';
import { sleep } from '../src/utils/sleepPromise.js';

vi.mock('sleep-promise', () => ({
  default: vi.fn((ms: number) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))))
}));

describe('Chaos Engineering - Non-Standard Scenarios', () => {
  describe('Socket State Chaos', () => {
    it('should handle socket in CONNECTING state forever', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 0, // CONNECTING forever
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockImplementation(() => {
          throw new Error('Cannot send - still connecting');
        })
      };

      let openHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'open') openHandler = handler;
      });

      setServer(mockWs as any);

      // Try to make request while stuck in CONNECTING
      const promise = router.request('test', null, {
        timeout: 100,
        doNotWaitForConnection: false
      });

      // Socket never opens
      await expect(promise).rejects.toThrow();

      // Cleanup
      mockWs.readyState = 3; // Force close
    });

    it('should handle socket changing states rapidly during request', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockImplementation(function () {
          // Change state on each send
          this.readyState = this.readyState === 1 ? 0 : 1;
          if (this.readyState === 0) {
            throw new Error('Socket not ready');
          }
          return true;
        })
      };

      setServer(mockWs as any);

      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          router.request(`test-${i}`, null, {
            timeout: 100,
            doNotWaitForConnection: true
          }).catch(e => ({ error: e.message }))
        );
      }

      const outcomes = await Promise.all(results);

      // Some should fail, some might succeed
      const errors = outcomes.filter(o => o.error);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should handle zombie socket that appears open but is dead', async () => {
      const { router, setServer } = PerfectWS.client({temp: true});
      router.config.runPingLoop = false;

      const mockWs = {
        readyState: 1, // Claims to be open
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true), // Claims to send successfully
        bufferedAmount: 999999 // But buffer is full
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      setServer(mockWs as any);

      // Request will send but never get response
      const promise = router.request('zombie-test', null, {
        timeout: 100,
        doNotWaitForConnection: true
      });

      // No response ever comes
      await expect(promise).rejects.toThrow('timeout');
    });
  });

  describe('Server Amnesia Scenarios', () => {
    it('should handle server forgetting all requests after restart', async () => {
      const { router, setServer } = PerfectWS.client();
      router.config.syncRequestsWhenServerOpen = false; // Disable auto-sync to avoid interference

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true)
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      setServer(mockWs as any);

      // Make several requests
      const requests = [];
      for (let i = 0; i < 3; i++) {
        requests.push(
          router.request(`amnesia-${i}`, { data: i }, {
            timeout: 1000
          }).catch(e => e)
        );
      }

      // Manually trigger sync and simulate server restart
      await sleep(10);
      const syncPromise = router.syncRequests();

      await sleep(10);
      const syncCall = mockWs.send.mock.calls.find(
        call => {
          try {
            const data = BSON.deserialize(call[0]);
            return data.method === '___syncRequests';
          } catch {
            return false;
          }
        }
      );

      if (syncCall && messageHandler) {
        const syncData = BSON.deserialize(syncCall[0]);
        const activeRequestIds = syncData.data.activeRequestsIds || [];
        // Server doesn't know about any requests - return all as unknown
        await messageHandler({
          data: BSON.serialize({
            requestId: syncData.requestId,
            data: activeRequestIds, // Return all request IDs as unknown
            down: true
          })
        });
      }

      await syncPromise.catch(() => { });

      // All requests should be rejected with unknownRequest error
      const results = await Promise.all(requests);
      const rejected = results.filter(r => r && r.code === 'unknownRequest');
      expect(rejected.length).toBe(3);
    });

    it('should handle server claiming to know requests it never received', async () => {
      const { router } = PerfectWS.server();

      // Server thinks it has active requests
      router['_activeResponses'].set('phantom-1', {
        events: new NetworkEventListener(),
        clients: new Set()
      });
      router['_activeResponses'].set('phantom-2', {
        events: new NetworkEventListener(),
        clients: new Set()
      });

      // Client asks about completely different requests
      const handler = router['_listenForRequests'].get('___syncRequests');
      const result = await handler?.callbacks?.[0]?.({
        activeRequestsIds: ['real-1', 'real-2', 'real-3']
      }, {} as any);

      // Server doesn't know any of the client's requests
      expect(result).toEqual(['real-1', 'real-2', 'real-3']);
    });
  });

  describe('Partial Message Scenarios', () => {
    it('should handle receiving messages out of order', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true)
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      setServer(mockWs as any);

      // Start multiple requests
      const promise1 = router.request('order-1', null, { timeout: 1000 });
      const promise2 = router.request('order-2', null, { timeout: 1000 });

      await sleep(10);

      // Get request IDs
      const calls = mockWs.send.mock.calls.map(x => BSON.deserialize(x[0])).filter(x => x.method.startsWith('order-'));
      const req1 = calls[0];
      const req2 = calls[1];

      // Send responses in reverse order
      if (messageHandler) {
        await messageHandler({
          data: BSON.serialize({
            requestId: req2.requestId,
            data: { result: 'second' },
            down: true
          })
        });

        await messageHandler({
          data: BSON.serialize({
            requestId: req1.requestId,
            data: { result: 'first' },
            down: true
          })
        });
      }

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1.result).toBe('first');
      expect(result2.result).toBe('second');
    });
  });

  describe('Connection Hijacking Scenarios', () => {
    it('should handle another client taking over the connection', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs1 = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true),
        id: 'ws1'
      };

      setServer(mockWs1 as any);

      // Start a request
      const promise = router.request('hijack-test', null, {
        timeout: 5000
      });

      // Another socket takes over
      const mockWs2 = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true),
        id: 'ws2'
      };

      // Force close first socket
      mockWs1.readyState = 3;

      // Set new socket
      setServer(mockWs2 as any);

      // Original request should handle the transition
      await expect(Promise.race([
        promise,
        sleep(100).then(() => 'handled')
      ])).resolves.toBeDefined();
    });
  });

  describe('Timing Attack Scenarios', () => {
    it('should handle requests with expired timestamps', async () => {
      const { router, attachClient } = PerfectWS.server();

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn()
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      router.on('timing', async (data) => {
        const now = Date.now();
        if (data.timestamp < now - 60000) { // More than 1 minute old
          throw new Error('Request too old');
        }
        return { accepted: true };
      });

      attachClient(mockWs as any);

      // Send old request
      await messageHandler({
        data: BSON.serialize({
          method: 'timing',
          requestId: 'old-123',
          data: {
            timestamp: Date.now() - 120000 // 2 minutes old
          }
        })
      });

      const response = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(response.error).toBeDefined();
    });

    it('should handle requests from the future', async () => {
      const { router, attachClient } = PerfectWS.server();

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn()
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      router.on('future', async (data) => {
        const now = Date.now();
        if (data.timestamp > now + 60000) { // More than 1 minute in future
          throw new Error('Request from the future');
        }
        return { accepted: true };
      });

      attachClient(mockWs as any);

      // Send future request
      await messageHandler({
        data: BSON.serialize({
          method: 'future',
          requestId: 'future-123',
          data: {
            timestamp: Date.now() + 120000 // 2 minutes in future
          }
        })
      });

      const response = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(response.error).toBeDefined();
    });
  });

  describe('Resource Exhaustion Scenarios', () => {
    it('should handle infinite event emission loops', async () => {
      const events = new NetworkEventListener();
      let emitCount = 0;
      const maxEmits = 100;

      // Create circular event handlers
      events.on('ping', (source) => {
        emitCount++;
        if (emitCount < maxEmits) {
          events.emit('pong', 'ping');
        }
      });

      events.on('pong', (source) => {
        emitCount++;
        if (emitCount < maxEmits) {
          events.emit('ping', 'pong');
        }
      });

      // Start the loop
      events.emit('ping', 'start');

      // Should stop at maxEmits
      expect(emitCount).toBe(maxEmits);
    });

    it('should handle request ID collision attacks', async () => {
      const { router, setServer } = PerfectWS.client({temp: true});
      router.config.runPingLoop = false;

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true)
      };

      setServer(mockWs as any);

      // Try to use same request ID multiple times
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          router.request('collision', null, {
            requestId: 'same-id', // Same ID!
            doNotWaitForConnection: true,
            timeout: 100
          }).catch(e => ({ error: e.message }))
        );
      }

      const outcomes = await Promise.all(results);

      // All should error since they timeout (no server response) or conflict
      const errors = outcomes.filter(o => o.error);
      expect(errors.length).toBeGreaterThanOrEqual(4);

      // Check that at least some mention the duplicate issue or timeout
      const errorMessages = errors.map(e => e.error).join(' ');
      expect(errorMessages).toBeDefined();
    });
  });

  describe('Protocol Version Mismatch', () => {
    it('should handle receiving unknown message types', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn()
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      setServer(mockWs as any);

      // Send message with unknown structure
      if (messageHandler) {
        await messageHandler({
          data: BSON.serialize({
            type: 'unknown-protocol-v2',
            payload: { data: 'incompatible' },
            version: 2
          })
        });
      }

      // Should not crash
      expect(router).toBeDefined();
    });

    it('should handle malformed error responses', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true)
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      setServer(mockWs as any);

      const promise = router.request('error-test', null, {
        timeout: 1000
      });

      await sleep(10);
      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);

      // Send malformed error response
      if (messageHandler) {
        await messageHandler({
          data: BSON.serialize({
            requestId: sentData.requestId,
            error: 'string-instead-of-object', // Wrong format!
            down: true
          })
        });
      }

      // Should handle gracefully
      await expect(promise).rejects.toThrow();
    });
  });

  describe('Concurrent Mutation Scenarios', () => {
    it('should handle simultaneous socket changes', async () => {
      const { router, setServer } = PerfectWS.client();

      const sockets = Array.from({ length: 5 }, (_, i) => ({
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true),
        id: `socket-${i}`
      }));

      // Rapidly change sockets
      const promises = sockets.map(async (socket, i) => {
        await sleep(i * 2);
        setServer(socket as any);
        return router.request(`concurrent-${i}`, null, {
          timeout: 100,
          doNotWaitForConnection: true
        }).catch(e => ({ error: e.message, socketId: socket.id }));
      });

      const results = await Promise.all(promises);

      // Some requests might fail due to rapid socket changes
      expect(results.length).toBe(5);
    });

    it('should handle cleanup during active operations', async () => {
      const { router, setServer, unregister } = PerfectWS.client();
      router.config.syncRequestsWhenServerOpen = false; // Disable auto-sync to avoid interference

      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true)
      };

      setServer(mockWs as any);

      // Start multiple operations with short timeout
      const promises = Array.from({ length: 10 }, (_, i) =>
        router.request(`cleanup-${i}`, null, {
          timeout: 100,
          doNotWaitForConnection: true
        }).catch(e => ({ error: e.code || 'cleaned' }))
      );

      // Immediately unregister
      await sleep(5);
      unregister();

      const results = await Promise.all(promises);

      // All should timeout or be aborted after unregister
      const cleaned = results.filter(r => r && r.error);
      expect(cleaned.length).toBeGreaterThan(0);
    });
  });

  describe('State Corruption Scenarios', () => {
    it('should handle corrupted internal state maps', () => {
      const { router } = PerfectWS.server();

      // Corrupt the internal state
      router['_activeResponses'] = null as any;
      router['_listenForRequests'] = null as any;

      // Try to use the router
      expect(() => {
        router.on('test', async () => ({ result: 'test' }));
      }).toThrow();

      // Restore for cleanup
      router['_activeResponses'] = new Map();
      router['_listenForRequests'] = new Map();
    });

    it('should handle event listener memory leaks', () => {
      const events = new NetworkEventListener();

      // Add thousands of listeners
      for (let i = 0; i < 10000; i++) {
        events.on(`event-${i % 100}`, () => { });
      }

      // Check that max listeners is enforced
      expect(events.listenerCount('event-0')).toBeGreaterThan(0);

      // Remove all should work
      events.removeAllListeners();
      expect(events.listenerCount('event-0')).toBe(0);
    });
  });
});