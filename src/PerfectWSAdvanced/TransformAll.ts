import { TransformAbortSignal } from './transform/TransformAbortSignal.js';
import { TransformBinaryData } from './transform/TransformBinaryData.js';
import { TransformCallbacks } from './transform/TransformCallbacks.js';
import { TransformCircularObjects } from './transform/TransformCircularObjects.js';
import { TransformInstruction, CustomTransformers } from './transform/CustomTransformers.js';
import { NetworkEventListener } from '../utils/NetworkEventListener.js';
import { PureValueClone } from './transform/utils/PureValueClone.js';
import { SerializationTransaction } from './transform/utils/changeType.js';
import { TransformDescriptor } from './transform/TransformDescriptor.js';
import { TransformNativeTypes } from './transform/TransformNativeTypes.js';
import { TransformPureRPC } from './transform/TransformPureRPC.js';
import { TransformSymbols } from './transform/TransformSymbols.js';
import { TransformEscapedMarkers } from './transform/TransformEscapedMarkers.js';

interface TransformData {
    serialize(pureValueClone: PureValueClone, transaction?: SerializationTransaction): any;
    deserialize(data: any): any;
}

export type PreparedTransformData = {
    data: any;
    hasLiveResources: boolean;
    commit: () => void;
    rollback: () => void;
};

export type TransformAllOptions = {
    events: NetworkEventListener;
    transformers?: TransformInstruction<any>[];
    maxDepth?: number;
    maxMessageSize?: number;
    fullTrustedRPC?: boolean;
    maxPureRPCHandles?: number;
    maxRPCOperations?: number;
    autoWrapUnknownClasses?: boolean;
    globalSymbols?: Map<string, symbol>;
    maxGlobalSymbols?: number;
};

export class TransformAll {

    private _serializeOrder: TransformData[];
    private _deserializeOrder: Pick<TransformData, 'deserialize'>[];
    private _liveStateTransforms: { hasLiveState(): boolean; }[];

    private _pureRPC: TransformPureRPC;
    private _callbacks: TransformCallbacks;
    private _abortSignal: TransformAbortSignal;
    private _symbols: TransformSymbols;

    constructor({
        events,
        transformers = [],
        maxDepth = 100,
        maxMessageSize = Infinity,
        fullTrustedRPC = false,
        maxPureRPCHandles = 10_000,
        maxRPCOperations = 10_000,
        autoWrapUnknownClasses = false,
        globalSymbols = new Map(),
        maxGlobalSymbols = 10_000,
    }: TransformAllOptions) {
        const onLiveStateChanged = () => events.emit('___request.resourcesChanged');
        const descriptor = new TransformDescriptor(maxDepth);
        const escapedMarkers = new TransformEscapedMarkers(maxDepth);
        // The final send-side safety scan must cover values nested inside generated
        // container markers even when their wire shape exceeds maxDepth. Decoding stays
        // bounded by maxDepth so hostile wire data cannot force unbounded recursion.
        const escapedMarkersSafetyScan = new TransformEscapedMarkers(Infinity);
        const nativeTypes = new TransformNativeTypes(maxDepth);
        const binaryData = new TransformBinaryData(maxDepth, maxMessageSize);
        const callbacks = this._callbacks = new TransformCallbacks(events, maxDepth, onLiveStateChanged, maxRPCOperations);
        const abortSignal = this._abortSignal = new TransformAbortSignal(callbacks, maxDepth);
        const custom = new CustomTransformers(transformers, maxDepth);
        const circular = new TransformCircularObjects(maxDepth, globalSymbols);
        const pureRPC = this._pureRPC = new TransformPureRPC({
            events,
            fullTrustedRPC,
            maxDepth,
            maxHandles: maxPureRPCHandles,
            autoWrapUnknownClasses,
            transformCallbacks: callbacks,
            maxOperations: maxRPCOperations,
            onLiveStateChanged
        });
        const symbols = this._symbols = new TransformSymbols(maxDepth, globalSymbols, maxGlobalSymbols);
        this._liveStateTransforms = [callbacks, pureRPC];

        // PureRPC must run before callbacks because its proxies are functions too.
        this._serializeOrder = [
            escapedMarkers,
            descriptor,
            nativeTypes,
            abortSignal,
            descriptor,
            nativeTypes,
            binaryData,
            custom,
            escapedMarkersSafetyScan,
            circular,
            pureRPC,
            callbacks,
            symbols
        ];

        // Decode values inside container markers before rebuilding the containers.
        this._deserializeOrder = [
            symbols,
            binaryData,
            custom,
            callbacks,
            { deserialize: data => abortSignal.deserializeLive(data) },
            pureRPC,
            circular,
            escapedMarkers,
            nativeTypes,
            escapedMarkers,
            abortSignal,
            descriptor
        ];
    }

    serialize(data: any) {
        const prepared = this.prepareSerialize(data);
        prepared.commit();
        return prepared.data;
    }

    prepareSerialize(data: any): PreparedTransformData {
        const pureValueClone = new PureValueClone(data);
        const transaction = new SerializationTransaction();

        try {
            for (const transform of this._serializeOrder) {
                transform.serialize(pureValueClone, transaction);
            }
        } catch (error) {
            transaction.rollback();
            throw error;
        }

        return {
            data: pureValueClone.cloneRoot.root,
            hasLiveResources: transaction.hasRegistrations,
            commit: () => transaction.commit(),
            rollback: () => transaction.rollback(),
        };
    }

    deserialize(data: any) {
        return this._deserializeOrder.reduce((data, transform) => transform.deserialize(data), data);
    }

    hasLiveState(): boolean {
        return this._liveStateTransforms.some(transform => transform.hasLiveState());
    }

    releaseAll(): void {
        this._callbacks.releaseAll();
        this._pureRPC.releaseAll();
        this._abortSignal.releaseAll();
        this._symbols.releaseAll();
    }
}
