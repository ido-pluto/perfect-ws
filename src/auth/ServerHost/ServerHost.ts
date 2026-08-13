import { IncomingMessage } from "http";
import { WebSocketServer } from "ws";
import { PerfectWS } from "../../PerfectWS.js";
import { WebSocketForce, WSLike } from "../../utils/WebSocketForce.js";
import { AUTH_READY_MESSAGE, DEFAULT_HOST, DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_MESSAGE_SIZE, DEFAULT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS, DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS, DEFAULT_PORT, DEFAULT_REQUEST_TIMEOUT, RATE_LIMITED_CLOSE_CODE, WRONG_PASSWORD_CLOSE_CODE } from "../config.js";
import { assertFullTrustedRPCSupport } from "../utils/assertFullTrustedRPCSupport.js";
import { generateRemoteId } from "../utils/generateRemoteId.js";
import { PasswordRateLimiter } from "../utils/PasswordRateLimiter.js";
import { validatePassword } from "../utils/validatePassword.js";

export type ServerHostOptions<Constructor extends typeof PerfectWS = typeof PerfectWS> = {
    id?: string;
    password?: string | string[] | ((password: any, ws: WSLike, request?: IncomingMessage) => boolean | Promise<boolean>);
    verbose?: boolean;
    debugging?: boolean;
    /**
     * Logs auth handshake lifecycle events (connected, rejected, disconnected,
     * unusual throws/closes) - the same lines `verbose` prints for these events,
     * without enabling verbose's full per-request tracing. Defaults to following
     * `debugging`; set explicitly to override that. `verbose: true` always forces
     * this on regardless, since these events are a subset of what verbose already logs.
     */
    logAuthFlow?: boolean;
    /** Enables PureRPC. Both peers must explicitly use PerfectWSAdvanced and opt in. */
    fullTrustedRPC?: boolean;
    wsServer?: WebSocketServer;
    port?: number;
    host?: string;
    /** Protocol implementation for the persistent router. Defaults to the BSON-only PerfectWS. */
    perfectWSConstructor?: Constructor;
    /** Max concurrent connections (pending + attached). Defaults to `DEFAULT_MAX_CONNECTIONS`. */
    maxConnections?: number;
    /** Max incoming WebSocket message size in bytes. Defaults to `DEFAULT_MAX_MESSAGE_SIZE` (30MB). */
    maxMessageSize?: number;
    /** Disabled automatically when `debugging` is true. Set to `false` to disable explicitly. */
    passwordRateLimit?: false | {
        maxAttempts?: number;
        windowMs?: number;
        /** Defaults to `request.socket.remoteAddress`, which is the proxy's IP behind nginx/Cloudflare - override to read a trusted forwarding header (e.g. `CF-Connecting-IP`) instead. */
        getClientKey?: (request?: IncomingMessage) => string | undefined;
    };
}

export type InitializedClient = {
    ws: WebSocketForce;
    clientId: string;
    request?: IncomingMessage;
}

type RouterFor<Constructor extends typeof PerfectWS> = ReturnType<Constructor['server']>['router'];

export class ServerHost<Constructor extends typeof PerfectWS = typeof PerfectWS> {
    public REQUEST_TIME_OUT = DEFAULT_REQUEST_TIMEOUT;
    public clients: Map<string, WebSocketForce<WSLike>> = new Map();

    private _wsServer?: WebSocketServer;
    private _server: ReturnType<typeof PerfectWS.server>;
    private _on = false;
    private _connectionCount = 0;
    private _pendingSockets = new Set<WebSocketForce>();
    private _passwordLimiter?: PasswordRateLimiter;
    private _getRateLimitKey: (request?: IncomingMessage) => string | undefined;

    public constructor(private _options: ServerHostOptions<Constructor> = {}) {
        _options.logAuthFlow = _options.verbose || (_options.logAuthFlow ?? _options.debugging);

        if (_options.fullTrustedRPC) {
            assertFullTrustedRPCSupport(_options.perfectWSConstructor, 'ServerHost');
        }

        const ProtocolConstructor = (this._options.perfectWSConstructor ?? PerfectWS) as Constructor;
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

        this._options.id ??= generateRemoteId('server');

        this._options.host ??= DEFAULT_HOST;
        this._options.port ??= DEFAULT_PORT;
        this._options.maxConnections ??= DEFAULT_MAX_CONNECTIONS;
        this._options.maxMessageSize ??= DEFAULT_MAX_MESSAGE_SIZE;

        this._getRateLimitKey = (typeof _options.passwordRateLimit === 'object' && _options.passwordRateLimit.getClientKey)
            || ((request) => request?.socket?.remoteAddress);

        // brute-force guard is off in debugging mode so local/dev testing isn't throttled
        if (!_options.debugging && _options.passwordRateLimit !== false) {
            this._passwordLimiter = new PasswordRateLimiter(
                _options.passwordRateLimit?.maxAttempts ?? DEFAULT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
                _options.passwordRateLimit?.windowMs ?? DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS
            );
        }
    }

    public get router(): RouterFor<Constructor> {
        return this._server.router as RouterFor<Constructor>;
    }

    public start() {
        if (this._on) {
            return;
        }
        this._on = true;

        const wss = this._wsServer = this._options.wsServer ?? new WebSocketServer({
            port: this._options.port,
            host: this._options.host,
            maxPayload: this._options.maxMessageSize
        });

        wss.on("error", (err) => {
            console.error('[PerfectWS::ServerHost] WS Server error:', err);
        });

        wss.on("connection", (ws: WSLike, request?: IncomingMessage) => this._onConnection(ws, request));

        if (this._options.verbose) {
            console.log(`[PerfectWS::ServerHost] ServerHost started on ${ this._options.host }:${ this._options.port }`);
        }

        if (this._options.debugging) {
            console.log(`[PerfectWS::ServerHost] Debugging mode enabled`);
        }
    }

    private async _onConnection(ws: WSLike, request?: IncomingMessage) {
        if (this._connectionCount >= this._options.maxConnections!) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Connection rejected - server at max capacity (${ this._options.maxConnections })`);
            ws.close(1013, "Server is at maximum capacity");
            return;
        }

        this._connectionCount++;
        if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Connection accepted` + (request?.socket?.remoteAddress ? ` (${ request.socket.remoteAddress })` : ''));

        const forceWS: WebSocketForce & { clientId?: string } = new WebSocketForce(ws);
        this._pendingSockets.add(forceWS);
        forceWS.on('close', () => {
            this._connectionCount--;
            this._pendingSockets.delete(forceWS);
        });

        const { router, unregister, detachServer, setServer } = PerfectWS.client({ temp: true, debugging: this._options.debugging });
        forceWS.on('close', unregister);

        if (this._options.verbose) {
            router.config.verbose = true;
        }

        setServer(forceWS);

        try {
        const rateLimitKey = this._getRateLimitKey(request);
        if (this._passwordLimiter && rateLimitKey && this._passwordLimiter.isBlocked(rateLimitKey)) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Connection rejected - too many failed password attempts (${ rateLimitKey })`);
            forceWS.close(RATE_LIMITED_CLOSE_CODE, "Too many failed attempts, try again later");
            return;
        }

        if (!await this._passwordValidation(forceWS, router, request)) {
            if (rateLimitKey) this._passwordLimiter?.recordFailure(rateLimitKey);
            return;
        }
        if (rateLimitKey) this._passwordLimiter?.reset(rateLimitKey);

        const clientId = await this._getClientId(forceWS, router);
        if (!clientId) {
            return;
        }

        if (this.clients.has(clientId)) {
            const lastClientIdWS = this.clients.get(clientId)!;
            if (lastClientIdWS.readyState == WebSocketForce.OPEN) {
                await lastClientIdWS.once('close');
            } else {
                lastClientIdWS.close(3000, "New connection with same clientId");
            }
        }

        try {
            const initializedClient = this.initializeClient(router, { ws: forceWS, clientId, request });
            if (initializedClient instanceof Promise) {
                await initializedClient;
            }
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ServerHost] error during initializeClient:', err);
            forceWS.close(3000, "Error during client initialization");
            return;
        }

        if (forceWS.readyState != WebSocketForce.OPEN) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Client disconnected during initialization (${ clientId })`);
            forceWS.close(3000, "Client disconnected during initialization");
            return;
        }

        if (!await this._finalizeInitializeClient(router)) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Client disconnected during internal initialization (${ clientId })`);
            forceWS.close(3000, "Client disconnected during internal initialization");
            return;
        }

        forceWS.clientId = clientId;
        detachServer();
        let cleanup: () => void;
        try {
            cleanup = this._server.attachClient(forceWS);
        } catch {
            forceWS.close(3000, 'Unable to attach authenticated client');
            return;
        }
        this._pendingSockets.delete(forceWS);
        this.clients.set(clientId, forceWS);
        if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Client connected (${ clientId })`);

        forceWS.on('error', (err) => {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ServerHost] Server connection error:', err);
        });

        forceWS.on('close', () => {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Client disconnected (${ clientId })`);
            this.clients.delete(clientId);
            cleanup();
        });

        forceWS.send(AUTH_READY_MESSAGE);
        } finally {
            forceWS.off('close', unregister);
            unregister();
        }
    }

    private async _passwordValidation(forceSocket: WebSocketForce, router: ReturnType<typeof PerfectWS.client>['router'], request?: IncomingMessage) {
        try {
            const password = await router.request('___sh_password', this._options.id, { timeout: this.REQUEST_TIME_OUT, doNotWaitForConnection: true });

            const isValid = await validatePassword(password, { forceSocket, request, password: this._options.password });

            if (!isValid) {
                if (this._options.logAuthFlow) console.log(`[PerfectWS::ServerHost] Client disconnected - wrong password`);
                forceSocket.forceClose(WRONG_PASSWORD_CLOSE_CODE, "Wrong password");
                return false;
            }
            return true;
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ServerHost] error during password validation:', err);
            forceSocket.close(3000, "Error during password validation");
            return false;
        }
    }

    private async _getClientId(forceSocket: WebSocketForce, router: ReturnType<typeof PerfectWS.client>['router']) {
        try {
            const clientId = await router.request('___sh_id', this._options.id, { timeout: this.REQUEST_TIME_OUT, doNotWaitForConnection: true });
            if (!clientId) {
                throw new Error("Client did not provide an ID");
            }
            return clientId;
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ServerHost] error during getClientId:', err);
            forceSocket.close(3000, "Error during getClientId");
            return null;
        }
    }

    private async _finalizeInitializeClient(router: ReturnType<typeof PerfectWS.client>['router']) {
        try {
            const peerInfo: { fullTrustedRPC?: boolean; } | null = await router.request(
                '___sh_initialized', { fullTrustedRPC: !!this._options.fullTrustedRPC },
                { timeout: this.REQUEST_TIME_OUT, doNotWaitForConnection: true }
            );

            if (this._options.logAuthFlow && !!this._options.fullTrustedRPC !== !!peerInfo?.fullTrustedRPC) {
                console.log(`[PerfectWS::ServerHost] fullTrustedRPC mismatch (local=${ !!this._options.fullTrustedRPC }, client=${ !!peerInfo?.fullTrustedRPC }) - PureRPC will not work on this connection`);
            }
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ServerHost] error during finalizeInitializeClient:', err);
            return false;
        }

        return true;
    }

    /**
     * Initialize the client state like with methods define in the client `initializeMethods`.
     * This is a simple PerfectWS router - does not use the perfectWSConstructor for internal initialization.
     */
    protected initializeClient(router: ReturnType<typeof PerfectWS.client>['router'], options: InitializedClient): any | Promise<any> {

    }

    stop() {
        this._on = false;

        if (this._server) {
            this._server.unregister();
        }

        if (this._wsServer) {
            this._wsServer.close();
            this._wsServer = undefined;
        }

        for (const pending of this._pendingSockets) {
            pending.close(3000, "ServerHost stopped");
        }
        this._pendingSockets.clear();

        for (const wsClient of this.clients.values()) {
            wsClient.close(3000, "ServerHost stopped");
        }

        this.clients.clear();
        this._passwordLimiter?.stop();
    }
}
