import { transformSendDeserializeType, transformSendRecursive } from './utils/changeType.js';
import { v4 as uuid } from 'uuid';
import { NetworkEventListener } from '../../utils/NetworkEventListener.js';
import { PerfectWSError } from '../../PerfectWSError.js';

export class TransformCallbacks {
    private _functions: [string, any][] = [];
    private _activeRequests = new Map<string, { resolve: (data: any) => void, reject: (error: any) => void; }>();

    constructor(private _events: NetworkEventListener, private _maxDepth: number = 100) {
        this._registerEvents();
    }

    private _registerEvents() {
        this._events.on('___callback.request', async (source, { args, funcId, requestId }) => {
            if (source === 'local') return;

            const func = this._functions.find(([localFuncId]) => localFuncId === funcId)?.[1];
            if (!func) {
                this._events.emit('___callback.response', { error: 'Method not found', requestId });
                return;
            }

            try {
                const response = await func(...args);
                this._events.emit('___callback.response', { data: response, requestId });
            } catch (error: any) {
                this._events.emit('___callback.response', { error: error.message || error, requestId });
            }
        });

        this._events.on('___callback.response', (source, { data, error, requestId }) => {
            if (source === 'local') return;

            const request = this._activeRequests.get(requestId);
            if (!request) return;

            if (error) {
                request.reject(new PerfectWSError(error, 'callbackError'));
            } else {
                request.resolve(data);
            }

            this._activeRequests.delete(requestId);
        });
    }

    deserialize(data: any) {
        return transformSendDeserializeType(data, 'callback', found => {
            const func = (...args: any[]) => {
                const requestId = uuid();
                this._events.emit('___callback.request', { args, funcId: found.funcId, requestId });

                return new Promise((resolve, reject) => {
                    this._activeRequests.set(requestId, { resolve, reject });
                });
            };

            Object.defineProperty(func, 'name', { value: found.funcName });
            return func;
        }, this._maxDepth);
    }

    serialize(obj: any) {
        return transformSendRecursive(obj, {
            maxDepth: this._maxDepth,
            processingDataType: (data) => typeof data === 'object' && data !== null || typeof data === 'function',
            transformData: (data) => this._serializeFunction(data)
        });
    }

    private _serializeFunction(func: any) {
        if(typeof func !== 'function') {
            return null;
        }

        let hasFunc = this._functions.find(([_, fn]) => fn === func)?.[0];
        if (!hasFunc) {
            hasFunc = uuid();
            this._functions.push([hasFunc, func]);
        }

        return { ___type: 'callback', funcId: hasFunc, funcName: func.name }
    }
}
