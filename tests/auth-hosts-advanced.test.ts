// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientHost } from '../src/auth/ClientHost/ClientHost.ts';
import { RemoteServer } from '../src/auth/ClientHost/RemoteServer.ts';
import { RemoteClient } from '../src/auth/ServerHost/RemoteClient.ts';
import { ServerHost } from '../src/auth/ServerHost/ServerHost.ts';
import { DEFAULT_DELAY_BEFORE_RECONNECT, DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY, DEFAULT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS, DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS } from '../src/auth/config.ts';
import { PerfectWS } from '../src/PerfectWS.ts';
import { PerfectWSAdvanced } from '../src/PerfectWSAdvanced/PerfectWSAdvanced.ts';
import { WSLike } from '../src/utils/WebSocketForce.ts';
import { sleep } from '../src/utils/sleepPromise.ts';
import { waitFor } from './utils/waitFor.ts';
import { PureRPC } from '../src/PerfectWSAdvanced/PureRPC.ts';
import { createDuplexPair } from './utils/createDuplexPair.ts';
import { MockWebSocketServer } from './utils/MockWebSocketServer.ts';

const nextServer = async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>(resolve => wss.once('listening', resolve));
    const address = wss.address();
    if (typeof address === 'string' || address === null) {
        await new Promise<void>(resolve => wss.close(() => resolve()));
        throw new Error('Could not allocate a WebSocket test server');
    }

    return { port: address.port, wss };
};

const cleanupCallbacks = new Set<() => void>();

afterEach(async () => {
    for (const cleanup of cleanupCallbacks) {
        try { cleanup(); } catch { /* best-effort */ }
    }
    cleanupCallbacks.clear();
    await sleep(30);
});

// Deliberately does NOT wait for 'open' before returning: the host side can send its
// handshake request as soon as it sees the server-side 'connection' event, which can
// race ahead of this process's own 'open' listener. Callers that need to attach a
// PerfectWS router to this socket must do so immediately (attachClient registers its
// 'message' listener synchronously), before any handshake message can be missed.
const connectRaw = (port: number) => new WebSocket(`ws://localhost:${port}`);

const waitForOpen = (ws: WebSocket) => new Promise<void>((resolve) => ws.once('open', () => resolve()));

describe('auth hosts - verbose propagation', () => {
    it('ClientHost applies verbose to its persistent client router', () => {
        const host = new ClientHost({ verbose: true, debugging: true, password: 'x', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        expect(host.router.config.verbose).toBe(true);
    });

    it('ServerHost applies verbose to its persistent server router', () => {
        const host = new ServerHost({ verbose: true, debugging: true, password: 'x', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        expect(host.router.config.verbose).toBe(true);
    });

    it('RemoteServer applies verbose to its persistent server router', () => {
        const remote = new RemoteServer({ verbose: true, debugging: true, id: 'r1', password: 'x', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => remote.stop());
        expect(remote.router.config.verbose).toBe(true);
    });

    it('RemoteClient applies verbose to its persistent client router', () => {
        const remote = new RemoteClient({ verbose: true, debugging: true, id: 'r1', password: 'x', url: 'ws://localhost:1', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => remote.stop());
        expect(remote.router.config.verbose).toBe(true);
    });
});

describe('auth hosts - fullTrustedRPC propagation', () => {
    it('ClientHost applies fullTrustedRPC to its persistent client router', () => {
        const host = new ClientHost({ fullTrustedRPC: true, password: 'x', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        expect(host.router.config.fullTrustedRPC).toBe(true);
    });

    it('ServerHost applies fullTrustedRPC to its persistent server router', () => {
        const host = new ServerHost({ fullTrustedRPC: true, password: 'x', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        expect(host.router.config.fullTrustedRPC).toBe(true);
    });

    it('RemoteServer applies fullTrustedRPC to its persistent server router', () => {
        const remote = new RemoteServer({ fullTrustedRPC: true, id: 'r1', password: 'x', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => remote.stop());
        expect(remote.router.config.fullTrustedRPC).toBe(true);
    });

    it('RemoteClient applies fullTrustedRPC to its persistent client router', () => {
        const remote = new RemoteClient({ fullTrustedRPC: true, id: 'r1', password: 'x', url: 'ws://localhost:1', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => remote.stop());
        expect(remote.router.config.fullTrustedRPC).toBe(true);
    });

    it('defaults all four auth classes to the base BSON-only protocol', () => {
        const host = new ClientHost({ password: 'x' });
        const serverHost = new ServerHost({ password: 'x' });
        const remoteServer = new RemoteServer({ id: 'r1', password: 'x' });
        const remoteClient = new RemoteClient({ id: 'r1', password: 'x', url: 'ws://localhost:1' });
        cleanupCallbacks.add(() => host.stop());
        cleanupCallbacks.add(() => serverHost.stop());
        cleanupCallbacks.add(() => remoteServer.stop());
        cleanupCallbacks.add(() => remoteClient.stop());

        expect(host.router.config.fullTrustedRPC).toBe(false);
        expect(serverHost.router.config.fullTrustedRPC).toBe(false);
        expect(remoteServer.router.config.fullTrustedRPC).toBe(false);
        expect(remoteClient.router.config.fullTrustedRPC).toBe(false);
        for (const router of [host.router, serverHost.router, remoteServer.router, remoteClient.router]) {
            expect(router).toBeInstanceOf(PerfectWS);
            expect(router).not.toBeInstanceOf(PerfectWSAdvanced);
            expect(router).not.toHaveProperty('transformers');
        }
    });

    // fullTrustedRPC only exists on PerfectWSAdvanced - a plain PerfectWS constructor would
    // silently turn the option into a no-op, so this is refused at construction instead.
    describe('perfectWSConstructor guard', () => {
        it('ClientHost throws when fullTrustedRPC is combined with a plain PerfectWS constructor', () => {
            expect(() => new ClientHost({ fullTrustedRPC: true, password: 'x', perfectWSConstructor: PerfectWS }))
                .toThrow(/fullTrustedRPC requires PerfectWSAdvanced/);
        });

        it('ServerHost throws when fullTrustedRPC is combined with a plain PerfectWS constructor', () => {
            expect(() => new ServerHost({ fullTrustedRPC: true, password: 'x', perfectWSConstructor: PerfectWS }))
                .toThrow(/fullTrustedRPC requires PerfectWSAdvanced/);
        });

        it('RemoteServer throws when fullTrustedRPC is combined with a plain PerfectWS constructor', () => {
            expect(() => new RemoteServer({ fullTrustedRPC: true, id: 'r1', password: 'x', perfectWSConstructor: PerfectWS }))
                .toThrow(/fullTrustedRPC requires PerfectWSAdvanced/);
        });

        it('RemoteClient throws when fullTrustedRPC is combined with a plain PerfectWS constructor', () => {
            expect(() => new RemoteClient({ fullTrustedRPC: true, id: 'r1', password: 'x', url: 'ws://localhost:1', perfectWSConstructor: PerfectWS }))
                .toThrow(/fullTrustedRPC requires PerfectWSAdvanced/);
        });

        it('exposes honest base routers when a plain PerfectWS constructor is selected', () => {
            const clientHost = new ClientHost({ fullTrustedRPC: false, password: 'x', perfectWSConstructor: PerfectWS });
            const serverHost = new ServerHost({ fullTrustedRPC: false, password: 'x', perfectWSConstructor: PerfectWS });
            const remoteClient = new RemoteClient({ fullTrustedRPC: false, password: 'x', url: 'ws://localhost:1', perfectWSConstructor: PerfectWS });
            const remoteServer = new RemoteServer({ fullTrustedRPC: false, password: 'x', perfectWSConstructor: PerfectWS });
            cleanupCallbacks.add(() => clientHost.stop());
            cleanupCallbacks.add(() => serverHost.stop());
            cleanupCallbacks.add(() => remoteClient.stop());
            cleanupCallbacks.add(() => remoteServer.stop());

            for (const router of [clientHost.router, serverHost.router, remoteClient.router, remoteServer.router]) {
                expect(router).toBeInstanceOf(PerfectWS);
                expect(router).not.toBeInstanceOf(PerfectWSAdvanced);
                expect(router).not.toHaveProperty('transformers');
                expect(router.config.fullTrustedRPC).toBe(false);
            }
        });

        it('rejects fullTrustedRPC on every auth class when the advanced constructor is omitted', () => {
            const construct = [
                () => new ClientHost({ fullTrustedRPC: true, password: 'x' }),
                () => new ServerHost({ fullTrustedRPC: true, password: 'x' }),
                () => new RemoteServer({ fullTrustedRPC: true, password: 'x' }),
                () => new RemoteClient({ fullTrustedRPC: true, password: 'x', url: 'ws://localhost:1' }),
            ];
            for (const create of construct) {
                expect(create).toThrow(/fullTrustedRPC requires PerfectWSAdvanced/);
            }
        });
    });
});

describe('auth hosts - PureRPC end to end', () => {
    it('supports callbacks, Maps, and Sets only after both auth peers explicitly select PerfectWSAdvanced', async () => {
        const { port, wss } = await nextServer();
        const host = new ServerHost({
            debugging: true,
            password: 'shared-secret',
            port,
            wsServer: wss,
            perfectWSConstructor: PerfectWSAdvanced,
        });
        cleanupCallbacks.add(() => host.stop());
        host.router.on('advanced-values', async ({ values, lookup, calculate }) => ({
            values,
            lookup,
            calculated: await calculate(6, 7),
            format: (value: string) => `advanced:${ value }`,
        }));
        host.start();

        const remote = new RemoteClient({
            debugging: true,
            id: 'advanced-values-client',
            password: 'shared-secret',
            url: `ws://localhost:${ port }`,
            webSocketConstructor: WebSocket as any,
            perfectWSConstructor: PerfectWSAdvanced,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();
        await waitFor(() => host.clients.has('advanced-values-client'));

        const response = await remote.router.request('advanced-values', {
            values: new Set([1, 2, 3]),
            lookup: new Map<any, string>([[2, 'two'], [null, 'null']]),
            calculate: (left: number, right: number) => left * right,
        });

        expect(response.values).toEqual(new Set([1, 2, 3]));
        expect(response.lookup).toEqual(new Map<any, string>([[2, 'two'], [null, 'null']]));
        expect(response.calculated).toBe(42);
        expect(await response.format('ok')).toBe('advanced:ok');
    });

    it('runs the documented ServerHost/RemoteClient flow without manual disposal', async () => {
        class Counter extends PureRPC {
            count = 0;
            increment() { return ++this.count; }
        }

        const { port, wss } = await nextServer();
        const host = new ServerHost({
            debugging: true,
            password: 'shared-secret',
            port,
            wsServer: wss,
            fullTrustedRPC: true,
            perfectWSConstructor: PerfectWSAdvanced,
        });
        cleanupCallbacks.add(() => host.stop());
        host.router.on('counter', () => new Counter());
        host.start();

        const remote = new RemoteClient({
            debugging: true,
            id: 'pure-rpc-client',
            password: 'shared-secret',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
            fullTrustedRPC: true,
            perfectWSConstructor: PerfectWSAdvanced,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => host.clients.has('pure-rpc-client'));

        const counter = await remote.router.request('counter', null, {
            requestId: 'docs-pure-rpc',
        });
        expect(await (counter as any).count).toBe(0);
        expect(await (counter as any).increment()).toBe(1);
        (counter as any).count = 10;
        expect(await (counter as any).count).toBe(10);

        remote.router.config.clientId = 'spoofed-client';
        await expect(remote.router.request('counter', null)).rejects.toMatchObject({
            code: 'clientIdMismatch',
        });
    });
});

describe('auth hosts - requests during startup', () => {
    it('queues a request made immediately after RemoteClient.start()', async () => {
        const { port, wss } = await nextServer();
        const host = new ServerHost({
            debugging: true,
            password: 'shared-secret',
            port,
            wsServer: wss,
        });
        cleanupCallbacks.add(() => host.stop());
        host.router.on('greet', ({ name }) => ({ message: `Hello, ${ name }!` }));
        host.start();

        const remote = new RemoteClient({
            debugging: true,
            id: 'startup-client',
            password: 'shared-secret',
            url: `ws://localhost:${ port }`,
            webSocketConstructor: WebSocket as any,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await expect(remote.router.request('greet', { name: 'Ada' }, { timeout: 2000 }))
            .resolves.toEqual({ message: 'Hello, Ada!' });
    });
});

describe('auth hosts - password forms', () => {
    it('ClientHost accepts a password from an allowed list (string[])', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: ['secret1', 'secret2'], port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'secret2' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);
        expect(host.serverId).toBe('srv');
    });

    it('ClientHost rejects a password not in the allowed list (string[])', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: ['secret1', 'secret2'], port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'not-allowed' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);
        expect(host.router.isServerConnected).toBe(false);
    });

    it('ServerHost validates a password via a custom sync/async function', async () => {
        const { port, wss } = await nextServer();
        const seenPasswords: any[] = [];
        const host = new ServerHost({
            debugging: true,
            port,
            wsServer: wss,
            password: async (password: any) => {
                seenPasswords.push(password);
                await sleep(5);
                return password === 'dynamic-secret';
            },
        });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteClient({
            debugging: true,
            id: 'cli',
            password: 'dynamic-secret',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => host.clients.has('cli'));
        expect(seenPasswords).toEqual(['dynamic-secret']);
    });

    it('ServerHost rejects when the password function returns false', async () => {
        const { port, wss } = await nextServer();
        const host = new ServerHost({
            debugging: true,
            port,
            wsServer: wss,
            password: () => false,
        });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteClient({
            debugging: true,
            id: 'cli',
            password: 'whatever',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await sleep(300);
        expect(host.clients.has('cli')).toBe(false);
    });
});

describe('auth hosts - initializeX hook rejection', () => {
    it('ClientHost closes the connection when initializeServer throws', async () => {
        const { port, wss } = await nextServer();

        class RejectingClientHost extends ClientHost {
            protected override initializeServer(): any {
                throw new Error('server not allowed');
            }
        }

        const host = new RejectingClientHost({ debugging: true, password: 'x', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);
        expect(host.router.isServerConnected).toBe(false);
        expect(host.serverId).toBeUndefined();
    });

    it('ServerHost closes the connection when initializeClient throws', async () => {
        const { port, wss } = await nextServer();

        class RejectingServerHost extends ServerHost {
            protected override initializeClient(): any {
                throw new Error('client not allowed');
            }
        }

        const host = new RejectingServerHost({ debugging: true, password: 'x', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteClient({
            debugging: true,
            id: 'cli',
            password: 'x',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await sleep(400);
        expect(host.clients.has('cli')).toBe(false);
        expect(host.initializedClientIds ?? []).toEqual([]);
    });
});

describe('auth hosts - handshake-time RPC via initializeMethods/initializeClient', () => {
    it('the host side gets a client it can request() into the remote side\'s initializeMethods-registered handlers', async () => {
        const { port, wss } = await nextServer();

        class CapableRemoteClient extends RemoteClient {
            protected override initializeMethods(router: any) {
                router.on('capabilities', () => ({ version: 2, features: ['streaming'] }));
            }
        }

        const seenCaps: any[] = [];
        class CheckingServerHost extends ServerHost {
            protected override async initializeClient(router: any, { clientId }: any) {
                const caps = await router.request('capabilities', {});
                seenCaps.push({ clientId, caps });
                if (caps.version < 2) {
                    throw new Error(`client ${clientId} is too old`);
                }
            }
        }

        const host = new CheckingServerHost({ debugging: true, password: 'x', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new CapableRemoteClient({
            debugging: true,
            id: 'capable-cli',
            password: 'x',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => host.clients.has('capable-cli'));

        expect(seenCaps).toEqual([
            { clientId: 'capable-cli', caps: { version: 2, features: ['streaming'] } },
        ]);
    });

    it('holds for the ClientHost/RemoteServer pairing too: the host (client role) calls what the remote (server role) registered', async () => {
        const { port, wss } = await nextServer();

        // initializeMethods (remote side) runs while responding to the ___ch_id
        // request, strictly before the host's own initializeServer (which only runs
        // after receiving that response) - so the remote must be the one registering,
        // and the host the one calling, not the other way around.
        class GreetingRemoteServer extends RemoteServer {
            protected override initializeMethods(router: any) {
                router.on('greeting', () => ({ hello: 'from remote' }));
            }
        }

        const seenGreetings: any[] = [];
        class GreetingClientHost extends ClientHost {
            protected override async initializeServer(router: any, { serverId }: any) {
                const greeting = await router.request('greeting', {});
                seenGreetings.push({ serverId, greeting });
            }
        }

        const host = new GreetingClientHost({ debugging: true, password: 'x', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new GreetingRemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(seenGreetings).toEqual([
            { serverId: 'srv', greeting: { hello: 'from remote' } },
        ]);
    });
});

describe('auth hosts - same-id reconnect handoff', () => {
    it('ClientHost waits for the previous same-serverId socket to close before accepting a new one', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: 'x', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote1 = new RemoteServer({ debugging: true, id: 'same-server-id', password: 'x' });
        cleanupCallbacks.add(() => remote1.stop());
        remote1.router.on('/ping', () => ({ from: 'remote1' }));
        const rawWs1 = connectRaw(port);
        const unregister1 = await remote1.attachClient(rawWs1 as any);

        await waitFor(() => host.router.isServerConnected && remote1.clients.size === 1);
        expect(await host.router.request('/ping', {}, { timeout: 1000 })).toEqual({ from: 'remote1' });

        // A second RemoteServer reconnects with the SAME serverId while remote1's socket
        // is still open. ClientHost must not switch over yet - it should keep serving
        // through remote1 until that socket actually closes.
        const remote2 = new RemoteServer({ debugging: true, id: 'same-server-id', password: 'x' });
        cleanupCallbacks.add(() => remote2.stop());
        remote2.router.on('/ping', () => ({ from: 'remote2' }));
        const rawWs2 = connectRaw(port);
        const attach2 = remote2.attachClient(rawWs2 as any); // not awaited: should hang on old-socket wait

        await sleep(300);
        expect(await host.router.request('/ping', {}, { timeout: 1000 })).toEqual({ from: 'remote1' });

        unregister1();
        await attach2;
        await waitFor(() => remote2.clients.size === 1, 3000);

        await waitFor(async () => {
            try {
                const res = await host.router.request('/ping', {}, { timeout: 500 });
                return res.from === 'remote2';
            } catch {
                return false;
            }
        }, 3000);
    }, 10000);

    it('ServerHost waits for the previous same-clientId socket to close before accepting a new one', async () => {
        const { port, wss } = await nextServer();
        const host = new ServerHost({ debugging: true, password: 'x', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.router.on('/ping', ({}, { clientId }) => ({ clientId }));
        host.start();

        const rawWs1 = connectRaw(port);
        const remote1 = new RemoteClient({ debugging: true, id: 'same-client-id', password: 'x', wsServer: rawWs1 as any });
        cleanupCallbacks.add(() => remote1.stop());
        remote1.start();

        await waitFor(() => host.clients.has('same-client-id'));
        expect(await remote1.router.request('/ping', {}, { timeout: 1000 })).toEqual({ clientId: 'same-client-id' });

        const rawWs2 = connectRaw(port);
        const remote2 = new RemoteClient({ debugging: true, id: 'same-client-id', password: 'x', wsServer: rawWs2 as any });
        cleanupCallbacks.add(() => remote2.stop());
        remote2.start();

        await sleep(300);
        // remote1 is still the registered connection for this clientId
        expect(host.clients.get('same-client-id')).toBeDefined();
        expect(await remote1.router.request('/ping', {}, { timeout: 1000 })).toEqual({ clientId: 'same-client-id' });

        remote1.stop();

        await waitFor(() => remote2.router.isServerConnected, 3000);
        expect(await remote2.router.request('/ping', {}, { timeout: 1000 })).toEqual({ clientId: 'same-client-id' });
    }, 10000);
});

describe('auth hosts - RemoteServer with multiple simultaneous ClientHost connections', () => {
    it('tracks and serves each connected ClientHost independently', async () => {
        const wsServerA = new MockWebSocketServer();
        const wsServerB = new MockWebSocketServer();
        const pairA = createDuplexPair();
        const pairB = createDuplexPair();

        const hostA = new ClientHost({ debugging: true, password: 'x', wsServer: wsServerA as any });
        const hostB = new ClientHost({ debugging: true, password: 'x', wsServer: wsServerB as any });
        cleanupCallbacks.add(() => hostA.stop());
        cleanupCallbacks.add(() => hostB.stop());
        hostA.start();
        hostB.start();

        const remote = new RemoteServer({ debugging: true, password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        remote.router.on('/ping', ({}, { clientId }) => ({ clientId }));

        await Promise.all([
            remote.attachClient(pairA.clientWs as any),
            remote.attachClient(pairB.clientWs as any),
        ]);
        wsServerA.emitConnection(pairA.serverWs);
        wsServerB.emitConnection(pairB.serverWs);

        await waitFor(() => hostA.router.isServerConnected && hostB.router.isServerConnected);

        expect(remote.clients.size).toBe(2);

        const resA = await hostA.router.request('/ping', {}, { timeout: 1000 });
        const resB = await hostB.router.request('/ping', {}, { timeout: 1000 });

        expect(resA.clientId).toMatch(/^client-/);
        expect(resB.clientId).toMatch(/^client-/);
        expect(resA.clientId).not.toBe(resB.clientId);
        expect(new Set(remote.clients.keys())).toEqual(new Set([resA.clientId, resB.clientId]));
    });
});

describe('auth hosts - maxConnections enforcement', () => {
    it('ClientHost rejects a connection beyond maxConnections while the first is pending validation', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: 'x', port, wsServer: wss, maxConnections: 1 });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        // Hold the first connection open without completing the handshake. Wait for it to
        // actually be accepted server-side before opening the second, so the connection
        // count is deterministically 1 before the second attempt is made.
        const rawWs1 = connectRaw(port);
        await waitForOpen(rawWs1);
        cleanupCallbacks.add(() => rawWs1.close());

        const rawWs2 = connectRaw(port);
        cleanupCallbacks.add(() => rawWs2.close());

        await waitFor(() => rawWs2.readyState === WebSocket.CLOSED, 2000);
    });
});

describe('auth hosts - stop() cleanup', () => {
    it('ClientHost.stop() closes the active connection and stops accepting new ones', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: 'x', port, wsServer: wss });
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        host.stop();

        await waitFor(() => !host.router.isServerConnected, 2000);

        // No listener left on the underlying WebSocketServer.
        const rawWs2 = new WebSocket(`ws://localhost:${port}`);
        await new Promise<void>((resolve, reject) => {
            rawWs2.once('error', () => resolve());
            rawWs2.once('open', () => reject(new Error('should not have connected after stop()')));
            setTimeout(resolve, 500);
        });
        rawWs2.close();
    });
});

describe('auth hosts - reconnect delay', () => {
    it('defaults to 3 seconds', () => {
        expect(DEFAULT_DELAY_BEFORE_RECONNECT).toBe(3000);
    });

    it('RemoteClient waits delayBeforeReconnect before retrying after a dropped connection', async () => {
        const { port, wss } = await nextServer();

        const connectTimestamps: number[] = [];
        wss.on('connection', () => connectTimestamps.push(Date.now()));

        const host = new ServerHost({ debugging: true, password: 'x', wsServer: wss as any });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const DELAY = 250;
        const remote = new RemoteClient({
            debugging: true,
            id: 'cli',
            password: 'x',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
            delayBeforeReconnect: DELAY,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => host.clients.has('cli'));
        expect(connectTimestamps).toHaveLength(1);

        // Drop the established connection from the raw WebSocketServer side.
        for (const ws of wss.clients) ws.close();

        await waitFor(() => connectTimestamps.length >= 2, DELAY + 3000);

        const gap = connectTimestamps[1] - connectTimestamps[0];
        expect(gap).toBeGreaterThanOrEqual(DELAY - 50);
    }, 10000);

    it('RemoteServer waits delayBeforeReconnect before retrying after a dropped connection', async () => {
        const { port, wss } = await nextServer();

        const connectTimestamps: number[] = [];
        wss.on('connection', () => connectTimestamps.push(Date.now()));

        const host = new ClientHost({ debugging: true, password: 'x', wsServer: wss as any });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const DELAY = 250;
        const remote = new RemoteServer({
            debugging: true,
            id: 'srv',
            password: 'x',
            webSocketConstructor: WebSocket as any,
            delayBeforeReconnect: DELAY,
        });
        cleanupCallbacks.add(() => remote.stop());
        await remote.attachClient(`ws://localhost:${port}`);

        await waitFor(() => host.router.isServerConnected);
        expect(connectTimestamps).toHaveLength(1);

        for (const ws of wss.clients) ws.close();

        await waitFor(() => connectTimestamps.length >= 2, DELAY + 3000);

        const gap = connectTimestamps[1] - connectTimestamps[0];
        expect(gap).toBeGreaterThanOrEqual(DELAY - 50);
    }, 10000);
});

describe('auth hosts - password-failure reconnect delay', () => {
    it('defaults to the rate-limit window split across the allowed attempts, not the full window', () => {
        const perAttemptBudget = DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS / DEFAULT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS;

        // Must be a bit more than the raw per-attempt budget (there's a small safety
        // margin) ...
        expect(DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY).toBeGreaterThan(perAttemptBudget);
        // ... but nowhere near the full window - regression guard against reverting to
        // the overly conservative "wait out the whole window every time" formula.
        expect(DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY).toBeLessThan(DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS / 2);
    });

    it('RemoteClient waits passwordFailureDelay (not delayBeforeReconnect) after a wrong-password rejection', async () => {
        const { port, wss } = await nextServer();

        const connectTimestamps: number[] = [];
        wss.on('connection', () => connectTimestamps.push(Date.now()));

        const host = new ServerHost({ debugging: true, password: 'expected-secret', wsServer: wss as any });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const PASSWORD_DELAY = 300;
        const remote = new RemoteClient({
            debugging: true,
            id: 'cli',
            password: 'wrong-secret',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
            delayBeforeReconnect: 10, // should NOT be used for a password rejection
            passwordFailureDelay: PASSWORD_DELAY,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => connectTimestamps.length >= 1);
        // Never authenticates, so ServerHost never registers it as a client.
        expect(host.clients.has('cli')).toBe(false);

        await waitFor(() => connectTimestamps.length >= 2, PASSWORD_DELAY + 3000);

        const gap = connectTimestamps[1] - connectTimestamps[0];
        expect(gap).toBeGreaterThanOrEqual(PASSWORD_DELAY - 50);
    }, 10000);

    it('RemoteServer waits passwordFailureDelay (not delayBeforeReconnect) after a wrong-password rejection', async () => {
        const { port, wss } = await nextServer();

        const connectTimestamps: number[] = [];
        wss.on('connection', () => connectTimestamps.push(Date.now()));

        const host = new ClientHost({ debugging: true, password: 'expected-secret', wsServer: wss as any });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const PASSWORD_DELAY = 300;
        const remote = new RemoteServer({
            debugging: true,
            id: 'srv',
            password: 'wrong-secret',
            webSocketConstructor: WebSocket as any,
            delayBeforeReconnect: 10, // should NOT be used for a password rejection
            passwordFailureDelay: PASSWORD_DELAY,
        });
        cleanupCallbacks.add(() => remote.stop());
        await remote.attachClient(`ws://localhost:${port}`);

        await waitFor(() => connectTimestamps.length >= 1);
        expect(host.serverId).toBeUndefined();

        await waitFor(() => connectTimestamps.length >= 2, PASSWORD_DELAY + 3000);

        const gap = connectTimestamps[1] - connectTimestamps[0];
        expect(gap).toBeGreaterThanOrEqual(PASSWORD_DELAY - 50);
    }, 10000);
});

describe('auth hosts - logAuthFlow logging', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    const hasLog = (substr: string) => [...logSpy.mock.calls, ...errorSpy.mock.calls].some(call => typeof call[0] === 'string' && call[0].includes(substr));

    it('debugging:true auto-enables logAuthFlow logging for both ClientHost and RemoteServer', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('[PerfectWS::ClientHost] Connection accepted')).toBe(true);
        expect(hasLog('[PerfectWS::ClientHost] Server connected (srv)')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteServer] Attaching to provided socket')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteServer] Connection initialized (clientId=host1)')).toBe(true);
    });

    it('logs nothing when debugging is false and logAuthFlow is not set', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: false, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: false, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('Connection accepted')).toBe(false);
        expect(hasLog('Server connected (')).toBe(false);
        expect(hasLog('Connection initialized (clientId=')).toBe(false);
        expect(hasLog('Attaching to provided socket')).toBe(false);
    });

    it('keeps an ACK-enabled handshake connection open after promotion', async () => {
        class FastAckPerfectWS<WSType extends WSLike = WSLike> extends PerfectWSAdvanced<WSType> {
            protected static override _newInstance<T extends WSLike = WSLike>() {
                const router = new FastAckPerfectWS<T>();
                router.config.enableAckSystem = true;
                router.config.ackTimeout = 20;
                router.config.ackRetryDelays = [20];
                return router;
            }
        }

        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: false, password: 'x', port, wsServer: wss, id: 'host1', perfectWSConstructor: FastAckPerfectWS });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: false, id: 'srv', password: 'x', perfectWSConstructor: FastAckPerfectWS });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);
        await sleep(100);

        expect(host.router.isServerConnected).toBe(true);
        expect(rawWs.readyState).toBe(WebSocket.OPEN);
    });

    it('logAuthFlow:true overrides debugging:false', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: false, logAuthFlow: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: false, logAuthFlow: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('[PerfectWS::ClientHost] Server connected (srv)')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteServer] Connection initialized (clientId=host1)')).toBe(true);
    });

    it('logAuthFlow:false overrides debugging:true', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, logAuthFlow: false, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, logAuthFlow: false, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('Connection accepted')).toBe(false);
        expect(hasLog('Server connected (')).toBe(false);
        expect(hasLog('Connection initialized (clientId=')).toBe(false);
        expect(hasLog('Attaching to provided socket')).toBe(false);
    });

    it('verbose:true forces logAuthFlow on even when explicitly set to false', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ verbose: true, logAuthFlow: false, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ verbose: true, logAuthFlow: false, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('[PerfectWS::ClientHost] Server connected (srv)')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteServer] Connection initialized (clientId=host1)')).toBe(true);
    });

    it('logs a wrong-password rejection on both ClientHost and RemoteServer', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: 'right', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'wrong' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);

        expect(hasLog('[PerfectWS::ClientHost] Server disconnected - wrong password')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteServer] Rejected: wrong password')).toBe(true);
    });

    it('logs a rate-limited rejection on both ClientHost and RemoteServer once maxAttempts is exceeded', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({
            debugging: false,
            logAuthFlow: true,
            password: 'right',
            port,
            wsServer: wss,
            id: 'host1',
            passwordRateLimit: { maxAttempts: 1, windowMs: 5000 },
        });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote1 = new RemoteServer({ debugging: false, logAuthFlow: true, id: 'srv1', password: 'wrong' });
        cleanupCallbacks.add(() => remote1.stop());
        const rawWs1 = connectRaw(port);
        await remote1.attachClient(rawWs1 as any);
        await waitFor(() => rawWs1.readyState === WebSocket.CLOSED, 2000);

        // Second attempt, from the same address, with the CORRECT password - still
        // blocked outright by the rate limiter before password validation runs.
        const remote2 = new RemoteServer({ debugging: false, logAuthFlow: true, id: 'srv2', password: 'right' });
        cleanupCallbacks.add(() => remote2.stop());
        const rawWs2 = connectRaw(port);
        await remote2.attachClient(rawWs2 as any);
        await waitFor(() => rawWs2.readyState === WebSocket.CLOSED, 2000);

        expect(hasLog('[PerfectWS::ClientHost] Connection rejected - too many failed password attempts')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteServer] Rejected: rate limited')).toBe(true);
    });

    it('logs and closes when a remote\'s initializeMethods hook throws', async () => {
        class ThrowingRemoteServer extends RemoteServer {
            protected override initializeMethods(): void {
                throw new Error('boom');
            }
        }

        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new ThrowingRemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);

        expect(hasLog('[PerfectWS::RemoteServer] initializeMethods threw:')).toBe(true);
        expect(host.router.isServerConnected).toBe(false);
    });

    it('closes when a remote initializeMethods hook rejects asynchronously', async () => {
        class RejectingRemoteServer extends RemoteServer {
            protected override async initializeMethods(): Promise<void> {
                throw new Error('async boom');
            }
        }

        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();
        const remote = new RejectingRemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);
        expect(host.router.isServerConnected).toBe(false);
    });

    it('closes when RemoteClient initializeMethods rejects asynchronously', async () => {
        class RejectingRemoteClient extends RemoteClient {
            protected override async initializeMethods(): Promise<void> {
                throw new Error('async client boom');
            }
        }

        const { port, wss } = await nextServer();
        const host = new ServerHost({ debugging: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();
        const rawWs = connectRaw(port);
        const remote = new RejectingRemoteClient({ debugging: true, id: 'client', password: 'x', wsServer: rawWs as any });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);
        expect(host.clients.size).toBe(0);
    });

    it('logs when the host\'s initializeServer hook throws', async () => {
        class RejectingClientHost extends ClientHost {
            protected override initializeServer(): any {
                throw new Error('server not allowed');
            }
        }

        const { port, wss } = await nextServer();
        const host = new RejectingClientHost({ debugging: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);

        expect(hasLog('[PerfectWS::ClientHost] error during server initialization:')).toBe(true);
    });

    it('logs a mid-handshake disconnect when the remote closes during initializeServer', async () => {
        class DisconnectingClientHost extends ClientHost {
            protected override initializeServer(_router: any, { ws }: any): void {
                ws.close(1000, 'closing mid-handshake');
            }
        }

        const { port, wss } = await nextServer();
        const host = new DisconnectingClientHost({ debugging: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => rawWs.readyState === WebSocket.CLOSED, 2000);

        expect(hasLog('[PerfectWS::ClientHost] Server disconnected during initialization (srv)')).toBe(true);
    });

    it('spot check - ServerHost and RemoteClient log a successful connect and a wrong password the same way', async () => {
        const { port, wss } = await nextServer();
        const host = new ServerHost({ debugging: true, password: 'right', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const goodRemote = new RemoteClient({
            debugging: true,
            id: 'cli-good',
            password: 'right',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
        });
        cleanupCallbacks.add(() => goodRemote.stop());
        goodRemote.start();

        await waitFor(() => host.clients.has('cli-good'));

        expect(hasLog('[PerfectWS::ServerHost] Connection accepted')).toBe(true);
        expect(hasLog('[PerfectWS::ServerHost] Client connected (cli-good)')).toBe(true);
        expect(hasLog(`[PerfectWS::RemoteClient] Connecting to ws://localhost:${port}`)).toBe(true);
        expect(hasLog('[PerfectWS::RemoteClient] Connection initialized (serverId=')).toBe(true);

        const badRemote = new RemoteClient({
            debugging: true,
            id: 'cli-bad',
            password: 'wrong',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
            autoReconnect: false,
        });
        cleanupCallbacks.add(() => badRemote.stop());
        badRemote.start();

        await waitFor(() => hasLog('[PerfectWS::RemoteClient] Rejected: wrong password'), 2000);

        expect(hasLog('[PerfectWS::ServerHost] Client disconnected - wrong password')).toBe(true);
    });

    it('spot check - RemoteClient logs "Disconnected" then "Retrying in Xms" after a dropped connection', async () => {
        const { port, wss } = await nextServer();

        const host = new ServerHost({ debugging: true, password: 'x', wsServer: wss as any });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const DELAY = 200;
        const remote = new RemoteClient({
            debugging: true,
            id: 'cli',
            password: 'x',
            url: `ws://localhost:${port}`,
            webSocketConstructor: WebSocket as any,
            delayBeforeReconnect: DELAY,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => host.clients.has('cli'));

        for (const ws of wss.clients) ws.close();

        await waitFor(() => hasLog(`[PerfectWS::RemoteClient] Retrying in ${DELAY}ms`), DELAY + 3000);

        expect(hasLog('[PerfectWS::RemoteClient] Disconnected')).toBe(true);
    }, 10000);
});

describe('auth hosts - fullTrustedRPC handshake negotiation', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    const hasLog = (substr: string) => logSpy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes(substr));

    it('ClientHost/RemoteServer: logs nothing when both sides agree (both false)', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, logAuthFlow: true, password: 'x', port, wsServer: wss, id: 'host1' });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, logAuthFlow: true, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('fullTrustedRPC mismatch')).toBe(false);
    });

    it('ClientHost/RemoteServer: logs nothing when both sides agree (both true)', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, logAuthFlow: true, fullTrustedRPC: true, password: 'x', port, wsServer: wss, id: 'host1', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, logAuthFlow: true, fullTrustedRPC: true, id: 'srv', password: 'x', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('fullTrustedRPC mismatch')).toBe(false);
    });

    it('ClientHost/RemoteServer: both sides log a clear mismatch when only one opts in', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, logAuthFlow: true, fullTrustedRPC: true, password: 'x', port, wsServer: wss, id: 'host1', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, logAuthFlow: true, fullTrustedRPC: false, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected);

        expect(hasLog('[PerfectWS::ClientHost] fullTrustedRPC mismatch (local=true, server=false)')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteServer] fullTrustedRPC mismatch (local=false, client=true)')).toBe(true);
    });

    it('ClientHost/RemoteServer: the connection still succeeds despite a mismatch', async () => {
        const { port, wss } = await nextServer();
        const host = new ClientHost({ debugging: true, fullTrustedRPC: true, password: 'x', port, wsServer: wss, id: 'host1', perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteServer({ debugging: true, fullTrustedRPC: false, id: 'srv', password: 'x' });
        cleanupCallbacks.add(() => remote.stop());
        const rawWs = connectRaw(port);
        await remote.attachClient(rawWs as any);

        await waitFor(() => host.router.isServerConnected, 3000);
        expect(host.serverId).toBe('srv');
    });

    it('ServerHost/RemoteClient: logs nothing when both sides agree (both true)', async () => {
        const { port, wss } = await nextServer();
        const host = new ServerHost({ debugging: true, logAuthFlow: true, fullTrustedRPC: true, password: 'x', port, wsServer: wss, perfectWSConstructor: PerfectWSAdvanced });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteClient({
            debugging: true, logAuthFlow: true, fullTrustedRPC: true,
            id: 'cli', password: 'x', url: `ws://localhost:${port}`, webSocketConstructor: WebSocket as any,
            perfectWSConstructor: PerfectWSAdvanced,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => host.clients.has('cli'));

        expect(hasLog('fullTrustedRPC mismatch')).toBe(false);
    });

    it('ServerHost/RemoteClient: both sides log a clear mismatch when only one opts in', async () => {
        const { port, wss } = await nextServer();
        const host = new ServerHost({ debugging: true, logAuthFlow: true, fullTrustedRPC: false, password: 'x', port, wsServer: wss });
        cleanupCallbacks.add(() => host.stop());
        host.start();

        const remote = new RemoteClient({
            debugging: true, logAuthFlow: true, fullTrustedRPC: true,
            id: 'cli', password: 'x', url: `ws://localhost:${port}`, webSocketConstructor: WebSocket as any,
            perfectWSConstructor: PerfectWSAdvanced,
        });
        cleanupCallbacks.add(() => remote.stop());
        remote.start();

        await waitFor(() => host.clients.has('cli'));

        expect(hasLog('[PerfectWS::ServerHost] fullTrustedRPC mismatch (local=false, client=true)')).toBe(true);
        expect(hasLog('[PerfectWS::RemoteClient] fullTrustedRPC mismatch (local=true, server=false)')).toBe(true);
    });
});
