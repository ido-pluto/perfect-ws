export class PureValueClone<T = any> {
    private _refs = new WeakMap<object, any>();

    public readonly originalRoot: { root: T };
    public readonly cloneRoot: { root: any };

    constructor(originalObject: any) {
        this.originalRoot = { root: originalObject };
        this.cloneRoot = { root: originalObject };
    }

    private _clones = new WeakSet<object>();
    private _owned = new WeakSet<object>();
    private _originalByWireValue = new WeakMap<object, object>();
    private _wireValueByOriginal = new WeakMap<object, object>();

    own<T>(value: T, original?: unknown): T {
        if (typeof value === 'object' && value !== null) {
            this._owned.add(value);
            if (typeof original === 'object' && original !== null) {
                this._refs.set(original, value);
                this._originalByWireValue.set(value, original);
                this._wireValueByOriginal.set(original, value);
            }
        }

        return value;
    }

    isOwned(value: any): boolean {
        return typeof value === 'object' && value !== null && this._owned.has(value);
    }

    isClone(value: any): boolean {
        return typeof value === 'object' && value !== null && this._clones.has(value);
    }

    originalOf(value: object): object {
        return this._originalByWireValue.get(value) ?? value;
    }

    wireValueOf(value: object): object | undefined {
        return this._wireValueByOriginal.get(value);
    }

    /**
     * Only plain objects and arrays can be copied safely.
     */
    static isCloneable(value: any): boolean {
        if (typeof value !== 'object' || value === null) {
            return false;
        }

        if (Array.isArray(value)) {
            return true;
        }

        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    clone(original: object) {
        if (this._owned.has(original) || this._clones.has(original)) {
            return original;
        }

        if (this._refs.has(original)) {
            return this._refs.get(original);
        }

        if (!PureValueClone.isCloneable(original)) {
            return original;
        }

        const proto = Object.getPrototypeOf(original);

        // A null-prototype object has no `constructor` to call, so rebuild it as one.
        const clone: Record<PropertyKey, any> = Array.isArray(original)
            ? []
            : Object.create(proto);
        this._refs.set(original, clone);
        this._clones.add(clone);
        this._originalByWireValue.set(clone, original);
        this._wireValueByOriginal.set(original, clone);

        if (Array.isArray(original)) clone.length = original.length;

        const objectDescriptor = Object.getOwnPropertyDescriptors(original);
        for (const key of Reflect.ownKeys(objectDescriptor)) {
            const descriptor = (objectDescriptor as Record<PropertyKey, PropertyDescriptor>)[key];

            // Accessors are left out on purpose - TransformDescriptor claims them and packs
            // the get/set into a marker, which TransformCallbacks then turns into callbacks.
            const isNormal = descriptor.configurable && descriptor.enumerable && descriptor.writable;
            if (!isNormal) {
                continue;
            }

            Object.defineProperty(clone, key, descriptor);
        }

        return clone;
    }
}
