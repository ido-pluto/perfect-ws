import { createTransformMarker, isGeneratedTransformMarker, isTransformMarker, markEscapedApplicationMarker, transformSendRecursive } from './utils/changeType.js';
import { PureValueClone } from './utils/PureValueClone.js';

export class TransformEscapedMarkers {
    constructor(private _maxDepth = 100) { }

    serialize(pureValueClone: PureValueClone): void {
        transformSendRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            transformData: value => {
                if (typeof value !== 'object' || value === null) return null;
                if (isGeneratedTransformMarker(value)) return null;
                const existing = pureValueClone.wireValueOf(value);
                if (existing && isTransformMarker(existing, 'escapedMarker')) return existing;
                if (pureValueClone.isOwned(value)) return null;
                const type = Object.getOwnPropertyDescriptor(value, '___type');
                if (!type || !('value' in type) || typeof type.value !== 'string'
                    || !isTransformMarker(value, type.value)) return null;

                const descriptors = Reflect.ownKeys(value).map(key => [
                    key,
                    { ...Object.getOwnPropertyDescriptor(value, key)! },
                ]);
                return createTransformMarker('escapedMarker', {
                    array: Array.isArray(value),
                    nullPrototype: Object.getPrototypeOf(value) === null,
                    descriptors,
                });
            },
        });
    }

    deserialize(data: any): any {
        const memo = new WeakMap<object, any>();
        const decode = (current: any, depth: number): any => {
            if (typeof current !== 'object' || current === null) return current;
            const existing = memo.get(current);
            if (existing !== undefined) return existing;

            if (current instanceof Map) {
                memo.set(current, current);
                if (depth >= this._maxDepth) return current;
                const entries = [...Map.prototype.entries.call(current)] as [any, any][];
                Map.prototype.clear.call(current);
                for (const [key, value] of entries) {
                    Map.prototype.set.call(current, decode(key, depth + 1), decode(value, depth + 1));
                }
                return current;
            }

            if (current instanceof Set) {
                memo.set(current, current);
                if (depth >= this._maxDepth) return current;
                const values = [...Set.prototype.values.call(current)] as any[];
                Set.prototype.clear.call(current);
                for (const value of values) Set.prototype.add.call(current, decode(value, depth + 1));
                return current;
            }

            if (isTransformMarker(current, 'escapedMarker') && this._isValidMarker(current)) {
                const marker = current;
            const target = marker.array ? [] : marker.nullPrototype ? Object.create(null) : {};
                memo.set(current, target);
                markEscapedApplicationMarker(target);
            const descriptors = [...marker.descriptors].sort(([key]) => key === 'length' ? 1 : -1);
            for (const [key, descriptor] of descriptors) {
                try {
                        const decodedDescriptor = 'value' in descriptor
                            ? { ...descriptor, value: decode(descriptor.value, depth + 1) }
                            : descriptor;
                        Object.defineProperty(target, key, decodedDescriptor);
                } catch {
                    memo.delete(current);
                    return marker;
                }
            }
            return target;
            }

            memo.set(current, current);
            if (depth >= this._maxDepth) return current;
            for (const key of Reflect.ownKeys(current)) {
                const descriptor = Object.getOwnPropertyDescriptor(current, key);
                if (!descriptor || !('value' in descriptor)) continue;
                const value = decode(descriptor.value, depth + 1);
                if (value !== descriptor.value) {
                    try { Object.defineProperty(current, key, { ...descriptor, value }); } catch { }
                }
            }
            return current;
        };

        return decode(data, 0);
    }

    private _isValidMarker(marker: any): boolean {
        return typeof marker.array === 'boolean'
            && typeof marker.nullPrototype === 'boolean'
            && Array.isArray(marker.descriptors)
            && marker.descriptors.every((entry: unknown) => Array.isArray(entry) && entry.length === 2
                && (typeof entry[0] === 'string' || typeof entry[0] === 'symbol')
                && typeof entry[1] === 'object' && entry[1] !== null);
    }
}
