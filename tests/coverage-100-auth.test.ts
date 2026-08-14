// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientHost } from '../src/auth/ClientHost/ClientHost.js';
import { RemoteServer } from '../src/auth/ClientHost/RemoteServer.js';
import { RemoteClient } from '../src/auth/ServerHost/RemoteClient.js';
import { ServerHost } from '../src/auth/ServerHost/ServerHost.js';
import { AUTH_READY_MESSAGE, RATE_LIMITED_CLOSE_CODE } from '../src/auth/config.js';
import { PerfectWS } from '../src/PerfectWS.js';
import { WebSocketForce, type WSLike } from '../src/utils/WebSocketForce.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch { }
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function rawSocket(readyState = WebSocketForce.OPEN) {
    const listeners = new Map<string, Function[]>();
    const ws: WSLike = {
        url: 'ws://test', protocol: '', extensions: '', binaryType: 'arraybuffer', bufferedAmount: 0, readyState,
        onopen: null, onclose: null, onerror: null, onmessage: null,
        send: vi.fn(), close: vi.fn(),
        addEventListener(type, listener) {
            const entries = listeners.get(type) ?? [];
            entries.push(listener);
            listeners.set(type, entries);
        },
        removeEventListener(type, listener) {
            listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== listener));
        },
    };
    return {
        ws,
        emit(type: string, event: any = new Event(type)) {
            for (const listener of [...listeners.get(type) ?? []]) listener(event);
        },
    };
}

function fakeWSServer() {
    const listeners = new Map<string, Function>();
    return {
        on: vi.fn((event: string, listener: Function) => listeners.set(event, listener)),
        addListener: vi.fn((event: string, listener: Function) => listeners.set(event, listener)),
        close: vi.fn(),
        emit(event: string, value?: any) { listeners.get(event)?.(value); },
    };
}

describe('internally managed host servers', () => {
    it('binds both host directions directly to an OS-assigned port', async () => {
        const clientHost = new ClientHost({ debugging: true, port: 0 });
        const serverHost = new ServerHost({ debugging: true, port: 0 });
        cleanups.push(() => clientHost.stop(), () => serverHost.stop());

        clientHost.start();
        serverHost.start();
        const clientWss = (clientHost as any)._wsServer;
        const serverWss = (serverHost as any)._wsServer;
        await Promise.all([
            new Promise<void>(resolve => clientWss.once('listening', resolve)),
            new Promise<void>(resolve => serverWss.once('listening', resolve)),
        ]);

        expect(clientWss.address().port).toBeGreaterThan(0);
        expect(serverWss.address().port).toBeGreaterThan(0);
    });

    it('closes pending ServerHost sockets during stop', () => {
        const host = new ServerHost({ debugging: true });
        const raw = rawSocket();
        const connected = rawSocket();
        (host as any)._pendingSockets.add(new WebSocketForce(raw.ws));
        host.clients.set('connected', new WebSocketForce(connected.ws));

        host.stop();

        expect(raw.ws.close).toHaveBeenCalledWith(3000, 'ServerHost stopped');
        expect(connected.ws.close).toHaveBeenCalledWith(3000, 'ServerHost stopped');
    });
});

describe('ClientHost remaining failure paths', () => {
    it('logs a verbose capacity rejection', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const host = new ClientHost({ debugging: true, verbose: true, maxConnections: 0 });
        cleanups.push(() => host.stop());
        const full = rawSocket();

        await (host as any)._onConnection(full.ws);

        expect(log).toHaveBeenCalledWith('[PerfectWS::ClientHost] Connection rejected - server at max capacity (0)');
    });

    it('starts only once and reports WebSocket server errors', () => {
        const wss = fakeWSServer();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = new ClientHost({ wsServer: wss as any, verbose: true, debugging: true });
        cleanups.push(() => host.stop());

        host.start();
        host.start();
        wss.emit('error', new Error('listen failed'));

        expect(wss.addListener).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalled();
    });

    it('handles missing ids and request failures during handshake finalization', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = new ClientHost({ debugging: true, logAuthFlow: true });
        cleanups.push(() => host.stop());
        const forceSocket = { close: vi.fn() } as any;

        expect(await (host as any)._getServerId(forceSocket, { request: vi.fn().mockResolvedValue(null) })).toBeNull();
        expect(await (host as any)._getServerId(forceSocket, { request: vi.fn().mockRejectedValue(new Error('id failed')) })).toBeNull();
        expect(await (host as any)._finalizeInitializeServer({ request: vi.fn().mockRejectedValue(new Error('finalize failed')) })).toBe(false);

        expect(forceSocket.close).toHaveBeenCalled();
        expect(log).toHaveBeenCalled();
    });

    it('rejects sockets that disconnect during validation or internal initialization', async () => {
        const host = new ClientHost({ debugging: true, logAuthFlow: true });
        cleanups.push(() => host.stop());
        vi.spyOn(host as any, '_passwordValidation').mockResolvedValue(true);
        vi.spyOn(host as any, '_getServerId').mockResolvedValue('server');

        const disconnected = rawSocket(WebSocketForce.CLOSED);
        await (host as any)._onConnection(disconnected.ws);
        expect(disconnected.ws.close).toHaveBeenCalledWith(3000, 'Server disconnected during validation');

        const open = rawSocket();
        vi.spyOn(host as any, '_finalizeInitializeServer').mockResolvedValue(false);
        await (host as any)._onConnection(open.ws);
        expect(open.ws.close).toHaveBeenCalledWith(3000, 'Server disconnected during internal initialization');
    });

    it('stops initialization when the server does not provide an id', async () => {
        const host = new ClientHost({ debugging: true });
        cleanups.push(() => host.stop());
        vi.spyOn(host as any, '_passwordValidation').mockResolvedValue(true);
        vi.spyOn(host as any, '_getServerId').mockResolvedValue(null);
        const open = rawSocket();

        await (host as any)._onConnection(open.ws);

        expect((host as any)._lastServerId).toBeUndefined();
    });

    it('logs errors emitted by an attached server when verbose', async () => {
        const host = new ClientHost({ debugging: true, verbose: true });
        cleanups.push(() => host.stop());
        vi.spyOn(host as any, '_passwordValidation').mockResolvedValue(true);
        vi.spyOn(host as any, '_getServerId').mockResolvedValue('server');
        vi.spyOn(host as any, '_finalizeInitializeServer').mockResolvedValue(true);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const open = rawSocket();
        const off = vi.spyOn(WebSocketForce.prototype, 'off');

        await (host as any)._onConnection(open.ws);
        open.emit('error', new Error('socket failed'));
        expect(error).toHaveBeenCalled();
        expect(off).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('closes a promoted server if the persistent client router was already released', async () => {
        const host = new ClientHost({ debugging: true });
        cleanups.push(() => host.stop());
        vi.spyOn(host as any, '_passwordValidation').mockResolvedValue(true);
        vi.spyOn(host as any, '_getServerId').mockResolvedValue('server');
        vi.spyOn(host as any, '_finalizeInitializeServer').mockResolvedValue(true);
        vi.spyOn((host as any)._client, 'setServer').mockImplementation(() => {
            throw new Error('released');
        });
        const open = rawSocket();

        await (host as any)._onConnection(open.ws);

        expect(open.ws.close).toHaveBeenCalledWith(3000, 'Unable to attach authenticated server');
        expect(host.serverId).toBeUndefined();
    });
});

describe('ServerHost remaining failure paths', () => {
    it('uses custom rate-limit configuration and safely skips a limiter in debugging mode', async () => {
        const configured = new ServerHost({
            passwordRateLimit: { maxAttempts: 2, windowMs: 25, getClientKey: () => 'custom' },
        });
        cleanups.push(() => configured.stop());
        expect((configured as any)._getRateLimitKey()).toBe('custom');
        const recordFailure = vi.spyOn((configured as any)._passwordLimiter, 'recordFailure');
        const reset = vi.spyOn((configured as any)._passwordLimiter, 'reset');
        vi.spyOn(configured as any, '_passwordValidation').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        vi.spyOn(configured as any, '_getClientId').mockResolvedValue(null);
        await (configured as any)._onConnection(rawSocket().ws);
        await (configured as any)._onConnection(rawSocket().ws);
        expect(recordFailure).toHaveBeenCalledWith('custom');
        expect(reset).toHaveBeenCalledWith('custom');

        const host = new ServerHost({
            debugging: true,
            passwordRateLimit: { getClientKey: () => 'debug-key' },
        });
        cleanups.push(() => host.stop());

        vi.spyOn(host as any, '_passwordValidation').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        vi.spyOn(host as any, '_getClientId').mockResolvedValue(null);
        await (host as any)._onConnection(rawSocket().ws);
        await (host as any)._onConnection(rawSocket().ws);

        expect((host as any)._passwordLimiter).toBeUndefined();
    });

    it('starts once, configures verbose auth, and reports server errors', () => {
        const wss = fakeWSServer();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = new ServerHost({ wsServer: wss as any, verbose: true, debugging: true });
        cleanups.push(() => host.stop());

        host.start();
        host.start();
        wss.emit('error', new Error('listen failed'));
        expect(error).toHaveBeenCalled();
    });

    it('rejects capacity and rate-limited connections', async () => {
        const host = new ServerHost({ debugging: true, logAuthFlow: true, maxConnections: 0 });
        cleanups.push(() => host.stop());
        const full = rawSocket();
        await (host as any)._onConnection(full.ws);
        expect(full.ws.close).toHaveBeenCalledWith(1013, 'Server is at maximum capacity');

        const rateLimited = new ServerHost({ debugging: true, logAuthFlow: true });
        cleanups.push(() => rateLimited.stop());
        (rateLimited as any)._passwordLimiter = { isBlocked: () => true, stop: vi.fn() };
        (rateLimited as any)._getRateLimitKey = () => 'ip';
        const blocked = rawSocket();
        await (rateLimited as any)._onConnection(blocked.ws);
        expect(blocked.ws.close).toHaveBeenCalled();
    });

    it('handles missing client ids and failed finalization requests', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = new ServerHost({ debugging: true, logAuthFlow: true });
        cleanups.push(() => host.stop());
        const forceSocket = { close: vi.fn() } as any;

        expect(await (host as any)._getClientId(forceSocket, { request: vi.fn().mockResolvedValue(null) })).toBeNull();
        expect(await (host as any)._finalizeInitializeClient({ request: vi.fn().mockRejectedValue(new Error('failed')) })).toBe(false);
        expect(log).toHaveBeenCalled();
    });

    it('handles password request throws with auth logging', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = new ServerHost({ debugging: true, logAuthFlow: true });
        cleanups.push(() => host.stop());
        const socket = { close: vi.fn() } as any;

        expect(await (host as any)._passwordValidation(socket, { request: vi.fn().mockRejectedValue(new Error('failed')) })).toBe(false);
        expect(socket.close).toHaveBeenCalled();
        expect(log).toHaveBeenCalled();
    });

    it('handles disconnects, duplicate closed clients, failed finalization, and socket errors', async () => {
        const host = new ServerHost({ debugging: true, logAuthFlow: true, verbose: true });
        cleanups.push(() => host.stop());
        vi.spyOn(host as any, '_passwordValidation').mockResolvedValue(true);
        vi.spyOn(host as any, '_getClientId').mockResolvedValue('client');

        const disconnected = rawSocket(WebSocketForce.CLOSED);
        await (host as any)._onConnection(disconnected.ws);
        expect(disconnected.ws.close).toHaveBeenCalledWith(3000, 'Client disconnected during initialization');

        const old = rawSocket(WebSocketForce.CLOSED);
        host.clients.set('client', new WebSocketForce(old.ws));
        const next = rawSocket();
        vi.spyOn(host as any, '_finalizeInitializeClient').mockResolvedValue(false);
        await (host as any)._onConnection(next.ws);
        expect(old.ws.close).toHaveBeenCalledWith(3000, 'New connection with same clientId');
        expect(next.ws.close).toHaveBeenCalledWith(3000, 'Client disconnected during internal initialization');

        host.clients.clear();
        const connected = rawSocket();
        vi.spyOn(host as any, '_finalizeInitializeClient').mockResolvedValue(true);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const off = vi.spyOn(WebSocketForce.prototype, 'off');
        await (host as any)._onConnection(connected.ws);
        connected.emit('error', new Error('socket failed'));
        expect(error).toHaveBeenCalled();
        expect(off).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('closes a promoted client if the persistent server router was already released', async () => {
        const host = new ServerHost({ debugging: true });
        cleanups.push(() => host.stop());
        vi.spyOn(host as any, '_passwordValidation').mockResolvedValue(true);
        vi.spyOn(host as any, '_getClientId').mockResolvedValue('client');
        vi.spyOn(host as any, '_finalizeInitializeClient').mockResolvedValue(true);
        vi.spyOn((host as any)._server, 'attachClient').mockImplementation(() => {
            throw new Error('released');
        });
        const open = rawSocket();

        await (host as any)._onConnection(open.ws);

        expect(open.ws.close).toHaveBeenCalledWith(3000, 'Unable to attach authenticated client');
    });
});

describe('remote peer remaining paths', () => {
    it('constructs URL sockets with custom and global WebSocket constructors', () => {
        const constructed: string[] = [];
        class FakeWebSocket {
            constructor(url: string | URL) {
                constructed.push(String(url));
                return rawSocket().ws;
            }
        }
        vi.stubGlobal('WebSocket', FakeWebSocket);

        const remoteServerDefault = new RemoteServer({ debugging: true });
        const remoteServerCustom = new RemoteServer({ debugging: true, webSocketConstructor: FakeWebSocket as any });
        const remoteClientDefault = new RemoteClient({ debugging: true, url: 'ws://client-default' });
        const remoteClientCustom = new RemoteClient({ debugging: true, url: 'ws://client-custom', webSocketConstructor: FakeWebSocket as any });
        cleanups.push(
            () => remoteServerDefault.stop(),
            () => remoteServerCustom.stop(),
            () => remoteClientDefault.stop(),
            () => remoteClientCustom.stop(),
        );

        expect((remoteServerDefault as any)._getWSClient('ws://server-default')).toBeInstanceOf(WebSocketForce);
        expect((remoteServerCustom as any)._getWSClient('ws://server-custom')).toBeInstanceOf(WebSocketForce);
        expect((remoteClientDefault as any)._getWSServer()).toBeInstanceOf(WebSocketForce);
        expect((remoteClientCustom as any)._getWSServer()).toBeInstanceOf(WebSocketForce);
        expect(constructed).toHaveLength(4);
    });

    it('reuses an existing WebSocketForce and logs its error', () => {
        const raw = rawSocket();
        const force = new WebSocketForce(raw.ws);
        const remote = new RemoteServer({ debugging: true, logAuthFlow: true });
        cleanups.push(() => remote.stop());
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        expect((remote as any)._getWSClient(force)).toBe(force);
        raw.emit('error', new Error('socket failed'));
        expect(log).toHaveBeenCalledWith('[PerfectWS::RemoteServer] Connection error');
    });

    it('starts a RemoteClient once and reuses an existing WebSocketForce', () => {
        const raw = rawSocket();
        const force = new WebSocketForce(raw.ws);
        const remote = new RemoteClient({ debugging: true, verbose: true, id: 'client', wsServer: force } as any);
        cleanups.push(() => remote.stop());
        vi.spyOn(remote as any, '_connectionLoop').mockResolvedValue(undefined);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        remote.start();
        remote.start();
        expect((remote as any)._getWSServer()).toBe(force);
        raw.emit('error', new Error('socket failed'));
        expect(log).toHaveBeenCalled();
    });

    it('resolves the RemoteClient host-ready wait as false when the socket closes', async () => {
        const raw = rawSocket();
        const force = new WebSocketForce(raw.ws);
        const remote = new RemoteClient({ debugging: true, id: 'client', wsServer: force } as any);
        cleanups.push(() => remote.stop());
        const handlers = new Map<string, Function>();
        const server = {
            router: { on: (method: string, handler: Function) => handlers.set(method, handler) },
            unregister: vi.fn(),
        } as any;
        (remote as any)._internalInitializeMethods(server, force);

        const initialized = handlers.get('___sh_initialized')!(null, { send: vi.fn().mockResolvedValue(undefined) });
        await Promise.resolve();
        raw.emit('message', { data: 'not-ready-yet' });
        raw.emit('close', { code: 1000 });
        await initialized;

        expect((remote as any)._wsServer).toBeUndefined();
    });

    it('propagates and logs initializeMethods failures', async () => {
        const raw = rawSocket();
        const force = new WebSocketForce(raw.ws);
        const remote = new RemoteClient({ debugging: true, logAuthFlow: true, id: 'client', wsServer: force } as any);
        cleanups.push(() => remote.stop());
        vi.spyOn(remote, 'initializeMethods').mockImplementation(() => { throw new Error('initialize failed'); });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const handlers = new Map<string, Function>();
        const server = {
            router: { on: (method: string, handler: Function) => handlers.set(method, handler) },
            unregister: vi.fn(),
        } as any;
        (remote as any)._internalInitializeMethods(server, force);

        await expect(handlers.get('___sh_id')!('server')).rejects.toThrow('initialize failed');

        expect(error).toHaveBeenCalled();
        expect((remote as any)._wsServer).toBeUndefined();
    });

    it('logs rate-limit disconnects and verbose temporary router setup', async () => {
        const raw = rawSocket();
        const force = new WebSocketForce(raw.ws);
        const remote = new RemoteClient({ debugging: true, verbose: true, id: 'client', wsServer: force } as any);
        cleanups.push(() => remote.stop());
        (remote as any)._on = true;
        vi.spyOn(remote as any, '_getWSServer').mockReturnValue(force);
        vi.spyOn(remote as any, '_internalInitializeMethods').mockImplementation(() => undefined);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const server = {
            router: { config: {} },
            attachClient: vi.fn(),
            unregister: vi.fn(),
        } as any;
        vi.spyOn(PerfectWS, 'server').mockReturnValue(server);
        vi.spyOn(force, 'addEventListener').mockImplementation((type: any, listener: any) => {
            if (type === 'close') queueMicrotask(() => listener({ code: RATE_LIMITED_CLOSE_CODE }));
        });

        await (remote as any)._connectionLoop();
        expect(server.router.config.verbose).toBe(true);
        expect(log).toHaveBeenCalledWith('[PerfectWS::RemoteClient] Rejected: rate limited');
    });

    it('handles already-closed sockets in both remote connection loops', async () => {
        const closed = new WebSocketForce(rawSocket(WebSocketForce.CLOSED).ws);
        const server = {
            router: { config: {} }, attachClient: vi.fn(), unregister: vi.fn(),
        } as any;
        vi.spyOn(PerfectWS, 'server').mockReturnValue(server);

        const remoteServer = new RemoteServer({ debugging: true, autoReconnect: false });
        cleanups.push(() => remoteServer.stop());
        vi.spyOn(remoteServer as any, '_getWSClient').mockReturnValue(closed);
        vi.spyOn(remoteServer as any, '_internalInitializeMethods').mockImplementation(() => undefined);
        await remoteServer.attachClient(closed as any);

        const remoteClient = new RemoteClient({ debugging: true, id: 'client', wsServer: closed } as any);
        cleanups.push(() => remoteClient.stop());
        vi.spyOn(remoteClient as any, '_internalInitializeMethods').mockImplementation(() => undefined);
        await (remoteClient as any)._connectionLoop(new AbortController().signal);

        expect(server.unregister).toHaveBeenCalled();
    });

    it('contains both per-attempt and outer-loop constructor failures', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const server = {
            router: { config: {} }, attachClient: vi.fn(), unregister: vi.fn(),
        } as any;
        const serverFactory = vi.spyOn(PerfectWS, 'server').mockReturnValue(server);

        const remoteServer = new RemoteServer({ debugging: true, logAuthFlow: true, autoReconnect: false });
        cleanups.push(() => remoteServer.stop());
        vi.spyOn(remoteServer as any, '_getWSClient').mockImplementation(() => { throw new Error('client constructor failed'); });
        await remoteServer.attachClient('ws://invalid');
        await Promise.resolve();
        expect(error).toHaveBeenCalledWith('[PerfectWS::RemoteServer] Connection attempt failed:', expect.any(Error));

        const remoteClient = new RemoteClient({ debugging: true, logAuthFlow: true, id: 'client', wsServer: rawSocket().ws } as any);
        cleanups.push(() => remoteClient.stop());
        vi.spyOn(remoteClient as any, '_getWSServer').mockImplementation(() => { throw new Error('server constructor failed'); });
        await (remoteClient as any)._connectionLoop(new AbortController().signal);
        expect(error).toHaveBeenCalledWith('[PerfectWS::RemoteClient] Connection attempt failed:', expect.any(Error));

        const outerServer = new RemoteServer({ debugging: true, autoReconnect: false });
        cleanups.push(() => outerServer.stop());
        serverFactory.mockImplementation(() => { throw new Error('router constructor failed'); });
        await outerServer.attachClient('ws://invalid');
        await Promise.resolve();
        expect(error).toHaveBeenCalledWith('[PerfectWS::RemoteServer] Reconnection loop failed:', expect.any(Error));

        const outerClient = new RemoteClient({ debugging: true, id: 'client', wsServer: rawSocket().ws } as any);
        cleanups.push(() => outerClient.stop());
        outerClient.start();
        await Promise.resolve();
        expect(error).toHaveBeenCalledWith('[PerfectWS::RemoteClient] Connection loop failed:', expect.any(Error));
    });
});
