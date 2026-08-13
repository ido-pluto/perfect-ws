// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { PerfectWS } from '../src/index.ts';
import { ClientHost } from '../src/auth/ClientHost/ClientHost.ts';
import { RemoteServer } from '../src/auth/ClientHost/RemoteServer.ts';
import { RemoteClient } from '../src/auth/ServerHost/RemoteClient.ts';
import { ServerHost } from '../src/auth/ServerHost/ServerHost.ts';
import { clientHost, serverHost } from '../src/auth/auth.ts';
import { createDuplexPair } from './utils/createDuplexPair.ts';
import { MockWebSocketServer } from './utils/MockWebSocketServer.ts';
import { waitFor } from './utils/waitFor.ts';

class TestClientHost extends ClientHost {
    public initializedServerIds: string[] = [];

    constructor(options: ConstructorParameters<typeof ClientHost>[0] = {}) {
        super(options);
        this.router.config.syncRequestsWhenServerOpen = false;
    }

    protected override initializeServer(_router: ReturnType<typeof PerfectWS.client>['router'], options: { serverId: string }) {
        this.initializedServerIds.push(options.serverId);
        return null;
    }
}

class TestServerHost extends ServerHost {
    public initializedClientIds: string[] = [];

    protected override initializeClient(_router: ReturnType<typeof PerfectWS.client>['router'], options: { clientId: string }) {
        this.initializedClientIds.push(options.clientId);
        return null;
    }
}

class TestRemoteClient extends RemoteClient {
    public initializeCalls: string[] = [];

    constructor(options: ConstructorParameters<typeof RemoteClient>[0]) {
        super(options);
        this.router.config.syncRequestsWhenServerOpen = false;
    }

    public connect() {
        this.start();
    }

    protected override initializeMethods(_router: ReturnType<typeof PerfectWS.client>['router'], options: { serverId: string }) {
        this.initializeCalls.push(options.serverId);
    }
}

const cleanupCallbacks = new Set<() => void>();

afterEach(() => {
    for (const cleanup of cleanupCallbacks) {
        cleanup();
    }

    cleanupCallbacks.clear();
});

describe('auth hosts', () => {
    it('connects client host to remote server and routes requests over the authenticated socket', async () => {
        const wsServer = new MockWebSocketServer();
        const { clientWs, serverWs } = createDuplexPair();

        const host = new TestClientHost({
            debugging: true,
            password: 'shared-secret',
            wsServer: wsServer as any,
        });
        const remote = new RemoteServer({
            debugging: true,
            id: 'server-test',
            password: 'shared-secret',
        });

        cleanupCallbacks.add(() => host.stop());
        cleanupCallbacks.add(() => remote.stop());

        remote.router.on('/auth/ping', ({ value }: { value: string }, { clientId }) => {
            return {
                echoed: value,
                seenClientId: clientId,
            };
        });

        host.start();
        remote.attachClient(clientWs as any);
        wsServer.emitConnection(serverWs);

        await waitFor(() => Boolean(host.serverId) && remote.clients.size > 0 && host.router.isServerConnected);

        const response = await host.router.request('/auth/ping', { value: 'ok' }, { timeout: 1000 });
        const connectedClientId = Array.from(remote.clients.keys())[0];

        expect(host.serverId).toBe('server-test');
        expect(host.initializedServerIds).toEqual(['server-test']);
        expect(connectedClientId).toMatch(/^client-/);
        expect(response).toEqual({
            echoed: 'ok',
            seenClientId: connectedClientId,
        });
    });

    it('connects server host to remote client and keeps the public route reachable', async () => {
        const wsServer = new MockWebSocketServer();
        const { clientWs, serverWs } = createDuplexPair();

        const host = new TestServerHost({
            debugging: true,
            id: 'server-host-test',
            password: 'shared-secret',
            wsServer: wsServer as any,
        });
        const remote = new TestRemoteClient({
            debugging: true,
            id: 'client-test',
            password: 'shared-secret',
            wsServer: clientWs as any,
        });

        cleanupCallbacks.add(() => remote.stop());

        host.router.on('/auth/ping', ({ value }: { value: string }) => {
            return {
                echoed: value,
                connectedClients: Array.from(host.clients.keys()),
            };
        });

        host.start();
        remote.connect();
        wsServer.emitConnection(serverWs);

        await waitFor(() => host.clients.has('client-test') && remote.router.isServerConnected && remote.serverId === 'server-host-test');

        const response = await remote.router.request('/auth/ping', { value: 'ok' }, { timeout: 1000 });

        expect(remote.serverId).toBe('server-host-test');
        expect(remote.initializeCalls).toEqual(['server-host-test']);
        expect(host.initializedClientIds).toEqual(['client-test']);
        expect(response).toEqual({
            echoed: 'ok',
            connectedClients: ['client-test'],
        });
    });

    it('rejects the connection when passwords do not match', async () => {
        const wsServer = new MockWebSocketServer();
        const { clientWs, serverWs } = createDuplexPair();

        const host = new TestClientHost({
            debugging: true,
            password: 'expected-secret',
            wsServer: wsServer as any,
        });
        const remote = new RemoteServer({
            debugging: true,
            id: 'server-test',
            password: 'wrong-secret',
        });

        cleanupCallbacks.add(() => host.stop());
        cleanupCallbacks.add(() => remote.stop());

        host.start();
        remote.attachClient(clientWs as any);
        wsServer.emitConnection(serverWs);

        await waitFor(() => clientWs.readyState === 3 && serverWs.readyState === 3);

        expect(host.serverId).toBeUndefined();
        expect(host.router.isServerConnected).toBe(false);
        expect(host.initializedServerIds).toEqual([]);
    });
});

describe('clientHost/serverHost bundle exports', () => {
    it('maps each key to the class actually playing that PerfectWS role', () => {
        // clientHost/serverHost group the two halves of each pairing; the "Client"/
        // "Server" key must name the PerfectWS role the class plays (does it call
        // .request(), or register .on() handlers?), not just mirror the other group's
        // key layout. Regression guard for a prior mix-up in serverHost specifically.
        expect(clientHost.Client).toBe(ClientHost);
        expect(clientHost.Server).toBe(RemoteServer);
        expect(serverHost.Client).toBe(RemoteClient);
        expect(serverHost.Server).toBe(ServerHost);
    });
});