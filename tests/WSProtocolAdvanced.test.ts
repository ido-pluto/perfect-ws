import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWSAdvanced } from '../src/PerfectWSAdvanced/PerfectWSAdvanced.ts';
import { TransformAll } from '../src/PerfectWSAdvanced/TransformAll.ts';
import { NetworkEventListener } from '../src/utils/NetworkEventListener.ts';

describe('PerfectWSAdvanced', () => {
  describe('Class Inheritance', () => {
    it('should extend PerfectWS', () => {
      const { router } = PerfectWSAdvanced.client();
      expect(router).toBeInstanceOf(PerfectWSAdvanced);
    });

    it('should have transformers property', () => {
      const { router } = PerfectWSAdvanced.client();
      expect(router.transformers).toBeDefined();
      expect(Array.isArray(router.transformers)).toBe(true);
    });

    it('should have maxTransformDepth in config', () => {
      const { router } = PerfectWSAdvanced.client();
      expect(router.config.maxTransformDepth).toBe(100);
    });
  });

  describe('Transform Integration', () => {
    it('should create TransformAll instance for each event listener', () => {
      const { router } = PerfectWSAdvanced.client();
      const events1 = new NetworkEventListener();
      const events2 = new NetworkEventListener();

      const transforms1 = (router as any)._getTransforms(events1);
      const transforms2 = (router as any)._getTransforms(events2);

      expect(transforms1).toBeInstanceOf(TransformAll);
      expect(transforms2).toBeInstanceOf(TransformAll);
      expect(transforms1).not.toBe(transforms2);
    });

    it('should reuse TransformAll instance for same event listener', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const transforms1 = (router as any)._getTransforms(events);
      const transforms2 = (router as any)._getTransforms(events);

      expect(transforms1).toBe(transforms2);
    });

    it('should pass transformers to TransformAll', () => {
      const { router } = PerfectWSAdvanced.client();

      class TestClass {
        constructor(public value: string) {}
      }

      router.transformers = [{
        check: (obj: any): obj is TestClass => obj instanceof TestClass,
        uniqueId: 'TestClass',
        serialize: (obj) => obj.value,
        deserialize: (str) => new TestClass(str)
      }];

      const events = new NetworkEventListener();
      const transforms = (router as any)._getTransforms(events);

      expect(transforms).toBeDefined();
    });
  });

  describe('Serialization/Deserialization Override', () => {
    it('should serialize request data with transforms', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const abortController = new AbortController();
      const data = {
        signal: abortController.signal,
        callback: () => 'test',
        normal: 'value'
      };

      const serialized = (router as any).serializeRequestData(data, events);

      expect(serialized.signal).toHaveProperty('___type', 'abortSignal');
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.normal).toBe('value');
    });

    it('should deserialize request data with transforms', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const serializedData = {
        signal: {
          ___type: 'abortSignal',
          signalId: 'test-id'
        },
        callback: {
          ___type: 'callback',
          funcId: 'func-id',
          funcName: 'testFunc'
        },
        normal: 'value'
      };

      const deserialized = (router as any).deserializeRequestData(serializedData, events);

      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
      expect(typeof deserialized.callback).toBe('function');
      expect(deserialized.normal).toBe('value');
    });
  });

  describe('Custom Classes Transform', () => {
    class CustomDate {
      constructor(public timestamp: number) {}
      toISOString() {
        return new Date(this.timestamp).toISOString();
      }
    }

    class CustomBuffer {
      constructor(public data: string) {}
      toString() {
        return this.data;
      }
    }

    it('should serialize and deserialize custom classes', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const transformers = [
        {
          check: (obj: any): obj is CustomDate => obj instanceof CustomDate,
          uniqueId: 'CustomDate',
          serialize: (obj: CustomDate) => obj.timestamp.toString(),
          deserialize: (str: string) => new CustomDate(parseInt(str))
        },
        {
          check: (obj: any): obj is CustomBuffer => obj instanceof CustomBuffer,
          uniqueId: 'MyCustomBuffer',
          serialize: (obj: CustomBuffer) => obj.data,
          deserialize: (str: string) => new CustomBuffer(str)
        }
      ];

      router.transformers = transformers as any;

      const testData = {
        date: new CustomDate(1234567890000),
        buffer: new CustomBuffer('test data'),
        nested: {
          anotherDate: new CustomDate(9876543210000)
        }
      };

      const serialized = (router as any).serializeRequestData(testData, events);
      expect(serialized.date).toHaveProperty('___type', 'customTransformer');
      expect(serialized.buffer).toHaveProperty('___type', 'customTransformer');
      expect(serialized.nested.anotherDate).toHaveProperty('___type', 'customTransformer');

      const deserialized = (router as any).deserializeRequestData(serialized, events);
      expect(deserialized.date).toBeInstanceOf(CustomDate);
      expect(deserialized.date.timestamp).toBe(1234567890000);
      expect(deserialized.buffer).toBeInstanceOf(CustomBuffer);
      expect(deserialized.buffer.data).toBe('test data');
      expect(deserialized.nested.anotherDate).toBeInstanceOf(CustomDate);
      expect(deserialized.nested.anotherDate.timestamp).toBe(9876543210000);
    });

    it('should handle arrays of custom classes', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const transformers = [{
        check: (obj: any): obj is CustomDate => obj instanceof CustomDate,
        uniqueId: 'CustomDate',
        serialize: (obj: CustomDate) => obj.timestamp.toString(),
        deserialize: (str: string) => new CustomDate(parseInt(str))
      }];

      router.transformers = transformers as any;

      const testData = [
        new CustomDate(1000),
        new CustomDate(2000),
        { date: new CustomDate(3000) }
      ];

      const serialized = (router as any).serializeRequestData(testData, events);
      expect(serialized[0]).toHaveProperty('___type', 'customTransformer');
      expect(serialized[1]).toHaveProperty('___type', 'customTransformer');
      expect(serialized[2].date).toHaveProperty('___type', 'customTransformer');

      const deserialized = (router as any).deserializeRequestData(serialized, events);
      expect(deserialized[0]).toBeInstanceOf(CustomDate);
      expect(deserialized[0].timestamp).toBe(1000);
      expect(deserialized[1]).toBeInstanceOf(CustomDate);
      expect(deserialized[1].timestamp).toBe(2000);
      expect(deserialized[2].date).toBeInstanceOf(CustomDate);
      expect(deserialized[2].date.timestamp).toBe(3000);
    });
  });

  describe('Function Serialization', () => {
    it('should serialize and deserialize functions', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const testData = {
        callback: (a: number, b: number) => a + b,
        multiply: (x: number) => x * 2,
        async: async (str: string) => str.toUpperCase()
      };

      const serialized = (router as any).serializeRequestData(testData, events);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.multiply).toHaveProperty('___type', 'callback');
      expect(serialized.async).toHaveProperty('___type', 'callback');

      const deserialized = (router as any).deserializeRequestData(serialized, events);
      expect(typeof deserialized.callback).toBe('function');
      expect(typeof deserialized.multiply).toBe('function');
      expect(typeof deserialized.async).toBe('function');
    });
  });

  describe('AbortSignal Serialization', () => {
    it('should serialize and deserialize AbortSignals', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const ac1 = new AbortController();
      const ac2 = new AbortController();

      const testData = {
        signal1: ac1.signal,
        signal2: ac2.signal,
        nested: {
          signal3: new AbortController().signal
        }
      };

      const serialized = (router as any).serializeRequestData(testData, events);
      expect(serialized.signal1).toHaveProperty('___type', 'abortSignal');
      expect(serialized.signal2).toHaveProperty('___type', 'abortSignal');
      expect(serialized.nested.signal3).toHaveProperty('___type', 'abortSignal');

      const deserialized = (router as any).deserializeRequestData(serialized, events);
      expect(deserialized.signal1).toBeInstanceOf(AbortSignal);
      expect(deserialized.signal2).toBeInstanceOf(AbortSignal);
      expect(deserialized.nested.signal3).toBeInstanceOf(AbortSignal);
    });

    it('should handle pre-aborted signals', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      const ac = new AbortController();
      ac.abort('Already aborted');

      const testData = {
        signal: ac.signal
      };

      const serialized = (router as any).serializeRequestData(testData, events);
      expect(serialized.signal).toHaveProperty('___type', 'abortSignal');

      const deserialized = (router as any).deserializeRequestData(serialized, events);
      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('Mixed Transforms', () => {
    it('should handle all transform types together', () => {
      const { router } = PerfectWSAdvanced.client();
      const events = new NetworkEventListener();

      class TestClass {
        constructor(public value: string) {}
      }

      router.transformers = [{
        check: (obj: any): obj is TestClass => obj instanceof TestClass,
        uniqueId: 'TestClass',
        serialize: (obj: TestClass) => obj.value,
        deserialize: (str: string) => new TestClass(str)
      }];

      const abortController = new AbortController();
      const testData = {
        callback: (str: string) => str.toUpperCase(),
        signal: abortController.signal,
        compute: (n: number) => n * 2,
        instance: new TestClass('original'),
        nested: {
          anotherCallback: () => 'nested',
          anotherInstance: new TestClass('nested')
        }
      };

      const serialized = (router as any).serializeRequestData(testData, events);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.signal).toHaveProperty('___type', 'abortSignal');
      expect(serialized.compute).toHaveProperty('___type', 'callback');
      expect(serialized.instance).toHaveProperty('___type', 'customTransformer');
      expect(serialized.nested.anotherCallback).toHaveProperty('___type', 'callback');
      expect(serialized.nested.anotherInstance).toHaveProperty('___type', 'customTransformer');

      const deserialized = (router as any).deserializeRequestData(serialized, events);
      expect(typeof deserialized.callback).toBe('function');
      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
      expect(typeof deserialized.compute).toBe('function');
      expect(deserialized.instance).toBeInstanceOf(TestClass);
      expect(deserialized.instance.value).toBe('original');
      expect(typeof deserialized.nested.anotherCallback).toBe('function');
      expect(deserialized.nested.anotherInstance).toBeInstanceOf(TestClass);
      expect(deserialized.nested.anotherInstance.value).toBe('nested');
    });
  });

  describe('Max Depth Handling', () => {
    it('should respect maxTransformDepth config', () => {
      const { router } = PerfectWSAdvanced.client();
      router.config.maxTransformDepth = 1;

      const events = new NetworkEventListener();

      const deepData = {
        level1: {
          level2: {
            callback: () => 'test'
          }
        }
      };

      // Should not transform beyond max depth
      const serialized = (router as any).serializeRequestData(deepData, events);

      // Level 2 callback should not be transformed (beyond depth)
      expect(typeof serialized.level1.level2.callback).toBe('function');
    });
  });

  describe('Static Factory Methods', () => {
    it('should create client instance with PerfectWSAdvanced', () => {
      const { router } = PerfectWSAdvanced.client();
      expect(router).toBeInstanceOf(PerfectWSAdvanced);
    });

    it('should create server instance with PerfectWSAdvanced', () => {
      const { router } = PerfectWSAdvanced.server();
      expect(router).toBeInstanceOf(PerfectWSAdvanced);
    });
  });

  describe('TransformAll Integration', () => {
    it('should apply all transforms in order', () => {
      const events = new NetworkEventListener();

      class TestClass {
        constructor(public value: string) {}
      }

      const transformers = [{
        check: (obj: any): obj is TestClass => obj instanceof TestClass,
        uniqueId: 'TestClass',
        serialize: (obj: TestClass) => obj.value,
        deserialize: (str: string) => new TestClass(str)
      }];

      const transformAll = new TransformAll(events, transformers as any, 10);

      const abortController = new AbortController();
      const data = {
        signal: abortController.signal,
        callback: function namedFunc() { return 'test'; },
        instance: new TestClass('test'),
        normal: 'value'
      };

      const serialized = transformAll.serialize(data);

      expect(serialized.signal).toHaveProperty('___type', 'abortSignal');
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.instance).toHaveProperty('___type', 'customTransformer');
      expect(serialized.normal).toBe('value');

      const deserialized = transformAll.deserialize(serialized);

      expect(deserialized.signal).toBeInstanceOf(AbortSignal);
      expect(typeof deserialized.callback).toBe('function');
      expect(deserialized.instance).toBeInstanceOf(TestClass);
      expect(deserialized.normal).toBe('value');
    });

    it('should handle empty transformers', () => {
      const events = new NetworkEventListener();
      const transformAll = new TransformAll(events, undefined, 10);

      const data = {
        callback: () => 'test',
        normal: 'value'
      };

      const serialized = transformAll.serialize(data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.normal).toBe('value');
    });

    it('should handle empty array transformers', () => {
      const events = new NetworkEventListener();
      const transformAll = new TransformAll(events, [], 10);

      const data = {
        callback: () => 'test',
        normal: 'value'
      };

      const serialized = transformAll.serialize(data);
      expect(serialized.callback).toHaveProperty('___type', 'callback');
      expect(serialized.normal).toBe('value');
    });
  });

  describe('Circular Object Handling', () => {
    it('should serialize circular objects with reference markers', () => {
      const events = new NetworkEventListener();
      const transformAll = new TransformAll(events);

      const circularObj: any = { name: 'test' };
      circularObj.self = circularObj;

      const serialized = transformAll.serialize(circularObj);
      expect(serialized.self).toHaveProperty('___type', 'circularRef');
      expect(serialized.self).toHaveProperty('refPath', '');
      expect(serialized.name).toBe('test');

      const deserialized = transformAll.deserialize(serialized);
      expect(deserialized.self).toBe(deserialized);
    });

    it('should handle nested circular references', () => {
      const events = new NetworkEventListener();
      const transformAll = new TransformAll(events);

      const parent: any = { name: 'parent' };
      const child: any = { name: 'child', parent };
      parent.child = child;

      const serialized = transformAll.serialize(parent);
      expect(serialized.child.parent).toHaveProperty('___type', 'circularRef');
      expect(serialized.child.parent).toHaveProperty('refPath', '');
      expect(serialized.name).toBe('parent');
      expect(serialized.child.name).toBe('child');

      const deserialized = transformAll.deserialize(serialized);
      expect(deserialized.child.parent).toBe(deserialized);
    });

    it('should handle circular arrays', () => {
      const events = new NetworkEventListener();
      const transformAll = new TransformAll(events);

      const circularArray: any = [1, 2, 3];
      circularArray.push(circularArray);

      const serialized = transformAll.serialize(circularArray);
      expect(serialized[3]).toHaveProperty('___type', 'circularRef');
      expect(serialized[3]).toHaveProperty('refPath', '');
      expect(serialized[0]).toBe(1);
      expect(serialized[1]).toBe(2);
      expect(serialized[2]).toBe(3);

      const deserialized = transformAll.deserialize(serialized);
      expect(deserialized[3]).toBe(deserialized);
    });

    it('should respect maxDepth for circular detection', () => {
      const events = new NetworkEventListener();
      const transformAll = new TransformAll(events, undefined, 10);

      const deepObj: any = { level1: { level2: { level3: {} } } };
      deepObj.level1.level2.level3.circular = deepObj;

      const serialized = transformAll.serialize(deepObj);
      expect(serialized.level1.level2.level3.circular).toHaveProperty('___type', 'circularRef');
      expect(serialized.level1.level2.level3.circular).toHaveProperty('refPath', '');

      const deserialized = transformAll.deserialize(serialized);
      expect(deserialized.level1.level2.level3.circular).toBe(deserialized);
    });

    it('should not create circular references for non-circular objects', () => {
      const events = new NetworkEventListener();
      const transformAll = new TransformAll(events);

      const normalObj = { name: 'test', value: 42, nested: { data: 'value' } };

      const serialized = transformAll.serialize(normalObj);
      expect(serialized).not.toHaveProperty('___type');
      expect(serialized.name).toBe('test');
      expect(serialized.value).toBe(42);
      expect(serialized.nested.data).toBe('value');
    });
  });
});