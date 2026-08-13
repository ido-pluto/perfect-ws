import { IncomingMessage } from 'http';
import { WebSocketServer } from 'ws';
import { PerfectWS } from '../../PerfectWS.js';
import { WebSocketForce, WSLike } from '../../utils/WebSocketForce.js';
import { DEFAULT_HOST, DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_MESSAGE_SIZE, DEFAULT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS, DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS, DEFAULT_PORT, DEFAULT_REQUEST_TIMEOUT, RATE_LIMITED_CLOSE_CODE, WRONG_PASSWORD_CLOSE_CODE } from '../config.js';
import { assertFullTrustedRPCSupport } from '../utils/assertFullTrustedRPCSupport.js';
import { generateRemoteId } from '../utils/generateRemoteId.js';
import { PasswordRateLimiter } from '../utils/PasswordRateLimiter.js';
import { validatePassword } from '../utils/validatePassword.js';

export type ClientHostOptions<Constructor extends typeof PerfectWS = typeof PerfectWS> = {
    id?: string;
    password?: string | string[] | ((password: any, ws: WSLike, request?: IncomingMessage) => boolean | Promise<boolean>);
    wsServer?: WebSocketServer;
    port?: number;
    host?: string;
    debugging?: boolean;
    verbose?: boolean;
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
    /** Protocol implementation for the persistent router. Defaults to the BSON-only PerfectWS. */
    perfectWSConstructor?: Constructor;
    /** Max concurrent connections (pending + attached). Defaults to 10_000. */
    maxConnections?: number;
    /** Max incoming WebSocket message size in bytes. Defaults to 30MB. */
    maxMessageSize?: number;
    /** Disabled automatically when `debugging` is true. Set to `false` to disable explicitly. */
    passwordRateLimit?: false | {
        maxAttempts?: number;
        windowMs?: number;
        /** Defaults to `request.socket.remoteAddress`, which is the proxy's IP behind nginx/Cloudflare - override to read a trusted forwarding header (e.g. `CF-Connecting-IP`) instead. */
        getClientKey?: (request?: IncomingMessage) => string | undefined;
    };
}

export type InitializedServer = {
    ws: WebSocketForce;
    serverId: string;
    request?: IncomingMessage;
}

type RouterFor<Constructor extends typeof PerfectWS> = ReturnType<Constructor['client']>['router'];

export class ClientHost<Constructor extends typeof PerfectWS = typeof PerfectWS> {
    public REQUEST_TIME_OUT = DEFAULT_REQUEST_TIMEOUT;

    private readonly _client: ReturnType<typeof PerfectWS.client>;
    
    private _wsServer?: WebSocketServer;
    private _lastSocket?: WebSocketForce;
    private _lastServerId?: string;
    private _connectionCount = 0;
    private _pendingSockets = new Set<WebSocketForce>();
    private _passwordLimiter?: PasswordRateLimiter;
    private _getRateLimitKey: (request?: IncomingMessage) => string | undefined;

    public get serverId() {
        return this._lastServerId;
    }

    public constructor(private _options: ClientHostOptions<Constructor> = {}) {
        _options.id ??= generateRemoteId('client');
        _options.logAuthFlow = _options.verbose || (_options.logAuthFlow ?? _options.debugging);

        if (_options.fullTrustedRPC) {
            assertFullTrustedRPCSupport(_options.perfectWSConstructor, 'ClientHost');
        }

        const ProtocolConstructor = (_options.perfectWSConstructor ?? PerfectWS) as Constructor;
        this._client = ProtocolConstructor.client({ debugging: _options.debugging, clientId: _options.id });

        if (_options.verbose) {
            this._client.router.config.verbose = true;
        }

        if (_options.fullTrustedRPC) {
            this._client.router.config.fullTrustedRPC = true;
        }

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
        return this._client.router as RouterFor<Constructor>;
    }

    public start() {
        if (this._wsServer) {
            return;
        }

        if (this._options.verbose) {
            console.log(`[PerfectWS::ClientHost] ClientHost started on ${ this._options.host }:${ this._options.port }`);
        }

        if (this._options.debugging) {
            console.log(`[PerfectWS::ClientHost] Debugging mode enabled`);
        }

        const wss = this._wsServer = (this._options.wsServer ?? new WebSocketServer({ port: this._options.port, host: this._options.host, maxPayload: this._options.maxMessageSize }));

        wss.on('error', (err) => {
            console.error('[PerfectWS::ClientHost] WS Server error:', err);
        });

        wss.addListener('connection', (ws, request) => this._onConnection(ws, request));
    }

    private async _onConnection(ws: WSLike, request?: IncomingMessage) {
        if (this._connectionCount >= this._options.maxConnections!) {
            if (this._options.verbose) console.log(`[PerfectWS::ClientHost] Connection rejected - server at max capacity (${ this._options.maxConnections })`);
            ws.close(1013, "Server is at maximum capacity");
            return;
        }

        this._connectionCount++;
        if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Connection accepted` + (request?.socket?.remoteAddress ? ` (${ request.socket.remoteAddress })` : ''));

        const forceWS: WebSocketForce = new WebSocketForce(ws);
        this._pendingSockets.add(forceWS);
        forceWS.on('close', () => {
            this._connectionCount--;
            this._pendingSockets.delete(forceWS);
        });

        const { router, setServer, unregister, detachServer } = PerfectWS.client({ temp: true, debugging: this._options.debugging });
        forceWS.on('close', unregister);
        if (this._options.verbose) {
            router.config.verbose = true;
        }

        setServer(forceWS);

        try {
        const rateLimitKey = this._getRateLimitKey(request);
        if (this._passwordLimiter && rateLimitKey && this._passwordLimiter.isBlocked(rateLimitKey)) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Connection rejected - too many failed password attempts (${ rateLimitKey })`);
            forceWS.close(RATE_LIMITED_CLOSE_CODE, "Too many failed attempts, try again later");
            return;
        }

        if (!await this._passwordValidation(forceWS, router, request)) {
            if (rateLimitKey) this._passwordLimiter?.recordFailure(rateLimitKey);
            return;
        }
        if (rateLimitKey) this._passwordLimiter?.reset(rateLimitKey);

        const serverId = await this._getServerId(forceWS, router);
        if (!serverId) {
            return;
        }

        if (this._lastServerId === serverId && this._lastSocket?.readyState == WebSocketForce.OPEN) {
            await this._lastSocket.once('close');
        }

        if (forceWS.readyState != WebSocketForce.OPEN) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Server disconnected during validation (${ serverId })`);
            forceWS.close(3000, "Server disconnected during validation");
            return;
        }

        try {
            const initializedServer = this.initializeServer(router, { ws: forceWS, serverId, request });
            if (initializedServer instanceof Promise) {
                await initializedServer;
            }
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ClientHost] error during server initialization:', err);
            forceWS.close(3000, "Error during server initialization");
            return;
        }

        if (forceWS.readyState != WebSocketForce.OPEN) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Server disconnected during initialization (${ serverId })`);
            forceWS.close(3000, "Server disconnected during initialization");
            return;
        }

        if (!await this._finalizeInitializeServer(router)) {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Server disconnected during internal initialization (${ serverId })`);
            forceWS.close(3000, "Server disconnected during internal initialization");
            return;
        }

        detachServer();
        try {
            this._client.setServer(forceWS);
        } catch {
            forceWS.close(3000, 'Unable to attach authenticated server');
            return;
        }
        this._lastSocket = forceWS;
        this._lastServerId = serverId;
        this._pendingSockets.delete(forceWS);
        if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Server connected (${ serverId })`);

        forceWS.on('error', (err) => {
            if (this._options.verbose) console.error('[PerfectWS::ClientHost] Server connection error:', err);
        });

        forceWS.on('close', () => {
            if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Server disconnected (${ this._lastServerId })`);
        });
        } finally {
            forceWS.off('close', unregister);
            unregister();
        }
    }

    private async _passwordValidation(forceSocket: WebSocketForce, router: ReturnType<typeof PerfectWS.client>['router'], request?: IncomingMessage) {
        try {
            const password = await router.request('___ch_password', this._options.id, { timeout: this.REQUEST_TIME_OUT, doNotWaitForConnection: true });

            const isValid = await validatePassword(password, { forceSocket, request, password: this._options.password });

            if (!isValid) {
                if (this._options.logAuthFlow) console.log(`[PerfectWS::ClientHost] Server disconnected - wrong password`);
                forceSocket.forceClose(WRONG_PASSWORD_CLOSE_CODE, "Wrong password");
                return false;
            }
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ClientHost] error during password validation:', err);
            forceSocket.close(3000, "Error during password validation");
            return false;
        }

        return true;
    }

    private async _getServerId(forceSocket: WebSocketForce, router: ReturnType<typeof PerfectWS.client>['router']) {
        try {
            const serverId = await router.request('___ch_id', this._options.id, { timeout: this.REQUEST_TIME_OUT, doNotWaitForConnection: true });
            if (!serverId) {
                throw new Error("Server did not provide an ID");
            }
            return serverId;
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ClientHost] error during getServerId:', err);
            forceSocket.close(3000, "Error during getServerId");
            return null;
        }
    }


    private async _finalizeInitializeServer(router: ReturnType<typeof PerfectWS.client>['router']) {
        try {
            const peerInfo: { fullTrustedRPC?: boolean; } | null = await router.request(
                '___ch_initialized', { fullTrustedRPC: !!this._options.fullTrustedRPC },
                { timeout: this.REQUEST_TIME_OUT, doNotWaitForConnection: true }
            );

            if (this._options.logAuthFlow && !!this._options.fullTrustedRPC !== !!peerInfo?.fullTrustedRPC) {
                console.log(`[PerfectWS::ClientHost] fullTrustedRPC mismatch (local=${ !!this._options.fullTrustedRPC }, server=${ !!peerInfo?.fullTrustedRPC }) - PureRPC will not work on this connection`);
            }
        } catch (err) {
            if (this._options.logAuthFlow) console.error('[PerfectWS::ClientHost] error during finalizeInitializeServer:', err);
            return false;
        }

        return true;
    }


    /**
     * Initialize the server state like with methods define in the server `initializeMethods`.
     * This is a simple PerfectWS router - does not use the perfectWSConstructor for internal initialization.
     */
    protected initializeServer(router: ReturnType<typeof PerfectWS.client>['router'], options: InitializedServer): any | Promise<any> {

    }

    public stop() {
        if (this._wsServer) {
            this._wsServer.close();
            this._wsServer = undefined;
        }

        for (const pending of this._pendingSockets) {
            pending.close(3000, "ClientHost stopped");
        }
        this._pendingSockets.clear();

        if (this._lastSocket) {
            this._lastSocket.close(1000, "ClientHost closed");
            this._lastSocket = undefined;
        }

        this._client.unregister();

        this._passwordLimiter?.stop();
    }
}
