import { PerfectWS, WSClientOptions, WSClientResult, WSServerResult } from '../PerfectWS.js';
import { NetworkEventListener } from '../utils/NetworkEventListener.js';
import { WSLike, WebSocketForce } from '../utils/WebSocketForce.js';
import { TransformAll } from './TransformAll.js';
import { GeneratorTransform } from './transform/BaseCustomTransformers/GeneratorTransform.js';
import { TransformInstruction } from './transform/CustomTransformers.js';

type PerfectWSAdvancedConfig = {
    maxTransformDepth: number;
    /** Maximum serialized binary value in bytes. */
    maxMessageSize: number;
    /** Enables live object RPC. Both peers must opt in. */
    fullTrustedRPC: boolean;
    /** Maximum live PureRPC handles per request channel. */
    maxPureRPCHandles: number;
    /** Maximum in-flight or unacknowledged callback/PureRPC operations per request channel. */
    maxRPCOperations: number;
    /** Treats otherwise-unhandled class instances as PureRPC values. */
    autoWrapUnknownClasses: boolean;
    /** Maximum process-global symbol keys accepted during this router's lifetime. */
    maxGlobalSymbols: number;
}

export class PerfectWSAdvanced<WSType extends WSLike = WSLike, ExtraConfig = { [key: string]: any; }> extends PerfectWS<WSType, ExtraConfig & PerfectWSAdvancedConfig> {
    public transformers: TransformInstruction<any>[] = [new GeneratorTransform()];
    private _callbacks = new WeakMap<NetworkEventListener, TransformAll>;
    private _globalSymbols = new Map<string, symbol>();

    protected _getTransforms(events: NetworkEventListener) {
        if (!this._callbacks.has(events)) {
            this._callbacks.set(events, new TransformAll({
                events,
                transformers: this.transformers,
                maxDepth: this.config.maxTransformDepth,
                maxMessageSize: this.config.maxMessageSize,
                fullTrustedRPC: this.config.fullTrustedRPC,
                maxPureRPCHandles: this.config.maxPureRPCHandles,
                maxRPCOperations: this.config.maxRPCOperations,
                autoWrapUnknownClasses: this.config.autoWrapUnknownClasses,
                globalSymbols: this._globalSymbols,
                maxGlobalSymbols: this.config.maxGlobalSymbols,
            }));
        }

        return this._callbacks.get(events)!;
    }

    protected override serializeRequestData(data: any, events: NetworkEventListener) {
        data = this._getTransforms(events).serialize(data);
        return super.serializeRequestData(data, events);
    }

    protected override prepareRequestData(data: any, events: NetworkEventListener) {
        const prepared = this._getTransforms(events).prepareSerialize(data);
        return {
            data: super.serializeRequestData(prepared.data, events),
            hasLiveResources: prepared.hasLiveResources,
            commit: prepared.commit,
            rollback: prepared.rollback,
        };
    }

    protected override deserializeRequestData(data: any, events: NetworkEventListener) {
        data = super.deserializeRequestData(data, events);
        data = this._getTransforms(events).deserialize(data);
        return data;
    }

    protected override shouldKeepResponseAlive(events: NetworkEventListener): boolean {
        return this._callbacks.get(events)?.hasLiveState() ?? false;
    }

    protected override releaseRequestResources(events: NetworkEventListener): void {
        this._callbacks.get(events)?.releaseAll();
        this._callbacks.delete(events);
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
