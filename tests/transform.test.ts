import { describe, it, expect, beforeEach, vi } from 'vitest';
import { serializeWith } from './utils/serializeWith.js';
import { TransformAbortSignal } from '../src/PerfectWSAdvanced/transform/TransformAbortSignal.ts';
import { TransformCallbacks } from '../src/PerfectWSAdvanced/transform/TransformCallbacks.ts';
// Replaced by CustomTransformers
import { CustomTransformers, TransformInstruction } from '../src/PerfectWSAdvanced/transform/CustomTransformers.ts';
import { transformReceivedDeserializeType } from '../src/PerfectWSAdvanced/transform/utils/changeType.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';
import { PerfectWSError } from '../src/PerfectWSError.ts';

describe('Transform Utilities', () => {
  describe('TransformAbortSignal', () => {
    let events: NetworkEventListener;
    let callbacks: TransformCallbacks;
    let transform: TransformAbortSignal;

    beforeEach(() => {
      events = new NetworkEventListener();
      callbacks = new TransformCallbacks(events, 10);
      transform = new TransformAbortSignal(callbacks, 10);
    });

    it('allocates no signal identity maps for values without signals', () => {
      serializeWith(transform, { value: 1 });

      expect(transform['_inboundStates']).toBeUndefined();
      expect(transform['_inboundSignals']).toBeUndefined();
      expect(transform['_outboundSubscriptions']).toBeUndefined();
      expect(transform['_outboundSignals']).toBeUndefined();
    });

    it('should serialize AbortSignal', () => {
      const abortController = new AbortController();
      const data = { signal: abortController.signal };

      const serialized = serializeWith(transform, data);
      expect(serialized.signal).toHaveProperty('___type', 'abortSignal');
      expect(serialized.signal.subscribe).toBeTypeOf('function');
    });

    it('reuses one subscription and one received signal for the same AbortSignal', () => {
      const controller = new AbortController();
      const first = serializeWith(transform, controller.signal);
      const second = serializeWith(transform, controller.signal);

      expect(second.subscribe).toBe(first.subscribe);
      expect(transform.deserialize(first)).toBe(controller.signal);

      const receiver = new TransformAbortSignal(
        new TransformCallbacks(new NetworkEventListener(), 10),
        10,
      );
      const received = receiver.deserialize({ first, second });
      expect(received.second).toBe(received.first);
      expect(receiver['_inboundStates']?.has(received.first)).toBe(true);
    });

    it('round-trips an already-aborted signal without live state', () => {
      const abortController = new AbortController();
      abortController.abort('already stopped');

      const serialized = serializeWith(transform, { signal: abortController.signal });
      const deserialized = transform.deserialize(serialized);

      expect(deserialized.signal.aborted).toBe(true);
      expect(deserialized.signal.reason).toBe('already stopped');
    });

    it('reuses an already-aborted signal within one message without live state', () => {
      const abortController = new AbortController();
      abortController.abort('already stopped');
      const serialized = serializeWith(transform, {
        first: abortController.signal,
        second: abortController.signal,
      });
      const receiver = new TransformAbortSignal(
        new TransformCallbacks(new NetworkEventListener(), 10),
        10,
      );

      expect(serialized.second.abortId).toBe(serialized.first.abortId);
      const received = receiver.deserialize(serialized);
      expect(received.second).toBe(received.first);
      expect(received.first.aborted).toBe(true);
      expect(receiver['_inboundStates']).toBeUndefined();
    });

    it('should deserialize AbortSignal', () => {
      const serializedData = {
        signal: {
          ___perfectWS: 1,
          ___type: 'abortSignal',
          subscribe: () => { }
        }
      };

      const deserialized = transform.deserialize(serializedData);
      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
    });

    it('should handle abort event propagation', () => {
      const abortController = new AbortController();
      const data = { signal: abortController.signal };

      const serialized = serializeWith(transform, data);
      const deserialized = transform.deserialize(serialized);
      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
      abortController.abort('Test abort reason');

      expect(deserialized.signal.aborted).toBe(true);
      expect(deserialized.signal.reason).toBe('Test abort reason');
    });

    it('should handle nested AbortSignals', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const data = {
        level1: {
          signal1: ac1.signal,
          level2: {
            signal2: ac2.signal
          }
        }
      };

      const serialized = serializeWith(transform, data);
      expect(serialized.level1.signal1).toHaveProperty('___type', 'abortSignal');
      expect(serialized.level1.level2.signal2).toHaveProperty('___type', 'abortSignal');

      const deserialized = transform.deserialize(serialized);
      expect(deserialized.level1.signal1).toBeInstanceOf(AbortSignal);
      expect(deserialized.level1.level2.signal2).toBeInstanceOf(AbortSignal);
    });

    it('should handle max depth during serialization', () => {
      const transform = new TransformAbortSignal(callbacks, 0);
      const ac = new AbortController();
      const data = {
        signal: ac.signal
      };

      // Should return object as-is when depth exceeded
      const result = serializeWith(transform, data);
      expect(result.signal).toBe(ac.signal); // Not transformed due to depth limit
    });

    it('should handle null and primitive values', () => {
      const data = {
        null: null,
        undefined: undefined,
        number: 42,
        string: 'test',
        boolean: true
      };

      const serialized = serializeWith(transform, data);
      expect(serialized).toEqual(data);

      const deserialized = transform.deserialize(data);
      expect(deserialized).toEqual(data);
    });

    it('should handle arrays with AbortSignals', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const data = [ac1.signal, { nested: ac2.signal }, 'string'];

      const serialized = serializeWith(transform, data);
      expect(serialized[0]).toHaveProperty('___type', 'abortSignal');
      expect(serialized[1].nested).toHaveProperty('___type', 'abortSignal');
      expect(serialized[2]).toBe('string');
    });

    it('releases the inbound subscription after abort', () => {
      const abortController = new AbortController();
      const serialized = serializeWith(transform, abortController.signal);
      const receiver = new TransformAbortSignal(
        new TransformCallbacks(new NetworkEventListener(), 10),
        10,
      );
      const received = receiver.deserialize(serialized);

      expect(receiver['_inboundStates']?.has(received)).toBe(true);
      abortController.abort('stopped');

      expect(received.aborted).toBe(true);
      expect(received.reason).toBe('stopped');
      expect(receiver['_inboundStates']?.has(received)).toBe(false);
    });

    it('releases an inbound subscription that fails', async () => {
      const received = transform.deserialize({
        ___perfectWS: 1,
        ___type: 'abortSignal',
        subscribe: () => Promise.reject(new Error('subscription failed')),
      });

      expect(transform['_inboundStates']?.has(received)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(transform['_inboundStates']?.has(received)).toBe(false);
    });

    it('removes the owner listener when the subscribe callback is released', async () => {
      const controller = new AbortController();
      const marker = serializeWith(transform, controller.signal);
      const encoded = serializeWith(callbacks, marker);
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

      await marker.subscribe(() => undefined);
      events._emitWithSource('___callback.release', 'remote', {
        funcId: encoded.subscribe.funcId,
      });

      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(callbacks.hasLiveState()).toBe(false);
    });
  });

  describe('TransformCallbacks', () => {
    let events: NetworkEventListener;
    let transform: TransformCallbacks;

    beforeEach(() => {
      events = new NetworkEventListener();
      transform = new TransformCallbacks(events, 10);
    });

    it('should serialize functions', () => {
      const func = function testFunction() { return 'test'; };
      const data = { callback: func };

      const serialized = serializeWith(transform, data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.callback).toHaveProperty('funcId');
      expect(serialized.callback.funcName).toBe('testFunction');
    });

    it('should serialize arrow functions', () => {
      const func = () => 'test';
      const data = { callback: func };

      const serialized = serializeWith(transform, data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.callback).toHaveProperty('funcId');
      expect(serialized.callback.funcName).toBe('func');
    });

    it('should serialize anonymous functions', () => {
      const data = { callback: function() { return 'test'; } };

      const serialized = serializeWith(transform, data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.callback).toHaveProperty('funcId');
    });

    it('should deserialize functions', () => {
      const serializedData = {
        callback: {
          ___perfectWS: 1,
          ___type: 'callback',
          funcId: 'test-func-id',
          funcName: 'testFunc'
        }
      };

      const deserialized = transform.deserialize(serializedData);
      expect(typeof deserialized.callback).toBe('function');
      expect(deserialized.callback.name).toBe('testFunc');
    });

    it('should handle function invocation across serialization', async () => {
      const originalFunc = vi.fn((a: number, b: number) => a + b);
      const data = { add: originalFunc };

      const serialized = serializeWith(transform, data);
      const funcId = serialized.add.funcId;

      expect(serialized.add).toHaveProperty('___type', 'callback');
      expect(serialized.add).toHaveProperty('funcId');

      const deserialized = transform.deserialize(serialized);
      expect(typeof deserialized.add).toBe('function');
    });

    it('should handle function invocation errors', () => {
      const errorFunc = () => { throw new Error('Function error'); };
      const data = { errorCallback: errorFunc };

      const serialized = serializeWith(transform, data);

      expect(serialized.errorCallback).toHaveProperty('___type', 'callback');
      expect(serialized.errorCallback).toHaveProperty('funcId');

      const deserialized = transform.deserialize(serialized);
      expect(typeof deserialized.errorCallback).toBe('function');
    });

    it('should handle missing function on invocation', () => {
      const deserialized = transform.deserialize({
        callback: {
          ___perfectWS: 1,
          ___type: 'callback',
          funcId: 'non-existent',
          funcName: 'missing'
        }
      });

      expect(typeof deserialized.callback).toBe('function');
      expect(deserialized.callback.name).toBe('missing');
    });

    it('should reuse function IDs for same function', () => {
      const func = () => 'test';
      const data1 = { callback: func };
      const data2 = { callback: func };

      const serialized1 = serializeWith(transform, data1);
      const serialized2 = serializeWith(transform, data2);

      expect(serialized1.callback.funcId).toBe(serialized2.callback.funcId);
    });

    it('should handle nested functions', () => {
      const func1 = () => 'func1';
      const func2 = () => 'func2';
      const data = {
        level1: {
          callback1: func1,
          level2: {
            callback2: func2
          }
        }
      };

      const serialized = serializeWith(transform, data);
      expect(serialized.level1.callback1).toHaveProperty('___type', 'callback');
      expect(serialized.level1.level2.callback2).toHaveProperty('___type', 'callback');
    });

    it('should handle max depth exceeded', () => {
      const transform = new TransformCallbacks(events, 0);
      const func = () => 'test';
      const data = {
        callback: func
      };

      // Should return object as-is when depth exceeded
      const result = serializeWith(transform, data);
      expect(result.callback).toBe(func); // Not transformed due to depth limit
    });

    it('should handle objects with function properties', () => {
      const obj = {
        method: function() { return this.value; },
        value: 42
      };

      const serialized = serializeWith(transform, obj);
      expect(serialized.method).toHaveProperty('___type', 'callback');
      expect(serialized.value).toBe(42);
    });
  });

  describe('CustomTransformers', () => {
    class TestClass {
      constructor(public value: string) {}
    }

    class AnotherClass {
      constructor(public num: number) {}
    }

    let transformers: TransformInstruction<any>[];
    let transform: CustomTransformers;

    beforeEach(() => {
      transformers = [
        {
          check: (obj: any): obj is TestClass => obj instanceof TestClass,
          uniqueId: 'TestClass',
          serialize: (obj) => JSON.stringify({ value: obj.value }),
          deserialize: (str) => {
            const data = JSON.parse(str);
            return new TestClass(data.value);
          }
        },
        {
          check: (obj: any): obj is AnotherClass => obj instanceof AnotherClass,
          uniqueId: 'CustomAnotherClass',
          serialize: (obj) => obj.num.toString(),
          deserialize: (str) => new AnotherClass(parseInt(str))
        }
      ];
      transform = new CustomTransformers(transformers, 10);
    });

    it('should serialize known class instances', () => {
      const instance = new TestClass('test value');
      const data = { obj: instance };

      const serialized = serializeWith(transform, data);
      expect(serialized.obj).toHaveProperty('___type', 'customTransformer');
      expect(serialized.obj).toHaveProperty('uniqueId', 'TestClass');
      expect(serialized.obj.serialized).toBe(JSON.stringify({ value: 'test value' }));
    });

    it('should use custom uniqueId when provided', () => {
      const instance = new AnotherClass(42);
      const data = { obj: instance };

      const serialized = serializeWith(transform, data);
      expect(serialized.obj.uniqueId).toBe('CustomAnotherClass');
    });

    it('should deserialize known class instances', () => {
      const serializedData = {
        obj: {
          ___perfectWS: 1,
          ___type: 'customTransformer',
          uniqueId: 'TestClass',
          serialized: JSON.stringify({ value: 'deserialized' })
        }
      };

      const deserialized = transform.deserialize(serializedData);
      expect(deserialized.obj).toBeInstanceOf(TestClass);
      expect(deserialized.obj.value).toBe('deserialized');
    });

    it('should throw error for unknown transformer during deserialization', () => {
      const serializedData = {
        obj: {
          ___perfectWS: 1,
          ___type: 'customTransformer',
          uniqueId: 'UnknownClass',
          serialized: '{}'
        }
      };

      expect(() => transform.deserialize(serializedData)).toThrow('Transform instruction not found: UnknownClass');
    });

    it('should handle nested class instances', () => {
      const data = {
        level1: {
          instance1: new TestClass('test1'),
          level2: {
            instance2: new AnotherClass(100)
          }
        }
      };

      const serialized = serializeWith(transform, data);
      expect(serialized.level1.instance1).toHaveProperty('___type', 'customTransformer');
      expect(serialized.level1.level2.instance2).toHaveProperty('___type', 'customTransformer');

      const deserialized = transform.deserialize(serialized);
      expect(deserialized.level1.instance1).toBeInstanceOf(TestClass);
      expect(deserialized.level1.instance1.value).toBe('test1');
      expect(deserialized.level1.level2.instance2).toBeInstanceOf(AnotherClass);
      expect(deserialized.level1.level2.instance2.num).toBe(100);
    });

    it('should handle arrays with class instances', () => {
      const data = [
        new TestClass('first'),
        { nested: new AnotherClass(50) },
        'string',
        new TestClass('second')
      ];

      const serialized = serializeWith(transform, data);
      expect(serialized[0]).toHaveProperty('___type', 'customTransformer');
      expect(serialized[1].nested).toHaveProperty('___type', 'customTransformer');
      expect(serialized[2]).toBe('string');
      expect(serialized[3]).toHaveProperty('___type', 'customTransformer');
    });

    it('should ignore non-object values', () => {
      const data = {
        string: 'test',
        number: 42,
        boolean: true,
        null: null,
        undefined: undefined
      };

      const serialized = serializeWith(transform, data);
      expect(serialized).toEqual(data);
    });

    it('should handle class instance at root level', () => {
      const instance = new TestClass('root');
      const serialized = serializeWith(transform, instance);

      expect(serialized).toHaveProperty('___type', 'customTransformer');
      expect(serialized.uniqueId).toBe('TestClass');

      const deserialized = transform.deserialize(serialized);
      expect(deserialized).toBeInstanceOf(TestClass);
      expect(deserialized.value).toBe('root');
    });

    it('should handle empty transformers array', () => {
      const transform = new CustomTransformers([], 10);
      const instance = new TestClass('test');
      const data = { obj: instance };

      const serialized = serializeWith(transform, data);
      expect(serialized.obj).toBe(instance);
    });
  });

  describe('transformReceivedDeserializeType', () => {
    it('should transform objects with specific type', () => {
      const data = {
        value1: { ___perfectWS: 1, ___type: 'testType', data: 'test1' },
        nested: {
          value2: { ___perfectWS: 1, ___type: 'testType', data: 'test2' }
        }
      };

      const result = transformReceivedDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result.value1).toBe('transformed-test1');
      expect(result.nested.value2).toBe('transformed-test2');
    });

    it('should handle transformation at root level', () => {
      const data = { ___perfectWS: 1, ___type: 'testType', data: 'root' };

      const result = transformReceivedDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result).toBe('transformed-root');
    });

    it('does not confuse a nested sole root property with the walker root', () => {
      const marker = { ___perfectWS: 1, ___type: 'testType', data: 'nested-root' };
      const nested = {} as { root: typeof marker | string };
      Object.defineProperty(nested, 'root', {
        value: marker,
        configurable: true,
        enumerable: true,
        writable: false,
      });

      const result = transformReceivedDeserializeType({ nested }, 'testType', found => {
        return `transformed-${found.data}`;
      });

      expect(result.nested.root).toBe('transformed-nested-root');
      expect(Object.getOwnPropertyDescriptor(result.nested, 'root')).toMatchObject({
        configurable: true,
        enumerable: true,
        writable: false,
      });
    });

    it('should skip non-matching types', () => {
      const data = {
        value1: { ___type: 'otherType', data: 'test1' },
        value2: { ___perfectWS: 1, ___type: 'testType', data: 'test2' }
      };

      const result = transformReceivedDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result.value1).toEqual({ ___type: 'otherType', data: 'test1' });
      expect(result.value2).toBe('transformed-test2');
    });

    it('should handle circular references', () => {
      const obj: any = { ___perfectWS: 1, ___type: 'testType', data: 'test' };
      obj.circular = obj;

      const result = transformReceivedDeserializeType(obj, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result).toBe('transformed-test');
    });

    it('should handle max depth exceeded', () => {
      const createDeepObject = (depth: number): any => {
        if (depth === 0) {
          return { ___perfectWS: 1, ___type: 'testType', data: 'deep' };
        }
        return { nested: createDeepObject(depth - 1) };
      };

      const data = createDeepObject(3);

      // transformReceivedDeserializeType should stop at max depth
      const result = transformReceivedDeserializeType(data, 'testType', (found) => 'transformed', 1);

      // The deep object should not be transformed (beyond depth limit)
      expect(result.nested.nested).toBeDefined();
      expect(result.nested.nested.nested.___type).toBe('testType'); // Not transformed
    });

    it('should handle arrays', () => {
      const data = [
        { ___perfectWS: 1, ___type: 'testType', data: 'first' },
        'string',
        { nested: { ___perfectWS: 1, ___type: 'testType', data: 'second' } }
      ];

      const result = transformReceivedDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result[0]).toBe('transformed-first');
      expect(result[1]).toBe('string');
      expect(result[2].nested).toBe('transformed-second');
    });

    it('should handle null and undefined values', () => {
      const data = {
        null: null,
        undefined: undefined,
        nested: {
          value: { ___perfectWS: 1, ___type: 'testType', data: 'test' }
        }
      };

      const result = transformReceivedDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result.null).toBe(null);
      expect(result.undefined).toBe(undefined);
      expect(result.nested.value).toBe('transformed-test');
    });

    it('should handle primitive values at root', () => {
      expect(transformReceivedDeserializeType('string', 'testType', () => 'transformed')).toBe('string');
      expect(transformReceivedDeserializeType(42, 'testType', () => 'transformed')).toBe(42);
      expect(transformReceivedDeserializeType(true, 'testType', () => 'transformed')).toBe(true);
      expect(transformReceivedDeserializeType(null, 'testType', () => 'transformed')).toBe(null);
    });

    it('should use iterative approach for performance', () => {
      const data = {
        a: { b: { c: { d: { e: { ___perfectWS: 1, ___type: 'testType', data: 'deep' } } } } }
      };

      const transformSpy = vi.fn((found) => `transformed-${found.data}`);
      const result = transformReceivedDeserializeType(data, 'testType', transformSpy);

      expect(transformSpy).toHaveBeenCalledTimes(1);
      expect(result.a.b.c.d.e).toBe('transformed-deep');
    });
  });
});
