import {
    createTransformMarker,
    SerializationTransaction,
    transformReceivedDeserializeType,
    transformSendRecursive,
} from './utils/changeType.js';
import { NetworkEventListener } from '../../utils/NetworkEventListener.js';
import { PureValueClone } from './utils/PureValueClone.js';
import { PureRPCRegistry } from './utils/PureRPCRegistry.js';
import { createPureRPCProxy, PureRPCTransport } from './utils/createPureRPCProxy.js';
import { isForbiddenPropertyKey, isPrimitivePropertyKey } from './utils/getProperty.js';
import { PerfectWSError } from '../../PerfectWSError.js';
import { randomUUID } from '../../utils/randomUUID.js';
import { WebSocketForce } from '../../utils/WebSocketForce.js';
import { PureRPC } from '../PureRPC.js';
import { TransformCallbacks } from './TransformCallbacks.js';
import { errorMessage } from '../../utils/errorMessage.js';

type PureRPCOp = 'get' | 'set' | 'apply' | 'release';

type PureRPCRequestMessage = {
    callId: string;
    op: PureRPCOp;
    rpcId: string;
    path: readonly PropertyKey[];
    args?: any[];
    value?: any;
    lease?: number;
};

type PureRPCResponseMessage = {
    callId: string;
    data?: any;
    error?: string;
};

type ReceivedProxyEntry = {
    ref: WeakRef<object>;
    token: object;
    lease: number;
};

const AUTO_WRAP_DENYLIST_NAMES = new Set<string>([
    'IncomingMessage', 'ServerResponse', 'ClientRequest',
    'Socket', 'TLSSocket', 'Server',
    'Duplex', 'Readable', 'Writable', 'Transform', 'Stream',
    'EventEmitter',
    'WebSocket',
]);

type TransformPureRPCOptions = {
    events: NetworkEventListener;
    fullTrustedRPC: boolean;
    maxDepth?: number;
    maxHandles?: number;
    autoWrapUnknownClasses?: boolean;
    transformCallbacks: TransformCallbacks;
    onLiveStateChanged?: () => void;
    maxOperations?: number;
};

type CallbackForwarders = {
    byReceiver: WeakMap<object, WeakMap<Function, Function>>;
};

type ProvisionalHandle = {
    committed: boolean;
    pendingTransactions: Set<SerializationTransaction>;
};

type HandleLeaseState = {
    current: number;
    committed: number;
    pending: Map<SerializationTransaction, number>;
    pendingRelease: number;
};

export class TransformPureRPC {
    private _registry: PureRPCRegistry;
    private _pendingCalls = new Map<string, { resolve: (data: any) => void; reject: (error: any) => void; }>();
    private _producedProxies = new WeakMap<object, string>();
    private _events: NetworkEventListener;
    private _fullTrustedRPC: boolean;
    private _maxDepth: number;
    private _maxHandles: number;
    private _autoWrapUnknownClasses: boolean;

    private _transformCallbacks: TransformCallbacks;
    private _callbackForwarders = new Map<string, CallbackForwarders>();
    private _provisionalHandles = new Map<string, ProvisionalHandle>();
    private _receivedProxies = new Map<string, ReceivedProxyEntry>();
    private _handleLeases = new Map<string, HandleLeaseState>();
    private _activeIncomingCalls = 0;
    private _incomingCallResults = new Map<string, Promise<PureRPCResponseMessage>>();
    private _onLiveStateChanged: () => void;
    private _released = false;
    private _maxOperations: number;

    private _onPureRPCRequest = async (source: string, message: unknown) => {
        if (source === 'local') return;

        if (!this._fullTrustedRPC) {
            if (typeof message === 'object' && message !== null && (message as { op?: unknown; }).op === 'release') return;
            if (hasCallId(message)) {
                this._events.emit('___pureRPC.response', { callId: message.callId, error: 'PureRPC is not enabled on this side (fullTrustedRPC)' });
            }
            return;
        }

        if (!isPureRPCRequestMessage(message)) {
            if (hasCallId(message)) {
                this._events.emit('___pureRPC.response', { callId: message.callId, error: 'Invalid PureRPC request' });
            }
            return;
        }

        if (message.op === 'release') {
            try {
                await this._handle(message);
            } catch { }
            return;
        }

        let result = this._incomingCallResults.get(message.callId);
        let startedHere = false;
        if (!result) {
            if (this._incomingCallResults.size >= this._maxOperations) {
                this._events.emit('___pureRPC.response', { callId: message.callId, error: 'Too many PureRPC operations' });
                return;
            }
            startedHere = true;
            this._activeIncomingCalls++;
            this._notifyLiveStateChanged();
            result = (async () => {
                try {
                    return { callId: message.callId, data: await this._handle(message) };
                } catch (error: any) {
                    return { callId: message.callId, error: errorMessage(error) };
                }
            })();
            this._incomingCallResults.set(message.callId, result);
        }
        this._events.emit('___pureRPC.response', await result);
        if (startedHere) {
            this._activeIncomingCalls--;
            this._notifyLiveStateChanged();
        }
    };

    private _onPureRPCResponse = (source: string, message: unknown) => {
        if (source === 'local') return;
        if (!hasCallId(message)) return;

        this._events.emit('___request.operationSettled', {
            eventName: '___pureRPC.request',
            operationId: message.callId,
        });

        const pending = this._pendingCalls.get(message.callId);
        if (!pending) return;

        this._pendingCalls.delete(message.callId);
        this._notifyLiveStateChanged();

        if (!isPureRPCResponseMessage(message)) {
            pending.reject(new PerfectWSError('Invalid PureRPC response', 'pureRPCError'));
            return;
        }

        if (message.error != null) {
            pending.reject(new PerfectWSError(message.error, 'pureRPCError'));
        } else {
            pending.resolve(message.data);
        }
    };

    private _onTransportSendFailed = (source: string, error: { message?: string; eventName?: string; operationId?: string; }) => {
        if (source === 'remote' || this._pendingCalls.size === 0) return;

        const reason = new PerfectWSError(error?.message ?? 'PureRPC transport send failed', 'pureRPCDisconnected');
        if ((error.eventName === '___pureRPC.request' || error.eventName === '___pureRPC.response') && typeof error.operationId === 'string') {
            const pending = this._pendingCalls.get(error.operationId);
            if (!pending) return;
            pending.reject(reason);
            this._pendingCalls.delete(error.operationId);
            this._notifyLiveStateChanged();
            return;
        }
        if (typeof error.eventName === 'string') return;
        for (const pending of this._pendingCalls.values()) {
            pending.reject(reason);
        }
        this._pendingCalls.clear();
        this._incomingCallResults.clear();
        this._activeIncomingCalls = 0;
        this._notifyLiveStateChanged();
    };

    private _onEventDelivered = (source: string, event: { eventName?: string; operationId?: string; }) => {
        if (source === 'remote' || event?.eventName !== '___pureRPC.response' || typeof event.operationId !== 'string') return;
        this._incomingCallResults.delete(event.operationId);
    };

    constructor(options: TransformPureRPCOptions) {
        this._events = options.events;
        this._fullTrustedRPC = options.fullTrustedRPC;
        this._maxDepth = options.maxDepth ?? 100;
        this._maxHandles = options.maxHandles ?? 10_000;
        this._autoWrapUnknownClasses = options.autoWrapUnknownClasses ?? false;
        this._transformCallbacks = options.transformCallbacks;
        this._onLiveStateChanged = options.onLiveStateChanged ?? (() => { });
        this._maxOperations = options.maxOperations ?? 10_000;

        this._registry = new PureRPCRegistry(this._maxHandles);
        this._registerEvents();
    }

    releaseAll(): void {
        if (this._released) return;
        this._released = true;

        this._events.off('___pureRPC.request', this._onPureRPCRequest);
        this._events.off('___pureRPC.response', this._onPureRPCResponse);
        this._events.off('___request.sendFailed', this._onTransportSendFailed);
        this._events.off('___request.eventDelivered', this._onEventDelivered);

        for (const rpcId of this._callbackForwarders.keys()) {
            this._releaseCallbackForwarders(rpcId);
        }
        this._registry.releaseAll();
        this._provisionalHandles.clear();
        this._receivedProxies.clear();
        this._handleLeases.clear();

        const error = new PerfectWSError('PureRPC channel released', 'pureRPCReleased');
        for (const pending of this._pendingCalls.values()) {
            pending.reject(error);
        }
        this._pendingCalls.clear();
        this._incomingCallResults.clear();
        this._activeIncomingCalls = 0;
    }

    hasLiveState(): boolean {
        return this._registry.size > 0 || this._pendingCalls.size > 0 || this._receivedProxies.size > 0
            || this._activeIncomingCalls > 0;
    }

    private _notifyLiveStateChanged(): void {
        if (!this._released) this._onLiveStateChanged();
    }

    private _registerEvents() {
        this._events.on('___pureRPC.request', this._onPureRPCRequest);
        this._events.on('___pureRPC.response', this._onPureRPCResponse);
        this._events.on('___request.sendFailed', this._onTransportSendFailed);
        this._events.on('___request.eventDelivered', this._onEventDelivered);
    }

    private async _handle({ op, rpcId, path, args, value, lease }: PureRPCRequestMessage): Promise<any> {
        switch (op) {
            case 'get': {
                const resolution = this._registry.resolve(rpcId, path);
                if (!resolution) {
                    throw new PerfectWSError('PureRPC path not found', 'pureRPCNotFound');
                }
                if (typeof resolution.value === 'function') {
                    return this._getCallbackForwarder(rpcId, resolution.receiver, resolution.value);
                }
                return resolution.value;
            }

            case 'set': {
                if (path.length === 0) {
                    throw new PerfectWSError('Cannot set the root handle itself', 'pureRPCInvalidSet');
                }

                const key = path[path.length - 1];
                if (isForbiddenPropertyKey(key)) {
                    throw new PerfectWSError('Refused property', 'pureRPCForbidden');
                }

                const resolved = this._registry.resolveContainer(rpcId, path.slice(0, -1));
                if (!resolved) {
                    throw new PerfectWSError('PureRPC path not found', 'pureRPCNotFound');
                }

                (resolved.container as Record<PropertyKey, unknown>)[key] = value;
                return undefined;
            }

            case 'apply': {
                if (path.length === 0) {
                    const root = this._registry.resolveContainer(rpcId, [])?.container;
                    if (typeof root !== 'function') {
                        throw new PerfectWSError('PureRPC method not found', 'pureRPCNotFound');
                    }
                    return await root(...(args ?? []));
                }

                const resolution = this._registry.resolve(rpcId, path);
                if (!resolution || typeof resolution.value !== 'function') {
                    throw new PerfectWSError('PureRPC method not found', 'pureRPCNotFound');
                }
                return await (resolution.value as Function).apply(resolution.receiver, args ?? []);
            }

            case 'release': {
                const leaseState = this._handleLeases.get(rpcId);
                const releasedLease = lease ?? leaseState?.current ?? 0;
                if (leaseState && releasedLease < leaseState.current) {
                    leaseState.pendingRelease = Math.max(leaseState.pendingRelease, releasedLease);
                    return undefined;
                }
                if (leaseState && releasedLease > leaseState.current) return undefined;
                this._releaseCallbackForwarders(rpcId);
                this._provisionalHandles.delete(rpcId);
                this._registry.release(rpcId);
                this._handleLeases.delete(rpcId);
                this._notifyLiveStateChanged();
                return undefined;
            }
        }
    }

    private _getCallbackForwarder(rpcId: string, receiver: unknown, func: Function): Function {
        if ((typeof receiver !== 'object' && typeof receiver !== 'function') || receiver === null) {
            throw new PerfectWSError('PureRPC function has no callable receiver', 'pureRPCInvalidReceiver');
        }

        let handle = this._callbackForwarders.get(rpcId);
        if (handle === undefined) {
            handle = { byReceiver: new WeakMap() };
            this._callbackForwarders.set(rpcId, handle);
        }

        let byFunction = handle.byReceiver.get(receiver);
        if (byFunction === undefined) {
            byFunction = new WeakMap();
            handle.byReceiver.set(receiver, byFunction);
        }

        let forwarder = byFunction.get(func);
        if (forwarder === undefined) {
            forwarder = (...args: any[]) => func.apply(receiver, args);
            byFunction.set(func, forwarder);
        }

        return forwarder;
    }

    private _releaseCallbackForwarders(rpcId: string): void {
        if (!this._callbackForwarders.has(rpcId)) return;

        this._callbackForwarders.delete(rpcId);
    }

    private _call(op: PureRPCOp, rpcId: string, path: readonly PropertyKey[], args?: any[], value?: any): Promise<any> {
        if (this._released) {
            return Promise.reject(new PerfectWSError('PureRPC channel released', 'pureRPCReleased'));
        }

        if (this._pendingCalls.size >= this._maxOperations) {
            return Promise.reject(new PerfectWSError('Too many PureRPC operations', 'pureRPCCapacity'));
        }

        const callId = randomUUID();

        return new Promise((resolve, reject) => {
            this._pendingCalls.set(callId, { resolve, reject });
            this._notifyLiveStateChanged();
            this._events.emit('___pureRPC.request', { callId, op, rpcId, path, args, value });
        });
    }

    deserialize(data: any) {
        return transformReceivedDeserializeType(data, 'pureRPC', found => {
            if (!this._fullTrustedRPC) {
                return found;
            }

            const rpcId = found.rpcId;

            const owned = this._registry.resolveContainer(rpcId, []);
            if (owned) {
                return owned.container;
            }

            const existing = this._receivedProxies.get(rpcId)?.ref.deref();
            if (existing !== undefined) {
                const entry = this._receivedProxies.get(rpcId)!;
                entry.lease = Math.max(entry.lease, validLease(found.lease));
                return existing;
            }

            const token = {};

            const transport: PureRPCTransport = {
                get: (path) => this._call('get', rpcId, path),
                set: (path, value) => {
                    const pending = this._call('set', rpcId, path, undefined, value);
                    pending.catch((error: any) => {
                        this._events.emit('___pureRPC.setError', { rpcId, path, error: errorMessage(error) });
                    });
                    return pending;
                },
                apply: (path, args) => this._call('apply', rpcId, path, args),
                release: () => {
                    const entry = this._receivedProxies.get(rpcId);
                    if (entry?.token !== token) return;

                    this._events.emit('___pureRPC.request', {
                        callId: randomUUID(),
                        op: 'release',
                        rpcId,
                        path: [],
                        lease: entry.lease,
                    });
                    this._receivedProxies.delete(rpcId);
                    this._notifyLiveStateChanged();
                },
            };

            const proxy = createPureRPCProxy(transport);
            this._producedProxies.set(proxy, rpcId);
            this._receivedProxies.set(rpcId, { ref: new WeakRef(proxy), token, lease: validLease(found.lease) });
            this._notifyLiveStateChanged();
            return proxy;
        }, this._maxDepth, found => typeof found.rpcId === 'string');
    }

    serialize(pureValueClone: PureValueClone, transaction?: SerializationTransaction) {
        return transformSendRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            transformData: (data) => this._serializePureRPC(data, transaction),
            processingDataType: (data) => typeof data === 'object' && data !== null || typeof data === 'function'
        });
    }

    private _serializePureRPC(value: any, transaction?: SerializationTransaction) {
        if (!this._fullTrustedRPC) {
            return null;
        }

        const ownRpcId = this._producedProxies.get(value);
        if (ownRpcId !== undefined) {
            const lease = this._receivedProxies.get(ownRpcId)?.lease ?? 0;
            return createTransformMarker('pureRPC', lease > 0 ? { rpcId: ownRpcId, lease } : { rpcId: ownRpcId });
        }

        if (value instanceof PureRPC || (this._autoWrapUnknownClasses && this._isAutoWrappable(value))) {
            const root = value?.root ?? value;
            const existingId = this._registry.getId(root);
            const rpcId = existingId ?? this._registry.register(root);
            let provisional = this._provisionalHandles.get(rpcId);

            if (existingId === undefined) {
                provisional = { committed: transaction === undefined, pendingTransactions: new Set() };
                if (!provisional.committed) this._provisionalHandles.set(rpcId, provisional);
                this._notifyLiveStateChanged();
            }

            if (!transaction && provisional && !provisional.committed) {
                provisional.committed = true;
                provisional.pendingTransactions.clear();
                this._provisionalHandles.delete(rpcId);
            }

            if (transaction && provisional && !provisional.committed && !provisional.pendingTransactions.has(transaction)) {
                provisional.pendingTransactions.add(transaction);
                transaction.add({
                    commit: () => {
                        if (this._provisionalHandles.get(rpcId) !== provisional) return;
                        provisional!.committed = true;
                        provisional!.pendingTransactions.clear();
                        this._provisionalHandles.delete(rpcId);
                    },
                    rollback: () => {
                        if (this._provisionalHandles.get(rpcId) !== provisional || provisional!.committed) return;
                        provisional!.pendingTransactions.delete(transaction);
                        if (provisional!.pendingTransactions.size === 0) {
                            this._provisionalHandles.delete(rpcId);
                            this._releaseCallbackForwarders(rpcId);
                            this._registry.release(rpcId);
                            this._handleLeases.delete(rpcId);
                            this._notifyLiveStateChanged();
                        }
                    },
                });
            }

            let leaseState = this._handleLeases.get(rpcId);
            if (leaseState === undefined) {
                leaseState = { current: 0, committed: 0, pending: new Map(), pendingRelease: -1 };
                this._handleLeases.set(rpcId, leaseState);
            }
            const lease = ++leaseState.current;
            if (transaction) {
                leaseState.pending.set(transaction, lease);
                const currentState = leaseState;
                transaction.add({
                    commit: () => {
                        if (this._handleLeases.get(rpcId) !== currentState) return;
                        currentState.pending.delete(transaction);
                        currentState.committed = Math.max(currentState.committed, lease);
                    },
                    rollback: () => {
                        if (this._handleLeases.get(rpcId) !== currentState) return;
                        currentState.pending.delete(transaction);
                        currentState.current = Math.max(currentState.committed, ...currentState.pending.values());
                        if (currentState.pendingRelease >= currentState.current && currentState.current > 0) {
                            this._releaseCallbackForwarders(rpcId);
                            this._provisionalHandles.delete(rpcId);
                            this._registry.release(rpcId);
                            this._handleLeases.delete(rpcId);
                            this._notifyLiveStateChanged();
                        }
                    },
                });
            } else {
                leaseState.committed = lease;
            }

            return createTransformMarker('pureRPC', { rpcId, lease });
        }

        return null;
    }

    private _isAutoWrappable(value: any): boolean {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return false;
        }

        if (value instanceof Date || value instanceof RegExp || value instanceof Promise) {
            return false;
        }

        const proto = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null) {
            return false;
        }

        if (value instanceof WebSocketForce) {
            return false;
        }

        let constructor: unknown;
        for (let current: object | null = value; current; current = Object.getPrototypeOf(current)) {
            const descriptor = Object.getOwnPropertyDescriptor(current, 'constructor');
            if (!descriptor) continue;
            if (!('value' in descriptor)) return false;
            constructor = descriptor.value;
            break;
        }
        if (constructor === undefined) return true;
        if (typeof constructor !== 'function') return false;
        const name = Object.getOwnPropertyDescriptor(constructor, 'name')?.value;
        return typeof name === 'string' && !AUTO_WRAP_DENYLIST_NAMES.has(name);
    }
}

function hasCallId(message: unknown): message is { callId: string; } {
    return typeof message === 'object'
        && message !== null
        && typeof (message as { callId?: unknown; }).callId === 'string';
}

function isPureRPCRequestMessage(message: unknown): message is PureRPCRequestMessage {
    if (!hasCallId(message)) return false;

    const request = message as Partial<PureRPCRequestMessage>;
    if (typeof request.rpcId !== 'string' || !Array.isArray(request.path)) return false;
    if (!request.path.every(isPrimitivePropertyKey)) return false;

    if (request.op === 'apply') return request.args === undefined || Array.isArray(request.args);
    if (request.op === 'release') return request.lease === undefined || validLease(request.lease) === request.lease;
    return request.op === 'get' || request.op === 'set';
}

function validLease(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isPureRPCResponseMessage(message: unknown): message is PureRPCResponseMessage {
    return hasCallId(message)
        && (!Object.hasOwn(message, 'error') || typeof (message as PureRPCResponseMessage).error === 'string');
}
