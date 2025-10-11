import { transformSendDeserializeType } from './utils/changeType.js';
import { getProperty } from 'dot-prop';

export class TransformCircularObjects {

    constructor(private _maxDepth: number = 100) {
    }

    deserialize(data: any) {
        return transformSendDeserializeType(data, 'circularRef', (found) => {
            if (found.refPath === '') return data;
            return getProperty(data, found.refPath);
        }, this._maxDepth);
    }

    serialize(obj: any) {
        if (typeof obj !== 'object' || !obj) {
            return obj;
        }
    
        const processed = new WeakMap();
        const parent = { root: obj };
        const stack: { obj: any; depth: number; parent: any, key: string | number; currentPath: string }[] = [{ obj, depth: 0, parent, key: 'root', currentPath: '' }];
    
        while (stack.length > 0) {
            const { obj: current, depth, parent, key, currentPath } = stack.pop()!;

            if (processed.has(current)) {
                const refPath = processed.get(current);
                parent[key] = { ___type: 'circularRef', refPath };
                continue;
            }

            processed.set(current, currentPath);
    
            if (depth >= this._maxDepth) {
                continue;
            }
    
            const currentKeys = Array.isArray(current) ? current.keys() : Object.keys(current);
            for (const key of currentKeys) {
                const value = current[key];
                if (typeof value !== 'object' || !value) {
                    continue;
                }
                const nextPath = currentPath ? `${currentPath}.${key}` : key.toString();
                stack.push({ obj: value, depth: depth + 1, key, parent: current, currentPath: nextPath });
            }
        }
    
        return parent.root;
    }
}
