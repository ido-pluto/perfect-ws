import { describe, it, expect, beforeEach } from 'vitest';
import { TransformBinaryData } from '../src/PerfectWSAdvanced/transform/TransformBinaryData';
import { BSON } from 'bson';

describe('TransformBinaryData - Comprehensive Binary Data Tests', () => {
    let transform: TransformBinaryData;

    beforeEach(() => {
        transform = new TransformBinaryData(10);
    });

    describe('Buffer', () => {
        it('should serialize and deserialize Buffer with same interface', () => {
            const original = Buffer.from([1, 2, 3, 4, 5]);
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            expect(serialized.buffer).toHaveProperty('___type', 'binaryData');
            expect(serialized.buffer).toHaveProperty('type', 'Buffer');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(Buffer.compare(deserialized.buffer, original)).toBe(0);
        });

        it('should handle Buffer created from string', () => {
            const original = Buffer.from('Hello World', 'utf-8');
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.buffer.toString('utf-8')).toBe('Hello World');
        });

        it('should handle empty Buffer', () => {
            const original = Buffer.alloc(0);
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.buffer.length).toBe(0);
        });

        it('should handle large Buffer', () => {
            const original = Buffer.alloc(10000);
            for (let i = 0; i < original.length; i++) {
                original[i] = i % 256;
            }
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(Buffer.compare(deserialized.buffer, original)).toBe(0);
        });
    });

    describe('Uint8Array', () => {
        it('should serialize and deserialize Uint8Array with same interface', () => {
            const original = new Uint8Array([10, 20, 30, 40, 50]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Uint8Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Uint8Array);
            expect(Array.from(deserialized.array)).toEqual([10, 20, 30, 40, 50]);
        });

        it('should preserve Uint8Array values correctly', () => {
            const original = new Uint8Array([0, 127, 128, 255]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Uint8Array);
            expect(deserialized.array[0]).toBe(0);
            expect(deserialized.array[1]).toBe(127);
            expect(deserialized.array[2]).toBe(128);
            expect(deserialized.array[3]).toBe(255);
        });
    });

    describe('Uint16Array', () => {
        it('should serialize and deserialize Uint16Array with same interface', () => {
            const original = new Uint16Array([100, 200, 300, 400]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Uint16Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Uint16Array);
            expect(Array.from(deserialized.array)).toEqual([100, 200, 300, 400]);
        });

        it('should handle Uint16Array max values', () => {
            const original = new Uint16Array([0, 32767, 32768, 65535]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Uint16Array);
            expect(Array.from(deserialized.array)).toEqual([0, 32767, 32768, 65535]);
        });
    });

    describe('Uint32Array', () => {
        it('should serialize and deserialize Uint32Array with same interface', () => {
            const original = new Uint32Array([1000, 2000, 3000, 4000]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Uint32Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Uint32Array);
            expect(Array.from(deserialized.array)).toEqual([1000, 2000, 3000, 4000]);
        });

        it('should handle Uint32Array max values', () => {
            const original = new Uint32Array([0, 2147483647, 2147483648, 4294967295]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Uint32Array);
            expect(Array.from(deserialized.array)).toEqual([0, 2147483647, 2147483648, 4294967295]);
        });
    });

    describe('Int8Array', () => {
        it('should serialize and deserialize Int8Array with same interface', () => {
            const original = new Int8Array([-10, -5, 0, 5, 10]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Int8Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Int8Array);
            expect(Array.from(deserialized.array)).toEqual([-10, -5, 0, 5, 10]);
        });

        it('should handle Int8Array boundary values', () => {
            const original = new Int8Array([-128, -1, 0, 1, 127]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Int8Array);
            expect(Array.from(deserialized.array)).toEqual([-128, -1, 0, 1, 127]);
        });
    });

    describe('Int16Array', () => {
        it('should serialize and deserialize Int16Array with same interface', () => {
            const original = new Int16Array([-1000, -500, 0, 500, 1000]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Int16Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Int16Array);
            expect(Array.from(deserialized.array)).toEqual([-1000, -500, 0, 500, 1000]);
        });

        it('should handle Int16Array boundary values', () => {
            const original = new Int16Array([-32768, -1, 0, 1, 32767]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Int16Array);
            expect(Array.from(deserialized.array)).toEqual([-32768, -1, 0, 1, 32767]);
        });
    });

    describe('Int32Array', () => {
        it('should serialize and deserialize Int32Array with same interface', () => {
            const original = new Int32Array([-10000, -5000, 0, 5000, 10000]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Int32Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Int32Array);
            expect(Array.from(deserialized.array)).toEqual([-10000, -5000, 0, 5000, 10000]);
        });

        it('should handle Int32Array boundary values', () => {
            const original = new Int32Array([-2147483648, -1, 0, 1, 2147483647]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Int32Array);
            expect(Array.from(deserialized.array)).toEqual([-2147483648, -1, 0, 1, 2147483647]);
        });
    });

    describe('Float32Array', () => {
        it('should serialize and deserialize Float32Array with same interface', () => {
            const original = new Float32Array([-1.5, -0.5, 0, 0.5, 1.5]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Float32Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Float32Array);
            expect(Array.from(deserialized.array)).toEqual(Array.from(original));
        });

        it('should handle Float32Array special values', () => {
            const original = new Float32Array([0, -0, Infinity, -Infinity, 3.14159]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Float32Array);
            expect(deserialized.array[0]).toBe(0);
            expect(deserialized.array[1]).toBe(-0);
            expect(deserialized.array[2]).toBe(Infinity);
            expect(deserialized.array[3]).toBe(-Infinity);
            expect(deserialized.array[4]).toBeCloseTo(3.14159, 5);
        });

        it('should handle Float32Array with NaN', () => {
            const original = new Float32Array([1, NaN, 3]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Float32Array);
            expect(deserialized.array[0]).toBe(1);
            expect(Number.isNaN(deserialized.array[1])).toBe(true);
            expect(deserialized.array[2]).toBe(3);
        });
    });

    describe('Float64Array', () => {
        it('should serialize and deserialize Float64Array with same interface', () => {
            const original = new Float64Array([-1.5, -0.5, 0, 0.5, 1.5]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            expect(serialized.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.array).toHaveProperty('type', 'Float64Array');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.array).toBeInstanceOf(Float64Array);
            expect(Array.from(deserialized.array)).toEqual(Array.from(original));
        });

        it('should handle Float64Array special values', () => {
            const original = new Float64Array([0, -0, Infinity, -Infinity, Math.PI]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Float64Array);
            expect(deserialized.array[0]).toBe(0);
            expect(deserialized.array[1]).toBe(-0);
            expect(deserialized.array[2]).toBe(Infinity);
            expect(deserialized.array[3]).toBe(-Infinity);
            expect(deserialized.array[4]).toBe(Math.PI);
        });

        it('should maintain Float64Array precision', () => {
            const original = new Float64Array([1.7976931348623157e+308, Number.MIN_VALUE]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Float64Array);
            expect(deserialized.array[0]).toBe(1.7976931348623157e+308);
            expect(deserialized.array[1]).toBe(Number.MIN_VALUE);
        });
    });

    describe('ArrayBuffer', () => {
        it('should serialize and deserialize ArrayBuffer with same interface', () => {
            const original = new ArrayBuffer(16);
            const view = new Uint8Array(original);
            view.set([1, 2, 3, 4, 5, 6, 7, 8]);
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            expect(serialized.buffer).toHaveProperty('___type', 'binaryData');
            expect(serialized.buffer).toHaveProperty('type', 'ArrayBuffer');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.buffer).toBeInstanceOf(ArrayBuffer);
            expect(deserialized.buffer.byteLength).toBe(16);

            const deserializedView = new Uint8Array(deserialized.buffer);
            expect(Array.from(deserializedView.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        });

        it('should handle empty ArrayBuffer', () => {
            const original = new ArrayBuffer(0);
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(ArrayBuffer);
            expect(deserialized.buffer.byteLength).toBe(0);
        });
    });

    describe('DataView', () => {
        it('should serialize and deserialize DataView with same interface', () => {
            const buffer = new ArrayBuffer(16);
            const original = new DataView(buffer);
            original.setInt32(0, 42);
            original.setFloat64(4, 3.14159);
            const data = { view: original };

            const serialized = transform.serialize(data);
            expect(serialized.view).toHaveProperty('___type', 'binaryData');
            expect(serialized.view).toHaveProperty('type', 'DataView');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.view).toBeInstanceOf(DataView);
            expect(deserialized.view.getInt32(0)).toBe(42);
            expect(deserialized.view.getFloat64(4)).toBeCloseTo(3.14159, 5);
        });

        it('should handle DataView with offset and length', () => {
            const buffer = new ArrayBuffer(16);
            const fullView = new DataView(buffer);
            fullView.setUint8(4, 100);
            fullView.setUint8(5, 200);

            const original = new DataView(buffer, 4, 8);
            const data = { view: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.view).toBeInstanceOf(DataView);
            expect(deserialized.view.getUint8(0)).toBe(100);
            expect(deserialized.view.getUint8(1)).toBe(200);
        });
    });

    describe('Nested Binary Data', () => {
        it('should handle deeply nested binary data', () => {
            const data = {
                level1: {
                    buffer: Buffer.from([1, 2, 3]),
                    level2: {
                        array: new Uint8Array([4, 5, 6]),
                        level3: {
                            float: new Float32Array([1.1, 2.2, 3.3])
                        }
                    }
                }
            };

            const serialized = transform.serialize(data);
            expect(serialized.level1.buffer).toHaveProperty('___type', 'binaryData');
            expect(serialized.level1.level2.array).toHaveProperty('___type', 'binaryData');
            expect(serialized.level1.level2.level3.float).toHaveProperty('___type', 'binaryData');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.level1.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.level1.level2.array).toBeInstanceOf(Uint8Array);
            expect(deserialized.level1.level2.level3.float).toBeInstanceOf(Float32Array);
        });

        it('should handle arrays containing binary data', () => {
            const data = [
                Buffer.from([1, 2, 3]),
                new Uint8Array([4, 5, 6]),
                { nested: new Int16Array([7, 8, 9]) },
                'regular string'
            ];

            const serialized = transform.serialize(data);
            expect(serialized[0]).toHaveProperty('___type', 'binaryData');
            expect(serialized[1]).toHaveProperty('___type', 'binaryData');
            expect(serialized[2].nested).toHaveProperty('___type', 'binaryData');
            expect(serialized[3]).toBe('regular string');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized[0]).toBeInstanceOf(Buffer);
            expect(deserialized[1]).toBeInstanceOf(Uint8Array);
            expect(deserialized[2].nested).toBeInstanceOf(Int16Array);
            expect(deserialized[3]).toBe('regular string');
        });
    });

    describe('Mixed Data Types', () => {
        it('should handle objects with mixed data types', () => {
            const data = {
                string: 'hello',
                number: 42,
                boolean: true,
                null: null,
                array: [1, 2, 3],
                buffer: Buffer.from([10, 20, 30]),
                uint8: new Uint8Array([40, 50, 60]),
                object: { key: 'value' }
            };

            const serialized = transform.serialize(data);
            expect(serialized.string).toBe('hello');
            expect(serialized.number).toBe(42);
            expect(serialized.boolean).toBe(true);
            expect(serialized.null).toBe(null);
            expect(serialized.array).toEqual([1, 2, 3]);
            expect(serialized.buffer).toHaveProperty('___type', 'binaryData');
            expect(serialized.uint8).toHaveProperty('___type', 'binaryData');
            expect(serialized.object).toEqual({ key: 'value' });

            const deserialized = transform.deserialize(serialized);
            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.uint8).toBeInstanceOf(Uint8Array);
        });
    });

    describe('Edge Cases', () => {
        it('should handle binary data at root level', () => {
            const original = Buffer.from([1, 2, 3, 4, 5]);

            const serialized = transform.serialize(original);
            expect(serialized).toHaveProperty('___type', 'binaryData');

            const deserialized = transform.deserialize(serialized);
            expect(deserialized).toBeInstanceOf(Buffer);
            expect(Buffer.compare(deserialized, original)).toBe(0);
        });

        it('should respect max depth limit', () => {
            const shallowTransform = new TransformBinaryData(1);
            const deepBuffer = Buffer.from([1, 2, 3]);

            // Create deeply nested structure
            const data = {
                level1: {
                    level2: {
                        level3: {
                            buffer: deepBuffer
                        }
                    }
                }
            };

            const serialized = shallowTransform.serialize(data);
            // Buffer at depth 3 should not be transformed due to depth limit
            expect(serialized.level1.level2.level3.buffer).toBe(deepBuffer);
        });

        it('should handle circular references gracefully', () => {
            const obj: any = {
                buffer: Buffer.from([1, 2, 3])
            };
            obj.circular = obj;

            const serialized = transform.serialize(obj);
            expect(serialized.buffer).toHaveProperty('___type', 'binaryData');
            expect(serialized.circular).toBe(obj.circular); // Circular reference preserved
        });

        it('should not transform non-binary objects', () => {
            const data = {
                date: new Date(),
                regex: /test/,
                function: () => 'test',
                map: new Map([['key', 'value']]),
                set: new Set([1, 2, 3])
            };

            const serialized = transform.serialize(data);
            expect(serialized.date).toBeInstanceOf(Date);
            expect(serialized.regex).toBeInstanceOf(RegExp);
            expect(typeof serialized.function).toBe('function');
            expect(serialized.map).toBeInstanceOf(Map);
            expect(serialized.set).toBeInstanceOf(Set);
        });
    });

    describe('BSON Integration', () => {
        it('should maintain Buffer interface after BSON round-trip without transformer', () => {
            // Demonstrate the problem with plain BSON
            const original = Buffer.from([1, 2, 3, 4, 5]);
            const data = { buffer: original };

            const bsonSerialized = BSON.serialize(data);
            const bsonDeserialized = BSON.deserialize(bsonSerialized);

            // BSON changes Buffer to BSON.Binary
            expect(bsonDeserialized.buffer).not.toBeInstanceOf(Buffer);
            expect(bsonDeserialized.buffer.constructor.name).toBe('Binary');
        });

        it('should maintain Buffer interface after BSON round-trip WITH transformer', () => {
            const original = Buffer.from([1, 2, 3, 4, 5]);
            const data = { buffer: original };

            // Apply transformer before BSON
            const transformed = transform.serialize(data);
            const bsonSerialized = BSON.serialize(transformed);
            const bsonDeserialized = BSON.deserialize(bsonSerialized);
            const restored = transform.deserialize(bsonDeserialized);

            // With transformer, we get Buffer back
            expect(restored.buffer).toBeInstanceOf(Buffer);
            expect(Buffer.compare(restored.buffer, original)).toBe(0);
        });

        it('should handle BSON.Binary objects in deserialization', () => {
            // Simulate data coming from BSON deserialization
            const bsonBinary = new BSON.Binary(Buffer.from([10, 20, 30, 40, 50]));
            const data = {
                ___type: 'binaryData',
                type: 'Buffer',
                data: bsonBinary
            };

            const deserialized = transform.deserialize(data);
            expect(deserialized).toBeInstanceOf(Buffer);
            expect(Array.from(deserialized)).toEqual([10, 20, 30, 40, 50]);
        });

        it('should handle all typed arrays through BSON round-trip', () => {
            const data = {
                buffer: Buffer.from([1, 2, 3]),
                uint8: new Uint8Array([4, 5, 6]),
                uint16: new Uint16Array([7, 8, 9]),
                uint32: new Uint32Array([10, 11, 12]),
                int8: new Int8Array([-1, -2, -3]),
                int16: new Int16Array([-4, -5, -6]),
                int32: new Int32Array([-7, -8, -9]),
                float32: new Float32Array([1.1, 2.2, 3.3]),
                float64: new Float64Array([4.4, 5.5, 6.6])
            };

            // Save expected values before transformation
            const expectedFloat32 = Array.from(data.float32);
            const expectedFloat64 = Array.from(data.float64);

            // Full round-trip with BSON
            const transformed = transform.serialize(data);
            const bsonSerialized = BSON.serialize(transformed);
            const bsonDeserialized = BSON.deserialize(bsonSerialized);
            const restored = transform.deserialize(bsonDeserialized);

            // Verify all types are restored correctly
            expect(restored.buffer).toBeInstanceOf(Buffer);
            expect(restored.uint8).toBeInstanceOf(Uint8Array);
            expect(restored.uint16).toBeInstanceOf(Uint16Array);
            expect(restored.uint32).toBeInstanceOf(Uint32Array);
            expect(restored.int8).toBeInstanceOf(Int8Array);
            expect(restored.int16).toBeInstanceOf(Int16Array);
            expect(restored.int32).toBeInstanceOf(Int32Array);
            expect(restored.float32).toBeInstanceOf(Float32Array);
            expect(restored.float64).toBeInstanceOf(Float64Array);

            // Verify data integrity
            expect(Array.from(restored.buffer)).toEqual([1, 2, 3]);
            expect(Array.from(restored.uint8)).toEqual([4, 5, 6]);
            expect(Array.from(restored.uint16)).toEqual([7, 8, 9]);
            expect(Array.from(restored.uint32)).toEqual([10, 11, 12]);
            expect(Array.from(restored.int8)).toEqual([-1, -2, -3]);
            expect(Array.from(restored.int16)).toEqual([-4, -5, -6]);
            expect(Array.from(restored.int32)).toEqual([-7, -8, -9]);
            expect(Array.from(restored.float32)).toEqual(expectedFloat32);
            expect(Array.from(restored.float64)).toEqual(expectedFloat64);
        });
    });

    describe('Performance and Large Data', () => {
        it('should handle multiple binary objects efficiently', () => {
            const data = {
                buffers: Array.from({ length: 100 }, (_, i) => Buffer.from([i, i + 1, i + 2]))
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffers).toHaveLength(100);
            deserialized.buffers.forEach((buf: Buffer, i: number) => {
                expect(buf).toBeInstanceOf(Buffer);
                expect(Array.from(buf)).toEqual([i, i + 1, i + 2]);
            });
        });

        it('should handle very large single buffer', () => {
            const size = 1024 * 1024; // 1MB
            const original = Buffer.alloc(size);

            // Set some pattern
            for (let i = 0; i < 1000; i++) {
                original[i * 1024] = i % 256;
            }

            const data = { largeBuffer: original };
            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.largeBuffer).toBeInstanceOf(Buffer);
            expect(deserialized.largeBuffer.length).toBe(size);

            // Verify pattern
            for (let i = 0; i < 1000; i++) {
                expect(deserialized.largeBuffer[i * 1024]).toBe(i % 256);
            }
        });
    });

    describe('Binary Data Methods and Properties', () => {
        it('should preserve Buffer methods after deserialization', () => {
            const original = Buffer.from('Hello World', 'utf-8');
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            // Test that Buffer methods work
            expect(deserialized.buffer.toString('utf-8')).toBe('Hello World');
            expect(deserialized.buffer.toString('hex')).toBe(original.toString('hex'));
            expect(deserialized.buffer.toString('base64')).toBe(original.toString('base64'));
            expect(deserialized.buffer.slice(0, 5).toString()).toBe('Hello');
        });

        it('should preserve TypedArray properties', () => {
            const original = new Uint32Array([100, 200, 300]);
            const data = { array: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array.length).toBe(3);
            expect(deserialized.array.byteLength).toBe(12);
            expect(deserialized.array.BYTES_PER_ELEMENT).toBe(4);
        });

        it('should allow modification of deserialized binary data', () => {
            const original = Buffer.from([1, 2, 3, 4, 5]);
            const data = { buffer: original };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            // Modify the deserialized buffer
            deserialized.buffer[0] = 100;
            deserialized.buffer[4] = 200;

            expect(deserialized.buffer[0]).toBe(100);
            expect(deserialized.buffer[4]).toBe(200);
            expect(Array.from(deserialized.buffer)).toEqual([100, 2, 3, 4, 200]);
        });
    });
});

