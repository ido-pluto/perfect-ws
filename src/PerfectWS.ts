import { BSON } from 'bson';
import { NetworkEventListener } from './utils/NetworkEventListener.js';
import { MessageEvent, WebSocketForce, WSLike } from './utils/WebSocketForce.js';
import { PerfectWSError } from './PerfectWSError.js';
import { PerfectWSSubRoute } from './PerfectWSSubRoute.js';
import { sleep } from './utils/sleepPromise.js';
import { randomUUID } from './utils/randomUUID.js';
import { errorCode, errorMessage } from './utils/errorMessage.js';
import { isRequestDataReplacement, type WSDataMiddleware } from './middleware/dataMiddleware.js';
import { isFinitePositiveTimeout, isValidRequestTimeout, setLongTimeout } from './utils/setLongTimeout.js';
import {
    CAPACITY_EXEMPT_METHODS,
    INTERNAL_EVENTS,
    NOOP_REQUEST_CALLBACK,
    isDurableControlEvent,
    operationFailure,
    operationIdentity,
} from './utils/requestProtocol.js';

export type WSErrorShape = { message: string; code: string; };
type WSRequestOptionsCallback<Response = any> = (data: Response | null, error: WSErrorShape | null, down: boolean) => void;

export type WSListenCallbackSend = (data: any, down?: boolean, allowPackageLoss?: boolean) => void | Promise<void>;
export type WSCallbackOptions = {
    send: WSListenCallbackSend,
    reject: (reason: string, code: string) => void,
    events: NetworkEventListener;
    abortSignal: AbortSignal;
    ws: WebSocketForce & { [key: string]: any; };
    requestId: string;
    clientId: string;
};
export type WSListenCallback<Params = any, Response = any> = (params: Params, options: WSCallbackOptions) => Promise<Response> | Response;

export type WSRequestOptions<Response = any, WSType extends WSLike = WSLike> = {
    callback?: WSRequestOptionsCallback<Response>;
    events?: NetworkEventListener;
    abortSignal?: AbortSignal;
    requestId?: string;
    /** Maximum request duration in milliseconds. Defaults to config.requestTimeout; 0 or Infinity disables it. */
    timeout?: number;
    doNotWaitForConnection?: boolean;
    /**@internal */
    useServer?: WebSocketForce<WSType>;
};

export type WSClientOptions = {
    /**
     * If true, unknown responses will be ignored and not aborted, and will not sync request when server is opened
     */
    temp?: boolean;
    /**
     * If true, disables ping timeouts and ack system (when the debugger is paused, pings and acks may timeout)
     */
    debugging?: boolean;

    /**
     * Stable logical id for reconnects of this in-memory router. Reusing it in a new process does not restore prior state.
     */
    clientId?: string;
};

type ActiveRequest = {
    finished?: boolean;
    requestId: string,
    updateTime: number,
    events: NetworkEventListener,
    server?: WebSocketForce<WSLike>,
    callback: WSRequestOptionsCallback;
    doNotWaitForConnection?: boolean;
    abortController: AbortController;
    hasSent?: boolean;
    deliveryConfirmed?: boolean;
    timeout: number;
    release: (error?: { message: string; code: string; }) => void;
    replay?: (server?: WebSocketForce<WSLike>) => Promise<void>;
    internal: boolean;
    method: string;
};

type ListenForRequest = {
    method: string,
    callbacks: WSListenCallback[];
    middleware?: () => WSListenCallback[];
    owner?: object;
};

type ActiveResponse = {
    requestId: string;
    events: NetworkEventListener;
    clientRef: { ref: WebSocketForce<WSLike> & { [key: string]: any; } | null };
    clientId: string;
    /** True after the final response, even if its event channel remains active. */
    responseEnded: boolean;
    detachClient: () => void;
    release: (force?: boolean) => void;
    sendChannelError?: (error: WSErrorShape) => Promise<boolean | undefined>;
    internal: boolean;
    method: string;
};

type PreparedRequestData = {
    data: any;
    hasLiveResources?: boolean;
    commit: () => void;
    rollback: () => void;
};

export type WSClientResult<WSType extends WSLike = WSLike, Router extends PerfectWS<WSType> = PerfectWS<WSType>> = {
    router: Router;
    setServer: (socket: WSType | WebSocketForce<WSType>) => void;
    unregister: () => void;
    /** @internal Transfers an authenticated socket without closing it. */
    detachServer: () => void;
};

export type WSServerResult<WSType extends WSLike = WSLike, Router extends PerfectWS<WSType> = PerfectWS<WSType>> = {
    router: Router;
    attachClient: (socket: WSType | WSLike) => () => void;
    autoReconnect: (url: string, webSocketConstructor?: new (url: string) => WSType) => () => void;
    unregister: () => void;
};

export type PerfectWSConfig = {
    connectionTimeout: number;
    reconnectTimeout: number;
    clearOldRequestsDelay: number;
    requestTimeout: number;
    syncRequestsTimeout: number;
    maxListeners: number;
    pingRequestTimeout: number;
    pingIntervalMs: number;
    pingReceiveTimeout: number;
    delayBeforeReconnect: number;
    sendRequestRetries: number;
    verbose: boolean;
    maxTransformDepth: number;
    fullTrustedRPC: boolean;
    syncRequestsWhenServerOpen: boolean;
    abortUnknownResponses: boolean;
    runPingLoop: boolean;
    enableAckSystem: boolean;
    ackTimeout: number;
    ackRetryDelays: number[];
    processedPacketsCleanupInterval: number;
    maxProcessedPackets: number;
    maxTotalProcessedPackets: number;
    maxProcessedPacketClients: number;
    maxPendingAcks: number;
    maxTotalPendingAcks: number;
    maxPendingAcksKept: number;
    maxPendingAborts: number;
    maxTotalPendingAborts: number;
    pendingAbortsMinAge: number;
    maxActiveRequests: number;
    maxInternalRequests: number;
    maxMessageSize: number;
    maxPureRPCHandles: number;
    maxRPCOperations: number;
    autoWrapUnknownClasses: boolean;
    maxGlobalSymbols: number;
    processedPacketsRetention: number;
    clientId?: string;
};

export class PerfectWS<WSType extends WSLike = WSLike, ExtraConfig = { [key: string]: any; }> {
    public config = {
        connectionTimeout: 1000 * 3,
        reconnectTimeout: 1000 * 60,
        clearOldRequestsDelay: 1000 * 10,
        requestTimeout: 1000 * 60 * 15,
        syncRequestsTimeout: 1000 * 5,
        maxListeners: 1000,
        pingRequestTimeout: 1000 * 5,
        pingIntervalMs: 1000 * 5,
        pingReceiveTimeout: 1000 * 10,
        delayBeforeReconnect: 1000 * 3,
        sendRequestRetries: 2,
        verbose: false,
        maxTransformDepth: 100,
        fullTrustedRPC: false,
        syncRequestsWhenServerOpen: true,
        abortUnknownResponses: true,
        runPingLoop: true,
        enableAckSystem: true,
        ackTimeout: 1000,
        ackRetryDelays: [3000, 5000],
        processedPacketsCleanupInterval: 1000 * 60,
        maxProcessedPackets: 1000,
        maxTotalProcessedPackets: 10000,
        maxProcessedPacketClients: 1000,
        maxPendingAcks: 100,
        maxTotalPendingAcks: 1000,
        maxPendingAcksKept: 50,
        maxPendingAborts: 1000,
        maxTotalPendingAborts: 10000,
        pendingAbortsMinAge: 3000,
        maxActiveRequests: 10000,
        maxInternalRequests: 3,
        maxMessageSize: Infinity,
        maxPureRPCHandles: 10_000,
        maxRPCOperations: 10_000,
        autoWrapUnknownClasses: false,
        maxGlobalSymbols: 10_000,
        processedPacketsRetention: 1000 * 60,
    } as PerfectWSConfig & ExtraConfig;

    private _server?: WebSocketForce<WSLike>;
    private _serverReady = false;
    private _unregisterServer?: () => void;
    private _isClient?: boolean;
    private _listenForRequests: Map<string, ListenForRequest> = new Map();
    private _activeRequests: Map<string, ActiveRequest> = new Map();
    private _activeResponses: Map<string, ActiveResponse> = new Map();
    private _waitForNewServer = new Set<(error?: PerfectWSError) => void>();
    private _clearOldRequestActive = false;
    private _lastPingTimes = new WeakMap<WebSocketForce<WSLike>, number>();
    private _pendingAborts = new Map<string, { clientId: string; requestId: string; timestamp: number; }>();
    private _addMiddlewareForNewRequests: WSListenCallback[] = [];
    private _pendingAcks: Map<string, { resolve: () => void, reject: (reason: string) => void; server?: WebSocketForce<WSLike>; }> = new Map();
    private _processedPackets: Map<string, number> = new Map();
    private _processedPacketsByClient = new Map<string, Map<string, number>>();
    private _processedPacketsByClientCount = 0;
    private _ackCleanupAbortController?: AbortController;
    private _requestCleanupAbortController = new AbortController();
    private _unregistered = false;

    get isServerConnected() {
        return this._server?.readyState == WebSocketForce.OPEN;
    }

    get bufferedAmount() {
        return this._server?.bufferedAmount || 0;
    }

    get serverOpen() {
        if (this._unregistered) {
            return Promise.reject(new PerfectWSError('Router unregistered', 'unregistered'));
        }
        if (this._serverReady && this.isServerConnected) return Promise.resolve(true);
        return new Promise<true>((resolve, reject) => {
            this._waitForNewServer.add(error => error ? reject(error) : resolve(true));
        });
    }

    protected constructor() {
        this.__initPrivateMethods();
    }

    private async _syncRequests(useServer?: WebSocketForce<WSType>) {
        if (!this._isClient) {
            throw new PerfectWSError('This is a server instance, you can only use "syncRequests" method on client instance', 'invalidInstance');
        }

        const activeRequestsIds: string[] = [];
        for (const [id, request] of this._activeRequests.entries()) {
            if (request.hasSent) {
                activeRequestsIds.push(id);
            }
        }

        if (this.config.verbose) {
            console.log('[PerfectWS] _syncRequests: activeRequestsIds=', activeRequestsIds);
        }

        const unknownActiveRequestsIds = await this.request("___syncRequests", { activeRequestsIds, clientId: this.config.clientId }, { doNotWaitForConnection: true, timeout: this.config.syncRequestsTimeout, useServer });
        if (this.config.verbose) {
            console.log('[PerfectWS] _syncRequests: unknownActiveRequestsIds=', unknownActiveRequestsIds);
        }
        for (const requestId of unknownActiveRequestsIds) {
            const request = this._activeRequests.get(requestId);
            if (!request) continue;
            if (this.config.verbose) {
                console.log('[PerfectWS] _syncRequests: calling callback for requestId=', requestId);
            }
            if (!request.deliveryConfirmed && request.replay) {
                await request.replay(useServer);
            } else {
                request.release({ message: 'Unknown request', code: 'unknownRequest' });
            }
        }
    }

    syncRequests() {
        return this._syncRequests();
    }

    private async hasRequest(requestId: string) {
        if (!this._isClient) {
            return [...this._activeResponses].some(([mapKey, response]) => (response.requestId ?? mapKey) === requestId);
        }

        return await this.request("___hasRequest", { requestId }, { doNotWaitForConnection: true, timeout: this.config.syncRequestsTimeout });
    }

    private async _ping(useServer?: WebSocketForce<WSType>) {
        return await this.request("___ping", null, { doNotWaitForConnection: true, timeout: this.config.pingRequestTimeout, useServer });
    }

    private __initPrivateMethods() {
        this.on("___syncRequests", ({ activeRequestsIds }: { activeRequestsIds: string[]; }, { requestId: currentRequestId, ws, clientId }) => {
            const activeResponses = Array.from(this._activeResponses.entries()).filter(([_, response]) => response.clientId === clientId);
            if (this.config.verbose) {
                console.log('[PerfectWS] ___syncRequests: activeResponses=', activeResponses);
            }

            for (const [mapKey, response] of activeResponses) {
                const requestId = response.requestId ?? mapKey;
                // Don't abort the current request we're processing
                if (requestId === currentRequestId) continue;

                if (!activeRequestsIds.includes(requestId)) {
                    if (response.responseEnded) {
                        response.release(true);
                    } else {
                        response.events._emitWithSource('___abort', 'remote', 'Unknown request');
                    }
                    continue;
                }

                if (response.clientRef.ref !== ws) {
                    this._connectWSToOnRequestResponse(response, ws);
                }
            }

            const activeResponseIds = activeResponses.map(([mapKey, response]) => response.requestId ?? mapKey);
            const unknownActiveRequestsIds = activeRequestsIds.filter(x => !activeResponseIds.includes(x));
            if (this.config.verbose) {
                console.log('[PerfectWS] ___syncRequests: unknownActiveRequestsIds=', unknownActiveRequestsIds);
            }
            return unknownActiveRequestsIds;
        });

        this.on("___hasRequest", ({ requestId }: { requestId: string; }, { clientId }) => {
            return this._getActiveResponse(clientId, requestId) !== undefined;
        });

        this.on("___ping", (_data, { ws }) => {
            this._lastPingTimes.set(ws, Date.now());
            return "pong";
        });

    }

    private _setServer(originalServer: WebSocketForce<WSType> | WSType) {
        if (this._unregistered) {
            throw new PerfectWSError('Router unregistered', 'unregistered');
        }
        this._unregisterServer?.();

        this._ackCleanupAbortController?.abort('New server set');

        const server = originalServer instanceof WebSocketForce ? originalServer : new WebSocketForce(originalServer);

        try {
            this._server?.forceClose?.();
        } catch { }

        server.setMaxListeners(this.config.maxListeners);
        server.binaryType = 'arraybuffer';
        this._server = server;
        this._serverReady = false;

        const pingLoopAbortController = new AbortController();

        const ackCleanupAbortController = new AbortController();
        this._ackCleanupAbortController = ackCleanupAbortController;
        this._startAckCleanupLoop(ackCleanupAbortController);

        const onMessage = ({ data }: MessageEvent) => {
            const parsedData = this.deserialize(data);
            if (parsedData === null) {
                // Corrupted data - ignore
                return;
            }
            data = null;
            this._onServerResponse(parsedData, server);
        };

        const onOpen = async () => {
            if (this.config.syncRequestsWhenServerOpen) {
                try {
                    await this._syncRequests(server);
                } catch {
                    server.forceClose();
                    return;
                }
            }

            if (this._server !== server || server.readyState !== WebSocketForce.OPEN) return;
            this._serverReady = true;
            this._resolveWaitForServer();

            if (!this.config.runPingLoop) return;

            while (server.readyState == WebSocketForce.OPEN && !pingLoopAbortController.signal.aborted) {
                try {
                    if (this.config.verbose) console.log('[PerfectWS] Sending ping');
                    await this._ping(server);
                    if (this.config.verbose) console.log('[PerfectWS] Ping received');
                    await sleep(this.config.pingIntervalMs, pingLoopAbortController.signal);
                } catch {
                    if (pingLoopAbortController.signal.aborted) break;
                    if (this.config.verbose) console.log('[PerfectWS] Ping failed, force closing socket');
                    server.forceClose();
                    break;
                }
            }
        };

        const onClose = () => {
            if (this._server === server) this._serverReady = false;
        };

        server.addEventListener('message', onMessage);
        server.addEventListener('close', onClose);

        if (server.readyState == WebSocketForce.OPEN) {
            onOpen();
        } else {
            server.addEventListener('open', onOpen);
        }

        this._unregisterServer = () => {
            pingLoopAbortController.abort('Server unregistered');
            ackCleanupAbortController.abort('Server unregistered');
            server.removeEventListener('message', onMessage);
            server.removeEventListener('open', onOpen);
            server.removeEventListener('close', onClose);
            if (this._server === server) this._serverReady = false;
        };
    }

    async request<Response = any>(method: string, data?: any, options: WSRequestOptions<Response, WSType> = {}): Promise<Response> {
        if (this.config.verbose) console.log('[PerfectWS] Request: method=', method, 'data=', data);

        if (this._unregistered) {
            throw new PerfectWSError('Router unregistered', 'unregistered');
        }

        const requestTimeout = options.timeout === undefined ? this.config.requestTimeout : options.timeout;
        if (!isValidRequestTimeout(requestTimeout)) {
            throw new PerfectWSError('Request timeout must be 0, a positive finite number, or Infinity', 'invalidTimeout');
        }

        const requestId = options.requestId || (method + randomUUID());

        const deferred = Promise.withResolvers<Response>();
        const promise = deferred.promise;
        let settlement: Pick<typeof deferred, 'resolve' | 'reject'> | undefined = deferred;

        const abortController = new AbortController();
        const onUserAbort = (event: Event) => {
            abortController.abort(options.abortSignal?.reason || 'Request aborted by user');
            event.preventDefault();
        };
        options.abortSignal?.addEventListener('abort', onUserAbort);
        const removeUserAbortListener = () => options.abortSignal?.removeEventListener('abort', onUserAbort);
        void promise.then(removeUserAbortListener, removeUserAbortListener);

        const events = options.events ?? new NetworkEventListener();
        let hasSetRequest = false;
        let released = false;
        let channelWasKeptAlive = false;
        let pendingDurableSends = 0;
        let deferredReleaseError: { message: string; code: string; } | undefined;
        let releaseRequested = false;
        let releaseEventEmitted = false;
        let initialContent: any = { data: undefined };
        let relayLocalEvent: ((source: string, eventName: string, ...args: any[]) => void) | undefined;
        let retryOnClose: (() => Promise<void>) | undefined;
        const onResourcesChanged = () => {
            if (activeRequest.finished && pendingDurableSends === 0 && !this.shouldKeepResponseAlive(events)) {
                releaseRequest();
            }
        };
        const releaseRequest = (releaseError?: { message: string; code: string; }) => {
            if (released) return;
            if (releaseError !== undefined && !activeRequest.finished) {
                activeRequest.callback(null, releaseError, true);
                return;
            }
            if (!this._unregistered) {
                releaseRequested = true;
                deferredReleaseError ??= releaseError;
                if (channelWasKeptAlive && !releaseEventEmitted) {
                    releaseEventEmitted = true;
                    events.emit('___request.release');
                }
                if (pendingDurableSends > 0) return;
            }
            events.off('___request.resourcesChanged', onResourcesChanged);
            if (retryOnClose) activeRequest.server?.removeEventListener('close', retryOnClose);
            if (relayLocalEvent) events.offAny(relayLocalEvent);
            released = true;
            if (!abortController.signal.aborted) abortController.abort('Request released');
            this.releaseRequestResources(events);
            if (hasSetRequest && this._activeRequests.get(requestId) === activeRequest) {
                this._activeRequests.delete(requestId);
            }
            activeRequest.server = undefined;
        };
        const thisStackTrace = new Error().stack;
        const activeRequest: ActiveRequest = {
            requestId,
            events,
            updateTime: Date.now(),
            server: options.useServer ?? this._server!,
            doNotWaitForConnection: options.doNotWaitForConnection,
            abortController,
            timeout: requestTimeout,
            internal: CAPACITY_EXEMPT_METHODS.has(method),
            method,
            release: releaseRequest,
            callback: (data, error, down) => {
                if (activeRequest.finished) return;

                activeRequest.updateTime = Date.now();
                try {
                    options.callback?.(data, error ?? null, down === true);
                } catch (callbackError) {
                    if (this.config.verbose) {
                        console.error('[PerfectWS] Request callback threw:', callbackError);
                    }
                }
                if (down) {
                    activeRequest.finished = true;
                    activeRequest.deliveryConfirmed = true;
                    activeRequest.replay = undefined;
                    initialContent.data = undefined;
                    events.emit('___request.finished', { data, error, requestId });
                    abortController.signal.removeEventListener('abort', onRequestAbort);

                    if (error != null) {
                        channelWasKeptAlive = this.shouldKeepResponseAlive(events);
                        const currentSettlement = settlement;
                        settlement = undefined;
                        releaseRequest();
                        const errorInfo = new PerfectWSError(error.message, error.code, requestId);
                        errorInfo.stack = thisStackTrace;
                        currentSettlement?.reject(errorInfo);
                    } else {
                        const keepAlive = this.shouldKeepResponseAlive(events);
                        channelWasKeptAlive = keepAlive;
                        const currentSettlement = settlement;
                        settlement = undefined;

                        // The live channel must not retain the fulfilled response.
                        activeRequest.callback = NOOP_REQUEST_CALLBACK;
                        if (!keepAlive) {
                            releaseRequest();
                        }
                        currentSettlement?.resolve(data);
                    }
                }
            }
        };

        const onRequestAbort = (event: Event) => {
            const hasRequest = this._activeRequests.has(requestId);
            if (hasRequest && !activeRequest.finished) {
                if (this.config.verbose) {
                    console.warn(`[PerfectWS] Request aborted: method=${ method } requestId=${ requestId } hasRequest=${ hasRequest } reason=${ abortController.signal.reason }`);
                }

                const reason = abortController.signal.reason;
                if (activeRequest.hasSent) {
                    events.emit('___abort', reason || 'Client aborted');
                }
                activeRequest.callback(null, { message: reason, code: 'abort' }, true);
            }

            event.preventDefault();
        };
        abortController.signal.addEventListener('abort', onRequestAbort);
        events.on('___request.resourcesChanged', onResourcesChanged);

        if (!this._isClient) {
            activeRequest.callback(null!, { message: 'This is a server instance, you can only use "request" method on client instance', code: 'invalidInstance' }, true);
            return await promise;
        }

        if (options.abortSignal?.aborted) {
            activeRequest.callback(null!, { message: 'Request aborted by user', code: 'abort' }, true);
            return await promise;
        }

        if (this._activeRequests.has(requestId)) {
            activeRequest.callback(null!, { message: 'Request already exists', code: 'requestAlreadyExists' }, true);
            return await promise;
        }

        const internalRequest = CAPACITY_EXEMPT_METHODS.has(method);
        const activeOfKind = [...this._activeRequests.values()].filter(request => internalRequest
            ? request.internal && request.method === method
            : !request.internal).length;
        const requestLimit = internalRequest ? this.config.maxInternalRequests : this.config.maxActiveRequests;
        if (activeOfKind >= requestLimit) {
            activeRequest.callback(null!, { message: 'Too many active requests', code: 'tooManyRequests' }, true);
            return await promise;
        }

        this._activeRequests.set(requestId, activeRequest);
        hasSetRequest = true;
        this._clearOldRequests();

        if (isFinitePositiveTimeout(requestTimeout)) {
            const clearRequestTimeout = setLongTimeout(() => {
                if (activeRequest.finished || abortController.signal.aborted) return;

                if (activeRequest.hasSent) {
                    if (this._activeRequests.has(requestId)) {
                        events.emit('___abort', 'Request timeout');
                        activeRequest.callback(null, { message: 'Request timeout', code: 'timeout' }, true);
                    }
                } else {
                    activeRequest.callback(null, { message: 'Request connecting timeout', code: 'timeout' }, true);
                }
            }, requestTimeout);
            void promise.then(clearRequestTimeout, clearRequestTimeout);
        }

        const waitForServer = (firstTime = true, ignoreAbort = false, operationSignal?: AbortSignal) => new Promise<void>((resolve, reject) => {
            const replacementIsReady = activeRequest.server != this._server
                && this._serverReady
                && this.isServerConnected;
            if (replacementIsReady || released || operationSignal?.aborted || !ignoreAbort && abortController.signal.aborted) {
                resolve();
                return;
            }

            let settled = false;
            let cleanup: () => void;

            const settleResolve = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };

            const settleReject = (reason?: any) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(reason);
            };

            const onServer = () => settleResolve();
            const onAbort = (e: any) => settleReject(e);
            const onOperationSettled = () => settleResolve();
            const onFinished = () => settleResolve();
            const onTimeout = () => settleReject({ message: 'Server not connected', code: 'serverClosed' });
            let timeout: ReturnType<typeof setTimeout>;

            cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                this._waitForNewServer.delete(onServer);
                abortController.signal.removeEventListener('abort', onAbort);
                operationSignal?.removeEventListener('abort', onOperationSettled);
                events.off('___request.finished', onFinished);
            };

            this._waitForNewServer.add(onServer);
            if (!ignoreAbort) abortController.signal.addEventListener('abort', onAbort);
            operationSignal?.addEventListener('abort', onOperationSettled, { once: true });
            events.on('___request.finished', onFinished);

            if (!firstTime) {
                timeout = setTimeout(onTimeout, this.config.reconnectTimeout);
            }
        });


        if (activeRequest.server?.readyState !== WebSocketForce.OPEN) {
            if (this.config.verbose) {
                console.log(`[PerfectWS] Server not connected, waiting for connection, method=${ method } requestId=${ requestId }`);
            }

            if (options.doNotWaitForConnection) {
                const error = { message: 'Server not connected', code: 'serverClosed' };
                activeRequest.callback(null, error, true);
                return promise;
            }

            try {
                await waitForServer();
            } catch {
                return await promise;
            }
            if (activeRequest.finished || released || abortController.signal.aborted) {
                return await promise;
            }
            activeRequest.server = this._server!;
        }

        const failSend = (content: any, cause?: unknown) => {
            if (released) return;
            const failure = cause instanceof PerfectWSError
                ? { message: cause.message, code: cause.code ?? 'sendFailed' }
                : { message: activeRequest.finished ? 'Failed to send request event' : 'Failed to send request', code: 'sendFailed' };
            if (activeRequest.finished) {
                // Reject this operation without destroying a resumable channel.
                events.emit('___request.sendFailed', operationFailure(content, failure.message, failure.code));
            } else {
                activeRequest.callback(null, failure, true);
            }
        };

        const sendRequestRetry = async (content: any) => {
            if (released) return;
            const durable = isDurableControlEvent(content);
            const operationEventName = content.event?.eventName;
            const operation = content.event?.args?.[0];
            const operationId = operation?.callId ?? operation?.requestId;
            const tracksOperation = (operationEventName === '___callback.request'
                || operationEventName === '___pureRPC.request' && operation?.op !== 'release')
                && typeof operationId === 'string';
            const operationController = tracksOperation ? new AbortController() : undefined;
            const onOperationSettled = (_source: string, settled: { eventName?: string; operationId?: string; }) => {
                if (settled?.eventName === operationEventName && settled.operationId === operationId) {
                    operationController?.abort();
                }
            };
            if (operationController) events.on('___request.operationSettled', onOperationSettled);
            content.packetId ??= randomUUID();
            let rollbackPrepared = () => { };

            try {
                const prepared = this.prepareRequestData(content.event ? content.event.args : content.data, events);
                rollbackPrepared = prepared.rollback;
                const serializeData = { ...content, clientId: this.config.clientId };
                if (content.event) {
                    serializeData.event = {
                        ...content.event,
                        args: prepared.data
                    };
                } else {
                    serializeData.data = prepared.data;
                }

                const maxSendAttempts = Math.max(1, Math.floor(this.config.sendRequestRetries));
                for (let i = 0; !released && !operationController?.signal.aborted && i < maxSendAttempts; i++) {
                    if (await this._sendWithAck(serializeData, activeRequest.server, false, () => {
                        prepared.commit();
                        activeRequest.hasSent = true;
                    }, operationController?.signal ?? (durable ? undefined : abortController.signal), durable || prepared.hasLiveResources,
                        content.event ? () => events.emit('___request.eventDelivered', operationIdentity(content)) : undefined)) {
                        if (!content.event) activeRequest.deliveryConfirmed = true;
                        return;
                    }

                    if (released || operationController?.signal.aborted) return;

                    const disconnected = activeRequest.server?.readyState != WebSocketForce.OPEN;
                    if ((disconnected || durable && i === maxSendAttempts - 1)
                        && (!activeRequest.doNotWaitForConnection || activeRequest.finished || content.event)) {
                        if (!disconnected) activeRequest.server?.forceClose();
                        events.emit('___request.disconnected', { ws: activeRequest.server });
                        try {
                            await waitForServer(durable, durable, operationController?.signal);
                        } catch {
                            failSend(content);
                            return;
                        }
                        if (released || operationController?.signal.aborted || !durable && abortController.signal.aborted) {
                            return;
                        }
                        activeRequest.server = this._server!;
                        events.emit('___request.connected', { ws: activeRequest.server });
                        i = -1;
                        continue;
                    }
                }

                failSend(content);
            } catch (serializationError) {
                const eventName = content.event?.eventName;
                const message = content.event?.args?.[0];
                let fallbackMessage: any;

                if (eventName === '___pureRPC.response' && typeof message?.callId === 'string') {
                    fallbackMessage = { callId: message.callId, error: errorMessage(serializationError) };
                } else if (eventName === '___callback.response' && typeof message?.requestId === 'string') {
                    fallbackMessage = {
                        requestId: message.requestId,
                        error: errorMessage(serializationError),
                        durable: message.durable
                    };
                }

                if (fallbackMessage !== undefined) {
                    const fallbackContent = {
                        ...content,
                        clientId: this.config.clientId,
                        event: { eventName, args: [fallbackMessage] }
                    };
                    const sent = await this._sendWithAck(fallbackContent, activeRequest.server, false, undefined,
                        undefined, true,
                        () => events.emit('___request.eventDelivered', operationIdentity(fallbackContent)));
                    if (!sent) failSend(content);
                } else if (eventName === '___pureRPC.request' && typeof message?.callId === 'string' && message.op !== 'release') {
                    events._emitWithSource('___pureRPC.response', 'remote', {
                        callId: message.callId,
                        error: errorMessage(serializationError)
                    });
                } else if (eventName === '___callback.request' && typeof message?.requestId === 'string') {
                    events._emitWithSource('___callback.response', 'remote', {
                        requestId: message.requestId,
                        error: errorMessage(serializationError)
                    });
                } else {
                    failSend(content, serializationError);
                }
            } finally {
                if (operationController) events.off('___request.operationSettled', onOperationSettled);
                rollbackPrepared();
            }
        };

        relayLocalEvent = (source, eventName, ...args) => {
            if (source === 'remote' || INTERNAL_EVENTS.includes(eventName)) return;
            const content = { requestId, event: { eventName, args } };
            const durable = isDurableControlEvent(content);
            if (durable) pendingDurableSends++;
            void sendRequestRetry(content).finally(() => {
                if (!durable) return;
                pendingDurableSends--;
                if (releaseRequested && pendingDurableSends === 0) {
                    releaseRequest(deferredReleaseError);
                } else {
                    onResourcesChanged();
                }
            });
        };
        events.onAny(relayLocalEvent);

        initialContent = { method, requestId, data, clientId: this.config.clientId, timeout: requestTimeout, packetId: randomUUID() };
        activeRequest.replay = async server => {
            if (activeRequest.finished || released || abortController.signal.aborted) return;
            activeRequest.server = server ?? this._server!;
            await sendRequestRetry(initialContent);
        };

        retryOnClose = async () => {
            const disconnectedServer = activeRequest.server;
            disconnectedServer?.removeEventListener('close', retryOnClose!);

            if (activeRequest.finished || abortController.signal.aborted) {
                if (activeRequest.server === disconnectedServer) activeRequest.server = undefined;
                return;
            }

            events.emit('___request.disconnected', { ws: disconnectedServer });
            if (activeRequest.doNotWaitForConnection) {
                activeRequest.callback(null, { message: 'Server closed', code: 'serverClosed' }, true);
                return;
            };

            try {
                await waitForServer(false);
                if (activeRequest.finished) {
                    return;
                }

                if (await this.hasRequest(requestId)) {
                    if (activeRequest.finished) {
                        return;
                    }

                    activeRequest.server = this._server!;
                    events.emit('___request.connected', { ws: activeRequest.server });
                    this._server!.addEventListener('close', retryOnClose!);
                } else if (!activeRequest.deliveryConfirmed) {
                    activeRequest.server = this._server!;
                    events.emit('___request.connected', { ws: activeRequest.server });
                    await sendRequestRetry(initialContent);
                    if (!activeRequest.finished && !released) {
                        activeRequest.server?.addEventListener('close', retryOnClose!);
                    }
                } else {
                    activeRequest.callback(null, { message: 'Unknown request', code: 'unknownRequest' }, true);
                }
            } catch (error) {
                activeRequest.callback(null, { message: 'Failed to check request status', code: 'reconnectFailed' }, true);
            }
        };

        // Sending and durable cleanup may legitimately wait for a reconnect long after
        // the public request has timed out. Keep that lifecycle in the background so
        // callers observe their timeout/abort settlement immediately.
        void sendRequestRetry(initialContent).then(() => {
            if (released) return;
            activeRequest.server?.addEventListener('close', retryOnClose!);
            // The socket may close after the send completes but before the close
            // listener above is attached. Treat that state exactly like a close event.
            if (!activeRequest.finished && activeRequest.server?.readyState !== WebSocketForce.OPEN) {
                void retryOnClose!();
            }
        }).catch(error => failSend(initialContent, error));
        return promise;
    }

    on<Data>(method: string, validator: WSDataMiddleware<Data>, ...callbacks: WSListenCallback<Data>[]): this;
    on(method: string, ...callbacks: WSListenCallback[]): this;
    on(method: string, ...callbacks: WSListenCallback[]): this {
        if (this._isClient) {
            throw new PerfectWSError('This is a client instance, you can only use "on" method on server instance', 'invalidInstance');
        }
        this._listenForRequests.set(method, { method, callbacks });
        return this;
    }

    off(method: string): this {
        if (this._isClient) {
            throw new PerfectWSError('This is a client instance, you can only use "off" method on server instance', 'invalidInstance');
        }
        this._listenForRequests.delete(method);
        return this;
    }

    /** @internal */
    public __registerSubRoute(
        method: string,
        callbacks: WSListenCallback[],
        middleware: () => WSListenCallback[],
        owner: object
    ): void {
        this._listenForRequests.set(method, { method, callbacks, middleware, owner });
    }

    /** @internal */
    public __unregisterSubRoute(method: string, owner: object): void {
        if (this._listenForRequests.get(method)?.owner === owner) {
            this._listenForRequests.delete(method);
        }
    }

    protected serialize(data: any) {
        return BSON.serialize(data);
    }

    protected deserialize(data: any) {
        try {
            return BSON.deserialize(data);
        } catch (error) {
            if (this.config.verbose) {
                console.log(`[PerfectWS] deserialize: BSON deserialization failed:`, error);
            }
            // Return null for corrupted data - the message handler should ignore it
            return null;
        }
    }

    protected serializeRequestData(data: any, events: NetworkEventListener) {
        return data;
    }

    protected prepareRequestData(data: any, events: NetworkEventListener): PreparedRequestData {
        return {
            data: this.serializeRequestData(data, events),
            commit: () => { },
            rollback: () => { },
        };
    }

    protected deserializeRequestData(data: any, events: NetworkEventListener) {
        return data;
    }

    /** Whether the request event channel is still needed after the final response. */
    protected shouldKeepResponseAlive(events: NetworkEventListener): boolean {
        return false;
    }

    protected releaseRequestResources(_events: NetworkEventListener): void {
    }

    private _sendJSON(data: any, server = this._server) {
        return this._sendData(this.serialize(data), server);
    }

    private _sendData(data: any, server = this._server) {
        if (server?.readyState != WebSocketForce.OPEN) {
            if (this.config.verbose) console.log(`[PerfectWS] _sendData: server not OPEN, readyState=${ server?.readyState }`);
            return false;
        }
        try {
            server.send(data);
            return true;
        } catch (error) {
            if (this.config.verbose) console.log(`[PerfectWS] _sendData: send() threw:`, error);
            return false;
        }
    }

    private async _sendWithAck(data: any, server = this._server, allowPackageLoss = false, onSent?: () => void, abortSignal?: AbortSignal, requireDelivery = false, onDelivered?: () => void): Promise<boolean> {
        if (data.method === '___ack') {
            return this._sendJSON(data, server);
        }

        if ((!this.config.enableAckSystem || allowPackageLoss) && !requireDelivery) {
            const sent = this._sendJSON(data, server);
            if (sent) {
                onSent?.();
                onDelivered?.();
            }
            return sent;
        }

        const packetId = typeof data.packetId === 'string' ? data.packetId : randomUUID();
        const dataWithPacketId = { ...data, packetId, requireAck: requireDelivery || undefined };

        let lastError = 'Unknown error';

        for (let attempt = -1; attempt < this.config.ackRetryDelays.length; attempt++) {
            const attemptLog = attempt + 2;
            if (!server || server.readyState !== WebSocketForce.OPEN) {
                lastError = 'Server not connected';
                if (this.config.verbose) console.log(`[PerfectWS] _sendWithAck: server not OPEN on attempt ${ attemptLog }`);
                return false;
            }

            if (this.config.verbose) {
                console.log(`[PerfectWS] _sendWithAck: attempt ${ attemptLog }/${ this.config.ackRetryDelays.length + 1 }, packetId=${ packetId }`);
            }

            let failedToSend = false;
            try {
                const serverPendingAcks = [...this._pendingAcks.values()]
                    .filter(pending => pending.server === server).length;
                if (serverPendingAcks >= Math.max(0, this.config.maxPendingAcks)) {
                    lastError = 'Too many pending ACKs';
                    server.forceClose(1013, 'Pending ACK capacity reached');
                    return false;
                }
                if (this._pendingAcks.size >= Math.max(0, this.config.maxTotalPendingAcks)) {
                    const counts = new Map<WebSocketForce<WSLike>, number>();
                    for (const pending of this._pendingAcks.values()) {
                        if (pending.server) counts.set(pending.server, (counts.get(pending.server) ?? 0) + 1);
                    }
                    const saturated = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
                    saturated?.forceClose(1013, 'Global pending ACK capacity reached');
                    if (this._pendingAcks.size >= Math.max(0, this.config.maxTotalPendingAcks)) {
                        lastError = 'Too many total pending ACKs';
                        return false;
                    }
                }
                const ackReceived = await new Promise<boolean>((resolve, reject) => {
                    let timeoutId: ReturnType<typeof setTimeout> | null = null;
                    let resolved = false;

                    const cleanup = () => {
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        this._pendingAcks.delete(packetId);
                        server.removeEventListener('close', onServerClose);
                        abortSignal?.removeEventListener('abort', onAbort);
                    };

                    const onServerClose = () => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolve(false);
                    };
                    const onAbort = () => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        reject(new Error('ACK wait aborted'));
                    };

                    this._pendingAcks.set(packetId, {
                        server,
                        resolve: () => {
                            if (resolved) return;
                            resolved = true;
                            cleanup();
                            try { onDelivered?.(); } catch { }
                            resolve(true);
                        },
                        reject: (reason: string) => {
                            if (resolved) return;
                            resolved = true;
                            cleanup();
                            reject(new Error(reason));
                        }
                    });
                    server.addEventListener('close', onServerClose);
                    abortSignal?.addEventListener('abort', onAbort, { once: true });

                    if (abortSignal?.aborted) {
                        onAbort();
                        return;
                    }

                    timeoutId = setTimeout(() => {
                        if (resolved) return;
                        resolved = true;
                        cleanup();
                        resolve(false);
                    }, this.config.ackRetryDelays[attempt] ?? this.config.ackTimeout);

                    const sent = this._sendJSON(dataWithPacketId, server);
                    if (sent) {
                        onSent?.();
                    } else {
                        failedToSend = true;
                        reject(new Error('Failed to send packet'));
                    }
                });

                if (ackReceived) {
                    if (this.config.verbose) console.log(`[PerfectWS] _sendWithAck: ACK received for packetId=${ packetId }`);
                    return true;
                }

                lastError = 'ACK timeout';
                if (this.config.verbose) console.log(`[PerfectWS] _sendWithAck: ACK timeout on attempt ${ attemptLog }`);
            } catch (error: any) {
                lastError = error.message || 'ACK error';
                if (this.config.verbose) console.log(`[PerfectWS] _sendWithAck: ACK error:`, error);

                if (failedToSend || abortSignal?.aborted) {
                    return false;
                }
            }
        }

        if (this.config.verbose) {
            console.log(`[PerfectWS] _sendWithAck: all retries exhausted for packetId=${ packetId }, lastError=${ lastError }`);
            console.log(`[PerfectWS] _sendWithAck: force closing server for packetId=${ packetId }, lastError=${ lastError }`);
        }

        server!.forceClose();

        return false;
    }

    private _acceptPacket(packetId: string, requestId: string, socket: WebSocketForce<WSLike>, clientId?: string): boolean {
        const processedPackets = clientId === undefined
            ? this._processedPackets
            : this._processedPacketsByClient.get(clientId) ?? new Map<string, number>();

        const oldestAllowed = Date.now() - Math.max(0, this.config.processedPacketsRetention);
        for (const [knownPacketId, timestamp] of processedPackets) {
            if (timestamp < oldestAllowed) {
                processedPackets.delete(knownPacketId);
                if (clientId !== undefined) this._processedPacketsByClientCount--;
            }
        }

        if (processedPackets.has(packetId)) {
            this._sendJSON({ requestId, method: '___ack', data: { ackFor: packetId } }, socket);
            return false;
        }

        if (processedPackets.size >= Math.max(0, this.config.maxProcessedPackets)) {
            socket.forceClose(1013, 'ACK deduplication capacity reached');
            return false;
        }
        if (clientId !== undefined && !this._processedPacketsByClient.has(clientId)
            && this._processedPacketsByClient.size >= Math.max(0, this.config.maxProcessedPacketClients)) {
            socket.forceClose(1013, 'ACK deduplication client capacity reached');
            return false;
        }
        const processedPacketCount = this._processedPackets.size + this._processedPacketsByClientCount;
        if (processedPacketCount >= Math.max(0, this.config.maxTotalProcessedPackets)) {
            socket.forceClose(1013, 'Global ACK deduplication capacity reached');
            return false;
        }

        if (clientId !== undefined && !this._processedPacketsByClient.has(clientId)) {
            this._processedPacketsByClient.set(clientId, processedPackets);
        }
        processedPackets.set(packetId, Date.now());
        if (clientId !== undefined) this._processedPacketsByClientCount++;
        this._sendJSON({ requestId, method: '___ack', data: { ackFor: packetId } }, socket);
        return true;
    }

    private _pendingAbortKey(clientId: string, requestId: string): string {
        return JSON.stringify([clientId, requestId]);
    }

    private _responseKey(clientId: string, requestId: string): string {
        return JSON.stringify([clientId, requestId]);
    }

    private _getActiveResponse(clientId: string, requestId: string): ActiveResponse | undefined {
        const direct = this._activeResponses.get(requestId);
        if (direct?.clientId === clientId) return direct;
        return this._activeResponses.get(this._responseKey(clientId, requestId));
    }

    private _setActiveResponse(response: ActiveResponse): void {
        const direct = this._activeResponses.get(response.requestId);
        if (!direct) {
            this._activeResponses.set(response.requestId, response);
            return;
        }
        if (direct.clientId === response.clientId) {
            this._activeResponses.set(response.requestId, response);
            return;
        }
        this._activeResponses.delete(response.requestId);
        this._activeResponses.set(this._responseKey(direct.clientId, direct.requestId), direct);
        this._activeResponses.set(this._responseKey(response.clientId, response.requestId), response);
    }

    private _deleteActiveResponse(response: ActiveResponse): void {
        if (this._activeResponses.get(response.requestId) === response) {
            this._activeResponses.delete(response.requestId);
        } else {
            this._activeResponses.delete(this._responseKey(response.clientId, response.requestId));
        }
    }

    private _onServerResponse(data: any, socket: WebSocketForce<WSType>) {
        const { requestId, data: responseData, error, down, event, packetId, method, requireAck } = data;

        // FIRST: Handle ACK messages - they should never trigger an ACK response
        if (method === '___ack') {
            const { ackFor } = responseData as { ackFor: string; };
            const pending = this._pendingAcks.get(ackFor);
            if (pending) {
                this._pendingAcks.delete(ackFor);
                pending.resolve();
                if (this.config.verbose) {
                    console.log(`[PerfectWS] _onServerResponse: resolved ack for packetId=${ ackFor }`);
                }
            }
            return;
        }

        // THEN: Handle ACK system for non-ACK messages
        if ((this.config.enableAckSystem || requireAck === true) && packetId) {
            if (!this._acceptPacket(packetId, requestId, socket)) {
                if (this.config.verbose) console.log(`[PerfectWS] _onServerResponse: duplicate packet ignored, packetId=${ packetId }`);
                return;
            }
        }

        const request = this._activeRequests.get(requestId);

        if (!request) {
            if (this.config.verbose) console.log('[PerfectWS] _onServerResponse: request not found, requestId=', requestId);
            if (this.config.abortUnknownResponses && !down) {
                this._sendJSON({
                    requestId,
                    clientId: this.config.clientId,
                    event: { eventName: '___abort', args: ["Unknown request"] }
                }, socket);
            }
            return;
        }

        if (this.config.verbose) console.log('[PerfectWS] _onServerResponse: request found, requestId=', requestId);

        if (event) {
            try {
                event.args = this.deserializeRequestData(event.args, request.events);
            } catch (deserializeError) {
                if (!request.finished) {
                    void this._sendWithAck({
                        requestId,
                        clientId: this.config.clientId,
                        event: { eventName: '___abort', args: ['Response event deserialization failed'] }
                    }, request.server);
                }
                request.events.emit('___request.release');
                request.release({
                    message: errorMessage(deserializeError),
                    code: 'deserializeFailed'
                });
                return;
            }
            request.updateTime = Date.now();
            try {
                request.events._emitWithSource(event.eventName, 'remote', ...event.args);
            } catch (error) {
                if (this.config.verbose) {
                    console.error(`[PerfectWS] _onServerResponse: Error in event listener for ${ event.eventName }:`, error);
                }
            }
            return;
        }

        if (request.finished && down) {
            if (data.channelError === true) {
                request.release({
                    message: typeof error?.message === 'string' ? error.message : 'Live RPC channel failed',
                    code: typeof error?.code === 'string' ? error.code : 'channelError'
                });
            }
            return;
        }

        let deserializedResponse: any;
        try {
            deserializedResponse = this.deserializeRequestData(responseData, request.events);
        } catch (deserializeError) {
            request.events.emit('___request.release');
            request.release({
                message: errorMessage(deserializeError),
                code: 'deserializeFailed'
            });
            return;
        }
        if (down) {
            request.deliveryConfirmed = true;
            request.replay = undefined;
        }
        request.callback(deserializedResponse, error, down);
    }

    private async _onRequest(clientData: any, client: WebSocketForce<WSType>): Promise<void> {
        const { method, requestId, data, event, packetId, clientId: claimedClientId, timeout: claimedRequestTimeout } = clientData;

        // FIRST: Handle ACK messages - they should never trigger an ACK response
        if (method === '___ack' && data && typeof data === 'object' && 'ackFor' in data && typeof data.ackFor === 'string') {
            const { ackFor } = data as { ackFor: string; };
            const pending = this._pendingAcks.get(ackFor);
            if (pending) {
                this._pendingAcks.delete(ackFor);
                pending.resolve();
                if (this.config.verbose) {
                    console.log(`[PerfectWS] _onRequest: resolved ack for packetId=${ ackFor }`);
                }
            }
            return;
        }

        const boundClientId = (client as WebSocketForce<WSType> & { clientId?: string; }).clientId;
        if (boundClientId !== undefined && claimedClientId !== boundClientId) {
            await this._sendWithAck({ error: { message: 'Client id does not match the authenticated socket', code: 'clientIdMismatch' }, requestId, down: true }, client);
            return;
        }
        const clientId = boundClientId ?? claimedClientId;
        if (typeof clientId !== 'string' || clientId.length === 0) {
            await this._sendWithAck({ error: { message: 'Client id is required', code: 'invalidClientId' }, requestId, down: true }, client);
            return;
        }
        const dedupeClient = client as WebSocketForce<WSType> & { _perfectWSDedupeClientId?: string; };
        dedupeClient._perfectWSDedupeClientId ??= clientId;

        const pendingAbortKey = this._pendingAbortKey(clientId, requestId);
        if ((this.config.enableAckSystem || clientData.requireAck === true) && packetId) {
            if (!this._acceptPacket(packetId, requestId, client, dedupeClient._perfectWSDedupeClientId)) {
                if (this.config.verbose) console.log(`[PerfectWS] _onRequest: duplicate packet ignored, packetId=${ packetId }`);
                return;
            }
        }

        const knownResponse = this._getActiveResponse(clientId, requestId);
        if (this.config.verbose) console.log(`[PerfectWS] _onRequest: requestId=${ requestId } method=${ method } hasRequest=${ knownResponse !== undefined }`);

        if (knownResponse) {
            const activeResponse = knownResponse;
            if (activeResponse.clientRef.ref !== client) {
                this._connectWSToOnRequestResponse(activeResponse, client);
            }
            if (event) {
                try {
                    event.args = this.deserializeRequestData(event.args, activeResponse.events);
                } catch (deserializeError) {
                    const error = { message: errorMessage(deserializeError), code: 'deserializeFailed' };
                    if (activeResponse.sendChannelError) {
                        await activeResponse.sendChannelError(error);
                    } else {
                        await this._sendWithAck({ error, requestId, channelError: true, down: true }, client,
                            false, undefined, undefined, true);
                    }
                    activeResponse.release();
                    return;
                }
                try {
                    activeResponse.events._emitWithSource(event.eventName, 'remote', ...event.args);
                } catch (error) {
                    if (this.config.verbose) {
                        console.error(`[PerfectWS] _onRequest: Error in event listener for ${ event.eventName }:`, error);
                    }
                }

                if (event.eventName === '___request.release') {
                    activeResponse.release();
                } else if (activeResponse.responseEnded && !this.shouldKeepResponseAlive(activeResponse.events)) {
                    activeResponse.release();
                }
                return;
            }

            return;
        }

        const requestTimeout = claimedRequestTimeout === undefined ? this.config.requestTimeout : claimedRequestTimeout;
        if (!isValidRequestTimeout(requestTimeout)) {
            await this._sendWithAck({
                error: {
                    message: 'Request timeout must be 0, a positive finite number, or Infinity',
                    code: 'invalidTimeout',
                },
                requestId,
                down: true,
            }, client);
            return;
        }
        const clientRef: { ref: WebSocketForce<WSType> | null } = { ref: client };
        const events = new NetworkEventListener();
        let responseEnded = false;
        let responseFinishing = false;
        let responseReleased = false;
        let pendingDurableSends = 0;
        let releaseRequested = false;
        let clearResponseTimeout: (() => void) | undefined;
        let activeResponse: ActiveResponse | undefined;
        const responseReleaseController = new AbortController();

        const releaseResponse = (force = false) => {
            if (responseReleased) return;
            releaseRequested = true;
            if (!force && !this._unregistered && pendingDurableSends > 0) return;
            responseReleased = true;
            responseReleaseController.abort('Response released');
            clearResponseTimeout?.();
            clearResponseTimeout = undefined;
            if (!responseEnded && !abortController.signal.aborted) {
                abortController.abort('Response released');
            }
            abortController.signal.removeEventListener('abort', onAbortControllerAbort);
            events.off('___request.resourcesChanged', onResourcesChanged);
            events.off('___abort', onRequestAbort);
            events.offAny(relayLocalEvent);
            activeResponse?.detachClient?.();
            if (activeResponse) activeResponse.clientRef.ref = null;
            this.releaseRequestResources(events);
            if (activeResponse) this._deleteActiveResponse(activeResponse);
        };

        const onResourcesChanged = () => {
            if (responseEnded && pendingDurableSends === 0 && !this.shouldKeepResponseAlive(events)) {
                releaseResponse();
            }
        };

        const endResponse = () => {
            clearResponseTimeout?.();
            clearResponseTimeout = undefined;
            if (activeResponse) activeResponse.responseEnded = true;
            responseFinishing = false;
            responseEnded = true;
            abortController.signal.removeEventListener('abort', onAbortControllerAbort);

            if (!this.shouldKeepResponseAlive(events)) {
                releaseResponse();
            }
        };

        const abortController = new AbortController();
        const onAbortControllerAbort = () => {
            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: abortSignal fired, setting responseEnded=true`);
            endResponse();
        };
        abortController.signal.addEventListener('abort', onAbortControllerAbort, { once: true });

        const beginResponseFinish = () => {
            if (responseEnded || responseFinishing) return false;
            responseFinishing = true;
            clearResponseTimeout?.();
            clearResponseTimeout = undefined;
            abortController.signal.removeEventListener('abort', onAbortControllerAbort);
            return true;
        };

        const onRequestAbort = (_source: string, reason: any) => {
            if (responseEnded || responseFinishing) {
                releaseResponse(true);
                return;
            }
            abortController.abort(reason);
        };
        const relayLocalEvent = (source: string, eventName: string, ...args: any[]) => {
            if (source === 'remote' || INTERNAL_EVENTS.includes(eventName)) return;
            const content = { event: { eventName, args }, requestId };
            const durable = isDurableControlEvent(content);
            if (durable) pendingDurableSends++;
            void sendJSON(content).finally(() => {
                if (!durable) return;
                pendingDurableSends--;
                if (releaseRequested && pendingDurableSends === 0) releaseResponse();
                else onResourcesChanged();
            });
        };

        events.on('___request.resourcesChanged', onResourcesChanged);

        const sendJSON = async (data: any, allowPackageLoss = false, mustDeliver = false) => {
            data.packetId ??= randomUUID();
            let durable = isDurableControlEvent(data) || mustDeliver;
            let rollbackPrepared = () => { };
            let result: boolean | undefined = false;
            try {
                result = await (async () => {
                    const prepared = this.prepareRequestData(data.event ? data.event.args : data.data, events);
                    rollbackPrepared = prepared.rollback;
                    if (prepared.hasLiveResources) {
                        allowPackageLoss = false;
                        mustDeliver = true;
                        durable = true;
                    }
                    const requiresOperationAck = Boolean(mustDeliver || isDurableControlEvent(data) || prepared.hasLiveResources);
                    const serializedData = data.event
                        ? {
                            ...data,
                            event: {
                                ...data.event,
                                args: prepared.data
                            }
                        }
                        : { ...data, data: prepared.data };

                    if (allowPackageLoss) {
                        if (!clientRef.ref) {
                            if (this.config.verbose) console.log(`[PerfectWS] sendJSON: client not connected, skipping send for allowPackageLoss`);
                            return;
                        }

                        const sent = await this._sendWithAck(serializedData, clientRef.ref, true, prepared.commit,
                            responseReleaseController.signal, requiresOperationAck, undefined);
                        return;
                    }

                    let messageSent = false;
                    const maxSendAttempts = Math.max(1, Math.floor(this.config.sendRequestRetries));
                    for (let i = 0; i < maxSendAttempts; i++) {
                        if (clientRef.ref?.readyState !== WebSocketForce.OPEN) {
                            if (this.config.verbose) console.log(`[PerfectWS] sendJSON: clientListen is empty, waiting...`);
                            if (responseReleaseController.signal.aborted) return false;
                            if (!durable && abortController.signal.aborted) return false;
                            const raceResult = await new Promise<'added' | 'released' | 'aborted' | 'timeout'>((resolve) => {
                                let settled = false;

                                const settle = (result: 'added' | 'released' | 'aborted' | 'timeout') => {
                                    if (settled) return;
                                    settled = true;
                                    cleanup();
                                    resolve(result);
                                };

                                const onClientAdded = () => settle('added');
                                const onReleased = () => settle('released');
                                const onAborted = () => settle('aborted');
                                const timeout = durable ? undefined : setTimeout(() => settle('timeout'), this.config.reconnectTimeout);

                                const cleanup = () => {
                                    events.off('___request.connected', onClientAdded);
                                    responseReleaseController.signal.removeEventListener('abort', onReleased);
                                    abortController.signal.removeEventListener('abort', onAborted);
                                    if (timeout) clearTimeout(timeout);
                                };

                                events.on('___request.connected', onClientAdded);
                                responseReleaseController.signal.addEventListener('abort', onReleased, { once: true });
                                if (!durable) abortController.signal.addEventListener('abort', onAborted, { once: true });
                                if (clientRef.ref?.readyState === WebSocketForce.OPEN) settle('added');
                            });

                            if (raceResult !== 'added') break;
                        }

                        if (clientRef.ref) {
                            if (this.config.verbose) console.log(`[PerfectWS] sendJSON: sending to client`);
                            const sent = await this._sendWithAck(serializedData, clientRef.ref, allowPackageLoss, prepared.commit,
                                durable ? responseReleaseController.signal : abortController.signal, requiresOperationAck,
                                data.event ? () => events.emit('___request.eventDelivered', operationIdentity(data)) : undefined);
                            if (this.config.verbose) console.log(`[PerfectWS] sendJSON: _sendWithAck returned`, sent);
                            if (sent) {
                                messageSent = true;
                            } else if (!allowPackageLoss) {
                                const disconnected = clientRef.ref?.readyState !== WebSocketForce.OPEN;
                                if (disconnected || durable && i === maxSendAttempts - 1) {
                                    if (!disconnected) clientRef.ref?.forceClose();
                                    i = -1;
                                    continue;
                                }
                            }
                        } else {
                            if (this.config.verbose) console.log(`[PerfectWS] sendJSON: client not connected, waiting for connection...`);
                        }

                        if (messageSent) break;
                    }

                    if (!messageSent) {
                        if (this.config.verbose) console.log(`[PerfectWS] sendJSON: no message sent, aborting`);
                        if (data.event && responseEnded) {
                            events.emit('___request.sendFailed', operationFailure(data, 'Failed to send response event'));
                        } else {
                            abortController.abort('failedToSendMessage');
                        }
                    }

                    return messageSent;
                })();
            } catch (serializationError) {
                rollbackPrepared();
                rollbackPrepared = () => { };

                const failure = {
                    message: errorMessage(serializationError),
                    code: 'serializeFailed'
                };
                const eventName = data.event?.eventName;
                const message = data.event?.args?.[0];

                if (eventName === '___pureRPC.response' && typeof message?.callId === 'string') {
                    return await sendJSON({
                        requestId,
                        event: {
                            eventName,
                            args: [{ callId: message.callId, error: failure.message }]
                        }
                    }, allowPackageLoss);
                }

                if (eventName === '___callback.response' && typeof message?.requestId === 'string') {
                    return await sendJSON({
                        requestId,
                        event: {
                            eventName,
                            args: [{ requestId: message.requestId, error: failure.message, durable: message.durable }]
                        }
                    }, allowPackageLoss);
                }

                if (data.event) {
                    try {
                        events.emit('___request.sendFailed', operationFailure(data, failure.message, failure.code));
                    } catch { }
                    return false;
                }

                if (!data.error) {
                    const finishIntermediateResponse = beginResponseFinish();
                    await sendJSON({ error: failure, requestId, down: true }, allowPackageLoss, true);
                    if (finishIntermediateResponse) {
                        abortController.abort(failure.message);
                        events.emit('___request.finished', { error: failure, requestId });
                        endResponse();
                    }
                    return false;
                }
                return false;
            } finally {
                rollbackPrepared();
            }

            return result;
        };

        if (event) {
            if (event.eventName === '___abort') {
                const clientPendingAborts = [...this._pendingAborts.values()]
                    .filter(pending => pending.clientId === clientId).length;
                if (!this._pendingAborts.has(pendingAbortKey)
                    && (clientPendingAborts >= Math.max(0, this.config.maxPendingAborts)
                        || this._pendingAborts.size >= Math.max(0, this.config.maxTotalPendingAborts))) {
                    client.forceClose(1013, 'Pending abort capacity reached');
                    return;
                }
                this._pendingAborts.delete(pendingAbortKey);
                this._pendingAborts.set(pendingAbortKey, { clientId, requestId, timestamp: Date.now() });
                void this._clearOldRequests();
                return;
            }
            if (event.eventName === '___session.release') {
                for (const response of [...this._activeResponses.values()]) {
                    if (response.clientId === clientId) response.release(true);
                }
                return;
            }
            if (event.eventName === '___request.release') {
                return;
            }
            sendJSON({
                error: { message: 'Live RPC channel is no longer known by the peer', code: 'requestNotFound' },
                requestId,
                channelError: true,
                down: true
            }, false, true);
            return;
        }

        if (method === '___syncRequests') {
            for (const response of [...this._activeResponses.values()]) {
                if (response.requestId !== requestId && response.clientId === clientId && response.method === method) {
                    response.release(true);
                }
            }
        }

        const internalRequest = CAPACITY_EXEMPT_METHODS.has(method);
        const activeOfKind = [...this._activeResponses.values()].filter(response => internalRequest
            ? response.internal && response.method === method && response.clientId === clientId
            : !response.internal).length;
        const requestLimit = internalRequest ? this.config.maxInternalRequests : this.config.maxActiveRequests;
        if (activeOfKind >= requestLimit) {
            sendJSON({ error: { message: 'Too many active requests', code: 'tooManyRequests' }, requestId, down: true });
            return;
        }

        events.on('___abort', onRequestAbort);
        events.onAny(relayLocalEvent);

        activeResponse = {
            requestId,
            events,
            clientRef,
            clientId,
            responseEnded: false,
            internal: internalRequest,
            method,
            detachClient: () => { },
            release: releaseResponse
        };
        activeResponse.sendChannelError = error => sendJSON({ error, requestId, channelError: true, down: true }, false, true);
        this._setActiveResponse(activeResponse);
        this._connectWSToOnRequestResponse(activeResponse, client, false);

        const findMethod = this._listenForRequests.get(method);
        if (!findMethod) {
            const error = { message: `Method "${ method }" not found`, code: 'notFound' };
            if (beginResponseFinish()) {
                await sendJSON({ error, requestId, down: true }, false, true);
                events.emit('___request.finished', { error, requestId });
                endResponse();
            }
            return;
        }

        if (isFinitePositiveTimeout(requestTimeout)) {
            clearResponseTimeout = setLongTimeout(() => {
                if (!beginResponseFinish()) return;

                const error = { message: 'Request timeout', code: 'timeout' };
                abortController.abort('Request timeout');
                void (async () => {
                    await sendJSON({ error, requestId, down: true }, false, true);
                    events.emit('___request.finished', { error, requestId });
                    endResponse();
                })();
            }, requestTimeout);
        }

        try {
            // Early abort if abort was received before handler setup
            if (this._pendingAborts.has(pendingAbortKey)) {
                if (this.config.verbose) console.log(`[PerfectWS] _onRequest: early abort detected`);
                this._pendingAborts.delete(pendingAbortKey);
                const error = { message: 'Request aborted by client', code: 'abort' };
                if (beginResponseFinish()) {
                    await sendJSON({ error, requestId, down: true }, false, true);
                    events.emit('___request.finished', { error, requestId });
                    endResponse();
                }
                return;
            }

            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: calling handler for method=${ method }`);

            let requestData = this.deserializeRequestData(data, events);
            const requestOptions: WSCallbackOptions = {
                abortSignal: abortController.signal,
                events,
                send: async (data, down, allowPackageLoss) => {
                    if (this.config.verbose) console.log(`[PerfectWS] send called: down=${ down }, responseEnded=${ responseEnded }`);
                    if (responseEnded || responseFinishing) return;
                    if (down) beginResponseFinish();

                    const messageSent = await sendJSON({ data, requestId, down }, allowPackageLoss, down === true);
                    if (!messageSent && !allowPackageLoss) {
                        if (this.config.verbose) console.log(`[PerfectWS] send: message not sent, aborting`);
                        abortController.abort('Failed to send message');
                    }

                    if (down) {
                        endResponse();
                        events.emit('___request.finished', { data, requestId });
                    }
                },
                reject: (message, code = 'throwErrorCallback') => {
                    if (!beginResponseFinish()) return;

                    const error = { message, code };
                    void (async () => {
                        await sendJSON({ error, requestId, down: true }, false, true);
                        events.emit('___request.finished', { error, requestId });
                        endResponse();
                    })();

                },
                ws: client,
                requestId,
                clientId
            };

            let response: any;
            const routeCallbacks = internalRequest
                ? findMethod.callbacks
                : this._addMiddlewareForNewRequests.concat(findMethod.middleware?.() ?? [], findMethod.callbacks);
            for (const callback of routeCallbacks) {
                response = callback(requestData, requestOptions);
                if (response instanceof Promise) response = await response;
                if (isRequestDataReplacement(response)) {
                    requestData = response.data;
                    response = undefined;
                    continue;
                }
                if (responseEnded || responseFinishing) break;
            }

            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: handler returned, responseEnded=${ responseEnded }`);
            if (beginResponseFinish()) {
                if (this.config.verbose) console.log(`[PerfectWS] _onRequest: sending final response`);
                await sendJSON({ data: response, requestId, down: true }, false, true);
                events.emit('___request.finished', { data: response, requestId });
                endResponse();
            }
        } catch (errorThrown: unknown) {
            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: caught error:`, errorMessage(errorThrown));
            if (beginResponseFinish()) {
                const error = {
                    message: errorMessage(errorThrown),
                    code: errorCode(errorThrown, 'throwError')
                };
                await sendJSON({ error, requestId, down: true }, false, true);
                events.emit('___request.finished', { error, requestId });
                endResponse();
            }
        }
    }

    private _connectWSToOnRequestResponse(activeResponse: ActiveResponse, client: WebSocketForce<WSLike>, emitConnected = true) {
        activeResponse.detachClient?.();
        activeResponse.clientRef.ref = client;
        if (emitConnected) activeResponse.events.emit('___request.connected', { ws: client });

        const closeListener = () => {
            if (activeResponse.clientRef.ref === client) activeResponse.clientRef.ref = null;
            activeResponse.events.emit('___request.disconnected', { ws: client });
            activeResponse.detachClient();
        };

        activeResponse.detachClient = () => {
            client.removeEventListener('close', closeListener);
        };

        client.addEventListener('close', closeListener);
    }


    private async _clearOldRequests() {
        if (this._clearOldRequestActive) {
            return;
        }

        this._clearOldRequestActive = true;
        try {
            while (!this._requestCleanupAbortController.signal.aborted &&
                ([...this._activeRequests.values()].some(request => !request.finished &&
                    isFinitePositiveTimeout(request.timeout ?? this.config.requestTimeout)) || this._pendingAborts.size > 0)) {
                const promises: Promise<void>[] = [];

                for (const [requestId, request] of this._activeRequests) {
                    if (request.finished) continue;

                    const timeoutLimit = request.timeout ?? this.config.requestTimeout;
                    const timeout = isFinitePositiveTimeout(timeoutLimit) && Date.now() - request.updateTime > timeoutLimit;
                    if (!timeout) continue;

                    const timeoutCallback = () => request.callback(null, { message: 'Request timeout', code: 'timeout' }, true);

                    if (request.server?.readyState == WebSocketForce.OPEN) {
                        try {
                            const promise = this.hasRequest(requestId)
                                .then(hasRequest => {
                                    if (!hasRequest) {
                                        timeoutCallback();
                                    }
                                })
                                .catch(() => timeoutCallback());
                            promises.push(promise);
                        } catch {
                            timeoutCallback();
                        }
                    } else {
                        timeoutCallback();
                    }
                }

                await Promise.all(promises);

                const now = Date.now();
                for (const [key, pendingAbort] of this._pendingAborts) {
                    const { clientId, requestId, timestamp } = pendingAbort;
                    if (now - timestamp > this.config.pendingAbortsMinAge) {
                        const response = this._getActiveResponse(clientId, requestId);
                        if (!response) {
                            this._pendingAborts.delete(key);
                            if (this.config.verbose) {
                                console.log(`[PerfectWS] _clearOldRequests: cleaned up pending abort for requestId=${ requestId }`);
                            }
                        }
                    }
                }

                if (this._pendingAborts.size > this.config.maxTotalPendingAborts) {
                    const toKeep = new Map<string, { clientId: string; requestId: string; timestamp: number; }>();
                    for (const [key, pendingAbort] of this._pendingAborts) {
                        const response = this._getActiveResponse(pendingAbort.clientId, pendingAbort.requestId);
                        if (response ||
                            (now - pendingAbort.timestamp <= this.config.pendingAbortsMinAge)) {
                            toKeep.set(key, pendingAbort);
                        }
                    }
                    this._pendingAborts = toKeep;
                    if (this.config.verbose) {
                        console.log(`[PerfectWS] _clearOldRequests: limited _pendingAborts to ${ this._pendingAborts.size } entries`);
                    }
                }

                const hasPendingCleanup = [...this._activeRequests.values()].some(request => !request.finished &&
                    isFinitePositiveTimeout(request.timeout ?? this.config.requestTimeout)) || this._pendingAborts.size > 0;
                if (!hasPendingCleanup) break;
                await sleep(this.config.clearOldRequestsDelay, this._requestCleanupAbortController.signal);
            }
        } finally {
            this._clearOldRequestActive = false;
        }
    }

    private async _startAckCleanupLoop(abortController: AbortController) {
        while (!abortController.signal.aborted) {
            await sleep(this.config.processedPacketsCleanupInterval, abortController.signal);

            if (abortController.signal.aborted) break;

            if (this._processedPackets.size > 0) {
                const oldestAllowed = Date.now() - Math.max(0, this.config.processedPacketsRetention);
                let removed = 0;
                for (const [packetId, timestamp] of this._processedPackets) {
                    if (timestamp < oldestAllowed) {
                        this._processedPackets.delete(packetId);
                        removed++;
                    }
                }

                if (this.config.verbose && removed > 0) {
                    console.log(`[PerfectWS] Cleaned up ${ removed } expired processed packets`);
                }
            }
            if (this._processedPacketsByClient.size > 0) {
                const oldestAllowed = Date.now() - Math.max(0, this.config.processedPacketsRetention);
                for (const [clientId, packets] of this._processedPacketsByClient) {
                    for (const [packetId, timestamp] of packets) {
                        if (timestamp < oldestAllowed) {
                            packets.delete(packetId);
                            this._processedPacketsByClientCount--;
                        }
                    }
                    if (packets.size === 0) this._processedPacketsByClient.delete(clientId);
                }
                this._processedPacketsByClientCount = [...this._processedPacketsByClient.values()]
                    .reduce((count, packets) => count + packets.size, 0);
            }

            // Clean up old pending ACKs (stuck ACKs that never received response)
            // Limit the total size to prevent memory leaks
            if (this._pendingAcks.size > this.config.maxTotalPendingAcks) {
                let cleanupCount = 0;
                const toDelete: string[] = [];

                for (const [packetId] of this._pendingAcks.entries()) {
                    if (cleanupCount >= this._pendingAcks.size - this.config.maxPendingAcksKept) break; // Keep only the configured number of newest
                    toDelete.push(packetId);
                    cleanupCount++;
                }

                for (const packetId of toDelete) {
                    const ackHandler = this._pendingAcks.get(packetId);
                    if (ackHandler) {
                        ackHandler.reject('ACK cleanup - too many pending');
                        this._pendingAcks.delete(packetId);
                    }
                }

                if (this.config.verbose && cleanupCount > 0) {
                    console.log(`[PerfectWS] Cleaned up ${ cleanupCount } stuck ACKs, kept ${ this._pendingAcks.size }`);
                }
            }

        }
    }

    private _resolveWaitForServer() {
        for (const settle of this._waitForNewServer) {
            settle();
        }
        this._waitForNewServer.clear();
    }

    private _releaseAllChannels() {
        if (this._unregistered) return;
        this._unregistered = true;
        this._requestCleanupAbortController.abort('Router unregistered');
        this._pendingAborts.clear();
        const unregisterError = new PerfectWSError('Router unregistered', 'unregistered');
        for (const settle of this._waitForNewServer) settle(unregisterError);
        this._waitForNewServer.clear();
        for (const ack of [...this._pendingAcks.values()]) {
            ack.reject('Router unregistered');
        }
        this._pendingAcks.clear();
        for (const request of [...this._activeRequests.values()]) {
            request.release({ message: 'Router unregistered', code: 'unregistered' });
        }
        for (const response of [...this._activeResponses.values()]) {
            response.release(true);
        }
        this._processedPackets.clear();
        this._processedPacketsByClient.clear();
        this._processedPacketsByClientCount = 0;
        this._server = undefined;
        this._unregisterServer = undefined;
        this._listenForRequests.clear();
        this._addMiddlewareForNewRequests.length = 0;
    }

    protected static _newInstance<WSType extends WSLike = WSLike>() {
        return new PerfectWS<WSType>();
    }

    /** Add middleware that applies to every direct and mounted route on this router. */
    use(...middleware: WSListenCallback[]): this {
        if (this._isClient) {
            throw new PerfectWSError('This is a client instance, you can only use "use" method on server instance', 'invalidInstance');
        }
        for (const callback of middleware) {
            if (typeof callback !== 'function') {
                throw new PerfectWSError('use() accepts middleware functions only; attach child routers with mount(prefix, router)', 'invalidMiddleware');
            }
            this._addMiddlewareForNewRequests.push(callback);
        }
        return this;
    }

    /** Mount a child router under a prefix owned by this router. */
    mount(prefix: string, router: PerfectWSSubRoute): this {
        if (this._isClient) {
            throw new PerfectWSError('This is a client instance, you can only use "mount" method on server instance', 'invalidInstance');
        }
        if (typeof prefix !== 'string' || !(router instanceof PerfectWSSubRoute)) {
            throw new PerfectWSError('mount() requires a string prefix and a router created by PerfectWS.Router()', 'invalidMount');
        }
        router.__connect(this, prefix);
        return this;
    }


    static client<WSType extends WSLike = WSLike>(config?: WSClientOptions): WSClientResult<WSType>;
    static client<WSType extends WSLike = WSLike>(server: WSType | WebSocketForce<WSType>, config?: WSClientOptions): WSClientResult<WSType>;
    static client<WSType extends WSLike = WSLike>(server?: WSType | WebSocketForce<WSType> | WSClientOptions, config?: WSClientOptions): WSClientResult<WSType> {
        const router = this._newInstance<WSType>();
        router._isClient = true;

        if (server && !("send" in server)) {
            config = server;
            server = undefined;
        }

        if (config) {
            if (config.temp) {
                router.config.syncRequestsWhenServerOpen = false;
                router.config.abortUnknownResponses = false;
            }

            if (config.debugging) {
                router.config.runPingLoop = false;
                router.config.enableAckSystem = false;
            }
        }

        router.config.clientId = config?.clientId ?? randomUUID();

        if (server) {
            router._setServer(server);
        }

        const release = (closeSocket: boolean) => {
            const server = router._server;
            if (server?.readyState === WebSocketForce.OPEN && router.config.clientId) {
                router._sendJSON({
                    requestId: `___session.release:${ randomUUID() }`,
                    clientId: router.config.clientId,
                    event: { eventName: '___session.release', args: [] },
                }, server);
            }
            router._unregisterServer?.();
            if (closeSocket) server?.forceClose(1000, 'Router unregistered');
            router._releaseAllChannels();
        };

        return {
            router,
            setServer: router._setServer.bind(router),
            unregister: () => release(true),
            detachServer: () => release(false),
        };
    }

    static server<WSType extends WSLike = WSLike>(): WSServerResult<WSType> {
        const router = this._newInstance<WSType>();
        const unregisterFunctions: (() => void)[] = [];

        // Start ACK cleanup loop for server
        const ackCleanupAbortController = new AbortController();
        router._ackCleanupAbortController = ackCleanupAbortController;
        router._startAckCleanupLoop(ackCleanupAbortController);

        const unregister = () => {
            ackCleanupAbortController.abort('Server unregistered');
            while (unregisterFunctions.length > 0) {
                unregisterFunctions.pop()?.();
            }
            router._releaseAllChannels();
        };

        const checkPingInterval = async (socket: WebSocketForce, abortSignal: AbortSignal) => {
            if (socket.readyState != WebSocketForce.OPEN) {
                const result = await Promise.race([
                    socket.once('open').then(x => 'open'),
                    sleep(router.config.connectionTimeout, abortSignal).then(x => 'timeout')
                ]);

                if (abortSignal.aborted) return;

                if (result === 'timeout') {
                    socket.forceClose(1000, 'Connection timeout');
                    return;
                }
            }

            router._lastPingTimes.set(socket, Date.now());

            while (socket.readyState == WebSocketForce.OPEN && router.config.runPingLoop && !abortSignal.aborted) {
                if (Date.now() - (router._lastPingTimes.get(socket) ?? 0) > router.config.pingReceiveTimeout) {
                    socket.forceClose(1000, 'Ping timeout');
                    break;
                }
                await sleep(router.config.pingIntervalMs, abortSignal);
            }
        };

        const attachClient = (socket: WSType | WSLike) => {
            if (router._unregistered) {
                throw new PerfectWSError('Router unregistered', 'unregistered');
            }
            const socketAsWSForce = socket instanceof WebSocketForce ? socket : new WebSocketForce(socket);

            socketAsWSForce.setMaxListeners(router.config.maxListeners);
            socketAsWSForce.binaryType = 'arraybuffer';
            const pingLoopAbortController = new AbortController();

            const onMessage = ({ data }: MessageEvent) => {
                const parsedData = router.deserialize(data);
                if (parsedData === null) {
                    // Corrupted data - ignore
                    return;
                }
                data = null;
                router._onRequest(parsedData, socketAsWSForce);
            };

            if (router.config.runPingLoop) {
                checkPingInterval(socketAsWSForce, pingLoopAbortController.signal);
            }


            socketAsWSForce.addEventListener('message', onMessage);
            let cleaned = false;
            const cleanup = (event?: { code?: number; reason?: string; }) => {
                if (cleaned) return;
                cleaned = true;
                if (event?.code === 1000 && event.reason === 'Router unregistered') {
                    for (const response of [...router._activeResponses.values()]) {
                        if (response.clientRef.ref === socketAsWSForce) response.release(true);
                    }
                }
                pingLoopAbortController.abort('Socket attachment removed');
                socketAsWSForce.removeEventListener('message', onMessage);
                socketAsWSForce.removeEventListener('close', cleanup);
                const index = unregisterFunctions.indexOf(unregisterAttachment);
                if (index >= 0) unregisterFunctions.splice(index, 1);
            };
            const unregisterAttachment = () => {
                socketAsWSForce.forceClose(1000, 'Router unregistered');
                cleanup();
            };
            socketAsWSForce.addEventListener('close', cleanup);
            unregisterFunctions.push(unregisterAttachment);

            let detached = false;
            return () => {
                if (detached) return;
                detached = true;
                cleanup();
            };
        };

        const autoReconnect = (url: string, webSocketConstructor: new (url: string) => WSLike | WSType = WebSocket) => {
            let stopReconnecting = false;
            let socketAsWSForce: WebSocketForce;
            const reconnectAbortController = new AbortController();

            const connectionLoop = async () => {
                while (!stopReconnecting) {
                    let cleanup: (() => void) | undefined;
                    try {
                        const socket = new webSocketConstructor(url);
                        socketAsWSForce = socket instanceof WebSocketForce ? socket : new WebSocketForce(socket);
                        cleanup = attachClient(socketAsWSForce);
                        await new Promise<void>(resolve => {
                            let settled = false;
                            const settle = () => {
                                if (settled) return;
                                settled = true;
                                socketAsWSForce.removeEventListener('error', settle);
                                socketAsWSForce.removeEventListener('close', settle);
                                resolve();
                            };
                            socketAsWSForce.addEventListener('error', settle);
                            socketAsWSForce.addEventListener('close', settle);
                            if (socketAsWSForce.readyState === WebSocketForce.CLOSED) settle();
                        });
                    } catch (error) {
                        if (!stopReconnecting && router.config.verbose) {
                            console.error('[PerfectWS] autoReconnect attempt failed:', error);
                        }
                    } finally {
                        cleanup?.();
                        if (socketAsWSForce?.readyState !== WebSocketForce.CLOSED) {
                            socketAsWSForce?.forceClose();
                        }
                    }

                    if (!stopReconnecting && router.config.delayBeforeReconnect) {
                        await sleep(router.config.delayBeforeReconnect, reconnectAbortController.signal);
                    }
                }
            };

            void connectionLoop();

            const stopReconnectingFn = () => {
                if (stopReconnecting) return;
                stopReconnecting = true;
                reconnectAbortController.abort('Auto reconnect stopped');
                socketAsWSForce?.forceClose();
            };

            unregisterFunctions.push(stopReconnectingFn);

            let detached = false;
            return () => {
                if (detached) return;
                detached = true;
                stopReconnectingFn();
                const index = unregisterFunctions.indexOf(stopReconnectingFn);
                if (index >= 0) unregisterFunctions.splice(index, 1);
            };
        };

        return {
            router,
            attachClient,
            autoReconnect,
            unregister
        };
    }

    static Router() {
        return new PerfectWSSubRoute();
    }
}
