import { createTransformMarker, transformReceivedDeserializeType } from './utils/changeType.js';
import { decodePathKey, encodePathKey } from './utils/getProperty.js';
import { PureValueClone } from './utils/PureValueClone.js';

export class TransformCircularObjects {

    constructor(private _maxDepth: number = 100, private _globalSymbols: Map<string, symbol> = new Map()) {
    }

    deserialize(data: any) {
        return transformReceivedDeserializeType(data, 'circularRef', (found) => {
            let current = data;
            for (const segment of found.refPath as string[]) {
                const key = decodePathKey(segment, this._globalSymbols);
                if (key === undefined || current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
                    return found;
                }
                current = current[key];
            }
            return current;
        }, this._maxDepth, found => Array.isArray(found.refPath) && found.refPath.every((segment: unknown) => typeof segment === 'string'));
    }

    serialize(pureValueClone: PureValueClone): void {
        const root = pureValueClone.cloneRoot.root;
        if (typeof root !== 'object' || root === null) {
            return;
        }

        const processed = new WeakMap<object, string[]>();
        const encode = (current: any, depth: number, currentPath: string[]): any => {
            const identity = pureValueClone.originalOf(current);
            const existingPath = processed.get(identity);
            if (existingPath !== undefined) {
                return createTransformMarker('circularRef', { refPath: existingPath });
            }
            processed.set(identity, currentPath);

            if (depth >= this._maxDepth || !PureValueClone.isCloneable(current)) return current;

            const clone: any = Array.isArray(current) ? [] : Object.create(Object.getPrototypeOf(current));
            const descriptors = Object.getOwnPropertyDescriptors(current);
            for (const key of Reflect.ownKeys(descriptors)) {
                const descriptor = (descriptors as Record<PropertyKey, PropertyDescriptor>)[key];
                if (!('value' in descriptor) || typeof descriptor.value !== 'object' || descriptor.value === null) {
                    Object.defineProperty(clone, key, descriptor);
                    continue;
                }

                const encodedKey = encodePathKey(key);
                if (encodedKey === null) {
                    Object.defineProperty(clone, key, descriptor);
                    continue;
                }
                const childPath = [...currentPath, encodedKey];
                Object.defineProperty(clone, key, { ...descriptor, value: encode(descriptor.value, depth + 1, childPath) });
            }
            return clone;
        };

        pureValueClone.cloneRoot.root = pureValueClone.own(encode(root, 0, []), pureValueClone.originalRoot.root);
    }
}
