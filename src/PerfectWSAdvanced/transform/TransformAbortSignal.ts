import { createTransformMarker, transformReceivedDeserializeType, transformSendRecursive } from './utils/changeType.js';
import { PureValueClone } from './utils/PureValueClone.js';
import { TransformCallbacks } from './TransformCallbacks.js';
import { randomUUID } from '../../utils/randomUUID.js';

type AbortCallback = (reason: any) => unknown;
type AbortSubscriber = (onAbort: AbortCallback) => unknown;
type InboundSignalState = {
    controller: AbortController;
    subscribe: Function;
    abortId?: string;
};

export class TransformAbortSignal {
    private _inboundStates?: WeakMap<AbortSignal, InboundSignalState>;
    private _inboundSignals?: WeakMap<Function, WeakRef<AbortSignal>>;
    private _outboundSubscriptions?: WeakMap<AbortSignal, AbortSubscriber>;
    private _outboundSignals?: WeakMap<Function, WeakRef<AbortSignal>>;
    private _abortedIds?: WeakMap<AbortSignal, string>;
    private _abortedSignals?: Map<string, WeakRef<AbortSignal>>;
    private _abortedSignalFinalizer?: FinalizationRegistry<string>;

    constructor(private _callbacks: TransformCallbacks, private _maxDepth: number = 100) {
    }

    deserialize(data: any) {
        return this._deserialize(data, true);
    }

    deserializeLive(data: any) {
        return this._deserialize(data, false);
    }

    private _deserialize(data: any, includeAborted: boolean) {
        return transformReceivedDeserializeType(data, 'abortSignal', found => {
            if (found.aborted === true) {
                const abortId = found.abortId;
                if (typeof abortId === 'string') {
                    const existing = this._abortedSignals?.get(abortId)?.deref();
                    if (existing !== undefined) return existing;
                    this._abortedSignals?.delete(abortId);
                }

                const abortController = new AbortController();
                abortController.abort(found.reason);
                if (typeof abortId === 'string') {
                    (this._abortedSignals ??= new Map()).set(abortId, new WeakRef(abortController.signal));
                    (this._abortedSignalFinalizer ??= new FinalizationRegistry(id => {
                        if (this._abortedSignals?.get(id)?.deref() === undefined) {
                            this._abortedSignals?.delete(id);
                        }
                    })).register(abortController.signal, abortId, abortController.signal);
                }
                return abortController.signal;
            }

            const subscribe = found.subscribe as AbortSubscriber;
            if (typeof subscribe !== 'function') return found;

            const owned = this._outboundSignals?.get(subscribe)?.deref();
            if (owned !== undefined) return owned;

            const existing = this._inboundSignals?.get(subscribe)?.deref();
            if (existing !== undefined) return existing;

            const abortController = new AbortController();
            const signal = abortController.signal;
            const abortId = typeof found.abortId === 'string' ? found.abortId : undefined;
            const signalRef = new WeakRef(signal);
            const onAbort = (reason: any) => {
                const liveSignal = signalRef.deref();
                if (liveSignal === undefined) {
                    this._callbacks.releaseFunction(onAbort);
                    return;
                }

                this._inboundStates?.get(liveSignal)?.controller.abort(reason);
                this._releaseInbound(signalRef, onAbort);
            };

            (this._inboundStates ??= new WeakMap()).set(signal, { controller: abortController, subscribe, abortId });
            (this._inboundSignals ??= new WeakMap()).set(subscribe, new WeakRef(signal));
            if (abortId !== undefined) this._rememberAbortedSignal(signal, abortId);

            try {
                const subscription = this._callbacks.invokeReceivedFunction(subscribe, [onAbort], true);
                void Promise.resolve(subscription).catch(() => {
                    this._releaseInbound(signalRef, onAbort);
                });
            } catch {
                this._releaseInbound(signalRef, onAbort);
            }

            return signal;
        }, this._maxDepth, found => includeAborted && found.aborted === true || typeof found.subscribe === 'function');
    }

    private _releaseInbound(signalRef: WeakRef<AbortSignal>, onAbort: Function): void {
        const signal = signalRef.deref();
        if (signal !== undefined) {
            const state = this._inboundStates?.get(signal);
            this._inboundStates?.delete(signal);
            if (state) this._callbacks.releaseReceivedFunction(state.subscribe);
        }
        this._callbacks.releaseFunction(onAbort);
    }

    serialize(pureValueClone: PureValueClone) {
        const getInlineSignalId = (signal: AbortSignal) => {
            const existing = this._abortedIds?.get(signal);
            if (existing !== undefined) return existing;

            const abortId = randomUUID();
            (this._abortedIds ??= new WeakMap()).set(signal, abortId);
            return abortId;
        };

        return transformSendRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            transformData: data => this._serializeAbortSignal(data, getInlineSignalId)
        });
    }

    private _rememberAbortedSignal(signal: AbortSignal, abortId: string): void {
        if (this._abortedSignals?.get(abortId)?.deref() === signal) return;
        (this._abortedIds ??= new WeakMap()).set(signal, abortId);
        (this._abortedSignals ??= new Map()).set(abortId, new WeakRef(signal));
        (this._abortedSignalFinalizer ??= new FinalizationRegistry(id => {
            if (this._abortedSignals?.get(id)?.deref() === undefined) this._abortedSignals?.delete(id);
        })).register(signal, abortId, signal);
    }

    private _serializeAbortSignal(signal: any, getInlineSignalId: (signal: AbortSignal) => string) {
        if (!(signal instanceof AbortSignal)) return null;
        const abortId = getInlineSignalId(signal);
        this._rememberAbortedSignal(signal, abortId);
        const receivedState = this._inboundStates?.get(signal);
        const received = receivedState?.subscribe;
        if (received !== undefined) {
            return createTransformMarker('abortSignal', { subscribe: received, abortId: receivedState?.abortId ?? abortId });
        }

        const existing = this._outboundSubscriptions?.get(signal);
        if (existing !== undefined) {
            return createTransformMarker('abortSignal', { subscribe: existing, abortId });
        }
        if (signal.aborted) {
            return createTransformMarker('abortSignal', {
                aborted: true,
                abortId,
                reason: signal.reason
            });
        }

        const subscribers = new Set<AbortCallback>();
        let listening = false;

        const cleanup = () => {
            if (this._outboundSubscriptions?.get(signal) === subscribe) {
                this._outboundSubscriptions.delete(signal);
            }
            this._outboundSignals?.delete(subscribe);
            if (listening) signal.removeEventListener('abort', onSignalAbort);
            listening = false;

            for (const callback of subscribers) this._callbacks.releaseReceivedFunction(callback);
            subscribers.clear();
        };
        const onSignalAbort = () => {
            listening = false;
            if (subscribers.size === 0) {
                this._callbacks.releaseFunction(subscribe);
                return;
            }
            const deliveries = [...subscribers].map(callback => {
                try {
                    return this._callbacks.invokeReceivedFunction(callback, [signal.reason], true);
                } catch {
                    return Promise.resolve();
                }
            });
            void Promise.allSettled(deliveries).finally(() => {
                for (const callback of subscribers) this._callbacks.releaseReceivedFunction(callback);
                subscribers.clear();
                    this._callbacks.releaseFunction(subscribe);
            });
        };
        const subscribe: AbortSubscriber = async callback => {
            if (subscribers.has(callback)) return;
            subscribers.add(callback);

            if (signal.aborted) {
                try {
                    await this._callbacks.invokeReceivedFunction(callback, [signal.reason], true);
                } finally {
                    subscribers.delete(callback);
                    this._callbacks.releaseReceivedFunction(callback);
                    if (subscribers.size === 0) this._callbacks.releaseFunction(subscribe);
                }
                return;
            }

            if (!listening) {
                listening = true;
                signal.addEventListener('abort', onSignalAbort, { once: true });
            }
        };

        this._callbacks.setFunctionReleaseHandler(subscribe, cleanup);
        (this._outboundSubscriptions ??= new WeakMap()).set(signal, subscribe);
        (this._outboundSignals ??= new WeakMap()).set(subscribe, new WeakRef(signal));
        return createTransformMarker('abortSignal', { subscribe, abortId });
    }

    releaseAll(): void {
        this._abortedSignals?.clear();
        this._abortedSignals = undefined;
        this._abortedSignalFinalizer = undefined;
        this._inboundStates = undefined;
        this._inboundSignals = undefined;
        this._outboundSubscriptions = undefined;
        this._outboundSignals = undefined;
        this._abortedIds = undefined;
    }
}
