import { transformReceivedLookBackRecursive, transformSendLookBackRecursive } from './utils/lookBackChangeType.js';
import { PureValueClone } from './utils/PureValueClone.js';
import { createTransformMarker, isTransformMarker } from './utils/changeType.js';
import { bindFunction, safeRemoteSetter } from './utils/bindFunction.js';

export class TransformDescriptor {
    constructor(private _maxDepth: number = 100) {
    }

    deserialize(data: any) {
        return transformReceivedLookBackRecursive(data, {
            maxDepth: this._maxDepth,
            transformData: (data, key, parent, isRoot) => {
                // A descriptor marker is only valid in a property slot. Defining an
                // accessor on the walker's synthetic root would invoke an untrusted
                // getter merely by returning the decoded root value.
                if (isRoot) return false;
                if (isTransformMarker(data, 'descriptor') && data.descriptor && typeof data.descriptor === 'object') {
                    try {
                        const descriptor = { ...data.descriptor } as PropertyDescriptor;
                        if (typeof descriptor.set === 'function') {
                            descriptor.set = safeRemoteSetter(descriptor.set);
                        }
                        Object.defineProperty(parent, key, descriptor);
                        return true;
                    } catch { }
                }

                return false;
            }
        });
    }

    serialize(pureValueClone: PureValueClone) {
        return transformSendLookBackRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            transformData: (current, key, parent) => {
                const propertyDescriptor = Object.getOwnPropertyDescriptor(current, key);
                if (!propertyDescriptor) {
                    return false;
                }

                if (Array.isArray(current) && key === 'length') {
                    return false;
                }

                const descriptor = { ...propertyDescriptor };
                if (typeof descriptor.get === 'function') descriptor.get = bindFunction(descriptor.get, current);
                if (typeof descriptor.set === 'function') descriptor.set = bindFunction(descriptor.set, current);

                const isOrdinaryDataProperty = 'value' in propertyDescriptor
                    && propertyDescriptor.configurable === true
                    && propertyDescriptor.enumerable === true
                    && propertyDescriptor.writable === true;
                if (isOrdinaryDataProperty) return false;

                const marker = createTransformMarker('descriptor', {
                    descriptor
                });
                try {
                    Object.defineProperty(parent, key, {
                        value: marker,
                        configurable: true,
                        enumerable: true,
                        writable: true
                    });
                    return marker;
                } catch {
                    return false;
                }
            }
        });
    }
}
