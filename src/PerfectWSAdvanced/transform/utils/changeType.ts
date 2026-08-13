import { PureValueClone } from "./PureValueClone.js";

export const TRANSFORM_MARKER_VERSION = 1;
const escapedApplicationMarkers = new WeakSet<object>();
const generatedTransformMarkers = new WeakSet<object>();

export function markEscapedApplicationMarker(value: object): void {
    escapedApplicationMarkers.add(value);
}

export type TransformMarker = {
    ___perfectWS: typeof TRANSFORM_MARKER_VERSION;
    ___type: string;
    [key: PropertyKey]: any;
};

export function createTransformMarker<T extends Record<PropertyKey, any>>(typeName: string, data: T): TransformMarker & T {
    const marker: TransformMarker & T = {
        ___perfectWS: TRANSFORM_MARKER_VERSION,
        ___type: typeName,
        ...data,
    } as TransformMarker & T;
    generatedTransformMarkers.add(marker);
    return marker;
}

export function isGeneratedTransformMarker(value: object): boolean {
    return generatedTransformMarkers.has(value);
}

export function isTransformMarker(data: any, typeName: string): data is TransformMarker {
    if (typeof data !== 'object' || data === null) return false;
    if (escapedApplicationMarkers.has(data)) return false;
    const version = Object.getOwnPropertyDescriptor(data, '___perfectWS');
    const type = Object.getOwnPropertyDescriptor(data, '___type');
    return version !== undefined && 'value' in version && version.value === TRANSFORM_MARKER_VERSION
        && type !== undefined && 'value' in type && type.value === typeName;
}

export type SerializationRegistration = {
    commit?: () => void;
    rollback?: () => void;
};

export class SerializationTransaction {
    private _registrations: SerializationRegistration[] = [];
    private _settled = false;

    add(registration: SerializationRegistration): void {
        if (this._settled) {
            throw new Error('Serialization transaction is already settled');
        }
        this._registrations.push(registration);
    }

    get hasRegistrations(): boolean {
        return this._registrations.length > 0;
    }

    commit(): void {
        if (this._settled) return;
        this._settled = true;
        for (const registration of this._registrations) registration.commit?.();
        this._registrations.length = 0;
    }

    rollback(): void {
        if (this._settled) return;
        this._settled = true;
        for (let index = this._registrations.length - 1; index >= 0; index--) {
            try {
                this._registrations[index].rollback?.();
            } catch { }
        }
        this._registrations.length = 0;
    }
}

export function transformReceivedDeserializeType(
    data: any,
    typeName: string,
    transformData: (data: any) => any,
    maxDepth: number = 100,
    validate: (data: TransformMarker) => boolean = () => true
) {
    return transformReceivedRecursive(data, {
        maxDepth,
        transformData: (obj) => {
            if (isTransformMarker(obj, typeName) && validate(obj)) {
                return transformData(obj);
            }
        }
    });
}

type TransformSendRecursiveOptions = {
    maxDepth?: number;
    transformData: (data: any) => any | null;
    processingDataType?: (data: any) => boolean;
    walkTransformed?: boolean;
};

const isWalkable = (data: any) => typeof data === 'object' && data !== null;

function ownDataValue(object: object, key: PropertyKey): { found: boolean; value?: any; } {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor
        ? { found: true, value: descriptor.value }
        : { found: false };
}

function replaceOwnValue(parent: any, key: PropertyKey, value: any): void {
    const descriptor = Object.getOwnPropertyDescriptor(parent, key);
    if (descriptor && 'value' in descriptor) {
        Object.defineProperty(parent, key, { ...descriptor, value });
    }
}

export function transformReceivedRecursive(obj: any, { transformData, processingDataType = isWalkable, maxDepth = 100 }: TransformSendRecursiveOptions): any {
    if (!processingDataType(obj)) {
        return obj;
    }

    const processed = new WeakSet();
    const parent = { root: obj };
    const stack: { obj: any; depth: number; parent: any, key: string | symbol; }[] = [{ obj, depth: 0, parent, key: 'root' }];

    while (stack.length > 0) {
        const { obj: current, depth, parent, key } = stack.pop()!;
        if (isWalkable(current)) {
            processed.add(current);
        }

        const foundTransform = transformData(current);
        if (foundTransform != null) {
            replaceOwnValue(parent, key, foundTransform);
            continue;
        }

        if (depth >= maxDepth || !isWalkable(current)) {
            continue;
        }

        for (const key of Reflect.ownKeys(current)) {
            const property = ownDataValue(current, key);
            if (!property.found) continue;
            const value = property.value;
            if (!processingDataType(value) || processed.has(value)) {
                continue;
            }
            stack.push({ obj: value, depth: depth + 1, key, parent: current });
        }
    }

    return parent.root;
}

/**
 * Clone the original object and transform it recursively.
 */
export function transformSendRecursive(pureValueClone: PureValueClone, {
    transformData,
    processingDataType = isWalkable,
    maxDepth = 100,
    walkTransformed = false,
}: TransformSendRecursiveOptions): void {
    const processed = new WeakSet();
    const stack: { obj: any; depth: number; parentClone: any, key: string | symbol; ours: boolean; }[] = [
        { obj: pureValueClone.originalRoot.root, depth: 0, parentClone: pureValueClone.cloneRoot, key: 'root', ours: false }
    ];

    while (stack.length > 0) {
        const { obj: current, depth, parentClone, key, ours } = stack.pop()!;

        if (!ours && isWalkable(current) && processed.has(current)) {
            const wireValue = pureValueClone.wireValueOf(current);
            if (wireValue !== undefined) parentClone[key] = wireValue;
            continue;
        }

        const existingRoot = ownDataValue(parentClone, key).value;
        if (!ours && pureValueClone.isOwned(existingRoot)) {
            stack.push({ obj: existingRoot, depth, parentClone, key, ours: true });
            continue;
        }

        if (isWalkable(current)) {
            processed.add(current);
        }

        const foundTransform = transformData(current);
        if (foundTransform != null) {
            replaceOwnValue(parentClone, key, pureValueClone.own(foundTransform, current));
            if (walkTransformed && depth < maxDepth && isWalkable(foundTransform)) {
                stack.push({ obj: foundTransform, depth, parentClone, key, ours: true });
            }
            continue;
        }

        if (depth >= maxDepth || !PureValueClone.isCloneable(current)) {
            continue;
        }

        const currentClone = ours ? current : pureValueClone.clone(current);
        if (!ours) replaceOwnValue(parentClone, key, currentClone);

        for (const subKey of Reflect.ownKeys(current)) {
            const existingProperty = ownDataValue(currentClone, subKey);
            const existing = existingProperty.value;
            if (!ours && pureValueClone.isOwned(existing)) {
                stack.push({ obj: existing, depth: depth + 1, key: subKey, parentClone: currentClone, ours: true });
                continue;
            }

            const originalProperty = ours ? existingProperty : ownDataValue(current, subKey);
            if (!originalProperty.found) continue;
            const value = originalProperty.value;
            if (!processingDataType(value)) {
                continue;
            }
            if (isWalkable(value) && processed.has(value)) {
                const wireValue = pureValueClone.wireValueOf(value);
                if (wireValue !== undefined) replaceOwnValue(currentClone, subKey, wireValue);
                continue;
            }

            const childIsOurs = ours || pureValueClone.isOwned(value) || pureValueClone.isClone(value);
            stack.push({ obj: value, depth: depth + 1, key: subKey, parentClone: currentClone, ours: childIsOurs });
        }
    }
}
