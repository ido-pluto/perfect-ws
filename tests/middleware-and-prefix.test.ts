import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';
import { PerfectWSSubRoute } from '../src/PerfectWSSubRoute.js';
import { createDuplexPair } from './utils/createDuplexPair.js';

describe('router middleware and mounts', () => {
    let server: PerfectWS;
    let client: PerfectWS;

    beforeEach(() => {
        const pair = createDuplexPair();
        const serverResult = PerfectWS.server();
        const clientResult = PerfectWS.client();
        server = serverResult.router;
        client = clientResult.router;
        serverResult.attachClient(pair.serverWs as any);
        clientResult.setServer(pair.clientWs as any);
    });

    it('runs route callbacks in order and stops after a final send', async () => {
        const calls: string[] = [];
        server.on('work',
            data => { calls.push(`first:${ data.value }`); },
            async (_data, { send }) => {
                calls.push('send');
                await send('finished', true);
            },
            () => { calls.push('unreachable'); }
        );

        await expect(client.request('work', { value: 1 })).resolves.toBe('finished');
        expect(calls).toEqual(['first:1', 'send']);
    });

    it('treats root use() as scope middleware independent of registration order', async () => {
        const calls: string[] = [];
        server.on('before', () => { calls.push('before'); return 'before'; });
        server.use(() => { calls.push('root-1'); });
        server.on('after', () => { calls.push('after'); return 'after'; });
        server.use(() => { calls.push('root-2'); });

        await expect(client.request('before', {})).resolves.toBe('before');
        expect(calls).toEqual(['root-1', 'root-2', 'before']);

        calls.length = 0;
        await expect(client.request('after', {})).resolves.toBe('after');
        expect(calls).toEqual(['root-1', 'root-2', 'after']);
    });

    it('shares middleware mutations with the route and supports rejection', async () => {
        server.use((data, { reject }) => {
            if (!data.token) return reject('Missing token', 'unauthorized');
            data.user = { id: 'user-1' };
        });
        server.on('secure', data => data.user.id);

        await expect(client.request('secure', {})).rejects.toMatchObject({ code: 'unauthorized' });
        await expect(client.request('secure', { token: 'ok' })).resolves.toBe('user-1');
    });

    it('mounts a prefix owned by the parent rather than the child router', async () => {
        const api = PerfectWS.Router();
        api.on('/users', () => ['Ada']);
        server.mount('/api', api);

        await expect(client.request('/api/users', {})).resolves.toEqual(['Ada']);
        await expect(client.request('/users', {})).rejects.toMatchObject({ code: 'notFound' });
    });

    it('applies router middleware to routes registered before and after use()', async () => {
        const calls: string[] = [];
        const api = PerfectWS.Router();
        api.on('/before', () => { calls.push('before'); return true; });
        api.use(() => { calls.push('api'); });
        api.on('/after', () => { calls.push('after'); return true; });
        server.mount('/api', api);

        await client.request('/api/before', {});
        expect(calls).toEqual(['api', 'before']);
        calls.length = 0;
        await client.request('/api/after', {});
        expect(calls).toEqual(['api', 'after']);
    });

    it('updates already-mounted routes when middleware is added later', async () => {
        const calls: string[] = [];
        const api = PerfectWS.Router();
        api.on('/value', () => { calls.push('handler'); return 1; });
        server.mount('/api', api);

        await client.request('/api/value', {});
        expect(calls).toEqual(['handler']);

        calls.length = 0;
        api.use(() => { calls.push('late'); });
        await client.request('/api/value', {});
        expect(calls).toEqual(['late', 'handler']);
    });

    it('uses a stable middleware snapshot for a request already in progress', async () => {
        const calls: string[] = [];
        let continueRequest!: () => void;
        let middlewareStarted!: () => void;
        const started = new Promise<void>(resolve => { middlewareStarted = resolve; });
        const gate = new Promise<void>(resolve => { continueRequest = resolve; });
        const api = PerfectWS.Router();
        api.use(async () => {
            calls.push('first');
            middlewareStarted();
            await gate;
        });
        api.on('/value', () => { calls.push('handler'); return 1; });
        server.mount('/api', api);

        const request = client.request('/api/value', {});
        await started;
        api.use(() => { calls.push('late'); });
        continueRequest();
        await request;
        expect(calls).toEqual(['first', 'handler']);

        calls.length = 0;
        await client.request('/api/value', {});
        expect(calls).toEqual(['first', 'late', 'handler']);
    });

    it('runs root and nested middleware from outermost to innermost', async () => {
        const calls: string[] = [];
        const api = PerfectWS.Router();
        const users = PerfectWS.Router();

        server.use(() => { calls.push('root'); });
        api.use(() => { calls.push('api'); });
        users.use(() => { calls.push('users'); });
        users.on('/list', () => { calls.push('handler'); return []; });
        api.mount('/users', users);
        server.mount('/api', api);

        await client.request('/api/users/list', {});
        expect(calls).toEqual(['root', 'api', 'users', 'handler']);
    });

    it('connects routes and nested routers added after their parent is mounted', async () => {
        const api = PerfectWS.Router();
        server.mount('/api', api);

        api.on('/health', () => 'ok');
        const users = PerfectWS.Router();
        users.on('/list', () => ['Ada']);
        api.mount('/users', users);

        await expect(client.request('/api/health', {})).resolves.toBe('ok');
        await expect(client.request('/api/users/list', {})).resolves.toEqual(['Ada']);
    });

    it('removes routes before or after mounting without affecting siblings', async () => {
        const api = PerfectWS.Router();
        api.on('/removed-before', () => 1).off('/removed-before');
        api.on('/kept', () => 2);
        api.on('/removed-after', () => 3);
        server.mount('/api', api);
        api.off('/removed-after');

        await expect(client.request('/api/kept', {})).resolves.toBe(2);
        await expect(client.request('/api/removed-before', {})).rejects.toMatchObject({ code: 'notFound' });
        await expect(client.request('/api/removed-after', {})).rejects.toMatchObject({ code: 'notFound' });
    });

    it('supports sibling routers and empty mount prefixes', async () => {
        const first = PerfectWS.Router().on('/one', () => 1);
        const second = PerfectWS.Router().on('/two', () => 2);
        server.mount('', first).mount('/api', second);

        await expect(client.request('/one', {})).resolves.toBe(1);
        await expect(client.request('/api/two', {})).resolves.toBe(2);
    });

    it('returns the router from on(), off(), use(), and mount() for optional chaining', () => {
        const router = PerfectWS.Router();
        const child = PerfectWS.Router();
        expect(router.use(vi.fn())).toBe(router);
        expect(router.on('/value', vi.fn())).toBe(router);
        expect(router.off('/value')).toBe(router);
        expect(router.mount('/child', child)).toBe(router);
        expect(server.use(vi.fn())).toBe(server);
        expect(server.on('value', vi.fn())).toBe(server);
        expect(server.off('value')).toBe(server);
        expect(server.mount('/router', router)).toBe(server);
    });

    it('rejects the removed child-prefix and use(router) forms with migration errors', () => {
        expect(() => new (PerfectWSSubRoute as any)('/api')).toThrow(/prefix to parent\.mount/);
        expect(() => (server as any).use(PerfectWS.Router())).toThrow(/mount\(prefix, router\)/);
        expect(() => (PerfectWS.Router() as any).use(PerfectWS.Router())).toThrow(/mount\(prefix, router\)/);
    });

    it('validates mount arguments and server-only usage', () => {
        expect(() => (server as any).mount(1, PerfectWS.Router())).toThrow(/string prefix/);
        expect(() => (server as any).mount('/api', {})).toThrow(/created by PerfectWS\.Router/);
        expect(() => (PerfectWS.Router() as any).mount('/api', {})).toThrow(/created by PerfectWS\.Router/);
        expect(() => client.use(vi.fn())).toThrow(/server instance/);
        expect(() => client.mount('/api', PerfectWS.Router())).toThrow(/server instance/);
    });

    it('rejects duplicate, self, and circular mounts', () => {
        const parent = PerfectWS.Router();
        const child = PerfectWS.Router();
        parent.mount('/child', child);

        expect(() => parent.mount('/again', child)).toThrow(/already mounted/);
        expect(() => parent.mount('/self', parent)).toThrow(/inside itself/);
        expect(() => child.mount('/parent', parent)).toThrow(/descendants/);

        server.mount('/parent', parent);
        expect(() => server.mount('/again', parent)).toThrow(/already mounted/);
        expect(() => parent.__connect(server)).toThrow(/already mounted/);
    });

    it('does not let one route owner remove another route at the same method', () => {
        const first = PerfectWS.Router().on('/value', () => 1);
        const second = PerfectWS.Router().on('/value', () => 2);
        server.mount('/same', first);
        server.mount('/same', second);
        first.off('/value');

        expect((server as any)._listenForRequests.get('/same/value').owner).toBe(second);
    });
});
