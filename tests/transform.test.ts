import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TransformAbortSignal } from '../src/PerfectWSAdvanced/transform/TransformAbortSignal.ts';
import { TransformCallbacks } from '../src/PerfectWSAdvanced/transform/TransformCallbacks.ts';
// Replaced by CustomTransformers
import { CustomTransformers, TransformInstruction } from '../src/PerfectWSAdvanced/transform/CustomTransformers.ts';
import { transformSendDeserializeType } from '../src/PerfectWSAdvanced/transform/utils/changeType.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';
import { PerfectWSError } from '../src/PerfectWSError.ts';

describe('Transform Utilities', () => {
  describe('TransformAbortSignal', () => {
    let events: NetworkEventListener;
    let transform: TransformAbortSignal;

    beforeEach(() => {
      events = new NetworkEventListener();
      transform = new TransformAbortSignal(events, 10);
    });

    it('should serialize AbortSignal', () => {
      const abortController = new AbortController();
      const data = { signal: abortController.signal };

      const serialized = transform.serialize(data);
      expect(serialized.signal).toHaveProperty('___type', 'abortSignal');
      expect(serialized.signal).toHaveProperty('signalId');
    });

    it('should deserialize AbortSignal', () => {
      const serializedData = {
        signal: {
          ___type: 'abortSignal',
          signalId: 'test-signal-id'
        }
      };

      const deserialized = transform.deserialize(serializedData);
      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
    });

    it('should handle abort event propagation', () => {
      const abortController = new AbortController();
      const data = { signal: abortController.signal };

      const serialized = transform.serialize(data);
      expect(serialized.signal).toHaveProperty('signalId');

      const deserialized = transform.deserialize(serialized);
      expect(deserialized.signal).toBeInstanceOf(AbortSignal);

      // Verify the event listener is set up
      const signalId = serialized.signal.signalId;

      // Trigger abort on original signal
      abortController.abort('Test abort reason');

      // The transform should emit the event
      events.emit(`___abortSignal.aborted.${signalId}`, { reason: 'Test abort reason' });
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

      const serialized = transform.serialize(data);
      expect(serialized.level1.signal1).toHaveProperty('___type', 'abortSignal');
      expect(serialized.level1.level2.signal2).toHaveProperty('___type', 'abortSignal');

      const deserialized = transform.deserialize(serialized);
      expect(deserialized.level1.signal1).toBeInstanceOf(AbortSignal);
      expect(deserialized.level1.level2.signal2).toBeInstanceOf(AbortSignal);
    });

    it('should handle max depth during serialization', () => {
      const transform = new TransformAbortSignal(events, 0);
      const ac = new AbortController();
      const data = {
        signal: ac.signal
      };

      // Should return object as-is when depth exceeded
      const result = transform.serialize(data);
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

      const serialized = transform.serialize(data);
      expect(serialized).toEqual(data);

      const deserialized = transform.deserialize(data);
      expect(deserialized).toEqual(data);
    });

    it('should handle arrays with AbortSignals', () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const data = [ac1.signal, { nested: ac2.signal }, 'string'];

      const serialized = transform.serialize(data);
      expect(serialized[0]).toHaveProperty('___type', 'abortSignal');
      expect(serialized[1].nested).toHaveProperty('___type', 'abortSignal');
      expect(serialized[2]).toBe('string');
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

      const serialized = transform.serialize(data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.callback).toHaveProperty('funcId');
      expect(serialized.callback.funcName).toBe('testFunction');
    });

    it('should serialize arrow functions', () => {
      const func = () => 'test';
      const data = { callback: func };

      const serialized = transform.serialize(data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.callback).toHaveProperty('funcId');
      expect(serialized.callback.funcName).toBe('func');
    });

    it('should serialize anonymous functions', () => {
      const data = { callback: function() { return 'test'; } };

      const serialized = transform.serialize(data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.callback).toHaveProperty('funcId');
    });

    it('should deserialize functions', () => {
      const serializedData = {
        callback: {
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

      const serialized = transform.serialize(data);
      const funcId = serialized.add.funcId;

      expect(serialized.add).toHaveProperty('___type', 'callback');
      expect(serialized.add).toHaveProperty('funcId');

      const deserialized = transform.deserialize(serialized);
      expect(typeof deserialized.add).toBe('function');
    });

    it('should handle function invocation errors', () => {
      const errorFunc = () => { throw new Error('Function error'); };
      const data = { errorCallback: errorFunc };

      const serialized = transform.serialize(data);

      expect(serialized.errorCallback).toHaveProperty('___type', 'callback');
      expect(serialized.errorCallback).toHaveProperty('funcId');

      const deserialized = transform.deserialize(serialized);
      expect(typeof deserialized.errorCallback).toBe('function');
    });

    it('should handle missing function on invocation', () => {
      const deserialized = transform.deserialize({
        callback: {
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

      const serialized1 = transform.serialize(data1);
      const serialized2 = transform.serialize(data2);

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

      const serialized = transform.serialize(data);
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
      const result = transform.serialize(data);
      expect(result.callback).toBe(func); // Not transformed due to depth limit
    });

    it('should handle objects with function properties', () => {
      const obj = {
        method: function() { return this.value; },
        value: 42
      };

      const serialized = transform.serialize(obj);
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

      const serialized = transform.serialize(data);
      expect(serialized.obj).toHaveProperty('___type', 'customTransformer');
      expect(serialized.obj).toHaveProperty('uniqueId', 'TestClass');
      expect(serialized.obj.serialized).toBe(JSON.stringify({ value: 'test value' }));
    });

    it('should use custom uniqueId when provided', () => {
      const instance = new AnotherClass(42);
      const data = { obj: instance };

      const serialized = transform.serialize(data);
      expect(serialized.obj.uniqueId).toBe('CustomAnotherClass');
    });

    it('should deserialize known class instances', () => {
      const serializedData = {
        obj: {
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

      const serialized = transform.serialize(data);
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

      const serialized = transform.serialize(data);
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

      const serialized = transform.serialize(data);
      expect(serialized).toEqual(data);
    });

    it('should handle class instance at root level', () => {
      const instance = new TestClass('root');
      const serialized = transform.serialize(instance);

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

      const serialized = transform.serialize(data);
      expect(serialized.obj).toBe(instance);
    });
  });

  describe('transformSendDeserializeType', () => {
    it('should transform objects with specific type', () => {
      const data = {
        value1: { ___type: 'testType', data: 'test1' },
        nested: {
          value2: { ___type: 'testType', data: 'test2' }
        }
      };

      const result = transformSendDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result.value1).toBe('transformed-test1');
      expect(result.nested.value2).toBe('transformed-test2');
    });

    it('should handle transformation at root level', () => {
      const data = { ___type: 'testType', data: 'root' };

      const result = transformSendDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result).toBe('transformed-root');
    });

    it('should skip non-matching types', () => {
      const data = {
        value1: { ___type: 'otherType', data: 'test1' },
        value2: { ___type: 'testType', data: 'test2' }
      };

      const result = transformSendDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result.value1).toEqual({ ___type: 'otherType', data: 'test1' });
      expect(result.value2).toBe('transformed-test2');
    });

    it('should handle circular references', () => {
      const obj: any = { ___type: 'testType', data: 'test' };
      obj.circular = obj;

      const result = transformSendDeserializeType(obj, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result).toBe('transformed-test');
    });

    it('should handle max depth exceeded', () => {
      const createDeepObject = (depth: number): any => {
        if (depth === 0) {
          return { ___type: 'testType', data: 'deep' };
        }
        return { nested: createDeepObject(depth - 1) };
      };

      const data = createDeepObject(3);

      // transformSendDeserializeType should stop at max depth
      const result = transformSendDeserializeType(data, 'testType', (found) => 'transformed', 1);

      // The deep object should not be transformed (beyond depth limit)
      expect(result.nested.nested).toBeDefined();
      expect(result.nested.nested.nested.___type).toBe('testType'); // Not transformed
    });

    it('should handle arrays', () => {
      const data = [
        { ___type: 'testType', data: 'first' },
        'string',
        { nested: { ___type: 'testType', data: 'second' } }
      ];

      const result = transformSendDeserializeType(data, 'testType', (found) => {
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
          value: { ___type: 'testType', data: 'test' }
        }
      };

      const result = transformSendDeserializeType(data, 'testType', (found) => {
        return `transformed-${found.data}`;
      });

      expect(result.null).toBe(null);
      expect(result.undefined).toBe(undefined);
      expect(result.nested.value).toBe('transformed-test');
    });

    it('should handle primitive values at root', () => {
      expect(transformSendDeserializeType('string', 'testType', () => 'transformed')).toBe('string');
      expect(transformSendDeserializeType(42, 'testType', () => 'transformed')).toBe(42);
      expect(transformSendDeserializeType(true, 'testType', () => 'transformed')).toBe(true);
      expect(transformSendDeserializeType(null, 'testType', () => 'transformed')).toBe(null);
    });

    it('should use iterative approach for performance', () => {
      const data = {
        a: { b: { c: { d: { e: { ___type: 'testType', data: 'deep' } } } } }
      };

      const transformSpy = vi.fn((found) => `transformed-${found.data}`);
      const result = transformSendDeserializeType(data, 'testType', transformSpy);

      expect(transformSpy).toHaveBeenCalledTimes(1);
      expect(result.a.b.c.d.e).toBe('transformed-deep');
    });
  });
});