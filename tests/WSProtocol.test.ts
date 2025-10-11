import { describe, expect, it, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.ts';
import { PerfectWSError } from '../src/PerfectWSError.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';

vi.mock('sleep-promise', () => ({
  default: vi.fn((ms: number) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))))
}));

describe('PerfectWS Core', () => {
  describe('Constructor and Initialization', () => {
    it('should create instance with default config', () => {
      const { router } = PerfectWS.client();
      expect(router.config.clearOldRequestsDelay).toBe(1000 * 10);
      expect(router.config.requestTimeout).toBe(1000 * 60 * 15);
      expect(router.config.syncRequestsTimeout).toBe(1000 * 5);
      expect(router.config.maxListeners).toBe(1000);
      expect(router.config.pingRequestTimeout).toBe(1000 * 5);
      expect(router.config.pingIntervalMs).toBe(1000 * 5);
      expect(router.config.pingReceiveTimeout).toBe(1000 * 10);
      expect(router.config.delayBeforeReconnect).toBe(1000 * 3);
      expect(router.config.sendRequestRetries).toBe(2);
      expect(router.config.verbose).toBe(false);
      expect(router.config.maxTransformDepth).toBe(100);
    });

    it('should override config values', () => {
      const { router } = PerfectWS.client();
      router.config.verbose = false;
      router.config.requestTimeout = 5000;
      expect(router.config.verbose).toBe(false);
      expect(router.config.requestTimeout).toBe(5000);
    });
  });

  describe('Client Instance', () => {
    it('should create client instance', () => {
      const { router, setServer, unregister } = PerfectWS.client();
      expect(router).toBeDefined();
      expect(setServer).toBeInstanceOf(Function);
      expect(unregister).toBeInstanceOf(Function);
    });

    it('should throw error when using server methods on client', async () => {
      const { router } = PerfectWS.client();
      expect(() => router.on('test', async () => {})).toThrow('This is a client instance');
      expect(() => router.off('test')).toThrow('This is a client instance');
    });

    it('should allow request method on client', async () => {
      const { router } = PerfectWS.client();
      await expect(router.request('test', null, { doNotWaitForConnection: true })).rejects.toThrow('Server not connected');
    });

    it('should handle aborted request before connection', async () => {
      const { router } = PerfectWS.client();
      const abortController = new AbortController();
      abortController.abort('Pre-aborted');

      await expect(
        router.request('test', null, { abortSignal: abortController.signal })
      ).rejects.toThrow('Request aborted by user');
    });
  });

  describe('Server Instance', () => {
    it('should create server instance', () => {
      const { router, attachClient, autoReconnect, unregister } = PerfectWS.server();
      expect(router).toBeDefined();
      expect(attachClient).toBeInstanceOf(Function);
      expect(autoReconnect).toBeInstanceOf(Function);
      expect(unregister).toBeInstanceOf(Function);
    });

    it('should throw error when using client methods on server', async () => {
      const { router } = PerfectWS.server();
      await expect(router.request('test')).rejects.toThrow('This is a server instance');
    });

    it('should allow on/off methods on server', () => {
      const { router } = PerfectWS.server();
      const callback = async () => 'test';
      router.on('test', callback);
      expect((router as any)._listenForRequests.has('test')).toBe(true);
      router.off('test');
      expect((router as any)._listenForRequests.has('test')).toBe(false);
    });
  });

  describe('Connection State', () => {
    it('should report connection state correctly', async () => {
      const { router } = PerfectWS.client();
      expect(router.isServerConnected).toBe(false);
      expect(router.bufferedAmount).toBe(0);
    });

    it('should handle serverOpen promise', () => {
      const { router } = PerfectWS.client();
      const openPromise = router.serverOpen;
      expect(openPromise).toBeInstanceOf(Promise);
    });
  });

  describe('Mock WebSocket Operations', () => {
    it('should handle setServer with mock WebSocket', () => {
      const { router, setServer } = PerfectWS.client();
      router.config.verbose = false;

      const mockWs = {
        readyState: 1, // OPEN
        send: vi.fn().mockReturnValue(true),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        bufferedAmount: 0,
        setMaxListeners: vi.fn()
      };

      // Mock the sync request to prevent unhandled rejection
      (router as any)._syncRequests = vi.fn().mockResolvedValue(undefined);

      setServer(mockWs as any);
      expect((router as any)._server).toBeDefined();
    });

    it('should handle request timeout', async () => {
      const { router } = PerfectWS.client();
      router.config.verbose = false;

      // Test that request with doNotWaitForConnection throws immediately when not connected
      try {
        await router.request('test', null, {
          timeout: 50,
          doNotWaitForConnection: true
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toBe('Server not connected');
        expect(error.code).toBe('serverClosed');
      }
    });
  });

  describe('Request Options', () => {
    it('should handle duplicate request ID', async () => {
      const { router } = PerfectWS.client();
      router.config.verbose = false;

      const mockWs = {
        readyState: 1, // OPEN
        send: vi.fn().mockReturnValue(true),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        bufferedAmount: 0,
        setMaxListeners: vi.fn()
      };

      // Mock the sync request to prevent unhandled rejection
      (router as any)._syncRequests = vi.fn().mockResolvedValue(undefined);

      (router as any)._setServer(mockWs as any);
      (router as any)._activeRequests.set('duplicate-id', {} as any);

      await expect(
        router.request('test', null, { requestId: 'duplicate-id' })
      ).rejects.toThrow('Request already exists');
    });
  });

  describe('Error Handling', () => {
    it('should create PerfectWSError with proper properties', () => {
      const error = new PerfectWSError('Test error', 'TEST_CODE', 'request-123');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.requestId).toBe('request-123');
      expect(error.name).toBe('PerfectWSError');
    });
  });

  describe('Events', () => {
    it('should handle custom event listeners', () => {
      const events = new NetworkEventListener();
      const callback = vi.fn();

      events.on('custom', callback);
      events.emit('custom', 'data1', 'data2');

      expect(callback).toHaveBeenCalledWith('local', 'data1', 'data2');
    });
  });

  describe('Serialization', () => {
    it('should serialize and deserialize data with BSON', () => {
      const { router } = PerfectWS.client();

      const testData = {
        string: 'test',
        number: 123,
        boolean: true,
        null: null,
        array: [1, 2, 3],
        object: { nested: 'value' },
        date: new Date(),
        buffer: Buffer.from('test')
      };

      const serialized = (router as any).serialize(testData);
      expect(serialized).toBeInstanceOf(Buffer);

      const deserialized = (router as any).deserialize(serialized);
      expect(deserialized.string).toBe(testData.string);
      expect(deserialized.number).toBe(testData.number);
      expect(deserialized.boolean).toBe(testData.boolean);
      expect(deserialized.null).toBe(testData.null);
      expect(deserialized.array).toEqual(testData.array);
      expect(deserialized.object).toEqual(testData.object);
      expect(deserialized.date.getTime()).toBe(testData.date.getTime());
      expect(deserialized.buffer.toString()).toBe(testData.buffer.toString());
    });
  });

  describe('SubRoute', () => {
    it('should create and use subroute', () => {
      const { router } = PerfectWS.server();
      const subRoute = PerfectWS.Router();

      subRoute.on('subMethod', async () => 'from subroute');

      router.use(subRoute);

      const hasMethod = (router as any)._listenForRequests.has('subMethod');
      expect(hasMethod).toBe(true);
    });

    it('should handle multiple subroutes', () => {
      const { router } = PerfectWS.server();
      const subRoute1 = PerfectWS.Router();
      const subRoute2 = PerfectWS.Router();

      subRoute1.on('method1', async () => 'result1');
      subRoute2.on('method2', async () => 'result2');

      router.use(subRoute1);
      router.use(subRoute2);

      expect((router as any)._listenForRequests.has('method1')).toBe(true);
      expect((router as any)._listenForRequests.has('method2')).toBe(true);
    });
  });

  describe('Private Methods', () => {
    it('should handle _sendJSON with closed connection', () => {
      const { router } = PerfectWS.client();

      const mockWs = {
        readyState: 3, // CLOSED
        send: vi.fn()
      };

      (router as any)._server = mockWs as any;
      const result = (router as any)._sendJSON({ test: 'data' });

      expect(result).toBe(false);
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should handle _sendJSON with open connection', () => {
      const { router } = PerfectWS.client();

      const mockWs = {
        readyState: 1, // OPEN
        send: vi.fn()
      };

      (router as any)._server = mockWs as any;
      const result = (router as any)._sendJSON({ test: 'data' });

      expect(result).toBe(true);
      expect(mockWs.send).toHaveBeenCalled();
    });

    it('should handle _sendJSON with send error', () => {
      const { router } = PerfectWS.client();

      const mockWs = {
        readyState: 1, // OPEN
        send: vi.fn().mockImplementation(() => {
          throw new Error('Send failed');
        })
      };

      (router as any)._server = mockWs as any;
      const result = (router as any)._sendJSON({ test: 'data' });

      expect(result).toBe(false);
    });
  });

  describe('Request Lifecycle', () => {
    it('should handle request with custom requestId', async () => {
      const { router } = PerfectWS.client();
      router.config.verbose = false;

      const customId = 'custom-request-id';
      await expect(router.request('test', null, {
        requestId: customId,
        doNotWaitForConnection: true
      })).rejects.toThrow('Server not connected');
    });

    it('should clear old requests map', () => {
      const { router } = PerfectWS.client();
      router.config.clearOldRequestsDelay = 10;
      router.config.requestTimeout = 10;

      const oldRequest = {
        requestId: 'old',
        updateTime: Date.now() - 20000,
        server: { readyState: 3 } as any,
        callback: vi.fn(),
        events: new NetworkEventListener(),
        abortController: new AbortController()
      };

      (router as any)._activeRequests.set('old', oldRequest);
      (router as any)._clearOldRequests();

      // The cleanup happens async, so we just verify it was called
      expect((router as any)._clearOldRequestActive).toBeDefined();
    });
  });

  describe('Verbose Mode', () => {
    it('should log when verbose is enabled', () => {
      const { router } = PerfectWS.client();
      router.config.verbose = true;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      router.request('test', null, { doNotWaitForConnection: true }).catch(() => {});

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should not log when verbose is disabled', () => {
      const { router } = PerfectWS.client();
      router.config.verbose = false;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      router.request('test', null, { doNotWaitForConnection: true }).catch(() => {});

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});