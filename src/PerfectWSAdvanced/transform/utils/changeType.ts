export function transformSendDeserializeType(data: any, typeName: string, transformData: (data: any) => any, maxDepth: number = 100) {
    return transformSendRecursive(data, {
        maxDepth,
        transformData: (obj) => {
            if (obj.___type === typeName) {
                return transformData(obj);
            }
        }
    });
}

type TransformSendRecursiveOptions = {
    maxDepth?: number;
    transformData: (data: any) => any | null;
    processingDataType?: (data: any) => boolean;
};


export function transformSendRecursive(obj: any, { transformData, maxDepth = 100, processingDataType = (data: any) => typeof data === 'object' && data !== null }: TransformSendRecursiveOptions) {
    if (!processingDataType(obj)) {
        return obj;
    }

    const processed = new WeakSet();
    const parent = { root: obj };
    const stack: { obj: any; depth: number; parent: any, key: string | number; }[] = [{ obj, depth: 0, parent, key: 'root' }];

    while (stack.length > 0) {
        const { obj: current, depth, parent, key } = stack.pop()!;
        processed.add(current);

        const foundTransform = transformData(current);
        if (foundTransform != null) {
            parent[key] = foundTransform;
            continue;
        }

        if (depth >= maxDepth) {
            continue;
        }

        const currentKeys = Array.isArray(current) ? current.keys() : Object.keys(current);
        for (const key of currentKeys) {
            const value = current[key];
            if (!processingDataType(value) || processed.has(value)) {
                continue;
            }
            stack.push({ obj: value, depth: depth + 1, key, parent: current });
        }
    }

    return parent.root;
}