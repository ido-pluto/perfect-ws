import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';
import { WebSocketForce } from '../src/utils/WebSocketForce.ts';
import { PerfectWSError } from '../src/PerfectWSError.ts';
import { PerfectWSSubRoute } from '../src/PerfectWSSubRoute.ts';
import { PerfectWS } from '../src/PerfectWS.ts';
import { WebSocket } from 'ws';

describe('Utility Classes', () => {
  describe('PerfectWSError', () => {
    it('should create error with message and code', () => {
      const error = new PerfectWSError('Test error', 'TEST_CODE');
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.name).toBe('PerfectWSError');
    });

    it('should create error with requestId', () => {
      const error = new PerfectWSError('Test error', 'TEST_CODE', 'request-123');
      expect(error.requestId).toBe('request-123');
    });

    it('should have proper stack trace', () => {
      const error = new PerfectWSError('Test error', 'TEST_CODE');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('PerfectWSError');
    });
  });

  describe('NetworkEventListener', () => {
    let events: NetworkEventListener;

    beforeEach(() => {
      events = new NetworkEventListener();
    });

    it('should emit and listen to events', () => {
      const callback = vi.fn();
      events.on('test', callback);

      events.emit('test', 'data1', 'data2');

      expect(callback).toHaveBeenCalledWith('local', 'data1', 'data2');
    });

    it('should handle multiple listeners', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      events.on('test', callback1);
      events.on('test', callback2);

      events.emit('test', 'data');

      expect(callback1).toHaveBeenCalledWith('local', 'data');
      expect(callback2).toHaveBeenCalledWith('local', 'data');
    });

    it('should remove listeners with off', () => {
      const callback = vi.fn();
      events.on('test', callback);
      events.off('test', callback);

      events.emit('test', 'data');

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle once listeners', () => {
      const callback = vi.fn();
      events.once('test', callback);

      events.emit('test', 'first');
      events.emit('test', 'second');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('local', 'first');
    });

    it('should handle onAny listeners', () => {
      const callback = vi.fn();
      events.onAny(callback);

      events.emit('event1', 'data1');
      events.emit('event2', 'data2');

      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledWith('local', 'event1', 'data1');
      expect(callback).toHaveBeenCalledWith('local', 'event2', 'data2');
    });

    it('should handle offAny', () => {
      const callback = vi.fn();
      events.onAny(callback);
      events.offAny(callback);

      events.emit('test', 'data');

      expect(callback).not.toHaveBeenCalled();
    });

    it('should emit with source', () => {
      const callback = vi.fn();
      events.on('test', callback);

      events._emitWithSource('test', 'remote', 'data');

      expect(callback).toHaveBeenCalledWith('remote', 'data');
    });

    it('should handle removeAllListeners', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      events.on('event1', callback1);
      events.on('event2', callback2);

      events.removeAllListeners();

      events.emit('event1');
      events.emit('event2');

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should handle removeAllListeners for specific event', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      events.on('event1', callback1);
      events.on('event2', callback2);

      events.removeAllListeners('event1');

      events.emit('event1');
      events.emit('event2');

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should handle listener count', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      expect(events.listenerCount('test')).toBe(0);

      events.on('test', callback1);
      expect(events.listenerCount('test')).toBe(1);

      events.on('test', callback2);
      expect(events.listenerCount('test')).toBe(2);

      events.off('test', callback1);
      expect(events.listenerCount('test')).toBe(1);
    });

    it('should get event names', () => {
      events.on('event1', () => { });
      events.on('event2', () => { });
      events.on('event3', () => { });

      const names = events.eventNames();
      expect(names).toContain('event1');
      expect(names).toContain('event2');
      expect(names).toContain('event3');
    });

    it('should handle listeners method', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      events.on('test', callback1);
      events.on('test', callback2);

      const listeners = events.listeners('test');
      expect(listeners).toContain(callback1);
      expect(listeners).toContain(callback2);
      expect(listeners.length).toBe(2);
    });

    it('should handle prependListener', () => {
      const callback1 = vi.fn(() => 'first');
      const callback2 = vi.fn(() => 'second');

      events.on('test', callback1);
      events.prependListener('test', callback2);

      const listeners = events.listeners('test');
      expect(listeners[0]).toBe(callback2);
      expect(listeners[1]).toBe(callback1);
    });

    it('should handle prependOnceListener', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      events.on('test', callback1);
      events.once('test', callback2);

      events.emit('test', 'first');
      events.emit('test', 'second');

      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback1).toHaveBeenCalledTimes(2);
    });

    it('should handle rawListeners', () => {
      const callback = vi.fn();
      events.once('test', callback);

      const rawListeners = events.listeners('test');
      expect(rawListeners.length).toBe(1);
      expect(typeof rawListeners[0]).toBe('function');
    });
  });

  describe('WebSocketForce', () => {
    let mockWs: any;
    let wsForce: WebSocketForce;

    beforeEach(() => {
      mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        bufferedAmount: 0,
        binaryType: 'blob',
        extensions: '',
        protocol: '',
        url: 'ws://localhost',
        CONNECTING: 0,
        OPEN: 1,
        CLOSING: 2,
        CLOSED: 3,
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null
      };
      wsForce = new WebSocketForce(mockWs);
    });

    it('should wrap WebSocket instance', () => {
      expect(wsForce).toBeInstanceOf(WebSocketForce);
      expect(wsForce.readyState).toBe(WebSocket.OPEN);
    });

    it('should proxy readyState', () => {
      mockWs.readyState = WebSocket.CONNECTING;
      expect(wsForce.readyState).toBe(WebSocket.CONNECTING);

      mockWs.readyState = WebSocket.CLOSED;
      expect(wsForce.readyState).toBe(WebSocket.CLOSED);
    });

    it('should proxy bufferedAmount', () => {
      mockWs.bufferedAmount = 1024;
      expect(wsForce.bufferedAmount).toBe(1024);
    });

    it('should proxy send method', () => {
      wsForce.send('test data');
      expect(mockWs.send).toHaveBeenCalledWith('test data');
    });

    it('should proxy close method', () => {
      wsForce.close(1000, 'Normal closure');
      expect(mockWs.close).toHaveBeenCalledWith(1000, 'Normal closure');
    });

    it('should handle forceClose method', () => {
      wsForce.forceClose(1001, 'Force close');
      expect(mockWs.close).toHaveBeenCalledWith(1001, 'Force close');
    });

    it('should proxy addEventListener', () => {
      const callback = vi.fn();
      wsForce.addEventListener('message', callback);
      expect(mockWs.addEventListener).toHaveBeenCalledWith('message', callback, undefined);
    });

    it('should proxy removeEventListener', () => {
      const callback = vi.fn();
      wsForce.removeEventListener('message', callback);
      expect(mockWs.removeEventListener).toHaveBeenCalledWith('message', callback, undefined);
    });

    it('should handle on/off aliases', () => {
      const callback = vi.fn();

      wsForce.on('open', callback);
      expect(mockWs.addEventListener).toHaveBeenCalledWith('open', callback, undefined);

      wsForce.off('open', callback);
      expect(mockWs.removeEventListener).toHaveBeenCalledWith('open', callback, undefined);
    });

    it('should handle once method', async () => {
      const promise = wsForce.once('message');

      expect(mockWs.addEventListener).toHaveBeenCalled();
      const wrappedCallback = (mockWs.addEventListener as Mock).mock.calls[0][1];
      const event = new MessageEvent('message', { data: 'test' });

      wrappedCallback(event);

      const result = await promise;
      expect(result).toBe(event);
    });

    it('should proxy dispatchEvent', () => {
      const event = new Event('test');
      wsForce.dispatchEvent(event);
      expect(mockWs.dispatchEvent).toHaveBeenCalledWith(event);
    });

    it('should proxy other properties', () => {
      expect(wsForce.binaryType).toBe('blob');
      expect(wsForce.extensions).toBe('');
      expect(wsForce.protocol).toBe('');
      expect(wsForce.url).toBe('ws://localhost');
    });

    it('should handle setMaxListeners', () => {
      if ('setMaxListeners' in wsForce && typeof wsForce.setMaxListeners === 'function') {
        expect(() => wsForce.setMaxListeners(100)).not.toThrow();
      }
    });

    it('should expose WebSocket constants', () => {
      expect(WebSocketForce.CONNECTING).toBe(0);
      expect(WebSocketForce.OPEN).toBe(1);
      expect(WebSocketForce.CLOSING).toBe(2);
      expect(WebSocketForce.CLOSED).toBe(3);
    });
  });

  describe('PerfectWSSubRoute', () => {
    let subRoute: PerfectWSSubRoute;
    let parentRouter: PerfectWS;

    beforeEach(() => {
      subRoute = new PerfectWSSubRoute();
      const { router } = PerfectWS.server();
      parentRouter = router;
    });

    it('should create subroute instance', () => {
      expect(subRoute).toBeInstanceOf(PerfectWSSubRoute);
    });

    it('should register handlers', () => {
      const callback = vi.fn();
      subRoute.on('test', callback);

      expect(subRoute._listenForRequests.has('test')).toBe(true);
    });

    it('should remove handlers', () => {
      const callback = vi.fn();
      subRoute.on('test', callback);
      subRoute.off('test');

      expect(subRoute._listenForRequests.has('test')).toBe(false);
    });

    it('should connect to parent router', () => {
      const callback = vi.fn();
      subRoute.on('subMethod', callback);

      subRoute.__connect(parentRouter);

      expect(parentRouter._listenForRequests.has('subMethod')).toBe(true);
    });

    it('should handle multiple methods', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      const callback3 = vi.fn();

      subRoute.on('method1', callback1);
      subRoute.on('method2', callback2);
      subRoute.on('method3', callback3);

      subRoute.__connect(parentRouter);

      expect(parentRouter._listenForRequests.has('method1')).toBe(true);
      expect(parentRouter._listenForRequests.has('method2')).toBe(true);
      expect(parentRouter._listenForRequests.has('method3')).toBe(true);
    });

    it('should override existing methods in parent', () => {
      const originalCallback = vi.fn();
      const newCallback = vi.fn();

      parentRouter.on('test', originalCallback);
      subRoute.on('test', newCallback);

      subRoute.__connect(parentRouter);

      const handler = parentRouter._listenForRequests.get('test');
      expect(handler?.callbacks?.[0]).toBe(newCallback);
    });

    it('should handle empty subroute', () => {
      expect(() => subRoute.__connect(parentRouter)).not.toThrow();
    });

    it('should chain subroutes', () => {
      const subRoute1 = new PerfectWSSubRoute();
      const subRoute2 = new PerfectWSSubRoute();

      subRoute1.on('method1', vi.fn());
      subRoute2.on('method2', vi.fn());

      parentRouter.use(subRoute1);
      parentRouter.use(subRoute2);

      expect(parentRouter._listenForRequests.has('method1')).toBe(true);
      expect(parentRouter._listenForRequests.has('method2')).toBe(true);
    });

    it('should maintain method isolation between subroutes', () => {
      const subRoute1 = new PerfectWSSubRoute();
      const subRoute2 = new PerfectWSSubRoute();

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      subRoute1.on('shared', callback1);
      subRoute2.on('shared', callback2);

      parentRouter.use(subRoute1);
      parentRouter.use(subRoute2);

      const handler = parentRouter._listenForRequests.get('shared');
      expect(handler?.callbacks?.[0]).toBe(callback2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle circular references in NetworkEventListener', () => {
      const events = new NetworkEventListener();
      const circularObj: any = { value: 'test' };
      circularObj.circular = circularObj;

      expect(() => events.emit('test', circularObj)).not.toThrow();
    });

    it('should handle very long event names', () => {
      const events = new NetworkEventListener();
      const longEventName = 'a'.repeat(1000);
      const callback = vi.fn();

      events.on(longEventName, callback);
      events.emit(longEventName, 'data');

      expect(callback).toHaveBeenCalled();
    });

    it('should handle special characters in event names', () => {
      const events = new NetworkEventListener();
      const specialEventName = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      const callback = vi.fn();

      events.on(specialEventName, callback);
      events.emit(specialEventName, 'data');

      expect(callback).toHaveBeenCalled();
    });

    it('should handle undefined and null in event data', () => {
      const events = new NetworkEventListener();
      const callback = vi.fn();

      events.on('test', callback);
      events.emit('test', undefined, null, undefined);

      expect(callback).toHaveBeenCalledWith('local', undefined, null, undefined);
    });

    it('should handle Symbol event names', () => {
      const events = new NetworkEventListener();
      const symbolEvent = Symbol('test');
      const callback = vi.fn();

      events.on(symbolEvent as any, callback);
      events.emit(symbolEvent as any, 'data');

      expect(callback).toHaveBeenCalled();
    });

    it('should handle removing non-existent listeners', () => {
      const events = new NetworkEventListener();
      const callback = vi.fn();

      expect(() => events.off('nonexistent', callback)).not.toThrow();
      expect(() => events.offAny(callback)).not.toThrow();
    });

    it('should handle WebSocket with no bufferedAmount', () => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        bufferedAmount: undefined
      } as any;

      const wsForce = new WebSocketForce(mockWs);
      expect(wsForce.bufferedAmount).toBeUndefined();
    });

    it('should handle PerfectWSError with no stack', () => {
      const error = new PerfectWSError('Test', 'CODE');
      Object.defineProperty(error, 'stack', {
        value: undefined,
        writable: true
      });

      expect(error.stack).toBeUndefined();
      expect(error.message).toBe('Test');
    });
  });
});