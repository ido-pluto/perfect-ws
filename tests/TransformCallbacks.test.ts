import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  describe('Remote Function Execution', () => {
    it('should handle remote callback request', async () => {
      // Register a local function
      const localFunc = vi.fn().mockResolvedValue({ result: 'success' });
      const serialized = transform.serialize(localFunc);

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
      const serialized = transform.serialize(localFunc);

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
      transform['_activeRequests'].set('req127', {
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
      expect(transform['_activeRequests'].has('req127')).toBe(false);
    });

    it('should handle remote callback response with error', async () => {
      // Set up a pending request
      const { promise, reject } = Promise.withResolvers();
      const rejectSpy = vi.fn(reject);
      transform['_activeRequests'].set('req128', {
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
      expect(transform['_activeRequests'].has('req128')).toBe(false);
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
      transform['_activeRequests'].set('req129', {
        resolve: resolveSpy,
        reject: vi.fn()
      });

      // Emit local response (should be ignored)
      events._emitWithSource('___callback.response', 'local', {
        data: 'local data',
        requestId: 'req129'
      });

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(transform['_activeRequests'].has('req129')).toBe(true);
    });
  });

  describe('Deserialization', () => {
    it('should deserialize callback and create callable function', async () => {
      const callbackData = {
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
            ___type: 'callback',
            funcId: 'nested-func',
            funcName: 'nestedFunc'
          },
          level2: {
            anotherCallback: {
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
  });

  describe('Serialization Edge Cases', () => {
    it('should handle error with no message property', async () => {
      const localFunc = vi.fn().mockRejectedValue('String error');
      const serialized = transform.serialize(localFunc);

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
      const serialized = transform.serialize(localFunc);

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

      const serialized1 = transform.serialize(func);
      const serialized2 = transform.serialize(func);

      expect(serialized1.funcId).toBe(serialized2.funcId);
      expect(transform['_functions'].length).toBe(1);
    });

    it('should handle circular references in serialization', () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      obj.func = () => 'test';

      const serialized = transform.serialize(obj);
      expect(serialized.func.___type).toBe('callback');
      expect(serialized.self).toBe(obj.self); // Circular reference preserved
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
      const serialized = transform.serialize(deepObject);

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

      const serialized1 = transform.serialize(func1);
      const serialized2 = transform.serialize(func2);

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

      const serialized = transform.serialize(complexFunc);

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