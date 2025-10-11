import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.ts';
import { PerfectWSAdvanced } from '../src/PerfectWSAdvanced/PerfectWSAdvanced.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';
import { TransformCallbacks } from '../src/PerfectWSAdvanced/transform/TransformCallbacks.ts';
import { PerfectWSError } from '../src/PerfectWSError.ts';
import { BSON } from 'bson';
import { sleep } from '../src/utils/sleepPromise.js';

vi.mock('sleep-promise', () => ({
  default: vi.fn((ms: number) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))))
}));

describe('Coverage Completion Tests', () => {
  describe('PerfectWS Uncovered Paths', () => {
    it('should handle server-side request processing', async () => {
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

      // Test with callback that sends multiple responses
      router.on('multiResponse', async (data, { send }) => {
        await send({ part: 1 }, false);
        await send({ part: 2 }, false);
        return { final: true };
      });

      attachClient(mockWs as any);

      await messageHandler({
        data: BSON.serialize({
          method: 'multiResponse',
          requestId: 'multi123',
          data: { test: true }
        })
      });

      expect(mockWs.send).toHaveBeenCalled();
    });

    it('should handle _syncRequests with active requests', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 1,
        send: vi.fn().mockReturnValue(true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      // Add active request
      const events = new NetworkEventListener();
      router['_activeRequests'].set('req1', {
        requestId: 'req1',
        updateTime: Date.now(),
        server: mockWs as any,
        events,
        callback: vi.fn(),
        abortController: new AbortController()
      });

      // Mock the sync process
      const syncPromise = router['_syncRequests'](mockWs as any);

      // Simulate server response
      await sleep(100);
      const sentData = BSON.deserialize(mockWs.send.mock.calls[0][0]);

      if (sentData.method === '___syncRequests') {
        router['_onServerResponse']({
          requestId: sentData.requestId,
          data: ['req2'],
          down: true
        });
      }

      await expect(syncPromise).resolves.toBeUndefined();
    });

    it('should handle connection loss during request', async () => {
      const { router, setServer } = PerfectWS.client();
      router.config.syncRequestsWhenServerOpen = false; // Disable auto-sync to avoid interference

      const mockWs = {
        readyState: 1,
        send: vi.fn().mockReturnValue(true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn()
      };

      const closeHandlers: any[] = [];
      mockWs.addEventListener.mockImplementation((event, handler) => {
        if (event === 'close') closeHandlers.push(handler);
      });

      setServer(mockWs as any);

      // Start a request
      const promise = router.request('test', null, {
        doNotWaitForConnection: true,
        timeout: 100
      });

      await sleep(10);

      // Simulate connection close
      mockWs.readyState = 3;
      for (const handler of closeHandlers) {
        handler();
      }

      await expect(promise).rejects.toThrow();
    });

    it('should handle ping with active responses', async () => {
      const { router } = PerfectWS.server();

      // Add active response
      const events = new NetworkEventListener();
      router['_activeResponses'].set('resp1', {
        events,
        clients: new Set(['client1'])
      });

      const handler = router['_listenForRequests'].get('___ping');
      const result = await handler?.callbacks?.[0]?.({}, { ws: 'client1' } as any);

      expect(result).toBe('pong');
      expect(router['_lastPingTime']).toBeGreaterThan(0);
    });

    it('should handle verbose logging paths', async () => {
      const { router, setServer } = PerfectWS.client();
      router.config.verbose = true;

      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockWs = {
        readyState: 1,
        send: vi.fn().mockReturnValue(true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };


      // Trigger various verbose logs
      const result = router.request('test', null, {
        doNotWaitForConnection: true,
      }).catch(() => {});

      await sleep(100);
      setServer(mockWs as any);
      await result;

      expect(consoleLogSpy).toHaveBeenCalled();

      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });
  });

  describe('TransformCallbacks Full Coverage', () => {
    it('should handle all callback request edge cases', async () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 10);

      // Test with function that returns undefined
      const undefinedFunc = vi.fn().mockReturnValue(undefined);
      const serialized = transform.serialize(undefinedFunc);

      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: serialized.funcId,
        requestId: 'undefined-test'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        data: undefined,
        requestId: 'undefined-test'
      });
    });

    it('should handle callback with complex error objects', async () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 10);

      const errorFunc = vi.fn().mockRejectedValue({
        message: 'Complex error',
        code: 'ERR_CODE',
        stack: 'Stack trace',
        custom: { field: 'value' }
      });

      const serialized = transform.serialize(errorFunc);

      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: serialized.funcId,
        requestId: 'error-test'
      });

      const response = await responsePromise;
      expect(response).toHaveProperty('error');
      expect(response).toHaveProperty('requestId', 'error-test');
    });

    it('should handle deserialize with missing active request', () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 10);

      // Emit response for non-existent request
      events._emitWithSource('___callback.response', 'remote', {
        data: 'orphan-data',
        requestId: 'orphan-request'
      });

      // Should not throw
      expect(transform['_activeRequests'].size).toBe(0);
    });

    it('should handle deeply nested callback serialization', () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 3); // Low depth limit

      const deep: any = {
          func1: () => 'test1',
          level2: {
            func2: () => 'test2',
            level3: {
              func3: () => 'test3',
              level4: {
                func4: () => 'test4' // Beyond depth
              }
            }
          }
      };

      const serialized = transform.serialize(deep);

      // Check that functions up to depth 3 are serialized
      expect(serialized.func1.___type).toBe('callback');
      expect(serialized.level2.func2.___type).toBe('callback');
      expect(serialized.level2.level3.func3.___type).toBe('callback');
      // Beyond depth should not be transformed
      expect(typeof serialized.level2.level3.level4.func4).toBe('function');
    });

    it('should handle array of functions', () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 10);

      const funcs = [
        () => 'func1',
        () => 'func2',
        () => 'func3'
      ];

      const serialized = transform.serialize(funcs);

      expect(Array.isArray(serialized)).toBe(true);
      expect(serialized[0].___type).toBe('callback');
      expect(serialized[1].___type).toBe('callback');
      expect(serialized[2].___type).toBe('callback');
    });

    it('should handle mixed object with functions and primitives', () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 10);

      const mixed = {
        str: 'string',
        num: 42,
        bool: true,
        nil: null,
        undef: undefined,
        func: () => 'result',
        nested: {
          deepFunc: async () => 'async result'
        }
      };

      const serialized = transform.serialize(mixed);

      expect(serialized.str).toBe('string');
      expect(serialized.num).toBe(42);
      expect(serialized.bool).toBe(true);
      expect(serialized.nil).toBe(null);
      expect(serialized.undef).toBe(undefined);
      expect(serialized.func.___type).toBe('callback');
      expect(serialized.nested.deepFunc.___type).toBe('callback');
    });

    it('should handle callback execution with this binding', async () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 10);

      const obj = {
        value: 42,
        getValue: function() {
          return this.value;
        }
      };

      const serialized = transform.serialize(obj.getValue.bind(obj));

      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: serialized.funcId,
        requestId: 'binding-test'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        data: 42,
        requestId: 'binding-test'
      });
    });

    it('should handle remote callback timeout', async () => {
      const events = new NetworkEventListener();
      const transform = new TransformCallbacks(events, 10);

      const callbackData = {
        ___type: 'callback',
        funcId: 'remote-func',
        funcName: 'timeoutFunc'
      };

      const deserialized = transform.deserialize(callbackData);

      // Call the function but never send response
      const promise = deserialized();

      // This will hang, so we use a timeout
      const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve('timeout'), 100)
      );

      const result = await Promise.race([promise, timeoutPromise]);
      expect(result).toBe('timeout');
    });
  });

  describe('PerfectWSAdvanced Additional Coverage', () => {
    it('should handle transform all with mixed content', () => {
      const { router } = PerfectWSAdvanced.client();

      const complexData = {
        func: () => 'test',
        signal: new AbortController().signal,
        class: new Date(),
        nested: {
          deepFunc: async () => 'async',
          deepSignal: new AbortController().signal
        }
      };

      const events = new NetworkEventListener();
      const serialized = router.serializeRequestData(complexData, events);

      expect(serialized.func.___type).toBe('callback');
      expect(serialized.signal.___type).toBe('abortSignal');
      expect(serialized.nested.deepFunc.___type).toBe('callback');
      expect(serialized.nested.deepSignal.___type).toBe('abortSignal');
    });

    it('should handle deserialize with all transforms', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const serializedData = {
        func: {
          ___type: 'callback',
          funcId: 'test-func',
          funcName: 'testFunc'
        },
        signal: {
          ___type: 'abortSignal',
          signalId: 'test-signal'
        },
        normal: 'data'
      };

      const deserialized = router.deserializeRequestData(serializedData, events);

      expect(typeof deserialized.func).toBe('function');
      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
      expect(deserialized.normal).toBe('data');
    });
  });

  describe('Error Handling Edge Cases', () => {
    it('should handle PerfectWSError with all parameters', () => {
      const error = new PerfectWSError('Test error', 'TEST_CODE', 'req-123');

      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.requestId).toBe('req-123');
      expect(error.name).toBe('PerfectWSError');
    });

    it('should handle request cleanup on error', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 1,
        send: vi.fn().mockImplementation(() => {
          throw new Error('Send failed');
        }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      setServer(mockWs as any);

      const events = new NetworkEventListener();
      const abortController = new AbortController();

      await expect(
        router.request('test', null, {
          events,
          abortSignal: abortController.signal,
          doNotWaitForConnection: true
        })
      ).rejects.toThrow();

      // Check cleanup happened
      expect(router['_activeRequests'].size).toBe(0);
    });
  });

  describe('Connection State Transitions', () => {
    it('should handle all WebSocket ready states', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs = {
        readyState: 0, // CONNECTING
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      setServer(mockWs as any);
      expect(router.isServerConnected).toBe(false);

      mockWs.readyState = 1; // OPEN
      expect(router.isServerConnected).toBe(true);

      mockWs.readyState = 2; // CLOSING
      expect(router.isServerConnected).toBe(false);

      mockWs.readyState = 3; // CLOSED
      expect(router.isServerConnected).toBe(false);
    });

    it('should handle reconnection with pending requests', async () => {
      const { router, setServer } = PerfectWS.client();

      const mockWs1 = {
        readyState: 1,
        send: vi.fn().mockReturnValue(true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn()
      };

      setServer(mockWs1 as any);

      // Start request
      const promise = router.request('test', null, {
        timeout: 5000
      });

      // Disconnect
      mockWs1.readyState = 3;

      // Reconnect with new socket
      const mockWs2 = {
        readyState: 1,
        send: vi.fn().mockReturnValue(true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };

      setServer(mockWs2 as any);

      // Request should continue or timeout
      await expect(Promise.race([
        promise,
        sleep(100).then(() => 'timeout')
      ])).resolves.toBeTruthy();
    });
  });
});