import { transformSendDeserializeType, transformSendRecursive } from './utils/changeType.js';
import { PerfectWSError } from '../../PerfectWSError.js';

export abstract class TransformInstruction<T> {
    abstract check(data: any): data is T;
    abstract uniqueId: string;
    abstract serialize(data: T): any;
    abstract deserialize(data: string): T;
};

export class CustomTransformers {
    constructor(private _transformers: TransformInstruction<any>[], private _maxDepth: number = 100) {
    }

    deserialize(data: any) {
        return transformSendDeserializeType(data, 'customTransformer', found => {
            const instance = this._transformers.find(c => c.uniqueId === found.uniqueId);
            if (!instance) {
                throw new PerfectWSError(`Transform instruction not found: ${found.uniqueId}`);
            }

            return instance.deserialize(found.serialized);
        }, this._maxDepth);
    }

    serialize(obj: any) {
        return transformSendRecursive(obj, {
            maxDepth: this._maxDepth,
            transformData: (data) => this._serializeClassInstance(data)
        });
    }
    
    private _serializeClassInstance(instance: any) {
        const foundTransform = this._transformers.find(x => x.check(instance));
        if (foundTransform) {
            return {
                ___type: 'customTransformer',
                serialized: foundTransform.serialize(instance),
                uniqueId: foundTransform.uniqueId
            };
        }

        return null
    }
}
