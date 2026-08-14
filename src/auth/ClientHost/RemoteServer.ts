import { PerfectWS } from '../../PerfectWS.js';
import { WebSocketForce, WSLike } from '../../utils/WebSocketForce.js';
import { DEFAULT_DELAY_BEFORE_RECONNECT, DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY, isPasswordRejectionCloseCode, RATE_LIMITED_CLOSE_CODE, WRONG_PASSWORD_CLOSE_CODE } from '../config.js';
import { assertFullTrustedRPCSupport } from '../utils/assertFullTrustedRPCSupport.js';
import { generateRemoteId } from '../utils/generateRemoteId.js';
import { sleep } from '../../utils/sleepPromise.js';

export type RemoteServerOptions<Constructor extends typeof PerfectWS = typeof PerfectWS> = {
    password?: string;
    id?: string;
    verbose?: boolean;
    webSocketConstructor?: new (url: string | URL) => WSLike
    debugging?: boolean;
    /**
     * Logs auth handshake lifecycle events (connecting, connected, rejected,
     * disconnected, unusual throws) - the same lines `verbose` prints for these
     * events, without enabling verbose's full per-request tracing. Defaults to
     * following `debugging`; set explicitly to override that. `verbose: true`
     * always forces this on regardless, since these events are a subset of what
     * verbose already logs.
     */
    logAuthFlow?: boolean;
    autoReconnect?: boolean;
    /** Delay before retrying a connection that closed for a reason other than a
     * password rejection. Defaults to 3s. */
    delayBeforeReconnect?: number;
    /**
     * Delay before retrying after the host closed the connection because of a wrong
     * password or the password rate limit. Defaults to the host's default rate-limit
     * window split across its allowed attempts (`windowMs / maxAttempts`, plus a
     * small margin) - if the host's `passwordRateLimit` is customized, set this to
     * match (`windowMs / maxAttempts` + a small safety margin).
     */
    passwordFailureDelay?: number;
    /** Enables PureRPC. Both peers must explicitly use PerfectWSAdvanced and opt in. */
    fullTrustedRPC?: boolean;
    /** Protocol implementation for the persistent router. Defaults to the BSON-only PerfectWS. */
    perfectWSConstructor?: Constructor;
};

export type InitializeRemoteServer = {
    ws: WebSocketForce<WSLike>;
    clientId: string;
};

type RouterFor<Constructor extends typeof PerfectWS> = ReturnType<Constructor['server']>['router'];

export class RemoteServer<Constructor extends typeof PerfectWS = typeof PerfectWS> {
    private readonly _server: ReturnType<typeof PerfectWS.server>;
    private _on = false;
    private _unregisterFns = new Set<() => void>();

    public clients: Map<string, WSLike> = new Map();


    public constructor(private _options: RemoteServerOptions<Constructor> = {}) {
        _options.logAuthFlow = _options.verbose || (_options.logAuthFlow ?? _options.debugging);

        if (_options.fullTrustedRPC) {
            assertFullTrustedRPCSupport(_options.perfectWSConstructor, 'RemoteServer');
        }

        const ProtocolConstructor = (_options.perfectWSConstructor ?? PerfectWS) as Constructor;
        const server = this._server = ProtocolConstructor.server();

        if (_options.debugging) {
            server.router.config.runPingLoop = false;
            server.router.config.enableAckSystem = false;
        }

        if (_options.verbose) {
            server.router.config.verbose = true;
        }

        if (_options.fullTrustedRPC) {
            server.router.config.fullTrustedRPC = true;
        }

        _options.autoReconnect ??= true;
        _options.delayBeforeReconnect ??= DEFAULT_DELAY_BEFORE_RECONNECT;
        _options.passwordFailureDelay ??= DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY;
        _options.id ??= generateRemoteId('server');
    }

    public get router(): RouterFor<Constructor> {
        return this._server.router as RouterFor<Constructor>;
    }

    private _start() {
        this._on = true;

        if (this._options.verbose) {
            console.log(`[PerfectWS::RemoteServer] RemoteServer started (${ this._options.id })`)
        };

        if (this._options.debugging) {
            console.log(`[PerfectWS::RemoteServer] Debugging mode enabled`);
        }
    }


    /**
     * Attach a client to this remote server. This will initialize the connection and allow the client to communicate with the server.
     * @param ws The WebSocket or URL to attach to the server. If a WebSocket is provided, auto-reconnect will not be enabled.
     * @returns A function to unregister the client from the server.
     */
    public async attachClient(ws: WSLike | string | URL, password = this._options.password) {
        if (!this._on) {
            this._start();
        }

        let attemptCount = 0;

        const type = typeof ws === 'string' || ws instanceof URL ? 'url' : 'ws';
        const wsURL = type === 'url' ? ws.toString() : (ws as WSLike).url;

        let thisClientId: string;
        let attachOn = true;
        let unregisterClient: () => void;
        let currentWsClient: WebSocketForce<WSLike> | undefined;
        const reconnectAbortController = new AbortController();

        const autoReconnect = type === 'url' && this._options.autoReconnect;
        const reconnectionLoop = async () => {
            while (attachOn && (autoReconnect && this._on || attemptCount === 0)) {
                if (this._options.logAuthFlow && attemptCount > 0) console.log(`[PerfectWS::RemoteServer] Connection closed, attempting to reconnect... (attempt ${ attemptCount }, ${ wsURL })`);
                attemptCount++;

                const server = PerfectWS.server();
                let detachAuthSocket: (() => void) | undefined;
                let closeCode: number | undefined;
                try {
                if (this._options.debugging) {
                    server.router.config.runPingLoop = false;
                    server.router.config.enableAckSystem = false;
                }

                if (this._options.verbose) {
                    server.router.config.verbose = true;
                }

                const wsClient = this._getWSClient(ws);
                currentWsClient = wsClient;
                if (this._options.logAuthFlow) console.log(type === 'url' ? `[PerfectWS::RemoteServer] Connecting to ${ wsURL }` : '[PerfectWS::RemoteServer] Attaching to provided socket');

                this._internalInitializeMethods(server, wsClient, password, (clientId) => {
                    detachAuthSocket?.();
                    server.unregister();

                    (wsClient as WebSocketForce<WSLike> & { clientId?: string; }).clientId = clientId;
                    unregisterClient = this._server.attachClient(wsClient);
                    thisClientId = clientId;
                    this.clients.set(clientId, wsClient);
                });

                detachAuthSocket = server.attachClient(wsClient);

                await new Promise<void>(resolve => {
                    if (wsClient.readyState === WebSocketForce.CLOSED) {
                        resolve();
                        return;
                    }
                    wsClient.addEventListener('close', (event: any) => {
                        closeCode = event?.code;
                        resolve();
                        this.clients.delete(thisClientId);
                        unregisterClient?.();
                    }, { once: true });
                });
                } catch (error) {
                    if (this._options.logAuthFlow && !reconnectAbortController.signal.aborted) {
                        console.error('[PerfectWS::RemoteServer] Connection attempt failed:', error);
                    }
                } finally {
                    detachAuthSocket?.();
                    server.unregister();
                }

                if (this._options.logAuthFlow) {
                    if (closeCode === WRONG_PASSWORD_CLOSE_CODE) {
                        console.log('[PerfectWS::RemoteServer] Rejected: wrong password');
                    } else if (closeCode === RATE_LIMITED_CLOSE_CODE) {
                        console.log('[PerfectWS::RemoteServer] Rejected: rate limited');
                    } else {
                        console.log('[PerfectWS::RemoteServer] Disconnected');
                    }
                }

                if (attachOn && autoReconnect && this._on) {
                    const delay = isPasswordRejectionCloseCode(closeCode)
                        ? this._options.passwordFailureDelay!
                        : this._options.delayBeforeReconnect!;

                    if (this._options.logAuthFlow) {
                        console.log(isPasswordRejectionCloseCode(closeCode)
                            ? `[PerfectWS::RemoteServer] Connection closed due to a password rejection, waiting ${ delay }ms before retrying`
                            : `[PerfectWS::RemoteServer] Retrying in ${ delay }ms`);
                    }

                    await sleep(delay, reconnectAbortController.signal);
                }
            }
        }

        void reconnectionLoop().catch(error => {
            if (!reconnectAbortController.signal.aborted) {
                console.error('[PerfectWS::RemoteServer] Reconnection loop failed:', error);
            }
        });

        const unregister = () => {
            attachOn = false;
            reconnectAbortController.abort('RemoteServer attachment removed');
            unregisterClient?.();
            currentWsClient?.forceClose(3000, "RemoteServer unregistered");
            this._unregisterFns.delete(unregister);
        };
        this._unregisterFns.add(unregister);

        return unregister;
    }

    private _getWSClient(ws: WSLike | string | URL) {
        let wsClient: WebSocketForce<WSLike>;

        if (typeof ws === 'string' || ws instanceof URL) {
            const wsInstance: WSLike = new (this._options.webSocketConstructor || WebSocket)(ws);
            wsClient = new WebSocketForce(wsInstance);
        } else if (!(ws instanceof WebSocketForce)) {
            wsClient = new WebSocketForce(ws);
        } else {
            wsClient = ws;
        }

        wsClient.addEventListener('error', () => {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteServer] Connection error`);
        });

        return wsClient;
    }

    private _internalInitializeMethods(server: ReturnType<typeof PerfectWS.server>, wsClient: WebSocketForce<WSLike>, password: string | undefined, registerClient: (clientId: string) => void) {
        let setInitializeMethods = false;
        let thisClientId: string;

        server.router.on("___ch_password", async (clientId) => {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteServer] Password request from ${ clientId }`);

            return password;
        });

        server.router.on("___ch_id", async (clientId) => {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteServer] ID request from ${ clientId }`);

            thisClientId = clientId;

            if (!setInitializeMethods) {
                try {
                    await this.initializeMethods(server.router, { ws: wsClient, clientId });
                } catch (err) {
                    if (this._options.logAuthFlow) console.error('[PerfectWS::RemoteServer] initializeMethods threw:', err);
                    throw err;
                }
                setInitializeMethods = true;
            }

            return this._options.id;
        });

        server.router.on("___ch_initialized", async (peerInfo: { fullTrustedRPC?: boolean; } | null, { send }) => {
            if (this._options.logAuthFlow && !!this._options.fullTrustedRPC !== !!peerInfo?.fullTrustedRPC) {
                console.log(`[PerfectWS::RemoteServer] fullTrustedRPC mismatch (local=${ !!this._options.fullTrustedRPC }, client=${ !!peerInfo?.fullTrustedRPC }) - PureRPC will not work on this connection`);
            }

            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteServer] Connection initialized (clientId=${ thisClientId })`);

            await send({ fullTrustedRPC: !!this._options.fullTrustedRPC }, true);
            registerClient(thisClientId);
        });
    }

    /**
     * Extra method we want to expose the client could initialize on the server state.
     * This is a simple PerfectWS router - does not use the perfectWSConstructor for internal initialization.
     */
    protected initializeMethods(router: ReturnType<typeof PerfectWS.server>['router'], options: InitializeRemoteServer): any | Promise<any> {

    }

    public stop() {
        this._on = false;

        if (this._server) {
            this._server.unregister();
        }

        for (const unregister of Array.from(this._unregisterFns)) {
            unregister();
        }

        this.clients.clear();
    }
}
