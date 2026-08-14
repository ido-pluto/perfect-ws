import {
    createTransformMarker,
    isTransformMarker,
    transformReceivedRecursive,
    transformSendRecursive,
} from './utils/changeType.js';
import { PureValueClone } from './utils/PureValueClone.js';
import { bindFunction, safeRemoteSetter } from './utils/bindFunction.js';

const ERROR_TYPES: Record<string, new (message?: string) => Error> = {
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    URIError
};
const NATIVE_ERROR_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const isArrayIndex = (key: PropertyKey): key is string => {
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return false;
    const number = Number(key);
    return Number.isInteger(number) && number >= 0 && number < 0xffff_ffff && String(number) === key;
};


export class TransformNativeTypes {
    constructor(private _maxDepth = 100) { }

    /** BigInt is a primitive, so the walker has to be told to visit it. */
    private static _isProcessable(data: any) {
        return (typeof data === 'object' && data !== null) || typeof data === 'bigint';
    }

    serialize(pureValueClone: PureValueClone) {
        return transformSendRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            processingDataType: TransformNativeTypes._isProcessable,
            transformData: (data) => this._encode(pureValueClone.wireValueOf(data) ?? data, 0, data),
            walkTransformed: true,
        });
    }

    deserialize(data: any) {
        const memo = new WeakMap<object, any>();
        return transformReceivedRecursive(data, {
            maxDepth: this._maxDepth,
            transformData: (data) => this._decode(data, 0, memo)
        });
    }

    private _encode(data: any, depth: number, original = data): any | null {
        if (depth > this._maxDepth) {
            return null;
        }

        if (typeof data === 'bigint') {
            return createTransformMarker('bigint', { value: data.toString() });
        }

        if (data instanceof Map) {
            return createTransformMarker('map', {
                entries: Array.from(Map.prototype.entries.call(data)),
                properties: this._encodeProperties(original),
            });
        }

        if (data instanceof Set) {
            return createTransformMarker('set', {
                values: Array.from(Set.prototype.values.call(data)),
                properties: this._encodeProperties(original),
            });
        }

        if (Array.isArray(data)) {
            const lengthDescriptor = Object.getOwnPropertyDescriptor(original, 'length');
            const keys = Reflect.ownKeys(data).filter(key => key !== 'length');
            const numericKeys = keys.filter(isArrayIndex);
            const hasHoles = numericKeys.length < data.length;
            const hasNamedProperties = keys.length !== numericKeys.length;
            if (hasHoles || hasNamedProperties || lengthDescriptor?.writable === false) {
                const entries = keys.flatMap(key => {
                    const descriptor = Object.getOwnPropertyDescriptor(data, key);
                    return descriptor && 'value' in descriptor
                        ? [[key, descriptor.value] as [PropertyKey, any]]
                        : [];
                });
                return createTransformMarker('array', {
                    length: data.length,
                    lengthWritable: lengthDescriptor?.writable !== false,
                    entries,
                });
            }
        }

        if (typeof data === 'object' && data !== null && Object.getPrototypeOf(data) === null) {
            return createTransformMarker('nullObject', {
                entries: Reflect.ownKeys(data).flatMap(key => {
                    const descriptor = Object.getOwnPropertyDescriptor(data, key);
                    return descriptor && 'value' in descriptor ? [[key, descriptor.value]] : [];
                }),
            });
        }

        if (data instanceof Error) {
            const own = Object.getOwnPropertyDescriptors(data);
            const typeName = Object.entries(ERROR_TYPES).find(([name, Type]) => name !== 'Error' && data instanceof Type)?.[0] ?? 'Error';
            const stack = typeof own.stack?.value === 'string'
                ? own.stack.value
                : own.stack?.get === NATIVE_ERROR_STACK_GETTER && NATIVE_ERROR_STACK_GETTER
                    ? Reflect.apply(NATIVE_ERROR_STACK_GETTER, data, [])
                    : undefined;
            const excluded = new Set<PropertyKey>();
            if (typeof own.name?.value === 'string') excluded.add('name');
            if (typeof own.message?.value === 'string') excluded.add('message');
            if (typeof stack === 'string') excluded.add('stack');
            return createTransformMarker('error', {
                name: typeof own.name?.value === 'string' ? own.name.value : typeName,
                message: typeof own.message?.value === 'string' ? own.message.value : '',
                stack,
                properties: this._encodeProperties(original, excluded),
            });
        }

        if (data instanceof RegExp) {
            const regexpPrototype = RegExp.prototype;
            const get = (name: string) => Object.getOwnPropertyDescriptor(regexpPrototype, name)?.get?.call(data);
            const flags = `${get('hasIndices') ? 'd' : ''}${get('global') ? 'g' : ''}${get('ignoreCase') ? 'i' : ''}${get('multiline') ? 'm' : ''}${get('dotAll') ? 's' : ''}${get('unicode') ? 'u' : ''}${get('unicodeSets') ? 'v' : ''}${get('sticky') ? 'y' : ''}`;
            const lastIndexDescriptor = Object.getOwnPropertyDescriptor(data, 'lastIndex');
            return createTransformMarker('regexp', {
                source: get('source'),
                flags,
                lastIndex: (lastIndexDescriptor as PropertyDescriptor & { value: unknown; }).value,
                lastIndexWritable: lastIndexDescriptor?.writable !== false,
                properties: this._encodeProperties(original, new Set(['lastIndex'])),
            });
        }

        if (typeof URL !== 'undefined' && data instanceof URL) {
            const href = URL.prototype.toString.call(data);
            return createTransformMarker('url', { href, properties: this._encodeProperties(original) });
        }

        if (data instanceof Date) {
            return createTransformMarker('date', {
                value: Date.prototype.getTime.call(data),
                properties: this._encodeProperties(original),
            });
        }

        return null;
    }

    private _decode(data: any, depth: number, memo = new WeakMap<object, any>()): any | null {
        if (depth > this._maxDepth) {
            return null;
        }

        if (isTransformMarker(data, 'bigint')) {
            if (typeof data.value !== 'string') return null;
            try {
                return BigInt(data.value);
            } catch {
                return null;
            }
        }

        if (isTransformMarker(data, 'map')) {
            if (!Array.isArray(data.entries) || data.entries.some((entry: any) => !Array.isArray(entry) || entry.length < 2)) return null;
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            const result = new Map();
            memo.set(data, result);
            for (const [key, value] of data.entries) {
                result.set(this._decodeChild(key, depth, memo), this._decodeChild(value, depth, memo));
            }
            if (!this._restoreProperties(result, data.properties, depth, memo)) {
                memo.delete(data);
                return null;
            }
            return result;
        }

        if (isTransformMarker(data, 'set')) {
            if (!Array.isArray(data.values)) return null;
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            const result = new Set();
            memo.set(data, result);
            for (const value of data.values) result.add(this._decodeChild(value, depth, memo));
            if (!this._restoreProperties(result, data.properties, depth, memo)) {
                memo.delete(data);
                return null;
            }
            return result;
        }

        if (isTransformMarker(data, 'array')) {
            if (!Number.isSafeInteger(data.length) || data.length < 0 || data.length > 0xffff_ffff
                || typeof data.lengthWritable !== 'boolean'
                || !Array.isArray(data.entries)
                || data.entries.some((entry: any) => !Array.isArray(entry) || entry.length < 2
                    || typeof entry[0] !== 'string' && typeof entry[0] !== 'symbol'
                    || entry[0] === 'length'
                    || isArrayIndex(entry[0]) && Number(entry[0]) >= data.length)) {
                return null;
            }
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            const result = new Array(data.length);
            memo.set(data, result);
            for (const [key, value] of data.entries) {
                Object.defineProperty(result, key, {
                    value: this._decodeChild(value, depth, memo),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            if (!data.lengthWritable) Object.defineProperty(result, 'length', { writable: false });
            return result;
        }

        if (isTransformMarker(data, 'nullObject')) {
            if (!Array.isArray(data.entries) || data.entries.some((entry: any) => !Array.isArray(entry) || entry.length < 2
                || typeof entry[0] !== 'string' && typeof entry[0] !== 'symbol')) return null;
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            const result = Object.create(null);
            memo.set(data, result);
            for (const [key, value] of data.entries) {
                Object.defineProperty(result, key, {
                    value: this._decodeChild(value, depth, memo),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }
            return result;
        }

        if (isTransformMarker(data, 'url')) {
            if (typeof data.href !== 'string' || typeof URL === 'undefined') return null;
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            try {
                const result = new URL(data.href);
                memo.set(data, result);
                if (this._restoreProperties(result, data.properties, depth, memo)) return result;
                memo.delete(data);
                return null;
            } catch {
                memo.delete(data);
                return null;
            }
        }

        if (isTransformMarker(data, 'date')) {
            if (typeof data.value !== 'number') return null;
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            const result = new Date(data.value);
            memo.set(data, result);
            if (this._restoreProperties(result, data.properties, depth, memo)) return result;
            memo.delete(data);
            return null;
        }

        if (isTransformMarker(data, 'regexp')) {
            if (typeof data.source !== 'string' || typeof data.flags !== 'string'
                || typeof data.lastIndex !== 'number') return null;
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            try {
                const regexp = new RegExp(data.source, data.flags);
                regexp.lastIndex = data.lastIndex;
                if (data.lastIndexWritable === false) Object.defineProperty(regexp, 'lastIndex', { writable: false });
                memo.set(data, regexp);
                if (this._restoreProperties(regexp, data.properties, depth, memo)) return regexp;
                memo.delete(data);
                return null;
            } catch {
                memo.delete(data);
                return null;
            }
        }

        if (isTransformMarker(data, 'error')) {
            if (typeof data.name !== 'string' || typeof data.message !== 'string') return null;
            const existing = memo.get(data);
            if (existing !== undefined) return existing;
            const ErrorType = ERROR_TYPES[data.name] ?? Error;
            const error = new ErrorType(data.message);
            memo.set(data, error);
            error.name = data.name;
            if (typeof data.stack === 'string') error.stack = data.stack;
            if (Array.isArray(data.properties)) {
                if (!this._restoreProperties(error, data.properties, depth, memo)) {
                    memo.delete(data);
                    return null;
                }
            } else {
                // Backward compatibility with the pre-descriptor wire format.
                const properties = this._decodeChild(data.properties, depth, memo);
                if (properties && typeof properties === 'object') {
                    Object.defineProperties(error, Object.getOwnPropertyDescriptors(properties));
                }
            }
            return error;
        }

        return null;
    }

    private _encodeProperties(value: object, excluded: ReadonlySet<PropertyKey> = new Set()): [PropertyKey, any][] {
        return Reflect.ownKeys(value).flatMap(key => {
            if (excluded.has(key)) return [];
            if (typeof key === 'symbol' && Symbol.keyFor(key) === undefined
                && !Object.getOwnPropertyNames(Symbol).some(name => (Symbol as any)[name] === key)) {
                return [];
            }
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

    private _restoreProperties(target: object, properties: unknown, depth: number, memo: WeakMap<object, any>): boolean {
        if (properties === undefined) return true;
        if (!Array.isArray(properties) || properties.some(entry => !Array.isArray(entry) || entry.length < 2
            || typeof entry[0] !== 'string' && typeof entry[0] !== 'symbol')) return false;
        try {
            for (const [key, value] of properties) {
                if (isTransformMarker(value, 'descriptor')
                    && value.descriptor && typeof value.descriptor === 'object') {
                    const descriptor = { ...value.descriptor } as PropertyDescriptor;
                    if ('value' in descriptor) {
                        descriptor.value = this._decodeChild(descriptor.value, depth, memo);
                    }
                    if (typeof descriptor.set === 'function') {
                        descriptor.set = safeRemoteSetter(descriptor.set);
                    }
                    Object.defineProperty(target, key, descriptor);
                    continue;
                }
                Object.defineProperty(target, key, {
                    value: this._decodeChild(value, depth, memo),
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

    private _decodeChild(value: any, depth: number, memo = new WeakMap<object, any>()): any {
        const decoded = this._decode(value, depth + 1, memo);
        if (decoded !== null) {
            return decoded;
        }

        if (depth >= this._maxDepth) {
            return value;
        }

        if (Array.isArray(value)) {
            const existing = memo.get(value);
            if (existing !== undefined) return existing;
            memo.set(value, value);
            for (let index = 0; index < value.length; index++) {
                value[index] = this._decodeChild(value[index], depth + 1, memo);
            }
            return value;
        }

        if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
            const existing = memo.get(value);
            if (existing !== undefined) return existing;
            memo.set(value, value);
            for (const key of Reflect.ownKeys(value)) {
                value[key] = this._decodeChild(value[key], depth + 1, memo);
            }
            return value;
        }

        return value;
    }
}
