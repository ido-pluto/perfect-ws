import { TransformAbortSignal } from './transform/TransformAbortSignal.js';
import { TransformBinaryData } from './transform/TransformBinaryData.js';
import { TransformCallbacks } from './transform/TransformCallbacks.js';
import { TransformCircularObjects } from './transform/TransformCircularObjects.js';
import { TransformInstruction, CustomTransformers } from './transform/CustomTransformers.js';
import { NetworkEventListener } from '../utils/NetworkEventListener.js';

interface TransformData {
    serialize(data: any): any;
    deserialize(data: any): any;
}

export class TransformAll {

    private _transforms: TransformData[] = [];
    constructor(events: NetworkEventListener, transformers: TransformInstruction<any>[] = [], maxDepth: number = 100) {
        this._transforms = [
            new TransformBinaryData(maxDepth),
            new TransformAbortSignal(events, maxDepth),
            new CustomTransformers(transformers, maxDepth),
            new TransformCircularObjects(maxDepth),
            new TransformCallbacks(events, maxDepth),
        ];
    }

    serialize(data: any) {
        return this._transforms.reduce((data, transform) => {
            return transform.serialize(data);
        }, data);
    }

    deserialize(data: any) {
        return this._transforms.reduce((data, transform) => transform.deserialize(data), data);
    }
}
