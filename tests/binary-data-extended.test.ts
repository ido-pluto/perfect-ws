import { describe, it, expect, beforeEach } from 'vitest';
import { TransformBinaryData } from '../src/PerfectWSAdvanced/transform/TransformBinaryData';
import { BSON } from 'bson';

describe('TransformBinaryData - Extended Tests', () => {
    let transform: TransformBinaryData;

    beforeEach(() => {
        transform = new TransformBinaryData(10);
    });

    describe('TypedArray Subarrays and Slices', () => {
        it('should handle Uint8Array subarray correctly', () => {
            const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            const subarray = original.subarray(2, 6); // [3, 4, 5, 6]
            const data = { array: subarray };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Uint8Array);
            expect(Array.from(deserialized.array)).toEqual([3, 4, 5, 6]);
        });

        it('should handle Uint16Array subarray with alignment', () => {
            const original = new Uint16Array([10, 20, 30, 40, 50]);
            const subarray = original.subarray(1, 4); // [20, 30, 40]
            const data = { array: subarray };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Uint16Array);
            expect(Array.from(deserialized.array)).toEqual([20, 30, 40]);
        });

        it('should handle Float32Array slice', () => {
            const original = new Float32Array([1.1, 2.2, 3.3, 4.4, 5.5]);
            const slice = original.slice(1, 4); // [2.2, 3.3, 4.4]
            const data = { array: slice };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Float32Array);
            expect(Array.from(deserialized.array)).toEqual(Array.from(slice));
        });

        it('should handle misaligned TypedArray buffers', () => {
            // Create a buffer with odd offset
            const buffer = new ArrayBuffer(16);
            const view = new Uint8Array(buffer);
            view.set([1, 2, 3, 4, 5, 6, 7, 8], 1);

            // Create Int32Array from odd offset (will require realignment)
            const oddOffsetView = new Uint8Array(buffer, 1, 8);
            const data = { array: oddOffsetView };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Uint8Array);
            expect(Array.from(deserialized.array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        });
    });

    describe('Zero-length Binary Data', () => {
        it('should handle zero-length Buffer', () => {
            const data = { buffer: Buffer.alloc(0) };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.buffer.length).toBe(0);
        });

        it('should handle zero-length TypedArrays', () => {
            const data = {
                uint8: new Uint8Array(0),
                uint16: new Uint16Array(0),
                uint32: new Uint32Array(0),
                float64: new Float64Array(0)
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.uint8.length).toBe(0);
            expect(deserialized.uint16.length).toBe(0);
            expect(deserialized.uint32.length).toBe(0);
            expect(deserialized.float64.length).toBe(0);
        });

        it('should handle zero-length ArrayBuffer', () => {
            const data = { buffer: new ArrayBuffer(0) };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(ArrayBuffer);
            expect(deserialized.buffer.byteLength).toBe(0);
        });
    });

    describe('Multiple Round-trips', () => {
        it('should maintain integrity through multiple serialization cycles', () => {
            let data = {
                buffer: Buffer.from([1, 2, 3, 4, 5]),
                uint32: new Uint32Array([100, 200, 300]),
                float64: new Float64Array([1.5, 2.5, 3.5])
            };

            // Save expected values
            const expectedBuffer = Array.from(data.buffer);
            const expectedUint32 = Array.from(data.uint32);
            const expectedFloat64 = Array.from(data.float64);

            // Multiple round-trips
            for (let i = 0; i < 5; i++) {
                const serialized = transform.serialize(data);
                data = transform.deserialize(serialized);
            }

            expect(Array.from(data.buffer)).toEqual(expectedBuffer);
            expect(Array.from(data.uint32)).toEqual(expectedUint32);
            expect(Array.from(data.float64)).toEqual(expectedFloat64);
        });

        it('should handle BSON round-trips multiple times', () => {
            let data = { buffer: Buffer.from([10, 20, 30, 40]) };
            const expected = [10, 20, 30, 40];

            for (let i = 0; i < 3; i++) {
                const transformed = transform.serialize(data);
                const bsonSerialized = BSON.serialize(transformed);
                const bsonDeserialized = BSON.deserialize(bsonSerialized);
                data = transform.deserialize(bsonDeserialized);
            }

            expect(data.buffer).toBeInstanceOf(Buffer);
            expect(Array.from(data.buffer)).toEqual(expected);
        });
    });

    describe('Complex Nested Structures', () => {
        it('should handle arrays of arrays with binary data', () => {
            const data = {
                matrix: [
                    [Buffer.from([1, 2]), Buffer.from([3, 4])],
                    [Buffer.from([5, 6]), Buffer.from([7, 8])]
                ]
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.matrix[0][0]).toBeInstanceOf(Buffer);
            expect(Array.from(deserialized.matrix[0][0])).toEqual([1, 2]);
            expect(Array.from(deserialized.matrix[1][1])).toEqual([7, 8]);
        });

        it('should handle maps with binary data', () => {
            const data = {
                bufferMap: new Map([
                    ['key1', Buffer.from([1, 2, 3])],
                    ['key2', new Uint8Array([4, 5, 6])],
                    ['key3', new Int16Array([7, 8, 9])]
                ])
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.bufferMap.get('key1')).toBeInstanceOf(Buffer);
            expect(deserialized.bufferMap.get('key2')).toBeInstanceOf(Uint8Array);
            expect(deserialized.bufferMap.get('key3')).toBeInstanceOf(Int16Array);
        });

        it('should handle sets with binary data', () => {
            const buf1 = Buffer.from([1, 2, 3]);
            const buf2 = Buffer.from([4, 5, 6]);
            const data = {
                bufferSet: new Set([buf1, buf2])
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.bufferSet.size).toBe(2);
            const buffers = Array.from(deserialized.bufferSet);
            expect(buffers[0]).toBeInstanceOf(Buffer);
            expect(buffers[1]).toBeInstanceOf(Buffer);
        });

        it('should handle deeply nested objects with binary data at various levels', () => {
            const data = {
                level1: {
                    buffer: Buffer.from([1]),
                    level2: {
                        array: new Uint16Array([2, 3]),
                        level3: {
                            view: new DataView(new ArrayBuffer(4)),
                            level4: {
                                float: new Float32Array([4.5])
                            }
                        }
                    }
                }
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.level1.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.level1.level2.array).toBeInstanceOf(Uint16Array);
            expect(deserialized.level1.level2.level3.view).toBeInstanceOf(DataView);
            expect(deserialized.level1.level2.level3.level4.float).toBeInstanceOf(Float32Array);
        });
    });

    describe('Special Values and Edge Cases', () => {
        it('should handle buffers containing only zeros', () => {
            const data = {
                zeros: Buffer.alloc(100)
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.zeros).toBeInstanceOf(Buffer);
            expect(deserialized.zeros.length).toBe(100);
            expect(deserialized.zeros.every((byte: number) => byte === 0)).toBe(true);
        });

        it('should handle buffers containing only 0xFF', () => {
            const data = {
                filled: Buffer.alloc(50, 0xFF)
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.filled).toBeInstanceOf(Buffer);
            expect(deserialized.filled.every((byte: number) => byte === 0xFF)).toBe(true);
        });

        it('should handle TypedArrays with extreme values', () => {
            const data = {
                int8Min: new Int8Array([- 128]),
                int8Max: new Int8Array([127]),
                uint8Max: new Uint8Array([255]),
                int16Min: new Int16Array([-32768]),
                int16Max: new Int16Array([32767]),
                int32Min: new Int32Array([-2147483648]),
                int32Max: new Int32Array([2147483647])
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.int8Min[0]).toBe(-128);
            expect(deserialized.int8Max[0]).toBe(127);
            expect(deserialized.uint8Max[0]).toBe(255);
            expect(deserialized.int16Min[0]).toBe(-32768);
            expect(deserialized.int16Max[0]).toBe(32767);
            expect(deserialized.int32Min[0]).toBe(-2147483648);
            expect(deserialized.int32Max[0]).toBe(2147483647);
        });

        it('should handle Float arrays with special values', () => {
            const data = {
                floats: new Float32Array([Infinity, -Infinity, NaN, 0, -0]),
                doubles: new Float64Array([Infinity, -Infinity, NaN, Number.MAX_VALUE, Number.MIN_VALUE])
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.floats[0]).toBe(Infinity);
            expect(deserialized.floats[1]).toBe(-Infinity);
            expect(Number.isNaN(deserialized.floats[2])).toBe(true);
            expect(deserialized.doubles[0]).toBe(Infinity);
            expect(deserialized.doubles[1]).toBe(-Infinity);
            expect(Number.isNaN(deserialized.doubles[2])).toBe(true);
        });
    });

    describe('DataView Advanced Operations', () => {
        it('should preserve DataView with mixed data types', () => {
            const buffer = new ArrayBuffer(24); // Increased size to fit all data
            const view = new DataView(buffer);
            view.setInt8(0, -128);
            view.setUint8(1, 255);
            view.setInt16(2, -32768, true); // little-endian
            view.setUint16(4, 65535, false); // big-endian
            view.setFloat32(6, 3.14159, true);
            view.setFloat64(16, Math.PI, false); // Moved to offset 16 (needs 8 bytes)

            const data = { view };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.view).toBeInstanceOf(DataView);
            expect(deserialized.view.getInt8(0)).toBe(-128);
            expect(deserialized.view.getUint8(1)).toBe(255);
            expect(deserialized.view.getInt16(2, true)).toBe(-32768);
            expect(deserialized.view.getUint16(4, false)).toBe(65535);
            expect(deserialized.view.getFloat32(6, true)).toBeCloseTo(3.14159, 5);
            expect(deserialized.view.getFloat64(16, false)).toBe(Math.PI);
        });

        it('should handle DataView with partial buffer views', () => {
            const buffer = new ArrayBuffer(20);
            const fullView = new Uint8Array(buffer);
            fullView.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);

            const partialView = new DataView(buffer, 5, 10);
            const data = { view: partialView };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.view).toBeInstanceOf(DataView);
            expect(deserialized.view.byteLength).toBe(10);
            expect(deserialized.view.getUint8(0)).toBe(1);
            expect(deserialized.view.getUint8(9)).toBe(10);
        });
    });

    describe('Performance and Stress Tests', () => {
        it('should handle many small buffers efficiently', () => {
            const data = {
                buffers: Array.from({ length: 1000 }, (_, i) => Buffer.from([i % 256]))
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffers).toHaveLength(1000);
            deserialized.buffers.forEach((buf: Buffer, i: number) => {
                expect(buf).toBeInstanceOf(Buffer);
                expect(buf[0]).toBe(i % 256);
            });
        });

        it('should handle mixed types in large arrays', () => {
            const data = {
                mixed: Array.from({ length: 100 }, (_, i) => {
                    switch (i % 5) {
                        case 0: return Buffer.from([i]);
                        case 1: return new Uint8Array([i]);
                        case 2: return new Int16Array([i]);
                        case 3: return new Float32Array([i * 1.5]);
                        case 4: return { value: i }; // Non-binary
                        default: return null;
                    }
                })
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.mixed).toHaveLength(100);
            expect(deserialized.mixed[0]).toBeInstanceOf(Buffer);
            expect(deserialized.mixed[1]).toBeInstanceOf(Uint8Array);
            expect(deserialized.mixed[2]).toBeInstanceOf(Int16Array);
            expect(deserialized.mixed[3]).toBeInstanceOf(Float32Array);
            expect(deserialized.mixed[4]).toEqual({ value: 4 });
        });
    });

    describe('Encoding and Character Sets', () => {
        it('should preserve UTF-8 encoded buffers', () => {
            const text = 'Hello 世界 🌍';
            const data = { buffer: Buffer.from(text, 'utf-8') };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.buffer.toString('utf-8')).toBe(text);
        });

        it('should preserve Base64 encoded buffers', () => {
            const base64 = 'SGVsbG8gV29ybGQ=';
            const data = { buffer: Buffer.from(base64, 'base64') };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.buffer.toString('base64')).toBe(base64);
        });

        it('should preserve Hex encoded buffers', () => {
            const hex = 'deadbeef';
            const data = { buffer: Buffer.from(hex, 'hex') };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.buffer.toString('hex')).toBe(hex);
        });
    });

    describe('Interoperability', () => {
        it('should work with Buffer.concat results', () => {
            const buf1 = Buffer.from([1, 2, 3]);
            const buf2 = Buffer.from([4, 5, 6]);
            const buf3 = Buffer.from([7, 8, 9]);
            const concatenated = Buffer.concat([buf1, buf2, buf3]);

            const data = { buffer: concatenated };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(Array.from(deserialized.buffer)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        });

        it('should work with TypedArray.from results', () => {
            const uint8 = Uint8Array.from([1, 2, 3, 4, 5]);
            const int16 = Int16Array.from([10, 20, 30]);

            const data = { uint8, int16 };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(Array.from(deserialized.uint8)).toEqual([1, 2, 3, 4, 5]);
            expect(Array.from(deserialized.int16)).toEqual([10, 20, 30]);
        });

        it('should work with SharedArrayBuffer backed TypedArrays if available', () => {
            // SharedArrayBuffer may not be available in all environments
            if (typeof SharedArrayBuffer === 'undefined') {
                return; // Skip test if not available
            }

            const sab = new SharedArrayBuffer(16);
            const uint32 = new Uint32Array(sab);
            uint32.set([100, 200, 300, 400]);

            const data = { array: uint32 };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.array).toBeInstanceOf(Uint32Array);
            expect(Array.from(deserialized.array)).toEqual([100, 200, 300, 400]);
        });
    });

    describe('Error Handling and Edge Cases', () => {
        it('should handle null and undefined gracefully', () => {
            const data = {
                buffer: Buffer.from([1, 2, 3]),
                nullValue: null,
                undefinedValue: undefined
            };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.buffer).toBeInstanceOf(Buffer);
            expect(deserialized.nullValue).toBe(null);
            expect(deserialized.undefinedValue).toBe(undefined);
        });

        it('should not transform non-binary objects', () => {
            const data = {
                date: new Date(),
                regex: /test/,
                string: 'hello',
                number: 42,
                boolean: true,
                object: { key: 'value' }
            };

            const serialized = transform.serialize(data);

            // None of these should be transformed
            expect(serialized.date).toBeInstanceOf(Date);
            expect(serialized.regex).toBeInstanceOf(RegExp);
            expect(serialized.string).toBe('hello');
            expect(serialized.number).toBe(42);
            expect(serialized.boolean).toBe(true);
            expect(serialized.object).toEqual({ key: 'value' });
        });
    });

    describe('Real-world Scenarios', () => {
        it('should handle image-like data (RGBA pixels)', () => {
            // Simulate 10x10 RGBA image
            // Note: Uint8ClampedArray is treated as Uint8Array by our transformer
            const width = 10;
            const height = 10;
            const pixels = new Uint8Array(width * height * 4);

            // Fill with gradient
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = (y * width + x) * 4;
                    pixels[i] = x * 25;     // R
                    pixels[i + 1] = y * 25; // G
                    pixels[i + 2] = 128;    // B
                    pixels[i + 3] = 255;    // A
                }
            }

            const data = { imageData: pixels };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.imageData).toBeInstanceOf(Uint8Array);
            expect(deserialized.imageData.length).toBe(400);
            expect(deserialized.imageData[0]).toBe(0);
            expect(deserialized.imageData[3]).toBe(255);
        });

        it('should handle audio-like data (Float32 samples)', () => {
            // Simulate audio samples (44.1kHz, 1 second, mono)
            const sampleRate = 44100;
            const duration = 0.1; // 100ms
            const samples = new Float32Array(Math.floor(sampleRate * duration));

            // Generate simple sine wave
            const frequency = 440; // A4 note
            for (let i = 0; i < samples.length; i++) {
                samples[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate);
            }

            const data = { audioSamples: samples };

            const serialized = transform.serialize(data);
            const deserialized = transform.deserialize(serialized);

            expect(deserialized.audioSamples).toBeInstanceOf(Float32Array);
            expect(deserialized.audioSamples.length).toBe(samples.length);
            expect(deserialized.audioSamples[0]).toBeCloseTo(samples[0], 5);
        });

        it('should handle cryptographic data (hashes and signatures)', () => {
            const data = {
                sha256Hash: Buffer.from('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex'),
                signature: Buffer.from(Array(64).fill(0).map((_, i) => i)),
                publicKey: new Uint8Array(32).fill(42),
                nonce: Buffer.from(Array(16).fill(0).map(() => Math.floor(Math.random() * 256)))
            };

            const serialized = transform.serialize(data);
            const bsonSerialized = BSON.serialize(serialized);
            const bsonDeserialized = BSON.deserialize(bsonSerialized);
            const deserialized = transform.deserialize(bsonDeserialized);

            expect(deserialized.sha256Hash).toBeInstanceOf(Buffer);
            expect(deserialized.sha256Hash.length).toBe(32);
            expect(deserialized.signature).toBeInstanceOf(Buffer);
            expect(deserialized.publicKey).toBeInstanceOf(Uint8Array);
            expect(deserialized.nonce).toBeInstanceOf(Buffer);
        });
    });
});

