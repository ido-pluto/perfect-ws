import { BSON } from 'bson';
import { v4 as uuid } from 'uuid';
import { NetworkEventListener } from './utils/NetworkEventListener.js';
import { MessageEvent, WebSocketForce, WSLike } from './utils/WebSocketForce.js';
import { PerfectWSError } from './PerfectWSError.js';
import { PerfectWSSubRoute } from './PerfectWSSubRoute.js';
import { sleep } from './utils/sleepPromise.js';

const INTERNAL_EVENTS = [
    'request.finished',
    'request.connected',
    'request.disconnected'
];

type WSRequestOptionsCallback<Response = any> = (data: Response, error: { message: string, code: string; }, down: boolean) => void;

export type WSListenCallbackSend = (data: any, down?: boolean, allowPackageLoss?: boolean) => void;
export type WSCallbackOptions = {
    send: WSListenCallbackSend,
    reject: (reason: string, code: string) => void,
    events: NetworkEventListener;
    abortSignal: AbortSignal;
    ws: WebSocketForce & { [key: string]: any; };
    requestId: string;
};
export type WSListenCallback = (params: any, options: WSCallbackOptions) => Promise<any> | any;

export type WSRequestOptions<Response = any, WSType extends WSLike = WSLike> = {
    callback?: WSRequestOptionsCallback<Response>;
    events?: NetworkEventListener;
    abortSignal?: AbortSignal;
    requestId?: string;
    timeout?: number; // 0 means no timeout
    doNotWaitForConnection?: boolean;
    /**@internal */
    useServer?: WebSocketForce<WSType>;
};

export type WSClientOptions = {
    /**
     * If true, unknown responses will be ignored and not aborted, and will not sync request when server is opened
     */
    temp: boolean;
};

type ActiveRequest<WSType extends WSLike> = {
    finished?: boolean;
    requestId: string,
    updateTime: number,
    events: NetworkEventListener,
    server: WebSocketForce<WSType>,
    callback: WSRequestOptionsCallback;
    doNotWaitForConnection?: boolean;
    abortController: AbortController;
};

type ListenForRequest = {
    method: string,
    callbacks: WSListenCallback[];
};

type ActiveResponse<WSType extends WSLike> = {
    events: NetworkEventListener;
    clients: Set<WebSocketForce<WSType>>;
};

export type WSClientResult<WSType extends WSLike = WSLike, Router extends PerfectWS<WSType> = PerfectWS<WSType>> = {
    router: Router;
    setServer: (socket: WSType | WebSocketForce<WSType>) => void;
    unregister: () => void;
};

export type WSServerResult<WSType extends WSLike = WSLike, Router extends PerfectWS<WSType> = PerfectWS<WSType>> = {
    router: Router;
    attachClient: (socket: WSType | WSLike) => () => void;
    autoReconnect: (url: string, webSocketConstructor?: typeof WebSocket) => () => void;
    unregister: () => void;
};

export type PerfectWSConfig = {
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
    syncRequestsWhenServerOpen: boolean;
    abortUnknownResponses: boolean;
};

export class PerfectWS<WSType extends WSLike = WSLike, ExtraConfig = { [key: string]: any; }> {
    public config = {
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
        syncRequestsWhenServerOpen: true,
        abortUnknownResponses: true
    } as PerfectWSConfig & ExtraConfig;

    private _server?: WebSocketForce<WSType>;
    private _unregisterServer?: () => void;
    private _isClient?: boolean;
    private _listenForRequests: Map<string, ListenForRequest> = new Map();
    private _activeRequests: Map<string, ActiveRequest<WSType>> = new Map();
    private _activeResponses: Map<string, ActiveResponse<WSType>> = new Map();
    private _waitForNewServer = new Set<() => void>();
    private _clearOldRequestActive = false;
    private _lastPingTime = 0;
    private _pendingAborts = new Set<string>();
    private _addMiddlewareForNewRequests: WSListenCallback[] = [];

    get isServerConnected() {
        return this._server?.readyState == WebSocketForce.OPEN;
    }

    get bufferedAmount() {
        return this._server?.bufferedAmount || 0;
    }

    get serverOpen() {
        if (this.isServerConnected) return Promise.resolve(true);
        return new Promise<void>((resolve) => {
            this._waitForNewServer.add(resolve);
        });
    }

    protected constructor() {
        this.__initPrivateMethods();
    }

    private async _syncRequests(useServer?: WebSocketForce<WSType>) {
        if (!this._isClient) {
            throw new PerfectWSError('This is a server instance, you can only use "syncRequests" method on client instance', 'invalidInstance');
        }

        const activeRequestsIds = Array.from(this._activeRequests.keys());
        const unknownActiveRequestsIds = await this.request("___syncRequests", { activeRequestsIds }, { doNotWaitForConnection: true, timeout: this.config.syncRequestsTimeout, useServer });
        for (const requestId of unknownActiveRequestsIds) {
            const request = this._activeRequests.get(requestId);
            if (!request) continue;
            request.callback(null, { message: 'Unknown request', code: 'unknownRequest' }, true);
        }
    }

    syncRequests() {
        return this._syncRequests();
    }

    private async hasRequest(requestId: string) {
        if (!this._isClient) {
            return this._activeResponses.has(requestId);
        }

        return await this.request("___hasRequest", { requestId }, { doNotWaitForConnection: true, timeout: this.config.syncRequestsTimeout });
    }

    private async _ping() {
        return await this.request("___ping", null, { doNotWaitForConnection: true, timeout: this.config.pingRequestTimeout });
    }

    private __initPrivateMethods() {
        this.on("___syncRequests", ({ activeRequestsIds }: { activeRequestsIds: string[]; }, { requestId: currentRequestId }) => {
            const activeResponses = Array.from(this._activeResponses.entries());

            for (const [requestId, response] of activeResponses) {
                // Don't abort the current request we're processing
                if (requestId === currentRequestId) continue;

                if (!activeRequestsIds.includes(requestId)) {
                    response.events._emitWithSource('___abort', 'remote', 'Unknown request');
                }
            }

            const activeResponseIds = activeResponses.map(([id]) => id);
            return activeRequestsIds.filter(x => !activeResponseIds.includes(x));
        });

        this.on("___hasRequest", ({ requestId }: { requestId: string; }) => {
            return this._activeResponses.has(requestId);
        });

        this.on("___ping", () => {
            this._lastPingTime = Date.now();
            return "pong";
        });
    }

    private _setServer(originalServer: WebSocketForce<WSType> | WSType) {
        this._unregisterServer?.();

        const server = originalServer instanceof WebSocketForce ? originalServer : new WebSocketForce(originalServer);

        try {
            this._server?.forceClose?.();
        } catch { }

        server.setMaxListeners(this.config.maxListeners);

        const onMessage = ({ data }: MessageEvent) => {
            const parsedData = this.deserialize(data);
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

            this._resolveWaitForServer();

            while (this.isServerConnected) {
                try {
                    await this._ping();
                    await sleep(this.config.pingIntervalMs);
                } catch {
                    server.forceClose();
                    break;
                }
            }
        };

        server.addEventListener('message', onMessage);

        if (server.readyState == WebSocketForce.OPEN) {
            onOpen();
        } else {
            server.addEventListener('open', onOpen);
        }


        this._server = server;

        this._unregisterServer = () => {
            server.removeEventListener('message', onMessage);
            server.removeEventListener('open', onOpen);
        };
    }

    async request<Response = any>(method: string, data?: any, options: WSRequestOptions<Response, WSType> = {}): Promise<Response> {
        if (!this._isClient) {
            throw new PerfectWSError('This is a server instance, you can only use "request" method on client instance', 'invalidInstance');
        }

        if (options.abortSignal?.aborted) {
            throw new PerfectWSError('Request aborted by user', 'abort');
        }

        const requestId = options.requestId || (method + uuid());
        if (this._activeRequests.has(requestId)) {
            throw new PerfectWSError('Request already exists', 'requestAlreadyExists');
        }

        const { promise, resolve, reject } = Promise.withResolvers<Response>();
        const abortController = new AbortController();
        options.abortSignal?.addEventListener('abort', () => {
            abortController.abort(options.abortSignal?.reason || 'Request aborted by user');
        });

        let requestSent = false;
        if (options.timeout) {
            const timeoutIndex = setTimeout(() => {
                if (requestSent) {
                    if (this._activeRequests.has(requestId)) {
                        abortController.abort(`Request timeout: ${options.timeout}ms`);
                    }
                } else {
                    abortController.abort(`Request connecting timeout: ${options.timeout}ms`);
                }
            }, options.timeout);

            promise.finally(() => {
                clearTimeout(timeoutIndex);
            });
        }

        const events = options.events ?? new NetworkEventListener();
        const waitForServer = () => new Promise<void>((resolve, reject) => {
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
            const onFinished = () => settleResolve();

            cleanup = () => {
                this._waitForNewServer.delete(onServer);
                abortController.signal.removeEventListener('abort', onAbort);
                events.off('request.finished', onFinished);
            };

            this._waitForNewServer.add(onServer);
            abortController.signal.addEventListener('abort', onAbort);
            events.on('request.finished', onFinished);
        });

        let useServer = options.useServer ?? this._server;
        if (useServer?.readyState !== WebSocketForce.OPEN) {
            if (this.config.verbose) {
                console.log(`[PerfectWS] Server not connected, waiting for connection, method=${method} requestId=${requestId}`);
            }

            if (options.doNotWaitForConnection) {
                const error = { message: 'Server not connected', code: 'serverClosed' };
                options?.callback?.(null!, error, true);
                reject(new PerfectWSError(error.message, error.code, requestId));
                return promise;
            }
            await waitForServer();
            useServer = this._server;

            if (options.abortSignal?.aborted) {
                throw new PerfectWSError('Request aborted by user', 'abort');
            }
        }

        const thisStackTrace = new Error().stack;
        const activeRequest: ActiveRequest<WSType> = {
            requestId,
            events,
            updateTime: Date.now(),
            server: useServer!,
            doNotWaitForConnection: options.doNotWaitForConnection,
            abortController,
            callback: (data, error, down) => {
                if (activeRequest.finished) return;

                activeRequest.updateTime = Date.now();
                options?.callback?.(data, error, down);
                if (down) {
                    activeRequest.finished = true;
                    events.emit('request.finished', { data, error, requestId });
                    this._activeRequests.delete(requestId);
                    if (error != null) {
                        const errorInfo = new PerfectWSError(error.message, error.code, requestId);
                        errorInfo.stack = thisStackTrace;
                        reject(errorInfo);
                    } else {
                        resolve(data);
                    }
                }
            }
        };
        this._activeRequests.set(requestId, activeRequest);

        this._clearOldRequests();

        abortController.signal.addEventListener('abort', (event) => {
            const hasRequest = this._activeRequests.has(requestId);
            if (this.config.verbose) {
                console.warn(`[PerfectWS] Request aborted: method=${method} requestId=${requestId} hasRequest=${hasRequest} reason=${abortController.signal.reason}`);
            }

            if (hasRequest) {
                const reason = abortController.signal.reason;
                activeRequest.callback(null, { message: reason, code: 'abort' }, true);
                this._sendJSON({ requestId, event: { eventName: '___abort', args: [abortController.signal.reason || "Client aborted"] } }, activeRequest.server);
            }
            event.preventDefault();
        });

        const sendRequestRetry = async (content: any, retryLefts = this.config.sendRequestRetries) => {
            const serializeData = this.serializeRequestData(content, events);

            for (let i = 0; i < this.config.sendRequestRetries; i++) {
                if (this._sendJSON(serializeData, activeRequest.server)) {
                    break;
                }

                if (retryLefts && activeRequest.server.readyState != WebSocketForce.OPEN && !activeRequest.doNotWaitForConnection) {
                    events.emit('request.disconnected', { ws: activeRequest.server });
                    await waitForServer();
                    if (activeRequest.finished || abortController.signal.aborted) return;
                    activeRequest.server = this._server!;
                    events.emit('request.connected', { ws: activeRequest.server });
                    continue;
                }


                activeRequest.callback(null, { message: 'Failed to send request', code: 'sendFailed' }, true);
            }
        };

        events.onAny((source, eventName, ...args) => {
            if (source === 'remote' || INTERNAL_EVENTS.includes(eventName)) return;
            sendRequestRetry({ requestId, event: { eventName, args } });
        });

        const retryOnClose = async () => {
            activeRequest.server.removeEventListener('close', retryOnClose);

            if (activeRequest.finished || abortController.signal.aborted) {
                return;
            }

            events.emit('request.disconnected', { ws: activeRequest.server });
            if (activeRequest.doNotWaitForConnection) {
                activeRequest.callback(null, { message: 'Server closed', code: 'serverClosed' }, true);
                return;
            };

            try {
                await waitForServer();
                if (activeRequest.finished) {
                    return;
                }

                if (await this.hasRequest(requestId)) {
                    if (activeRequest.finished) {
                        return;
                    }

                    activeRequest.server = this._server!;
                    events.emit('request.connected', { ws: activeRequest.server });
                    this._server!.addEventListener('close', retryOnClose);
                } else {
                    activeRequest.callback(null, { message: 'Request not found', code: 'requestNotFoundAfterReconnect' }, true);
                }
            } catch (error) {
                activeRequest.callback(null, { message: 'Failed to check request status', code: 'reconnectFailed' }, true);
            }
        };


        try {
            await sendRequestRetry({ method, requestId, data });
            requestSent = true;

            activeRequest.server.addEventListener('close', retryOnClose);
            return await promise;
        } finally {
            activeRequest.server.removeEventListener('close', retryOnClose);
        }
    }

    on(method: string, ...callbacks: WSListenCallback[]) {
        if (this._isClient) {
            throw new PerfectWSError('This is a client instance, you can only use "on" method on server instance', 'invalidInstance');
        }
        this._listenForRequests.set(method, { method, callbacks: this._addMiddlewareForNewRequests.concat(callbacks) });
    }

    off(method: string) {
        if (this._isClient) {
            throw new PerfectWSError('This is a client instance, you can only use "off" method on server instance', 'invalidInstance');
        }
        this._listenForRequests.delete(method);
    }

    protected serialize(data: any) {
        return BSON.serialize(data);
    }

    protected deserialize(data: any) {
        return BSON.deserialize(data);
    }

    protected serializeRequestData(data: any, events: NetworkEventListener) {
        return data;
    }

    protected deserializeRequestData(data: any, events: NetworkEventListener) {
        return data;
    }

    private _sendJSON(data: any, server = this._server) {
        return this._sendData(this.serialize(data), server);
    }

    private _sendData(data: any, server = this._server) {
        if (server?.readyState != WebSocketForce.OPEN) {
            if (this.config.verbose) console.log(`[PerfectWS] _sendData: server not OPEN, readyState=${server?.readyState}`);
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

    private _onServerResponse(data: any, socket: WebSocketForce<WSType>) {
        const { requestId, data: responseData, error, down, event } = data;
        const request = this._activeRequests.get(requestId);

        if (!request) {
            if (this.config.abortUnknownResponses && !down) {
                this._sendJSON({ requestId, event: { eventName: '___abort', args: ["Unknown request"] } }, socket);
            }
            return;
        }

        if (event) {
            event.args = this.deserializeRequestData(event.args, request.events);
            request.events._emitWithSource(event.eventName, 'remote', ...event.args);
            return;
        }

        request.callback(this.deserializeRequestData(responseData, request.events), error, down);
    }

    private async _onRequest(clientData: any, client: WebSocketForce<WSType>): Promise<void> {
        const { method, requestId, data, event } = clientData;

        if (this._activeResponses.has(requestId)) {
            const { events, clients } = this._activeResponses.get(requestId)!;
            if (event) {
                event.args = this.deserializeRequestData(event.args, events);
                events._emitWithSource(event.eventName, 'remote', ...event.args);
                return;
            }

            events.emit('request.connected', { ws: client });
            clients.add(client);
            client.addEventListener('close', () => {
                clients.delete(client);
                events.emit('request.disconnected', { ws: client });
            });
            return;
        }

        const clientListen = new Set<WebSocketForce<WSType>>([client]);
        const events = new NetworkEventListener();
        let pingDisconnected = Date.now();
        let responseEnded = false;

        const abortController = new AbortController();
        abortController.signal.addEventListener('abort', () => {
            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: abortSignal fired, setting responseEnded=true`);
            responseEnded = true;
        });

        events.on('request.disconnected', () => {
            pingDisconnected = Date.now();
        });

        const sendJSON = async (data: any, allowPackageLoss = false) => {
            try {
                const serializedData = this.serializeRequestData(data, events);

                if (allowPackageLoss) {
                    for (const client of clientListen) {
                        this._sendJSON(serializedData, client);
                    }
                    return;
                }

                if (clientListen.size === 0) {
                    if (this.config.verbose) console.log(`[PerfectWS] sendJSON: clientListen is empty, waiting...`);
                    const timePassedSinceLastSend = Date.now() - pingDisconnected;
                    const timeLeft = Math.max(0, this.config.requestTimeout - timePassedSinceLastSend);

                    if (timeLeft < 0) {
                        if (this.config.verbose) console.log(`[PerfectWS] sendJSON: timeLeft < 0, returning false`);
                        return false;
                    }

                    const raceResult = await new Promise<'added' | 'timeout'>((resolve) => {
                        let settled = false;

                        const settle = (result: 'added' | 'timeout') => {
                            if (settled) return;
                            settled = true;
                            cleanup();
                            resolve(result);
                        };

                        const onClientAdded = () => settle('added');
                        const onTimeout = () => settle('timeout');

                        const cleanup = () => {
                            events.off('request.connected', onClientAdded);
                            clearTimeout(timeoutId);
                        };

                        events.on('request.connected', onClientAdded);
                        const timeoutId = setTimeout(onTimeout, timeLeft);
                    });

                    if (raceResult === 'timeout') {
                        abortController.abort('sendTimeout');
                        return false;
                    }
                }

                if (this.config.verbose) console.log(`[PerfectWS] sendJSON: sending to ${clientListen.size} clients`);
                let messageSent = false;
                for (const client of clientListen) {
                    const sent = this._sendJSON(serializedData, client);
                    if (this.config.verbose) console.log(`[PerfectWS] sendJSON: _sendJSON returned`, sent);
                    if (sent) {
                        messageSent = true;
                    }
                }

                if (!messageSent) {
                    if (this.config.verbose) console.log(`[PerfectWS] sendJSON: no message sent, aborting`);
                    abortController.abort('failedToSendMessage');
                }

                return messageSent;
            } catch {
                return false;
            }
        };

        if (event) {
            if (event.eventName === '___abort') {
                this._pendingAborts.add(requestId);
                return;
            }
            sendJSON({ error: { message: `Request not found`, code: 'requestNotFound' }, requestId, down: true });
            return;
        }

        const findMethod = this._listenForRequests.get(method);
        if (!findMethod) {
            sendJSON({ error: { message: `Method "${method}" not found`, code: 'notFound' }, requestId, down: true });
            return;
        }

        events.on('___abort', (_source, reason) => {
            abortController.abort(reason);
        });

        events.onAny((source, eventName, ...args) => {
            if (source === 'remote' || INTERNAL_EVENTS.includes(eventName)) return;
            sendJSON({ event: { eventName, args }, requestId });
        });

        client.addEventListener('close', () => {
            clientListen.delete(client);
        });

        this._activeResponses.set(requestId, {
            events,
            clients: clientListen
        });

        try {
            // Early abort if abort was received before handler setup
            if (this._pendingAborts.has(requestId)) {
                if (this.config.verbose) console.log(`[PerfectWS] _onRequest: early abort detected`);
                this._pendingAborts.delete(requestId);
                abortController.abort('Client aborted');
            }

            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: calling handler for method=${method}`);

            const deserializeData = this.deserializeRequestData(data, events);
            const requestOptions: WSCallbackOptions = {
                abortSignal: abortController.signal,
                events,
                send: async (data, down, allowPackageLoss) => {
                    if (this.config.verbose) console.log(`[PerfectWS] send called: down=${down}, responseEnded=${responseEnded}`);
                    if (responseEnded) return;

                    const messageSent = await sendJSON({ data, requestId, down }, allowPackageLoss);
                    if (!messageSent && !allowPackageLoss) {
                        if (this.config.verbose) console.log(`[PerfectWS] send: message not sent, aborting`);
                        abortController.abort('Failed to send message');
                    }

                    if (down) {
                        this._activeResponses.delete(requestId);
                        responseEnded = true;
                        events.emit('request.finished', { data, requestId });
                    }
                },
                reject: (message, code = 'throwErrorCallback') => {
                    if (responseEnded) return;

                    const error = { message, code };
                    sendJSON({ error, requestId, down: true });
                    this._activeResponses.delete(requestId);
                    responseEnded = true;
                    events.emit('request.finished', { error, requestId });

                },
                ws: client,
                requestId
            };

            let response: any;
            for (const callback of findMethod.callbacks) {
                response = callback(deserializeData, requestOptions);
                if (response instanceof Promise) response = await response;
                if (responseEnded) break;
            }

            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: handler returned, responseEnded=${responseEnded}`);
            if (!responseEnded) {
                if (this.config.verbose) console.log(`[PerfectWS] _onRequest: sending final response`);
                sendJSON({ data: response, requestId, down: true });
                events.emit('request.finished', { data: response, requestId });
                responseEnded = true;
            }
        } catch (errorThrown: any) {
            if (this.config.verbose) console.log(`[PerfectWS] _onRequest: caught error:`, errorThrown.message);
            if (!responseEnded) {
                const error = { message: errorThrown.message, code: errorThrown.code || 'throwError' };
                sendJSON({ error, requestId, down: true });
                events.emit('request.finished', { error, requestId });
                responseEnded = true;
            }
        } finally {
            this._activeResponses.delete(requestId);
        }
    }


    private async _clearOldRequests() {
        if (this._clearOldRequestActive) {
            return;
        }

        this._clearOldRequestActive = true;
        try {
            while (this._activeRequests.size > 0) {
                const promises: Promise<void>[] = [];

                for (const [requestId, request] of this._activeRequests) {
                    const timeout = Date.now() - request.updateTime > this.config.requestTimeout;
                    if (!timeout) continue;

                    const timeoutCallback = () => request.callback(null, { message: 'Request timeout', code: 'timeout' }, true);

                    if (request.server.readyState == WebSocketForce.OPEN) {
                        try {
                            const promise = this.hasRequest(requestId)
                                .then(hasRequest => {
                                    if (!hasRequest) {
                                        timeoutCallback();
                                    }
                                })
                                .catch(() => timeoutCallback());
                            promises.push(promise);
                        } catch { }
                    } else {
                        timeoutCallback();
                    }
                }

                // Wait for all hasRequest checks to complete
                await Promise.all(promises);

                await sleep(this.config.clearOldRequestsDelay);
            }
        } finally {
            this._clearOldRequestActive = false;
        }
    }

    private _resolveWaitForServer() {
        for (const resolve of this._waitForNewServer) {
            resolve();
        }
        this._waitForNewServer.clear();
    }

    protected static _newInstance<WSType extends WSLike = WSLike>() {
        return new PerfectWS<WSType>();
    }

    use(...routers: (PerfectWSSubRoute | WSListenCallback)[]) {
        for (const router of routers) {
            if (router instanceof PerfectWSSubRoute) {
                router.__connect(this);
            } else {
                this._addMiddlewareForNewRequests.push(router);
            }
        }
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
        }

        if (server) {
            router._setServer(server);
        }

        return {
            router,
            setServer: router._setServer.bind(router),
            unregister: () => router._unregisterServer?.()
        };
    }

    static server<WSType extends WSLike = WSLike>(): WSServerResult<WSType> {
        const router = this._newInstance<WSType>();
        const unregisterFunctions: (() => void)[] = [];

        const unregister = () => {
            for (const unregisterFunction of unregisterFunctions) {
                unregisterFunction();
            }
            unregisterFunctions.length = 0;
        };

        const checkPingInterval = async (socket: WebSocketForce) => {
            if (socket.readyState != WebSocketForce.OPEN) {
                socket.addEventListener('open', () => {
                    checkPingInterval(socket);
                });
                return;
            }

            router._lastPingTime = Date.now();

            while (socket.readyState == WebSocketForce.OPEN) {
                if (Date.now() - router._lastPingTime > router.config.pingReceiveTimeout) {
                    socket.forceClose(1000, 'Ping timeout');
                    break;
                }
                await sleep(router.config.pingIntervalMs);
            }
        };

        const attachClient = (socket: WSType | WSLike) => {
            const socketAsWSForce = socket instanceof WebSocketForce ? socket : new WebSocketForce(socket);

            if ('setMaxListeners' in socketAsWSForce && typeof socketAsWSForce.setMaxListeners == 'function') {
                socketAsWSForce.setMaxListeners(router.config.maxListeners);
            }

            const onMessage = ({ data }: MessageEvent) => {
                const parsedData = router.deserialize(data);
                router._onRequest(parsedData, socketAsWSForce);
            };

            socketAsWSForce.addEventListener('message', onMessage);
            const cleanup = () => socketAsWSForce.removeEventListener('message', onMessage);
            unregisterFunctions.push(cleanup);

            return () => {
                cleanup();
                unregisterFunctions.splice(unregisterFunctions.indexOf(cleanup), 1);
            };
        };

        const autoReconnect = (url: string, webSocketConstructor = WebSocket) => {
            let stopReconnecting = false;
            let socketAsWSForce: WebSocketForce;

            const connectionLoop = async () => {
                while (!stopReconnecting) {
                    const socket = new webSocketConstructor(url);
                    socketAsWSForce = socket instanceof WebSocketForce ? socket : new WebSocketForce(socket);
                    socketAsWSForce.binaryType = 'arraybuffer';
                    const cleanup = attachClient(socketAsWSForce);

                    checkPingInterval(socketAsWSForce);

                    await socketAsWSForce.once('close');
                    cleanup();

                    if (router.config.delayBeforeReconnect) {
                        await sleep(router.config.delayBeforeReconnect);
                    }
                }
            };

            connectionLoop();

            const stopReconnectingFn = () => {
                stopReconnecting = true;
                socketAsWSForce?.forceClose();
            };

            unregisterFunctions.push(stopReconnectingFn);

            return () => {
                stopReconnectingFn();
                unregisterFunctions.splice(unregisterFunctions.indexOf(stopReconnectingFn), 1);
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