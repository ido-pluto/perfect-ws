import { PureValueClone } from "./PureValueClone.js";

const isWalkable = (data: any) => typeof data === 'object' && data !== null;

type TransformReceivedLookBackRecursiveOptions = {
    maxDepth?: number;
    transformData: (data: any, key: string | symbol, parent: any, isRoot: boolean) => boolean;
};

export function transformReceivedLookBackRecursive(obj: any, { transformData, maxDepth = 100 }: TransformReceivedLookBackRecursiveOptions): any {
    if (!isWalkable(obj)) {
        return obj;
    }

    const processed = new WeakSet();
    const parent = { root: obj };
    const rootParent = parent;
    const stack: { obj: any; depth: number; parent: any, key: string | symbol; }[] = [{ obj, depth: 0, parent, key: 'root' }];

    while (stack.length > 0) {
        const { obj: current, depth, parent, key } = stack.pop()!;
        processed.add(current);

        if (transformData(current, key, parent, depth === 0 && parent === rootParent)) {
            continue;
        }

        if (depth >= maxDepth) {
            continue;
        }

        for (const key of Reflect.ownKeys(current)) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (!descriptor || !('value' in descriptor)) continue;
            const value = descriptor.value;
            if (!isWalkable(value) || processed.has(value)) {
                continue;
            }
            stack.push({ obj: value, depth: depth + 1, key, parent: current });
        }
    }

    return parent.root;
}

type TransformLookBackRecursiveOptions = {
    maxDepth?: number;
    transformData: (current: any, key: string | symbol, parent: any) => false | any;
};

export function transformSendLookBackRecursive(pureValueClone: PureValueClone, { transformData, maxDepth = 100 }: TransformLookBackRecursiveOptions) {
    const processed = new WeakSet();

    const stack: { obj: any; depth: number; key: string | symbol; parentClone: any; ours: boolean; }[] = [
        { obj: pureValueClone.originalRoot.root, depth: 0, key: 'root', parentClone: pureValueClone.cloneRoot, ours: false }
    ];

    while (stack.length > 0) {
        const { obj: current, depth, parentClone, key, ours } = stack.pop()!;

        const existingRoot = Object.getOwnPropertyDescriptor(parentClone, key)?.value;
        if (!ours && pureValueClone.isOwned(existingRoot)) {
            stack.push({ obj: existingRoot, depth, parentClone, key, ours: true });
            continue;
        }

        if (!isWalkable(current)) {
            continue;
        }
        processed.add(current);

        if (depth >= maxDepth || !PureValueClone.isCloneable(current)) {
            continue;
        }

        const subParentClone: any = ours ? current : pureValueClone.clone(current);
        if (!ours) parentClone[key] = subParentClone;

        for (const subKey of Reflect.ownKeys(current)) {
            // An earlier transform already encoded this slot. Walk into its marker rather
            // than skipping it, so a symbol key on an object stored inside a Map - or inside
            // a descriptor's captured value - still gets converted.
            const existingDescriptor = Object.getOwnPropertyDescriptor(subParentClone, subKey);
            const existing = existingDescriptor && 'value' in existingDescriptor ? existingDescriptor.value : undefined;
            if (!ours && pureValueClone.isOwned(existing)) {
                stack.push({ obj: existing, depth: depth + 1, parentClone: subParentClone, key: subKey, ours: true });
                continue;
            }

            const transformedObj = pureValueClone.own(transformData(current, subKey, subParentClone));
            if (transformedObj) {
                stack.push({ obj: transformedObj, depth: depth + 1, parentClone: subParentClone, key: subKey, ours: true });
                continue;
            }

            const sourceDescriptor = ours ? existingDescriptor : Object.getOwnPropertyDescriptor(current, subKey);
            if (!sourceDescriptor || !('value' in sourceDescriptor)) continue;
            const value = sourceDescriptor.value;
            if (isWalkable(value) && !processed.has(value)) {
                const childIsOurs = ours || pureValueClone.isOwned(value) || pureValueClone.isClone(value);
                stack.push({ obj: value, depth: depth + 1, parentClone: subParentClone, key: subKey, ours: childIsOurs });
            }
        }
    }
}
