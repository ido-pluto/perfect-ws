import { transformSendDeserializeType, transformSendRecursive } from './utils/changeType.js';

/**
 * Transforms binary data types to maintain their interface through BSON serialization.
 * Works in both Node.js (with Buffer) and browser environments (TypedArrays only).
 * Supports: Buffer (Node.js), TypedArrays, ArrayBuffer, DataView
 */

export class TransformBinaryData {
    private static readonly HAS_BUFFER = typeof Buffer !== 'undefined';

    private static readonly TYPES: Record<string, any> = {
        ...(TransformBinaryData.HAS_BUFFER ? { Buffer } : {}),
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int8Array,
        Int16Array,
        Int32Array,
        Float32Array,
        Float64Array,
        ArrayBuffer,
        DataView
    };

    private static readonly BYTES_PER_ELEMENT: Record<string, number> = {
        Buffer: 1,
        Uint8Array: 1,
        Int8Array: 1,
        Uint16Array: 2,
        Int16Array: 2,
        Uint32Array: 4,
        Int32Array: 4,
        Float32Array: 4,
        Float64Array: 8,
        ArrayBuffer: 1,
        DataView: 1
    };

    private static readonly ALIGNMENTS: Record<string, number> = {
        Uint16Array: 2,
        Int16Array: 2,
        Uint32Array: 4,
        Int32Array: 4,
        Float32Array: 4,
        Float64Array: 8
    };

    constructor(private _maxDepth = 100) { }

    deserialize(data: any) {
        return transformSendDeserializeType(
            data,
            'binaryData',
            ({ type, data: binaryData }) => {
                const bytes = this._extractBytes(binaryData);
                return this._restoreType(type, bytes);
            },
            this._maxDepth
        );
    }

    serialize(obj: any) {
        return transformSendRecursive(obj, {
            maxDepth: this._maxDepth,
            transformData: data => {
                const detected = this._detectBinaryType(data);
                if (!detected) return null;

                const binaryData = TransformBinaryData.HAS_BUFFER
                    ? Buffer.from(detected.bytes)
                    : detected.bytes;

                return {
                    ___type: 'binaryData',
                    type: detected.type,
                    data: binaryData
                };
            }
        });
    }

    private _extractBytes(data: any): Uint8Array {
        if (TransformBinaryData.HAS_BUFFER && Buffer.isBuffer(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.length);
        }

        if (data?.buffer) {
            if (TransformBinaryData.HAS_BUFFER && Buffer.isBuffer(data.buffer)) {
                return new Uint8Array(data.buffer.buffer, data.buffer.byteOffset, data.buffer.length);
            }
            if (data.buffer instanceof ArrayBuffer) {
                return new Uint8Array(data.buffer);
            }
        }

        if (data?.constructor?.name === 'Binary') {
            const buf = data.buffer || data;
            if (buf instanceof ArrayBuffer) {
                return new Uint8Array(buf);
            }
            if (TransformBinaryData.HAS_BUFFER) {
                return new Uint8Array(Buffer.from(buf));
            }
        }

        if (data instanceof Uint8Array) {
            return data;
        }

        if (data instanceof ArrayBuffer) {
            return new Uint8Array(data);
        }

        if (TransformBinaryData.HAS_BUFFER) {
            return new Uint8Array(Buffer.from(data));
        }

        return new Uint8Array(data);
    }

    private _restoreType(type: string, bytes: Uint8Array): any {
        if (type === 'Buffer' && TransformBinaryData.HAS_BUFFER) {
            return Buffer.from(bytes);
        }

        if (type === 'ArrayBuffer') {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
        }

        if (type === 'DataView') {
            return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        }

        const Constructor = TransformBinaryData.TYPES[type];
        if (!Constructor) {
            return bytes;
        }

        const alignment = TransformBinaryData.ALIGNMENTS[type] || 1;
        const bytesPerElement = TransformBinaryData.BYTES_PER_ELEMENT[type] || 1;

        if (bytes.byteOffset % alignment === 0) {
            return new Constructor(
                bytes.buffer,
                bytes.byteOffset,
                bytes.length / bytesPerElement
            );
        }

        const alignedBytes = new Uint8Array(bytes);
        return new Constructor(alignedBytes.buffer);
    }

    private _detectBinaryType(data: any): { type: string; bytes: Uint8Array; } | null {
        for (const [typeName, Constructor] of Object.entries(TransformBinaryData.TYPES)) {
            if (!(data instanceof Constructor)) {
                continue;
            }

            let bytes: Uint8Array;

            if (typeName === 'Buffer' && TransformBinaryData.HAS_BUFFER) {
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
            }
            else if (data instanceof Uint8Array && !(TransformBinaryData.HAS_BUFFER && data instanceof Buffer)) {
                bytes = data;
            }
            else if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            }
            else if (data.buffer && data.byteOffset !== undefined && data.byteLength !== undefined) {
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            }
            else {
                continue;
            }

            return { type: typeName, bytes };
        }

        return null;
    }
}

