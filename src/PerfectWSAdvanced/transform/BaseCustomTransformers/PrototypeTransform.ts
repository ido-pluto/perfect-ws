import { TransformInstruction } from "../CustomTransformers.js";


export abstract class PrototypeTransform<T extends {[key: string]: any}> extends TransformInstruction<T> {
    abstract serializePrototypes: string[];

    serialize(data: T): any {
        const results: Record<string, any> = {};
        for(const key of this.serializePrototypes){
            if(typeof data[key] === 'function'){
                results[key] = (...args: any[]) => data[key](...args);
            } else if(data[key] !== undefined){
                results[key] = data[key];
            }
        }

        return results;
    }

    deserialize(data: any): T {
        return data;
    }
}