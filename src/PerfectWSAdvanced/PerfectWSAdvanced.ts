import { PerfectWS, WSClientOptions, WSClientResult, WSServerResult } from '../PerfectWS.js';
import { NetworkEventListener } from '../utils/NetworkEventListener.js';
import { WSLike, WebSocketForce } from '../utils/WebSocketForce.js';
import { TransformAll } from './TransformAll.js';
import { GeneratorTransform } from './transform/BaseCustomTransformers/GeneratorTransform.js';
import { TransformInstruction } from './transform/CustomTransformers.js';

type PerfectWSAdvancedConfig = {
    maxTransformDepth: number;
}

export class PerfectWSAdvanced<WSType extends WSLike = WSLike, ExtraConfig = { [key: string]: any; }> extends PerfectWS<WSType, ExtraConfig & PerfectWSAdvancedConfig> {
    public transformers: TransformInstruction<any>[] = [new GeneratorTransform()];
    private _callbacks = new WeakMap<NetworkEventListener, TransformAll>;

    protected _getTransforms(events: NetworkEventListener) {
        if (!this._callbacks.has(events)) {
            this._callbacks.set(events, new TransformAll(events, this.transformers, this.config.maxTransformDepth));
        }

        return this._callbacks.get(events)!;
    }

    protected override serializeRequestData(data: any, events: NetworkEventListener) {
        data = this._getTransforms(events).serialize(data);
        return super.serializeRequestData(data, events);
    }

    protected override deserializeRequestData(data: any, events: NetworkEventListener) {
        data = super.deserializeRequestData(data, events);
        data = this._getTransforms(events).deserialize(data);
        return data;
    }

    protected static override _newInstance<WSType extends WSLike = WSLike>() {
        return new PerfectWSAdvanced<WSType>();
    }

    static override client<WSType extends WSLike = WSLike>(config?: WSClientOptions): WSClientResult<WSType, PerfectWSAdvanced<WSType>>;
    static override client<WSType extends WSLike = WSLike>(server: WSType | WebSocketForce<WSType>, config?: WSClientOptions): WSClientResult<WSType, PerfectWSAdvanced<WSType>>;
    static override client<WSType extends WSLike = WSLike>(server?: WSType | WebSocketForce<WSType> | WSClientOptions, config?: WSClientOptions) {
        return super.client<WSType>(server as any, config) as WSClientResult<WSType, PerfectWSAdvanced<WSType>>;
    }

    static override server<WSType extends WSLike = WSLike>() {
        return super.server<WSType>() as WSServerResult<WSType, PerfectWSAdvanced<WSType>>;
    }
}
