import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerfectWS } from '../src/PerfectWS';
import { BSON } from 'bson';
import { NetworkEventListener } from '../src/utils/NetworkEventListener';
import { sleep } from '../src/utils/sleepPromise.js';

// Mock WebSocket
const mockWebSocket = vi.fn();

// Helper to create mock WebSocket instance
function createMockWs(overrides = {}) {
  return {
    readyState: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    forceClose: vi.fn(),
    setMaxListeners: vi.fn(),
    on: vi.fn(),
    ...overrides
  };
}

describe('PerfectWS Full Coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setMaxListeners coverage', () => {
    it('should call setMaxListeners when available on server', () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = createMockWs({
        setMaxListeners: vi.fn()
      });

      setServer(mockWs as any);
      expect(mockWs.setMaxListeners).toHaveBeenCalledWith(router.config.maxListeners);
    });

    it('should handle server without setMaxListeners', () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = createMockWs();
      delete mockWs.setMaxListeners;

      expect(() => setServer(mockWs as any)).not.toThrow();
    });

    it('should handle setMaxListeners not being a function', () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = createMockWs({
        setMaxListeners: 'not-a-function'
      });

      expect(() => setServer(mockWs as any)).not.toThrow();
    });
  });

  describe('Verbose logging coverage', () => {
    it('should log when verbose is enabled and server not connected', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { router, setServer } = PerfectWS.client();
      router.config.verbose = true;

      const mockWs = createMockWs({ readyState: 0 });
      setServer(mockWs as any);

      const promise = router.request('test', null, {
        doNotWaitForConnection: true
      });

      await expect(promise).rejects.toThrow('Server not connected');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PerfectWS] Server not connected')
      );
    });

    it('should log abort warning when verbose enabled', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { router, setServer } = PerfectWS.client();
      router.config.verbose = true;

      const mockWs = createMockWs();
      setServer(mockWs as any);

      const abortController = new AbortController();
      const promise = router.request('test', null, {
        abortSignal: abortController.signal,
        doNotWaitForConnection: true
      });

      // Wait for request to be registered
      await sleep(10);
      abortController.abort();

      await expect(promise).rejects.toThrow();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PerfectWS] Request aborted')
      );
    });
  });

  describe('Error handling in _sendData', () => {
    it('should handle send throwing an error', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = createMockWs({
        send: vi.fn().mockImplementation(() => {
          throw new Error('Send failed');
        })
      });

      setServer(mockWs as any);

      const result = router['_sendData']('test', mockWs as any);
      expect(result).toBe(false);
    });

    it('should return false when server is null', () => {
      const { router } = PerfectWS.client();
      const result = router['_sendData']('test', null as any);
      expect(result).toBe(false);
    });
  });

  describe('Server-side send logic coverage', () => {
    it('should handle sendJSON with allowPackageLoss true', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      router.on('streamTest', async (data, { send }) => {
        await send({ chunk: 1 }, false, true); // allowPackageLoss = true
        await send({ chunk: 2 }, false, true);
        return { done: true };
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'streamTest',
          requestId: 'test123',
          data: null
        })
      });

      await sleep(50);
      expect(mockWs.send).toHaveBeenCalled();
    });

    it('should handle sendJSON serialization errors', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      // Override serializeRequestData to throw
      router['serializeRequestData'] = () => {
        throw new Error('Serialization failed');
      };

      router.on('failTest', async (data, { send }) => {
        const result = await send({ data: 'test' }, true);
        return { result };
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'failTest',
          requestId: 'fail123',
          data: null
        })
      });

      await sleep(50);
    });

    it('should handle timeout while waiting for client reconnection', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;
      let closeHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
        if (event === 'close') closeHandler = handler;
      });

      router.config.requestTimeout = 100; // Short timeout

      router.on('longTest', async (data, { send, abortSignal }) => {
        await sleep(50);
        if (abortSignal.aborted) {
          return { aborted: true };
        }
        await send({ interim: true }, false);
        await sleep(200); // This will timeout
        return { done: true };
      });

      attachClient(mockWs as any);

      const requestPromise = messageHandler({
        data: BSON.serialize({
          method: 'longTest',
          requestId: 'long123',
          data: null
        })
      });

      // Simulate disconnect
      await sleep(20);
      closeHandler();

      await requestPromise;
      await sleep(150);
    });

    it('should handle ___abort event in _onRequest', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      let abortSignalReceived: AbortSignal | null = null;
      router.on('abortableTest', async (data, { abortSignal }) => {
        abortSignalReceived = abortSignal;
        await sleep(1000);
        return { completed: !abortSignal.aborted };
      });

      attachClient(mockWs as any);

      // Start request
      const requestPromise = messageHandler({
        data: BSON.serialize({
          method: 'abortableTest',
          requestId: 'abort123',
          data: null
        })
      });

      await sleep(10);

      // Send abort event
      await messageHandler({
        data: BSON.serialize({
          requestId: 'abort123',
          event: { eventName: '___abort', args: ['User cancelled'] }
        })
      });

      await requestPromise;
      expect(abortSignalReceived!?.aborted || false).toBe(true);
    });

    it('should handle unknown event for non-existent request', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      attachClient(mockWs as any);

      // Send event for non-existent request
      await messageHandler({
        data: BSON.serialize({
          requestId: 'unknown123',
          event: { eventName: 'customEvent', args: ['test'] }
        })
      });

      // Should send error response
      await sleep(10);
      expect(mockWs.send).toHaveBeenCalled();
      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(sentData.error).toBeDefined();
      expect(sentData.error.code).toBe('requestNotFound');
    });

    it('should handle callback error with custom code', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      router.on('errorTest', async (data, { reject }) => {
        reject('Custom error message', 'CUSTOM_CODE');
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'errorTest',
          requestId: 'error123',
          data: null
        })
      });

      await sleep(10);
      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(sentData.error.message).toBe('Custom error message');
      expect(sentData.error.code).toBe('CUSTOM_CODE');
    });

    it('should handle thrown error without code in handler', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      router.on('throwTest', async () => {
        const error = new Error('Test error');
        throw error;
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'throwTest',
          requestId: 'throw123',
          data: null
        })
      });

      await sleep(10);
      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(sentData.error.message).toBe('Test error');
      expect(sentData.error.code).toBe('throwError');
    });

    it('should handle thrown error with code in handler', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      router.on('throwCodeTest', async () => {
        const error: any = new Error('Test error with code');
        error.code = 'SPECIFIC_ERROR';
        throw error;
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'throwCodeTest',
          requestId: 'throwCode123',
          data: null
        })
      });

      await sleep(10);
      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(sentData.error.message).toBe('Test error with code');
      expect(sentData.error.code).toBe('SPECIFIC_ERROR');
    });
  });

  describe('Clear old requests timeout logic', () => {
    it('should handle timeout check with closed server', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = createMockWs({ readyState: 3 }); // CLOSED
      setServer(mockWs as any);

      // Add an old request
      const events = new NetworkEventListener();
      const callback = vi.fn();
      router['_activeRequests'].set('old-request', {
        requestId: 'old-request',
        updateTime: Date.now() - router.config.requestTimeout - 1000,
        server: mockWs as any,
        events,
        callback,
        abortController: new AbortController()
      });

      // Trigger clear old requests
      router['_clearOldRequests']();

      // Wait for the timeout to be processed
      await sleep(50);

      expect(callback).toHaveBeenCalledWith(
        null,
        { message: 'Request timeout', code: 'timeout' },
        true
      );
    });

    it('should check hasRequestRemote for open connections', async () => {
      const { router, setServer } = PerfectWS.client();
      router.config.syncRequestsWhenServerOpen = false; // Disable auto-sync to avoid interference
      const mockWs = createMockWs();
      let messageHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      setServer(mockWs as any);

      // Add an old request
      const events = new NetworkEventListener();
      const callback = vi.fn((data, error, down) => {
        // Simulate real callback behavior - remove request when down is true
        if (down) {
          router['_activeRequests'].delete('old-request');
        }
      });
      router['_activeRequests'].set('old-request', {
        requestId: 'old-request',
        updateTime: Date.now() - router.config.requestTimeout - 1000,
        server: mockWs as any,
        events,
        callback,
        abortController: new AbortController()
      });

      // Trigger clear old requests
      router['_clearOldRequests']();

      // Wait for ___hasRequest to be sent
      await sleep(50);

      // Respond that server doesn't have the request
      const hasRequestCall = mockWs.send.mock.calls.find(call => {
        const data = BSON.deserialize(call[0]);
        return data.method === '___hasRequest';
      });

      if (hasRequestCall) {
        const requestData = BSON.deserialize(hasRequestCall[0]);
        await messageHandler({
          data: BSON.serialize({
            requestId: requestData.requestId,
            data: false,
            down: true
          })
        });
      }

      await sleep(50);
      expect(callback).toHaveBeenCalledWith(
        null,
        { message: 'Request timeout', code: 'timeout' },
        true
      );
    });

    it('should handle hasRequestRemote throwing error', async () => {
      const { router, setServer } = PerfectWS.client();
      router.config.syncRequestsWhenServerOpen = false; // Disable auto-sync to avoid interference
      const mockWs = createMockWs();
      setServer(mockWs as any);

      // Override hasRequest to throw
      router['hasRequest'] = vi.fn().mockRejectedValue(new Error('Network error'));

      // Add an old request
      const events = new NetworkEventListener();
      const callback = vi.fn((data, error, down) => {
        // Simulate real callback behavior - remove request when down is true
        if (down) {
          router['_activeRequests'].delete('old-request');
        }
      });
      router['_activeRequests'].set('old-request', {
        requestId: 'old-request',
        updateTime: Date.now() - router.config.requestTimeout - 1000,
        server: mockWs as any,
        events,
        callback,
        abortController: new AbortController()
      });

      // Trigger clear old requests
      router['_clearOldRequests']();

      await sleep(100);
      expect(callback).toHaveBeenCalledWith(
        null,
        { message: 'Request timeout', code: 'timeout' },
        true
      );
    });
  });

  describe('checkPingInterval coverage', () => {
    it('should handle ping timeout and force close socket', async () => {
      const { autoReconnect, router } = PerfectWS.server();
      router.config.pingIntervalMs = 50;
      router.config.pingReceiveTimeout = 100; // Much shorter timeout

      const WebSocketMock = vi.fn();
      const mockWs = {
        readyState: 1, // OPEN
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        forceClose: vi.fn(),
        close: vi.fn(),
        on: vi.fn()
      };

      WebSocketMock.mockImplementation(() => mockWs);

      // Use autoReconnect which triggers checkPingInterval
      autoReconnect('ws://localhost:1234', WebSocketMock as any);

      // Wait for ping timeout
      await sleep(200);

      expect(mockWs.forceClose).toHaveBeenCalledWith(1000, 'Ping timeout');
    });

    it('should keep connection alive when pings are received', async () => {
      const { autoReconnect, router } = PerfectWS.server();
      router.config.pingIntervalMs = 50;
      router.config.pingReceiveTimeout = 150;

      const WebSocketMock = vi.fn();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        forceClose: vi.fn(),
        close: vi.fn(),
        on: vi.fn()
      };

      WebSocketMock.mockImplementation(() => mockWs);
      autoReconnect('ws://localhost:1234', WebSocketMock as any);

      // Simulate receiving pings periodically
      const pingInterval = setInterval(() => {
        router['_lastPingTime'] = Date.now();
      }, 40);

      await sleep(200);

      clearInterval(pingInterval);

      // Should not have force closed
      expect(mockWs.forceClose).not.toHaveBeenCalled();

      // Now stop pings and wait for timeout
      await sleep(200);

      expect(mockWs.forceClose).toHaveBeenCalledWith(1000, 'Ping timeout');
    });

    it('should exit loop when socket closes normally', async () => {
      const { autoReconnect, router } = PerfectWS.server();
      router.config.pingIntervalMs = 50;
      router.config.pingReceiveTimeout = 5000;

      const WebSocketMock = vi.fn();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        forceClose: vi.fn(),
        close: vi.fn(),
        on: vi.fn()
      };

      WebSocketMock.mockImplementation(() => mockWs);
      autoReconnect('ws://localhost:1234', WebSocketMock as any);

      // Keep pinging
      router['_lastPingTime'] = Date.now();

      // Close socket normally after 100ms
      setTimeout(() => {
        mockWs.readyState = 3; // CLOSED
      }, 100);

      await sleep(200);

      // Should not have force closed
      expect(mockWs.forceClose).not.toHaveBeenCalled();
    });
  });

  describe('autoReconnect coverage', () => {
    it('should handle autoReconnect with WebSocketForce instance', async () => {
      const { autoReconnect, router } = PerfectWS.server();
      router.config.delayBeforeReconnect = 50;
      router.config.pingIntervalMs = 50;
      router.config.pingReceiveTimeout = 100;

      const WebSocketForce = vi.fn();
      let closeHandler: any;
      const mockInstance = {
        readyState: 1,
        addEventListener: vi.fn((event, handler) => {
          if (event === 'close') closeHandler = handler;
        }),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        forceClose: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'close') closeHandler = handler;
        })
      };

      WebSocketForce.mockImplementation(() => mockInstance);

      autoReconnect('ws://localhost:1234', WebSocketForce as any);

      expect(WebSocketForce).toHaveBeenCalledWith('ws://localhost:1234');

      // Simulate close event
      await sleep(50);
      if (closeHandler) {
        const reconnectPromise = closeHandler();

        // Wait for delay before reconnect
        await sleep(100);

        // Should create new connection
        expect(WebSocketForce).toHaveBeenCalledTimes(2);
      }
    });

    it('should handle cleanup function returned by attachClient', () => {
      const { attachClient } = PerfectWS.server();
      const mockWs = createMockWs();

      const cleanup = attachClient(mockWs as any);
      expect(typeof cleanup).toBe('function');

      // Call cleanup
      cleanup();

      expect(mockWs.removeEventListener).toHaveBeenCalled();
    });

    it('should handle unregister removing cleanup from array', () => {
      const { attachClient, unregister } = PerfectWS.server();
      const mockWs1 = createMockWs();
      const mockWs2 = createMockWs();

      const cleanup1 = attachClient(mockWs1 as any);
      const cleanup2 = attachClient(mockWs2 as any);

      // Remove first client
      cleanup1();

      // Now unregister all
      unregister();

      // Only second client should be cleaned up by unregister
      expect(mockWs2.removeEventListener).toHaveBeenCalled();
    });

    it('should handle autoReconnect without delay', async () => {
      const { autoReconnect, router } = PerfectWS.server();
      router.config.delayBeforeReconnect = 0; // No delay
      router.config.pingIntervalMs = 50;
      router.config.pingReceiveTimeout = 100;

      const WebSocketMock = vi.fn();
      let closeHandler: any;
      const mockInstance = {
        readyState: 1,
        addEventListener: vi.fn((event, handler) => {
          if (event === 'close') closeHandler = handler;
        }),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        forceClose: vi.fn(),
        on: vi.fn((event, handler) => {
          if (event === 'close') closeHandler = handler;
        })
      };

      WebSocketMock.mockImplementation(() => mockInstance);

      autoReconnect('ws://localhost:1234', WebSocketMock as any);

      // Simulate close event
      if (closeHandler) {
        await closeHandler();

        // Should immediately create new connection (no delay)
        expect(WebSocketMock).toHaveBeenCalledTimes(2);
      }
    });
  });

  describe('Edge cases and race conditions', () => {
    it('should handle close during _setServer', () => {
      const { setServer } = PerfectWS.client();

      const oldWs = createMockWs();
      oldWs.close.mockImplementation(() => {
        throw new Error('Close failed');
      });

      // Set initial server
      setServer(oldWs as any);

      const newWs = createMockWs();

      // Should not throw when closing old server fails
      expect(() => setServer(newWs as any)).not.toThrow();
    });

    it('should handle request finished during reconnection check', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = createMockWs();
      let messageHandler: any;
      let closeHandler: any;

      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
        if (event === 'close') closeHandler = handler;
      });

      setServer(mockWs as any);

      // Start a request
      const promise = router.request('test', { data: 'test' }, {
        timeout: 5000
      });

      await sleep(10);

      // Trigger close to start reconnection
      if (closeHandler) {
        closeHandler();
      }

      // Mark request as finished immediately
      const requestId = Array.from(router['_activeRequests'].keys())[0];
      const request = router['_activeRequests'].get(requestId);
      if (request) {
        request.finished = true;
      }

      // Reconnect with new server
      const newWs = createMockWs();
      newWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });
      setServer(newWs as any);

      // Respond to sync requests
      await sleep(10);
      const syncCall = newWs.send.mock.calls.find(call => {
        const data = BSON.deserialize(call[0]);
        return data.method === '___syncRequests';
      });

      if (syncCall && messageHandler) {
        const syncData = BSON.deserialize(syncCall[0]);
        await messageHandler({
          data: BSON.serialize({
            requestId: syncData.requestId,
            data: [],
            down: true
          })
        });
      }
    });

    it('should handle multiple rapid setServer calls', async () => {
      const { setServer } = PerfectWS.client();

      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const ws3 = createMockWs();

      // Rapid successive calls
      setServer(ws1 as any);
      setServer(ws2 as any);
      setServer(ws3 as any);

      // Should clean up previous servers
      expect(ws1.removeEventListener).toHaveBeenCalled();
      expect(ws2.removeEventListener).toHaveBeenCalled();
    });
  });
});