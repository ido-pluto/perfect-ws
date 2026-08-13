import {
    createTransformMarker,
    SerializationTransaction,
    transformReceivedDeserializeType,
    transformSendRecursive,
} from './utils/changeType.js';
import { NetworkEventListener } from '../../utils/NetworkEventListener.js';
import { PerfectWSError } from '../../PerfectWSError.js';
import { PureValueClone } from './utils/PureValueClone.js';
import { randomUUID } from '../../utils/randomUUID.js';
import { errorMessage } from '../../utils/errorMessage.js';

type ReceivedCallbackEntry = {
    ref: WeakRef<Function>;
    token: object;
    lease: number;
};

type OwnedCallbackEntry = {
    funcId?: string;
    releaseHandler?: () => void;
    committed?: boolean;
    pendingTransactions?: Set<SerializationTransaction>;
    lease?: number;
    committedLease?: number;
    pendingLeases?: Map<SerializationTransaction, number>;
    pendingReleaseLease?: number;
};

type ReceivedCallbackFinalizer = {
    owner: TransformCallbacks;
    funcId: string;
    token: object;
};

const receivedCallbackFinalizers = typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<ReceivedCallbackFinalizer>(({ owner, funcId, token }) => {
        owner.finalizeReceivedFunction(funcId, token);
    })
    : undefined;

export class TransformCallbacks {
    private _functions?: Map<string, Function>;
    private _functionEntries?: WeakMap<Function, OwnedCallbackEntry>;
    private _activeRequests?: Map<string, { resolve: (data: any) => void, reject: (error: any) => void; }>;
    private _activeIncomingRequests = 0;
    private _incomingRequestResults = new Map<string, Promise<{ data?: any; error?: string; }>>();
    private _receivedFunctions?: Map<string, ReceivedCallbackEntry>;
    private _receivedFunctionEntries?: WeakMap<Function, { funcId: string; token: object; }>;
    private _released = false;

    private _onCallbackRequest = async (source: string, message: unknown) => {
        if (source === 'local') return;

        if (!isCallbackRequest(message)) {
            if (hasRequestId(message)) {
                this._events.emit('___callback.response', {
                    error: 'Invalid callback request',
                    requestId: message.requestId,
                });
            }
            return;
        }

        const { args, funcId, requestId, durable } = message;
        let result = this._incomingRequestResults.get(requestId);
        let startedHere = false;
        if (!result) {
            if (this._incomingRequestResults.size >= this._maxOperations) {
                this._events.emit('___callback.response', { error: 'Too many callback operations', requestId, durable });
                return;
            }
            const func = this._functions?.get(funcId);
            if (!func) {
                result = Promise.resolve({ error: 'Method not found' });
            } else {
                startedHere = true;
                this._activeIncomingRequests++;
                this._notifyLiveStateChanged();
                result = (async () => {
                    try {
                        return { data: await func(...args) };
                    } catch (error: unknown) {
                        return { error: errorMessage(error) };
                    }
                })();
            }
            this._incomingRequestResults.set(requestId, result);
        }
        this._events.emit('___callback.response', { ...await result, requestId, durable });
        if (startedHere) {
            this._activeIncomingRequests--;
            this._notifyLiveStateChanged();
        }
    };

    private _onCallbackResponse = (source: string, message: unknown) => {
        if (source === 'local') return;
        if (!hasRequestId(message)) return;

        this._events.emit('___request.operationSettled', {
            eventName: '___callback.request',
            operationId: message.requestId,
        });

        const { data, error, requestId } = message;
        const request = this._activeRequests?.get(requestId);
        if (!request) return;

        this._activeRequests!.delete(requestId);
        if (this._activeRequests!.size === 0) this._activeRequests = undefined;
        this._notifyLiveStateChanged();

        if (Object.hasOwn(message, 'error')) {
            request.reject(new PerfectWSError(errorMessage(error), 'callbackError'));
        } else {
            request.resolve(data);
        }
    };

    private _onCallbackRelease = (source: string, message: unknown) => {
        if (source === 'local') return;
        if (!isCallbackRelease(message)) return;
        const func = this._functions?.get(message.funcId);
        const entry = func === undefined ? undefined : this._functionEntries?.get(func);
        if (!entry) return;

        const currentLease = entry.lease!;
        const lease = message.lease ?? currentLease;
        if (lease < currentLease) {
            entry.pendingReleaseLease = Math.max(entry.pendingReleaseLease ?? 0, lease);
            return;
        }
        if (lease > currentLease) return;
        this._releaseOwnedFunctionId(message.funcId);
    };

    private _onTransportSendFailed = (source: string, error: { message?: string; eventName?: string; operationId?: string; }) => {
        if (source === 'remote' || !this._activeRequests?.size) return;

        const reason = new PerfectWSError(error?.message ?? 'Callback transport send failed', 'callbackDisconnected');
        if ((error.eventName === '___callback.request' || error.eventName === '___callback.response') && typeof error.operationId === 'string') {
            const request = this._activeRequests.get(error.operationId);
            if (!request) return;
            request.reject(reason);
            this._activeRequests.delete(error.operationId);
            if (this._activeRequests.size === 0) this._activeRequests = undefined;
            this._notifyLiveStateChanged();
            return;
        }
        if (typeof error.eventName === 'string') return;
        for (const request of this._activeRequests.values()) {
            request.reject(reason);
        }
        this._activeRequests.clear();
        this._activeRequests = undefined;
        this._notifyLiveStateChanged();
    };

    private _onEventDelivered = (source: string, event: { eventName?: string; operationId?: string; }) => {
        if (source === 'remote' || event?.eventName !== '___callback.response' || typeof event.operationId !== 'string') return;
        this._incomingRequestResults.delete(event.operationId);
    };

    constructor(
        private _events: NetworkEventListener,
        private _maxDepth: number = 100,
        private _onLiveStateChanged: () => void = () => { },
        private _maxOperations: number = 10_000
    ) {
        this._registerEvents();
    }

    private _registerEvents() {
        this._events.on('___callback.request', this._onCallbackRequest);
        this._events.on('___callback.response', this._onCallbackResponse);
        this._events.on('___callback.release', this._onCallbackRelease);
        this._events.on('___request.sendFailed', this._onTransportSendFailed);
        this._events.on('___request.eventDelivered', this._onEventDelivered);
    }

    private _notifyLiveStateChanged(): void {
        if (!this._released) this._onLiveStateChanged();
    }

    hasLiveState(): boolean {
        return Boolean(this._functions?.size || this._receivedFunctions?.size || this._activeRequests?.size || this._activeIncomingRequests);
    }

    releaseFunction(func: Function): void {
        const funcId = this._functionEntries?.get(func)?.funcId;
        if (funcId === undefined) return;
        this._releaseOwnedFunctionId(funcId);
    }

    setFunctionReleaseHandler(func: Function, handler: () => void): void {
        const entries = this._functionEntries ??= new WeakMap();
        const entry = entries.get(func);
        if (entry) entry.releaseHandler = handler;
        else entries.set(func, { releaseHandler: handler });
    }

    releaseReceivedFunction(func: Function): void {
        const entry = this._receivedFunctionEntries?.get(func);
        if (entry === undefined) return;
        this.finalizeReceivedFunction(entry.funcId, entry.token);
    }

    invokeReceivedFunction(func: Function, args: any[], durable = false): Promise<any> {
        const entry = this._receivedFunctionEntries?.get(func);
        if (entry === undefined) {
            return Promise.resolve(func(...args));
        }
        return this._invokeReceived(entry.funcId, args, durable);
    }

    private _invokeReceived(funcId: string, args: any[], durable: boolean): Promise<any> {
        if (this._released) {
            return Promise.reject(new PerfectWSError('Callback channel released', 'callbackReleased'));
        }

        if ((this._activeRequests?.size ?? 0) >= this._maxOperations) {
            return Promise.reject(new PerfectWSError('Too many callback operations', 'callbackCapacity'));
        }

        const requestId = randomUUID();
        const promise = new Promise((resolve, reject) => {
            (this._activeRequests ??= new Map()).set(requestId, { resolve, reject });
        });
        this._notifyLiveStateChanged();
        this._events.emit('___callback.request', { args, funcId, requestId, durable: durable || undefined });
        return promise;
    }

    private _releaseOwnedFunctionId(funcId: string): void {
        const func = this._functions?.get(funcId);
        if (func === undefined) return;

        const entry = this._functionEntries?.get(func);
        this._functionEntries?.delete(func);
        this._functions!.delete(funcId);
        if (this._functions!.size === 0) this._functions = undefined;
        try {
            entry?.releaseHandler?.();
        } catch { }
        this._notifyLiveStateChanged();
    }

    finalizeReceivedFunction(funcId: string, token: object): void {
        const entry = this._receivedFunctions?.get(funcId);
        if (entry?.token !== token) return;

        const func = entry.ref.deref();
        if (func !== undefined) this._receivedFunctionEntries?.delete(func);
        this._receivedFunctions!.delete(funcId);
        if (this._receivedFunctions!.size === 0) {
            this._receivedFunctions = undefined;
            this._receivedFunctionEntries = undefined;
        }
        if (!this._released) {
            this._events.emit('___callback.release', entry.lease > 0 ? { funcId, lease: entry.lease } : { funcId });
            this._notifyLiveStateChanged();
        }
    }

    releaseAll(): void {
        if (this._released) return;
        this._released = true;

        this._events.off('___callback.request', this._onCallbackRequest);
        this._events.off('___callback.response', this._onCallbackResponse);
        this._events.off('___callback.release', this._onCallbackRelease);
        this._events.off('___request.sendFailed', this._onTransportSendFailed);
        this._events.off('___request.eventDelivered', this._onEventDelivered);

        for (const funcId of [...this._functions?.keys() ?? []]) {
            this._releaseOwnedFunctionId(funcId);
        }

        for (const entry of this._receivedFunctions?.values() ?? []) {
            receivedCallbackFinalizers?.unregister(entry.token);
        }
        this._receivedFunctions?.clear();
        this._receivedFunctions = undefined;
        this._receivedFunctionEntries = undefined;

        const error = new PerfectWSError('Callback channel released', 'callbackReleased');
        for (const request of this._activeRequests?.values() ?? []) {
            request.reject(error);
        }
        this._activeRequests?.clear();
        this._activeRequests = undefined;
        this._incomingRequestResults.clear();
    }

    deserialize(data: any) {
        return transformReceivedDeserializeType(data, 'callback', found => {
            const funcId = found.funcId as string;
            const owned = this._functions?.get(funcId);
            if (owned !== undefined) return owned;

            const existing = this._receivedFunctions?.get(funcId)?.ref.deref();
            if (existing !== undefined) {
                const entry = this._receivedFunctions!.get(funcId)!;
                entry.lease = Math.max(entry.lease, validLease(found.lease));
                return existing;
            }

            const func = (...args: any[]) => {
                return this._invokeReceived(funcId, args, false);
            };

            Object.defineProperty(func, 'name', { value: found.funcName });

            const token = {};
            const lease = validLease(found.lease);
            (this._receivedFunctions ??= new Map()).set(funcId, { ref: new WeakRef(func), token, lease });
            (this._receivedFunctionEntries ??= new WeakMap()).set(func, { funcId, token });
            receivedCallbackFinalizers?.register(func, { owner: this, funcId, token }, token);
            this._notifyLiveStateChanged();
            return func;
        }, this._maxDepth, found => typeof found.funcId === 'string');
    }

    serialize(pureValueClone: PureValueClone, transaction?: SerializationTransaction) {
        return transformSendRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            transformData: (data) => this._serializeFunction(data, transaction),
            processingDataType: (data) => typeof data === 'object' && data !== null || typeof data === 'function'
        });
    }

    private _serializeFunction(func: any, transaction?: SerializationTransaction) {
        if (typeof func !== 'function') {
            return null;
        }

        const received = this._receivedFunctionEntries?.get(func);
        if (received !== undefined) {
            const lease = this._receivedFunctions!.get(received.funcId)!.lease;
            return createTransformMarker('callback', lease > 0
                ? { funcId: received.funcId, funcName: func.name, lease }
                : { funcId: received.funcId, funcName: func.name });
        }

        const entries = this._functionEntries ??= new WeakMap();
        const entry = entries.get(func);
        let funcId = entry?.funcId;
        if (funcId === undefined) {
            funcId = randomUUID();
            if (entry) entry.funcId = funcId;
            else entries.set(func, { funcId });
            (this._functions ??= new Map()).set(funcId, func);
            this._notifyLiveStateChanged();
        }

        const registeredEntry = entries.get(func)!;
        const lease = (registeredEntry.lease ?? 0) + 1;
        registeredEntry.lease = lease;
        if (transaction) {
            const pendingLeases = registeredEntry.pendingLeases ??= new Map();
            const firstRegistration = !pendingLeases.has(transaction);
            pendingLeases.set(transaction, lease);
            if (firstRegistration) {
                transaction.add({
                    commit: () => {
                        const current = this._functionEntries?.get(func);
                        if (current?.funcId !== funcId) return;
                        const committedLease = current.pendingLeases!.get(transaction)!;
                        current.pendingLeases?.delete(transaction);
                        current.committedLease = Math.max(current.committedLease ?? 0, committedLease);
                    },
                    rollback: () => {
                        const current = this._functionEntries?.get(func);
                        if (current?.funcId !== funcId) return;
                        current.pendingLeases?.delete(transaction);
                        const pending = [...current.pendingLeases?.values() ?? []];
                        current.lease = Math.max(current.committedLease ?? 0, ...pending);
                        if ((current.pendingReleaseLease ?? -1) >= current.lease && current.lease > 0) {
                            this._releaseOwnedFunctionId(funcId!);
                        }
                    },
                });
            }
        } else {
            registeredEntry.committedLease = lease;
        }
        if (transaction && !registeredEntry.committed) {
            const pending = registeredEntry.pendingTransactions ??= new Set();
            if (!pending.has(transaction)) {
                pending.add(transaction);
                transaction.add({
                    commit: () => {
                        const current = this._functionEntries?.get(func);
                        if (current?.funcId !== funcId) return;
                        current.committed = true;
                        current.pendingTransactions = undefined;
                    },
                    rollback: () => {
                        const current = this._functionEntries?.get(func);
                        if (current?.funcId !== funcId || current.committed) return;
                        current.pendingTransactions?.delete(transaction);
                        if (!current.pendingTransactions?.size) {
                            current.pendingTransactions = undefined;
                            this._releaseOwnedFunctionId(funcId!);
                        }
                    },
                });
            }
        } else if (!transaction) {
            registeredEntry.committed = true;
            registeredEntry.pendingTransactions = undefined;
        }

        return createTransformMarker('callback', { funcId, funcName: func.name, lease });
    }
}

function hasRequestId(message: unknown): message is { requestId: string; data?: any; error?: any; } {
    return typeof message === 'object'
        && message !== null
        && typeof (message as { requestId?: unknown; }).requestId === 'string';
}

function isCallbackRequest(message: unknown): message is { args: any[]; funcId: string; requestId: string; durable?: boolean; } {
    if (!hasRequestId(message)) return false;
    const request = message as { args?: unknown; funcId?: unknown; durable?: unknown; };
    return Array.isArray(request.args)
        && typeof request.funcId === 'string'
        && (request.durable === undefined || typeof request.durable === 'boolean');
}

function isCallbackRelease(message: unknown): message is { funcId: string; lease?: number; } {
    return typeof message === 'object'
        && message !== null
        && typeof (message as { funcId?: unknown; }).funcId === 'string'
        && ((message as { lease?: unknown; }).lease === undefined || Number.isSafeInteger((message as { lease?: number; }).lease) && (message as { lease: number; }).lease >= 0);
}

function validLease(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
