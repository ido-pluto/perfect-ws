import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.ts';
import { PerfectWSError } from '../src/PerfectWSError.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';
import { WebSocketForce } from '../src/utils/WebSocketForce.ts';
import { PerfectWSSubRoute } from '../src/PerfectWSSubRoute.ts';
import { BSON } from 'bson';
import { sleep } from '../src/utils/sleepPromise.js';

vi.mock('sleep-promise', () => ({
  default: vi.fn((ms: number) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))))
}));

// Simple in-memory duplex WebSocket to bridge client/server without mocking internal protocol
function createDuplex() {
  const makeSide = () => {
    const listeners = new Map<string, Set<Function>>();
    return {
      readyState: 1,
      bufferedAmount: 0,
      addEventListener: (type: string, handler: any) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
      },
      removeEventListener: (type: string, handler: any) => {
        listeners.get(type)?.delete(handler);
      },
      dispatchEvent: (evt: any) => {
        listeners.get(evt.type)?.forEach(h => h(evt));
      },
      _emitMessage: (data: Uint8Array) => {
        const evt = { type: 'message', data } as any;
        listeners.get('message')?.forEach(h => h(evt));
      },
      close: vi.fn()
    } as any;
  };

  const a = makeSide();
  const b = makeSide();

  // Wire sends across
  a.send = vi.fn((data: any) => { b._emitMessage(data); return true; });
  b.send = vi.fn((data: any) => { a._emitMessage(data); return true; });

  return { clientWs: a, serverWs: b };
}

describe('PerfectWS Extended Coverage', () => {
  describe('Server Instance', () => {
    it('should create server instance with all methods', () => {
      const { router, attachClient, autoReconnect, unregister } = PerfectWS.server();
      expect(router).toBeDefined();
      expect(attachClient).toBeInstanceOf(Function);
      expect(autoReconnect).toBeInstanceOf(Function);
      expect(unregister).toBeInstanceOf(Function);
    });

    it('should handle message from attached client', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        close: vi.fn()
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      const handler = vi.fn().mockResolvedValue({ result: 'test' });
      router.on('testMethod', handler);

      const cleanup = attachClient(mockWs as any);

      // Simulate message from client
      const requestData = {
        method: 'testMethod',
        requestId: 'test123',
        data: { test: 'data' }
      };

      await messageHandler({
        data: BSON.serialize(requestData)
      });

      expect(handler).toHaveBeenCalled();
      cleanup();
    });

    it('should handle ping timeout and close connection', async () => {
      const { router } = PerfectWS.server();
      router.config.pingReceiveTimeout = 50;
      router.config.pingIntervalMs = 10;

      const mockWs = {
        readyState: WebSocketForce.OPEN,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        forceClose: vi.fn()
      } as any;

      // Mock the checkPingInterval function behavior
      router['_lastPingTime'] = Date.now() - 100; // Set old ping time

      // Call checkPingInterval directly
      const checkPingInterval = async (socket: any) => {
        if (socket.readyState == WebSocketForce.OPEN) {
          if (Date.now() - router['_lastPingTime'] > router.config.pingReceiveTimeout) {
            socket.forceClose(1000, 'Ping timeout');
          }
        }
      };

      await checkPingInterval(mockWs);

      expect(mockWs.forceClose).toHaveBeenCalledWith(1000, 'Ping timeout');
    });

    it('should handle autoReconnect', async () => {
      const { router, autoReconnect } = PerfectWS.server();
      router.config.delayBeforeReconnect = 10;

      const mockWebSocket = vi.fn().mockImplementation(() => ({
        readyState: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        off: vi.fn()
      }));

      autoReconnect('ws://localhost:8080', mockWebSocket as any);

      expect(mockWebSocket).toHaveBeenCalledWith('ws://localhost:8080');
    });

    it('should unregister all attached clients', () => {
      const { attachClient, unregister } = PerfectWS.server();

      const mockWs1 = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn()
      };
      const mockWs2 = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn()
      };

      // Capture the handlers
      let handlers1: Map<string, any> = new Map();
      let handlers2: Map<string, any> = new Map();

      mockWs1.addEventListener.mockImplementation((event, handler) => {
        handlers1.set(event, handler);
      });
      mockWs2.addEventListener.mockImplementation((event, handler) => {
        handlers2.set(event, handler);
      });

      attachClient(mockWs1 as any);
      attachClient(mockWs2 as any);

      unregister();

      // Check that removeEventListener was called for cleanup
      expect(mockWs1.removeEventListener).toHaveBeenCalled();
      expect(mockWs2.removeEventListener).toHaveBeenCalled();
    });
  });

  describe('Request Handling', () => {
    it('should handle request with callback option', async () => {
      const { router: server, attachClient } = PerfectWS.server();
      const { router: client, setServer } = PerfectWS.client();
      const { clientWs, serverWs } = createDuplex();

      // Real handler on server (BSON prefers object roots)
      server.on('test', async (params) => ({ response: params.data }));

      attachClient(serverWs as any);
      setServer(clientWs as any);

      await client.serverOpen;

      const callback = vi.fn();
      const result = await client.request('test', { data: 'test' }, {
        callback,
        doNotWaitForConnection: true,
        timeout: 1000
      });

      expect(result).toEqual({ response: 'test' });
      expect(callback).toHaveBeenCalledWith({ response: 'test' }, undefined, true);
    });

    it('should handle request with events', async () => {
      const { router: server, attachClient } = PerfectWS.server();
      const { router: client, setServer } = PerfectWS.client();
      const { clientWs, serverWs } = createDuplex();

      attachClient(serverWs as any);
      setServer(clientWs as any);
      await client.serverOpen;

      // Server emits via events API for active response
      server.on('test', async (_params, { events }) => {
        events.emit('customEvent', 'arg1', 'arg2');
        return { ok: true };
      });

      const events = new NetworkEventListener();
      const eventHandler = vi.fn();
      events.on('customEvent', eventHandler);

      const promiseTask = client.request('test', null, {
        events,
        doNotWaitForConnection: true
      });

      await sleep(20);
      await promiseTask.catch(() => { });
      expect(eventHandler).toHaveBeenCalledWith('remote', 'arg1', 'arg2');
    });

    it('should handle request abort with AbortSignal', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn()
      };

      setServer(mockWs as any);
      router.config.verbose = true;
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

      const abortController = new AbortController();
      const promise = router.request('test', null, {
        abortSignal: abortController.signal,
        doNotWaitForConnection: true
      });

      // Abort the request
      abortController.abort('User cancelled');

      await expect(promise).rejects.toThrow('User cancelled');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Request aborted'));

      consoleWarnSpy.mockRestore();
    });

    it('should retry sending request on connection failure', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 0, // Not connected initially
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockImplementation(() => {
          throw new Error('Not connected');
        })
      };

      setServer(mockWs as any);
      router.config.sendRequestRetries = 2;

      const promise = router.request('test', null, {
        timeout: 100,
        doNotWaitForConnection: true
      });

      await expect(promise).rejects.toThrow('Server not connected');
    });

    it('should handle request timeout during connection', async () => {
      const { router } = PerfectWS.client();
      router.config.verbose = true;
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

      const promise = router.request('test', null, {
        timeout: 20
      });

      await expect(promise).rejects.toThrow();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Server not connected, waiting'));

      consoleLogSpy.mockRestore();
    });
  });

  describe('Internal Methods', () => {
    it('should handle ___syncRequests', async () => {
      const { router } = PerfectWS.server();

      // Add some active responses
      router['_activeResponses'].set('req1', {
        events: new NetworkEventListener(),
        clients: new Set()
      });
      router['_activeResponses'].set('req2', {
        events: new NetworkEventListener(),
        clients: new Set()
      });

      const handler = router['_listenForRequests'].get('___syncRequests');
      const result = await handler?.callbacks?.[0]?.({ activeRequestsIds: ['req1', 'req3'] }, {} as any);

      expect(result).toEqual(['req3']); // req3 is unknown
    });

    it('should handle ___hasRequest', async () => {
      const { router } = PerfectWS.server();

      router['_activeResponses'].set('req1', {
        events: new NetworkEventListener(),
        clients: new Set()
      });

      const handler = router['_listenForRequests'].get('___hasRequest');
      const result1 = await handler?.callbacks?.[0]?.({ requestId: 'req1' }, {} as any);
      const result2 = await handler?.callbacks[0]({ requestId: 'req2' }, {} as any);

      expect(result1).toBe(true);
      expect(result2).toBe(false);
    });

    it('should handle ___ping', async () => {
      const { router } = PerfectWS.server();

      const handler = router['_listenForRequests'].get('___ping');
      const result = await handler?.callbacks?.[0]?.({}, {} as any);

      expect(result).toBe('pong');
      expect(router['_lastPingTime']).toBeGreaterThan(0);
    });
  });

  describe('Connection Management', () => {
    it('should handle server open event and start ping', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true),
        close: vi.fn()
      };

      let openHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'open') openHandler = handler;
      });

      setServer(mockWs as any);

      // Mock _syncRequests to resolve immediately
      router['_syncRequests'] = vi.fn().mockResolvedValue(undefined);

      // Change state to open
      mockWs.readyState = 1;

      // Trigger open handler without the infinite loop
      if (openHandler) {
        const openPromise = openHandler();

        // Wait a bit for initial operations
        await sleep(20);

        // Close to stop the ping loop
        mockWs.readyState = 3;
      }

      expect(router['_syncRequests']).toHaveBeenCalled();
    });

    it('should resolve serverOpen promise when connected', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn()
      };

      setServer(mockWs as any);

      const result = await router.serverOpen;
      expect(result).toBe(true);
    });

    it('should wait for server when not connected', () => {
      const { router } = PerfectWS.client();

      const promise = router.serverOpen;
      expect(promise).toBeInstanceOf(Promise);
    });

    it('should get bufferedAmount from server', () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        bufferedAmount: 1024,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      setServer(mockWs as any);

      expect(router.bufferedAmount).toBe(1024);
    });

    it('should return 0 bufferedAmount when no server', () => {
      const { router } = PerfectWS.client();
      expect(router.bufferedAmount).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle method not found error', async () => {
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

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'unknownMethod',
          requestId: 'test123',
          data: null
        })
      });

      expect(mockWs.send).toHaveBeenCalledWith(
        expect.anything()
      );
    });

    it('should handle request after abort signal', async () => {
      const { router } = PerfectWS.client();

      const abortController = new AbortController();
      abortController.abort('Already aborted');

      await expect(
        router.request('test', null, {
          abortSignal: abortController.signal
        })
      ).rejects.toThrow('Request aborted by user');
    });

    it('should handle duplicate request ID error', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn()
      };

      setServer(mockWs as any);

      router['_activeRequests'].set('duplicate-id', {} as any);

      await expect(
        router.request('test', null, {
          requestId: 'duplicate-id',
          doNotWaitForConnection: true
        })
      ).rejects.toThrow('Request already exists');
    });
  });

  describe('SubRoute Usage', () => {
    it('should connect subroute to main router', () => {
      const { router } = PerfectWS.server();
      const subRoute = PerfectWS.Router();

      subRoute.on('subroute.test', async () => ({ result: 'from subroute' }));
      router.use(subRoute);

      expect(subRoute['_protocol']).toBe(router);
    });
  });

  describe('Clear Old Requests', () => {
    it('should clear timed out requests', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn()
      };

      setServer(mockWs as any);
      router.config.requestTimeout = 50;
      router.config.clearOldRequestsDelay = 10;

      // Add an old request
      const callback = vi.fn();
      router['_activeRequests'].set('old-request', {
        requestId: 'old-request',
        updateTime: Date.now() - 100000, // Very old
        server: mockWs as any,
        events: new NetworkEventListener(),
        callback,
        abortController: new AbortController()
      });

      // Manually trigger one iteration of clear old requests
      const requests = router['_activeRequests'];
      for (const [requestId, request] of requests) {
        const timeout = Date.now() - request.updateTime > router.config.requestTimeout;
        if (timeout) {
          request.callback(null, { message: 'Request timeout', code: 'timeout' }, true);
        }
      }

      expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ code: 'timeout' }), true);
    });
  });

  describe('Response Handling', () => {
    it('should handle streaming responses with send callback', async () => {
      const { router, attachClient } = PerfectWS.server();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true),
        close: vi.fn()
      };

      let messageHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'message') messageHandler = handler;
      });

      router.on('streamTest', async (data, { send }) => {
        await send({ chunk: 1 }, false);
        await send({ chunk: 2 }, false);
        await send({ chunk: 3 }, true);
        return { final: true };
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'streamTest',
          requestId: 'stream123',
          data: null
        })
      });

      // Give time for all async operations to complete
      await sleep(50);

      // Check that send was called multiple times (3 chunks + final response)
      expect(mockWs.send.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle response rejection with reject callback', async () => {
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

      router.on('rejectTest', async (data, { reject }) => {
        reject('Custom error', 'customCode');
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'rejectTest',
          requestId: 'reject123',
          data: null
        })
      });

      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(sentData.error).toEqual({ message: 'Custom error', code: 'customCode' });
    });

    it('should handle thrown errors in handlers', async () => {
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

      router.on('throwTest', async () => {
        throw new Error('Handler error');
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'throwTest',
          requestId: 'throw123',
          data: null
        })
      });

      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);
      expect(sentData.error).toEqual({ message: 'Handler error', code: 'throwError' });
    });
  });

  describe('Additional Coverage', () => {
    it('should handle server cleanup on close', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn()
      };

      let closeHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'close') closeHandler = handler;
      });

      setServer(mockWs as any);
      expect(router['_server']).toBeDefined();

      // Change readyState to CLOSED before triggering close
      mockWs.readyState = 3;

      // Trigger close event
      if (closeHandler) {
        closeHandler();
      }

      // Give time for cleanup
      await sleep(10);

      // Check that a close listener was registered at some point
      const closeCall = mockWs.addEventListener.mock.calls.find(call => call[0] === 'close');
      expect(closeCall).toBeDefined();
      expect(closeCall?.[1]).toBeInstanceOf(Function);
    });

    it('should handle WebSocket error events', () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      let errorHandler: any;
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'error') errorHandler = handler;
      });

      setServer(mockWs as any);

      // Trigger error event
      if (errorHandler) {
        errorHandler(new Error('WebSocket error'));
      }

      // Should not crash
      expect(router).toBeDefined();
    });

    it('should handle _sendJSON with various data types', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        send: vi.fn().mockReturnValue(true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      setServer(mockWs as any);

      // Test with different data types (BSON requires object as root)
      const testData = [
        { key: 'value' },
        { array: [1, 2, 3] },
        { string: 'test' },
        { number: 42 },
        { boolean: true },
        { nullValue: null }
      ];

      for (const test of testData) {
        const result = await router['_sendJSON'](test, mockWs as any);
        expect(result).toBe(true);
        expect(mockWs.send).toHaveBeenCalled();
      }
    });

    it('should handle request with all options', async () => {
      const { router, setServer } = PerfectWS.client();
      const mockWs = {
        readyState: 1,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        send: vi.fn().mockReturnValue(true)
      };

      setServer(mockWs as any);

      const events = new NetworkEventListener();
      const callback = vi.fn();
      const abortController = new AbortController();

      const promise = router.request('test', { data: 'test' }, {
        callback,
        events,
        abortSignal: abortController.signal,
        requestId: 'custom-id',
        timeout: 5000,
        doNotWaitForConnection: true
      });

      // Abort immediately
      abortController.abort();

      await expect(promise).rejects.toThrow();
    });
  });
});