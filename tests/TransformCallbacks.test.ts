import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serializeWith } from './utils/serializeWith.js';
import { TransformCallbacks } from '../src/PerfectWSAdvanced/transform/TransformCallbacks.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';
import { PerfectWSError } from '../src/PerfectWSError.ts';

describe('TransformCallbacks Extended Coverage', () => {
  let transform: TransformCallbacks;
  let events: NetworkEventListener;

  beforeEach(() => {
    events = new NetworkEventListener();
    transform = new TransformCallbacks(events, 10);
  });

  it('allocates callback registries only when callbacks are used', () => {
    serializeWith(transform, { value: 1 });

    expect(transform['_functions']).toBeUndefined();
    expect(transform['_functionEntries']).toBeUndefined();
    expect(transform['_activeRequests']).toBeUndefined();
    expect(transform['_receivedFunctions']).toBeUndefined();
    expect(transform['_receivedFunctionEntries']).toBeUndefined();
  });

  describe('Remote Function Execution', () => {
    it('should handle remote callback request', async () => {
      // Register a local function
      const localFunc = vi.fn().mockResolvedValue({ result: 'success' });
      const serialized = serializeWith(transform, localFunc);

      // Simulate remote callback request
      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      // Emit remote request
      events._emitWithSource('___callback.request', 'remote', {
        args: [1, 2, 3],
        funcId: serialized.funcId,
        requestId: 'req123'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        data: { result: 'success' },
        requestId: 'req123'
      });
      expect(localFunc).toHaveBeenCalledWith(1, 2, 3);
    });

    it('should handle remote callback request with error', async () => {
      // Register a function that throws
      const localFunc = vi.fn().mockRejectedValue(new Error('Function failed'));
      const serialized = serializeWith(transform, localFunc);

      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      // Emit remote request
      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: serialized.funcId,
        requestId: 'req124'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        error: 'Function failed',
        requestId: 'req124'
      });
    });

    it.each([
      ['null', null, 'null'],
      ['zero', 0, '0'],
      ['empty string', '', ''],
      ['undefined', undefined, 'undefined'],
    ])('returns a response when a callback throws %s', async (_label, thrown, expected) => {
      const localFunc = () => { throw thrown; };
      const serialized = serializeWith(transform, localFunc);
      const responsePromise = new Promise<any>((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: serialized.funcId,
        requestId: `throw-${_label}`,
      });

      await expect(responsePromise).resolves.toEqual({
        error: expected,
        requestId: `throw-${_label}`,
      });
    });

    it('returns a response even when the thrown value resists inspection and string conversion', async () => {
      const hostile = new Proxy({}, {
        has: () => { throw new Error('blocked'); },
        get: () => { throw new Error('blocked'); },
      });
      const serialized = serializeWith(transform, () => { throw hostile; });
      const responsePromise = new Promise<any>(resolve => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: serialized.funcId,
        requestId: 'hostile-error',
      });

      await expect(responsePromise).resolves.toEqual({
        error: 'Unknown error',
        requestId: 'hostile-error',
      });
    });

    it('should handle remote callback request for non-existent function', async () => {
      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      // Emit request for non-existent function
      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: 'non-existent-id',
        requestId: 'req125'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        error: 'Method not found',
        requestId: 'req125'
      });
    });

    it('should ignore local callback requests', () => {
      const responseHandler = vi.fn();
      events.on('___callback.response', responseHandler);

      // Emit local request (should be ignored)
      events._emitWithSource('___callback.request', 'local', {
        args: [],
        funcId: 'some-id',
        requestId: 'req126'
      });

      expect(responseHandler).not.toHaveBeenCalled();
    });
  });

  describe('Remote Function Response', () => {
    it('should handle remote callback response with data', async () => {
      // Set up a pending request
      const { promise, resolve } = Promise.withResolvers();
      (transform['_activeRequests'] ??= new Map()).set('req127', {
        resolve,
        reject: vi.fn()
      });

      // Emit remote response
      events._emitWithSource('___callback.response', 'remote', {
        data: { result: 'remote success' },
        requestId: 'req127'
      });

      const result = await promise;
      expect(result).toEqual({ result: 'remote success' });
      expect(transform['_activeRequests']?.has('req127') ?? false).toBe(false);
    });

    it('should handle remote callback response with error', async () => {
      // Set up a pending request
      const { promise, reject } = Promise.withResolvers();
      const rejectSpy = vi.fn(reject);
      (transform['_activeRequests'] ??= new Map()).set('req128', {
        resolve: vi.fn(),
        reject: rejectSpy
      });

      // Emit remote response with error
      events._emitWithSource('___callback.response', 'remote', {
        error: 'Remote function failed',
        requestId: 'req128'
      });

      await expect(promise).rejects.toThrow(PerfectWSError);
      expect(rejectSpy).toHaveBeenCalledWith(expect.any(PerfectWSError));
      expect(transform['_activeRequests']?.has('req128') ?? false).toBe(false);
    });

    it.each([0, '', null, undefined])('rejects a falsy remote error (%s)', async (error) => {
      const { promise, reject } = Promise.withResolvers();
      (transform['_activeRequests'] ??= new Map()).set('falsy-error', {
        resolve: vi.fn(),
        reject,
      });

      events._emitWithSource('___callback.response', 'remote', {
        error,
        requestId: 'falsy-error',
      });

      await expect(promise).rejects.toMatchObject({
        code: 'callbackError',
        message: String(error),
      });
    });

    it('marks internal durable callback calls on both request and response', async () => {
      const callback = transform.deserialize({
        ___perfectWS: 1,
        ___type: 'callback',
        funcId: 'durable-function',
        funcName: 'durableFunction',
      });
      const requestPromise = new Promise<any>(resolve => {
        events.on('___callback.request', (source, message) => {
          if (source === 'local') resolve(message);
        });
      });

      const resultPromise = transform.invokeReceivedFunction(callback, ['reason'], true);
      const request = await requestPromise;
      expect(request).toMatchObject({
        args: ['reason'],
        funcId: 'durable-function',
        durable: true,
      });

      events._emitWithSource('___callback.response', 'remote', {
        data: 'ack',
        requestId: request.requestId,
        durable: true,
      });
      await expect(resultPromise).resolves.toBe('ack');
    });

    it('directly invokes a function that was not received from the peer', async () => {
      await expect(transform.invokeReceivedFunction((value: number) => value * 2, [4], true)).resolves.toBe(8);
    });

    it('should ignore response for non-existent request', () => {
      const resolveSpy = vi.fn();
      const rejectSpy = vi.fn();

      // No request registered
      events._emitWithSource('___callback.response', 'remote', {
        data: 'some data',
        requestId: 'non-existent-req'
      });

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
    });

    it('should ignore local callback responses', () => {
      const resolveSpy = vi.fn();
      (transform['_activeRequests'] ??= new Map()).set('req129', {
        resolve: resolveSpy,
        reject: vi.fn()
      });

      // Emit local response (should be ignored)
      events._emitWithSource('___callback.response', 'local', {
        data: 'local data',
        requestId: 'req129'
      });

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(transform['_activeRequests']?.has('req129') ?? false).toBe(true);
    });
  });

  describe('Deserialization', () => {
    it('should deserialize callback and create callable function', async () => {
      const callbackData = {
        ___perfectWS: 1,
        ___type: 'callback',
        funcId: 'func123',
        funcName: 'myFunction'
      };

      const deserialized = transform.deserialize(callbackData);
      expect(typeof deserialized).toBe('function');
      expect(deserialized.name).toBe('myFunction');

      // Test that calling the deserialized function creates a request
      const requestPromise = new Promise((resolve) => {
        events.on('___callback.request', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      // Set up response
      const resultPromise = deserialized('arg1', 'arg2');

      const request = await requestPromise;
      expect(request).toEqual({
        args: ['arg1', 'arg2'],
        funcId: 'func123',
        requestId: expect.any(String)
      });

      // Simulate response
      events._emitWithSource('___callback.response', 'remote', {
        data: 'callback result',
        requestId: (request as any).requestId
      });

      const result = await resultPromise;
      expect(result).toBe('callback result');
    });

    it('should deserialize nested callbacks', () => {
      const data = {
        level1: {
          callback: {
            ___perfectWS: 1,
            ___type: 'callback',
            funcId: 'nested-func',
            funcName: 'nestedFunc'
          },
          level2: {
            anotherCallback: {
              ___perfectWS: 1,
              ___type: 'callback',
              funcId: 'deep-func',
              funcName: 'deepFunc'
            }
          }
        }
      };

      const deserialized = transform.deserialize(data);
      expect(typeof deserialized.level1.callback).toBe('function');
      expect(deserialized.level1.callback.name).toBe('nestedFunc');
      expect(typeof deserialized.level1.level2.anotherCallback).toBe('function');
      expect(deserialized.level1.level2.anotherCallback.name).toBe('deepFunc');
    });

    it('reuses a live received wrapper and releases its remote function when finalized', () => {
      const marker = {
        ___perfectWS: 1,
        ___type: 'callback',
        funcId: 'received-func',
        funcName: 'receivedFunc'
      };
      const releases: any[] = [];
      events.on('___callback.release', (source, message) => {
        if (source === 'local') releases.push(message);
      });

      const first = transform.deserialize({ ...marker });
      const second = transform.deserialize({ ...marker });
      expect(second).toBe(first);
      expect(transform.hasLiveState()).toBe(true);

      transform.finalizeReceivedFunction('missing-func', {});
      transform.finalizeReceivedFunction(marker.funcId, {});
      expect(transform.hasLiveState()).toBe(true);

      transform.releaseReceivedFunction(first);

      expect(releases).toEqual([{ funcId: marker.funcId }]);
      expect(transform.hasLiveState()).toBe(false);
    });

    it('passes callbacks back to their owner without registering a trampoline', () => {
      const original = () => 'original';
      const ownedMarker = serializeWith(transform, original);
      expect(transform.deserialize({ ...ownedMarker })).toBe(original);

      const remoteMarker = {
        ___perfectWS: 1,
        ___type: 'callback',
        funcId: 'remote-callback',
        funcName: 'remoteCallback',
      };
      const remote = transform.deserialize(remoteMarker);
      const returnedMarker = serializeWith(transform, remote);

      expect(returnedMarker).toEqual(remoteMarker);
      expect(transform['_functions']?.size ?? 0).toBe(1);
      expect(transform['_receivedFunctions']?.size ?? 0).toBe(1);
    });

    it('runs an owned callback release handler exactly once', () => {
      const callback = () => undefined;
      const release = vi.fn();
      transform.setFunctionReleaseHandler(callback, release);
      const marker = serializeWith(transform, callback);

      events._emitWithSource('___callback.release', 'remote', { funcId: marker.funcId });
      transform.releaseFunction(callback);

      expect(release).toHaveBeenCalledOnce();
      expect(transform.hasLiveState()).toBe(false);
    });

    it('runs owned callback release handlers when the channel closes', () => {
      const callback = () => undefined;
      const release = vi.fn();
      transform.setFunctionReleaseHandler(callback, release);
      serializeWith(transform, callback);

      transform.releaseAll();

      expect(release).toHaveBeenCalledOnce();
    });

    it('rejects a deserialized callback after its channel is released', async () => {
      const callback = transform.deserialize({
        ___perfectWS: 1,
        ___type: 'callback',
        funcId: 'released-func',
        funcName: 'releasedFunc'
      });

      transform.releaseAll();

      await expect(callback()).rejects.toMatchObject({ code: 'callbackReleased' });
    });

    it('removes its protocol listeners when the channel is released', () => {
      expect(events.listenerCount('___callback.request')).toBe(1);
      expect(events.listenerCount('___callback.response')).toBe(1);

      transform.releaseAll();
      transform.releaseAll();

      expect(events.listenerCount('___callback.request')).toBe(0);
      expect(events.listenerCount('___callback.response')).toBe(0);
    });
  });

  describe('Serialization Edge Cases', () => {
    it('should handle error with no message property', async () => {
      const localFunc = vi.fn().mockRejectedValue('String error');
      const serialized = serializeWith(transform, localFunc);

      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: [],
        funcId: serialized.funcId,
        requestId: 'req130'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        error: 'String error',
        requestId: 'req130'
      });
    });

    it('should handle synchronous function execution', async () => {
      const localFunc = vi.fn().mockReturnValue('sync result');
      const serialized = serializeWith(transform, localFunc);

      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: ['sync-arg'],
        funcId: serialized.funcId,
        requestId: 'req131'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        data: 'sync result',
        requestId: 'req131'
      });
      expect(localFunc).toHaveBeenCalledWith('sync-arg');
    });

    it('should reuse funcId for same function', () => {
      const func = () => 'test';

      const serialized1 = serializeWith(transform, func);
      const serialized2 = serializeWith(transform, func);

      expect(serialized1.funcId).toBe(serialized2.funcId);
      expect(transform['_functions']?.size ?? 0).toBe(1);
    });

    it('should handle circular references in serialization', () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      obj.func = () => 'test';

      const serialized = serializeWith(transform, obj);
      expect(serialized.func.___type).toBe('callback');
      expect(serialized.self).toBe(serialized);
    });

    it('should not serialize beyond max depth', () => {
      const deepFunc = () => 'deep';
      const deepObject: any = { level: 0, func: deepFunc };

      // Create deeply nested structure
      let current = deepObject;
      for (let i = 1; i <= 15; i++) {
        current.nested = { level: i, func: deepFunc };
        current = current.nested;
      }

      const transform = new TransformCallbacks(events, 5);
      const serialized = serializeWith(transform, deepObject);

      // Check that serialization stops at depth 5
      let checkDepth = serialized;
      for (let i = 0; i < 5; i++) {
        expect(checkDepth.func.___type).toBe('callback');
        checkDepth = checkDepth.nested;
      }
      // Beyond depth 5, functions should not be transformed
      expect(checkDepth.func).toBe(deepFunc);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multiple concurrent callback requests', async () => {
      const func1 = vi.fn().mockResolvedValue('result1');
      const func2 = vi.fn().mockResolvedValue('result2');

      const serialized1 = serializeWith(transform, func1);
      const serialized2 = serializeWith(transform, func2);

      const responses: any[] = [];
      events.on('___callback.response', (source, data) => {
        if (source === 'local') responses.push(data);
      });

      // Send multiple requests concurrently
      events._emitWithSource('___callback.request', 'remote', {
        args: ['a'],
        funcId: serialized1.funcId,
        requestId: 'req-multi-1'
      });
      events._emitWithSource('___callback.request', 'remote', {
        args: ['b'],
        funcId: serialized2.funcId,
        requestId: 'req-multi-2'
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(responses).toHaveLength(2);
      expect(responses).toContainEqual({
        data: 'result1',
        requestId: 'req-multi-1'
      });
      expect(responses).toContainEqual({
        data: 'result2',
        requestId: 'req-multi-2'
      });
    });

    it('should handle function with complex arguments', async () => {
      const complexFunc = vi.fn().mockImplementation((obj, arr, num) => ({
        processedObj: obj,
        arrayLength: arr.length,
        doubled: num * 2
      }));

      const serialized = serializeWith(transform, complexFunc);

      const responsePromise = new Promise((resolve) => {
        events.on('___callback.response', (source, data) => {
          if (source === 'local') resolve(data);
        });
      });

      events._emitWithSource('___callback.request', 'remote', {
        args: [{ key: 'value' }, [1, 2, 3], 42],
        funcId: serialized.funcId,
        requestId: 'req-complex'
      });

      const response = await responsePromise;
      expect(response).toEqual({
        data: {
          processedObj: { key: 'value' },
          arrayLength: 3,
          doubled: 84
        },
        requestId: 'req-complex'
      });
    });
  });
});
