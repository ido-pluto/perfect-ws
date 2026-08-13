import { isForbiddenPropertyKey, isPrimitivePropertyKey } from './getProperty.js';
import { randomUUID } from '../../../utils/randomUUID.js';
import { PerfectWSError } from '../../../PerfectWSError.js';

export type PureRPCResolution = {
    receiver: unknown;
    value: unknown;
};


export class PureRPCRegistry {
    private _byId = new Map<string, object>();
    private _idByObject = new Map<object, string>();


    constructor(private _maxHandles: number = 10_000) {
    }

    register(obj: object): string {
        const existing = this._idByObject.get(obj);
        if (existing) {
            return existing;
        }

        if (this._byId.size >= this._maxHandles) {
            throw new PerfectWSError(`PureRPC handle table exceeded maxPureRPCHandles (${this._maxHandles})`, 'pureRPCTooManyHandles');
        }

        const rpcId = randomUUID();
        this._byId.set(rpcId, obj);
        this._idByObject.set(obj, rpcId);
        return rpcId;
    }

    has(rpcId: string): boolean {
        return this._byId.has(rpcId);
    }

    get size(): number {
        return this._byId.size;
    }

    getId(obj: object): string | undefined {
        return this._idByObject.get(obj);
    }

    release(rpcId: string): void {
        const obj = this._byId.get(rpcId);
        if (obj === undefined) {
            return;
        }

        this._byId.delete(rpcId);
        this._idByObject.delete(obj);
    }

    releaseAll(): void {
        this._byId.clear();
        this._idByObject.clear();
    }

    resolve(rpcId: string, path: readonly PropertyKey[]): PureRPCResolution | undefined {
        if (!Array.isArray(path)) {
            return undefined;
        }

        const root = this._byId.get(rpcId);
        if (root === undefined || path.length === 0) {
            return undefined;
        }

        let receiver: unknown = root;
        let value: unknown = root;

        for (const key of path) {
            if (!isPrimitivePropertyKey(key) || isForbiddenPropertyKey(key) || !isOwnObject(value)) {
                return undefined;
            }

            const owner = ownerOf(value, key);
            if (owner === undefined) {
                return undefined;
            }

            receiver = value;
            value = (value as Record<PropertyKey, unknown>)[key];
        }

        return { receiver, value };
    }

    resolveContainer(rpcId: string, parentPath: readonly PropertyKey[]): { container: object; } | undefined {
        if (!Array.isArray(parentPath)) {
            return undefined;
        }

        const root = this._byId.get(rpcId);
        if (root === undefined) {
            return undefined;
        }

        if (parentPath.length === 0) {
            return { container: root };
        }

        const resolution = this.resolve(rpcId, parentPath);
        if (!resolution || !isOwnObject(resolution.value)) {
            return undefined;
        }

        return { container: resolution.value };
    }
}

function isOwnObject(value: unknown): value is object {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

const DANGEROUS_PROTOTYPES = new Set<unknown>([Function.prototype]);

function ownerOf(target: object, key: PropertyKey): object | undefined {
    if (Object.hasOwn(target, key)) {
        return target;
    }

    const visited = new Set<object>();
    let proto = Object.getPrototypeOf(target);
    while (proto && proto !== Object.prototype && !DANGEROUS_PROTOTYPES.has(proto) && !visited.has(proto)) {
        if (Object.hasOwn(proto, key)) return proto;
        visited.add(proto);
        proto = Object.getPrototypeOf(proto);
    }

    return undefined;
}
