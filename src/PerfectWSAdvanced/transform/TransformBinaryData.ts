import { createTransformMarker, transformReceivedDeserializeType, transformSendRecursive } from './utils/changeType.js';
import { PureValueClone } from './utils/PureValueClone.js';
import { PerfectWSError } from '../../PerfectWSError.js';
import { bindFunction } from './utils/bindFunction.js';

/**
 * Transforms binary data types to maintain their interface through BSON serialization.
 * Works in both Node.js (with Buffer) and browser environments (TypedArrays only).
 * Supports: Buffer (Node.js), TypedArrays, ArrayBuffer, DataView
 */

export class TransformBinaryData {
    private static readonly HAS_BUFFER = typeof Buffer !== 'undefined';

    private static readonly TYPES: Record<string, any> = {
        Buffer: Reflect.get(globalThis, 'Buffer'),
        Uint8Array,
        Uint8ClampedArray,
        Uint16Array,
        Uint32Array,
        Int8Array,
        Int16Array,
        Int32Array,
        Float32Array,
        Float64Array,
        BigInt64Array: Reflect.get(globalThis, 'BigInt64Array'),
        BigUint64Array: Reflect.get(globalThis, 'BigUint64Array'),
        Float16Array: Reflect.get(globalThis, 'Float16Array'),
        ArrayBuffer,
        DataView
    };

    private static readonly BYTES_PER_ELEMENT: Record<string, number> = {
        Buffer: 1,
        Uint8Array: 1,
        Uint8ClampedArray: 1,
        Int8Array: 1,
        Uint16Array: 2,
        Int16Array: 2,
        Uint32Array: 4,
        Int32Array: 4,
        Float32Array: 4,
        Float64Array: 8,
        BigInt64Array: 8,
        BigUint64Array: 8,
        Float16Array: 2,
        ArrayBuffer: 1,
        DataView: 1
    };

    /**
     * @param _maxMessageSize Largest binary value that may be sent, in bytes. A blob past this
     * is rejected here with a clear error instead of being framed and having the peer drop the
     * connection on `maxPayload`.
     */
    constructor(private _maxDepth = 100, private _maxMessageSize = Infinity) { }

    deserialize(data: any) {
        return transformReceivedDeserializeType(
            data,
            'binaryData',
            (marker) => {
                try {
                    const bytes = this._extractBytes(marker.data);
                    const result = this._restoreType(marker.type, bytes);
                    if (!this._restoreProperties(result, marker.properties)) return marker;
                    return result;
                } catch {
                    return marker;
                }
            },
            this._maxDepth,
            marker => typeof marker.type === 'string' && marker.data != null
        );
    }

    serialize(pureValueClone: PureValueClone) {
        return transformSendRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            transformData: data => {
                const detected = this._detectBinaryType(data);
                if (!detected) return null;

                if (detected.bytes.byteLength > this._maxMessageSize) {
                    throw new PerfectWSError(
                        `Binary payload of ${ detected.bytes.byteLength } bytes exceeds the maxMessageSize limit of ${ this._maxMessageSize } bytes`,
                        'messageTooLarge'
                    );
                }

                const binaryData = TransformBinaryData.HAS_BUFFER
                    ? Buffer.from(detected.bytes)
                    : detected.bytes;

                return createTransformMarker('binaryData', {
                    type: detected.type,
                    data: binaryData,
                    properties: this._encodeProperties(data),
                });
            }
        });
    }

    private _extractBytes(data: any): Uint8Array {
        if (TransformBinaryData.HAS_BUFFER && Buffer.isBuffer(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.length);
        }

        if (data?.buffer && !ArrayBuffer.isView(data)) {
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
            return new Uint8Array(bytes).buffer;
        }

        if (type === 'DataView') {
            return new DataView(new Uint8Array(bytes).buffer);
        }

        const Constructor = TransformBinaryData.TYPES[type];
        if (!Constructor) {
            return bytes;
        }

        const bytesPerElement = TransformBinaryData.BYTES_PER_ELEMENT[type] || 1;
        if (bytes.length % bytesPerElement !== 0) {
            throw new Error(`Invalid byte length for ${ type }`);
        }

        const exactBytes = new Uint8Array(bytes);
        return new Constructor(exactBytes.buffer, 0, exactBytes.length / bytesPerElement);
    }

    private _detectBinaryType(data: any): { type: string; bytes: Uint8Array; } | null {
        for (const [typeName, Constructor] of Object.entries(TransformBinaryData.TYPES)) {
            if (typeof Constructor !== 'function' || !(data instanceof Constructor)) {
                continue;
            }

            let bytes: Uint8Array;

            if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data);
            }
            else if (ArrayBuffer.isView(data)) {
                const prototype = data instanceof DataView
                    ? DataView.prototype
                    : Object.getPrototypeOf(Uint8Array.prototype);
                const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!.call(data) as ArrayBuffer;
                const byteOffset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')!.get!.call(data) as number;
                const byteLength = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!.call(data) as number;
                bytes = new Uint8Array(buffer, byteOffset, byteLength);
            }
            else {
                continue;
            }

            return { type: typeName, bytes };
        }

        return null;
    }

    private _encodeProperties(value: object): [PropertyKey, any][] {
        return Reflect.ownKeys(value).flatMap(key => {
            if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return [];
            if (typeof key === 'symbol' && Symbol.keyFor(key) === undefined
                && !Object.getOwnPropertyNames(Symbol).some(name => (Symbol as any)[name] === key)) return [];
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor) return [];
            const ordinary = 'value' in descriptor
                && descriptor.configurable === true
                && descriptor.enumerable === true
                && descriptor.writable === true;
            if (ordinary) return [[key, descriptor.value]];

            const encoded = { ...descriptor };
            if (typeof encoded.get === 'function') encoded.get = bindFunction(encoded.get, value);
            if (typeof encoded.set === 'function') encoded.set = bindFunction(encoded.set, value);
            return [[key, createTransformMarker('descriptor', { descriptor: encoded })]];
        });
    }

    private _restoreProperties(target: object, properties: unknown): boolean {
        if (properties === undefined) return true;
        if (!Array.isArray(properties) || properties.some(entry => !Array.isArray(entry) || entry.length < 2
            || typeof entry[0] !== 'string' && typeof entry[0] !== 'symbol')) return false;
        try {
            for (const [key, value] of properties) {
                Object.defineProperty(target, key, {
                    value,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            return true;
        } catch {
            return false;
        }
    }
}
