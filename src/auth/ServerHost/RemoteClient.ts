import { PerfectWS } from '../../PerfectWS.js';
import { WebSocketForce, WSLike } from '../../utils/WebSocketForce.js';
import { AUTH_READY_MESSAGE, DEFAULT_DELAY_BEFORE_RECONNECT, DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY, isPasswordRejectionCloseCode, RATE_LIMITED_CLOSE_CODE, WRONG_PASSWORD_CLOSE_CODE } from '../config.js';
import { assertFullTrustedRPCSupport } from '../utils/assertFullTrustedRPCSupport.js';
import { generateRemoteId } from '../utils/generateRemoteId.js';
import { sleep } from '../../utils/sleepPromise.js';

export type RemoteClientOptions<Constructor extends typeof PerfectWS = typeof PerfectWS> = {
    password?: string;
    id?: string;
    verbose?: boolean;
    webSocketConstructor?: new (url: string) => WSLike
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
     * Delay before retrying after the server closed the connection because of a
     * wrong password or the password rate limit. Defaults to the server's default
     * rate-limit window split across its allowed attempts (`windowMs / maxAttempts`,
     * plus a small margin) - if the server's `passwordRateLimit` is customized, set
     * this to match (`windowMs / maxAttempts` + a small safety margin).
     */
    passwordFailureDelay?: number;
    /** Enables PureRPC. Both peers must explicitly use PerfectWSAdvanced and opt in. */
    fullTrustedRPC?: boolean;
    /** Protocol implementation for the persistent router. Defaults to the BSON-only PerfectWS. */
    perfectWSConstructor?: Constructor;
} & ({
    wsServer: WSLike
} | {
    url: string;
});

export type InitializeRemoteClient = {
    ws: WebSocketForce;
    serverId: string;
}

type RouterFor<Constructor extends typeof PerfectWS> = ReturnType<Constructor['client']>['router'];

export class RemoteClient<Constructor extends typeof PerfectWS = typeof PerfectWS> {
    private readonly _client: ReturnType<typeof PerfectWS.client>;
    private _serverId?: string;
    private _wsServer?: WebSocketForce<WSLike>;
    private _activeAttemptWs?: WebSocketForce<WSLike>;
    private _loopAbortController?: AbortController;
    private _on = false;

    public get serverId() {
        return this._serverId;
    }

    public constructor(private _options: RemoteClientOptions<Constructor>) {
        _options.id ??= generateRemoteId('client');
        _options.logAuthFlow = _options.verbose || (_options.logAuthFlow ?? _options.debugging);

        if (_options.fullTrustedRPC) {
            assertFullTrustedRPCSupport(_options.perfectWSConstructor, 'RemoteClient');
        }

        const ProtocolConstructor = (_options.perfectWSConstructor ?? PerfectWS) as Constructor;
        const client = this._client = ProtocolConstructor.client({ debugging: _options.debugging, clientId: _options.id });

        if (_options.debugging) {
            client.router.config.runPingLoop = false;
            client.router.config.enableAckSystem = false;
        }

        if (_options.verbose) {
            client.router.config.verbose = true;
        }

        if (_options.fullTrustedRPC) {
            client.router.config.fullTrustedRPC = true;
        }

        _options.autoReconnect ??= true;
        _options.delayBeforeReconnect ??= DEFAULT_DELAY_BEFORE_RECONNECT;
        _options.passwordFailureDelay ??= DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY;
    }

    public get router(): RouterFor<Constructor> {
        return this._client.router as RouterFor<Constructor>;
    }

    public start() {
        if (this._on) {
            return;
        }
        this._on = true;

        if (this._options.verbose) {
            console.log(`[PerfectWS::RemoteClient] RemoteClient started (${ this._options.id })`);
        };

        if (this._options.debugging) {
            console.log(`[PerfectWS::RemoteClient] Debugging mode enabled`);
        }

        const controller = this._loopAbortController = new AbortController();
        void this._connectionLoop(controller.signal).catch(error => {
            if (!controller.signal.aborted) {
                console.error('[PerfectWS::RemoteClient] Connection loop failed:', error);
            }
            this._on = false;
        });
    }

    private async _connectionLoop(signal: AbortSignal) {
        const autoReconnect = 'url' in this._options && this._options.autoReconnect;
        let attemptCount = 0;

        while (autoReconnect && this._on || attemptCount === 0) {
            if (this._options.logAuthFlow && attemptCount > 0) console.log(`[PerfectWS::RemoteClient] Connection closed, attempting to reconnect... (attempt ${ attemptCount })`);
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

            const wsServer = this._getWSServer();
            this._activeAttemptWs = wsServer;
            if (this._options.logAuthFlow) console.log('url' in this._options ? `[PerfectWS::RemoteClient] Connecting to ${ this._options.url }` : '[PerfectWS::RemoteClient] Attaching to provided socket');

            this._internalInitializeMethods(server, wsServer, () => detachAuthSocket?.());
            detachAuthSocket = server.attachClient(wsServer);

            await new Promise<void>(resolve => {
                if (wsServer.readyState === WebSocketForce.CLOSED) {
                    resolve();
                    return;
                }
                wsServer.addEventListener('close', (event: any) => {
                    closeCode = event?.code;
                    resolve();
                }, { once: true });
            });
            } catch (error) {
                if (this._options.logAuthFlow && !signal.aborted) {
                    console.error('[PerfectWS::RemoteClient] Connection attempt failed:', error);
                }
            } finally {
                detachAuthSocket?.();
                server.unregister();
            }

            if (this._options.logAuthFlow) {
                if (closeCode === WRONG_PASSWORD_CLOSE_CODE) {
                    console.log('[PerfectWS::RemoteClient] Rejected: wrong password');
                } else if (closeCode === RATE_LIMITED_CLOSE_CODE) {
                    console.log('[PerfectWS::RemoteClient] Rejected: rate limited');
                } else {
                    console.log('[PerfectWS::RemoteClient] Disconnected');
                }
            }

            if (autoReconnect && this._on) {
                const delay = isPasswordRejectionCloseCode(closeCode)
                    ? this._options.passwordFailureDelay!
                    : this._options.delayBeforeReconnect!;

                if (this._options.logAuthFlow) {
                    console.log(isPasswordRejectionCloseCode(closeCode)
                        ? `[PerfectWS::RemoteClient] Connection closed due to a password rejection, waiting ${ delay }ms before retrying`
                        : `[PerfectWS::RemoteClient] Retrying in ${ delay }ms`);
                }

                await sleep(delay, signal);
            }
        }

        this._on = false;
    }

    private _getWSServer() {
        let wsServer: WebSocketForce<WSLike>;

        if ('wsServer' in this._options) {
            if (!(this._options.wsServer instanceof WebSocketForce)) {
                wsServer = new WebSocketForce(this._options.wsServer);
            } else {
                wsServer = this._options.wsServer;
            }
        } else {
            const ws: WSLike = new (this._options.webSocketConstructor || WebSocket)(this._options.url);
            wsServer = new WebSocketForce(ws);
        }

        wsServer.addEventListener('error', () => {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteClient] Connection error`);
        });

        return wsServer;
    }

    private _internalInitializeMethods(
        server: ReturnType<typeof PerfectWS.server>,
        wsServer: WebSocketForce<WSLike>,
        detachAuthSocket: () => void = () => { }
    ) {
        let setInitializeMethods = false;

        server.router.on("___sh_password", async (serverId) => {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteClient] Password request from ${ serverId }`);

            return this._options.password;
        });

        server.router.on("___sh_id", async (serverId) => {
            this._serverId = serverId;

            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteClient] ID request from ${ serverId }`);

            if (!setInitializeMethods) {
                try {
                    await this.initializeMethods(server.router, { ws: wsServer, serverId });
                } catch (err) {
                    if (this._options.logAuthFlow) console.error('[PerfectWS::RemoteClient] initializeMethods threw:', err);
                    throw err;
                }
                setInitializeMethods = true;
            }

            return this._options.id;
        });

        server.router.on("___sh_initialized", async (peerInfo: { fullTrustedRPC?: boolean; } | null, { send }) => {
            if (this._options.logAuthFlow && !!this._options.fullTrustedRPC !== !!peerInfo?.fullTrustedRPC) {
                console.log(`[PerfectWS::RemoteClient] fullTrustedRPC mismatch (local=${ !!this._options.fullTrustedRPC }, server=${ !!peerInfo?.fullTrustedRPC }) - PureRPC will not work on this connection`);
            }

            if (this._options.logAuthFlow) console.log(`[PerfectWS::RemoteClient] Connection initialized (serverId=${ this._serverId })`);

            const hostReady = new Promise<boolean>(resolve => {
                const cleanup = () => {
                    wsServer.removeEventListener('message', onMessage);
                    wsServer.removeEventListener('close', onClose);
                };
                const onMessage = (event: any) => {
                    if (String(event.data) !== AUTH_READY_MESSAGE) return;
                    cleanup();
                    resolve(true);
                };
                const onClose = () => {
                    cleanup();
                    resolve(false);
                };

                wsServer.addEventListener('message', onMessage);
                wsServer.addEventListener('close', onClose);
            });

            await send({ fullTrustedRPC: !!this._options.fullTrustedRPC }, true);
            detachAuthSocket();
            server.unregister();

            // Wait until the host has replaced its temporary auth router.
            if (!await hostReady) return;

            this._wsServer = wsServer;
            this._client.setServer(wsServer);
        });
    }

    /**
     * Extra method we want to expose the server could initialize on the client side state.
     * This is a simple PerfectWS router - does not use the perfectWSConstructor for internal initialization.
     */
    protected initializeMethods(router: ReturnType<typeof PerfectWS.server>['router'], options: InitializeRemoteClient): any | Promise<any> {

    }

    public stop() {
        this._on = false;
        this._loopAbortController?.abort('RemoteClient stopped');
        this._loopAbortController = undefined;
        this._wsServer?.close(1000, "RemoteClient stopped");
        this._wsServer = undefined;
        this._activeAttemptWs?.forceClose(1000, "RemoteClient stopped");
        this._activeAttemptWs = undefined;
        this._client.unregister();
    }
}
