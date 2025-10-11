import { transformSendDeserializeType, transformSendRecursive } from './utils/changeType.js';
import { v4 as uuid } from 'uuid';
import { NetworkEventListener } from '../../utils/NetworkEventListener.js';

export class TransformAbortSignal {

    constructor(private _events: NetworkEventListener, private _maxDepth: number = 100) {
    }

    deserialize(data: any) {
        return transformSendDeserializeType(data, 'abortSignal', found => {
            const abortController = new AbortController();
            this._events.once(`___abortSignal.aborted.${found.signalId}`, (source, { reason }) => {
                if (source === 'local') return;
                abortController.abort(reason);
            });

            return abortController.signal;
        }, this._maxDepth);
    }

    serialize(obj: any) {
        return transformSendRecursive(obj, {
            maxDepth: this._maxDepth,
            processingDataType: (data) => typeof data === 'object' && data !== null,
            transformData: (data) => this._serializeAbortSignal(data)
        });
    }

    private _serializeAbortSignal(signal: any) {
        if (!(signal instanceof AbortSignal)) {
            return null;
        }

        const signalId = uuid();
        signal.addEventListener('abort', () => {
            this._events.emit(`___abortSignal.aborted.${signalId}`, { reason: signal.reason });
        });

        return { ___type: 'abortSignal', signalId };
    }
}
