import { PrototypeTransform } from "./PrototypeTransform.js";

export class GeneratorTransform extends PrototypeTransform<Iterator<any>> {
    uniqueId = 'Generator'
    serializePrototypes = ['next', 'return', 'throw'];

    check(data: any): data is Iterator<any> {
        if ((typeof data !== 'object' && typeof data !== 'function') || data === null) return false;
        return (hasDataFunction(data, Symbol.iterator) || hasDataFunction(data, Symbol.asyncIterator))
            && hasDataFunction(data, 'next');
    }

    override deserialize(data: any) {
        data[Symbol.asyncIterator] = () => data
        return data;
    }
}

function hasDataFunction(value: object, key: PropertyKey): boolean {
    const visited = new Set<object>();
    let current: object | null = value;
    while (current !== null && !visited.has(current)) {
        visited.add(current);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function';
        current = Object.getPrototypeOf(current);
    }
    return false;
}
