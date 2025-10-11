import { PrototypeTransform } from "./PrototypeTransform.js";

export class GeneratorTransform extends PrototypeTransform<Iterator<any>> {
    uniqueId = 'Generator'
    serializePrototypes = ['next', 'return', 'throw'];

    check(data: any): data is Iterator<any> {
        return (typeof data[Symbol.iterator] === 'function' || typeof data[Symbol.asyncIterator] === 'function') && typeof data.next === 'function';
    }

    override deserialize(data: any) {
        data[Symbol.asyncIterator] = () => data
        return data;
    }
}