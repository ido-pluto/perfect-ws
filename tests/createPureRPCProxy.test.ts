import { describe, it, expect, vi } from 'vitest';
import { createPureRPCProxy, PureRPCTransport } from '../src/PerfectWSAdvanced/transform/utils/createPureRPCProxy.js';

function mockTransport(overrides: Partial<PureRPCTransport> = {}): PureRPCTransport {
    return {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined),
        apply: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('createPureRPCProxy', () => {
    describe('the root handle', () => {
        it('is not thenable - accessing .then on the root returns undefined, not a function', () => {
            const remote = createPureRPCProxy(mockTransport());
            expect(remote.then).toBeUndefined();
        });

        it('is still a real object/function you can access further properties on', () => {
            const remote = createPureRPCProxy(mockTransport());
            expect(typeof remote).toBe('function');
            expect(remote.count).toBeDefined();
        });

        it('does not call the transport just from being constructed or referenced', () => {
            const transport = mockTransport();
            createPureRPCProxy(transport);
            expect(transport.get).not.toHaveBeenCalled();
            expect(transport.set).not.toHaveBeenCalled();
            expect(transport.apply).not.toHaveBeenCalled();
        });
    });

    describe('explicit disposal (Symbol.dispose / Symbol.asyncDispose)', () => {
        it('calling Symbol.dispose on the root invokes transport.release', () => {
            const release = vi.fn();
            const remote = createPureRPCProxy(mockTransport({ release }));

            remote[Symbol.dispose]();

            expect(release).toHaveBeenCalledTimes(1);
        });

        it('Symbol.asyncDispose also invokes transport.release', async () => {
            const release = vi.fn();
            const remote = createPureRPCProxy(mockTransport({ release }));

            await remote[Symbol.asyncDispose]();

            expect(release).toHaveBeenCalledTimes(1);
        });

        it('disposal on a child (non-root) proxy does not call release - only the root has an rpcId to release', () => {
            const release = vi.fn();
            const remote = createPureRPCProxy(mockTransport({ release }));

            expect(remote.inner[Symbol.dispose]).toBeUndefined();
        });

        it('is undefined when the transport does not support release', () => {
            const remote = createPureRPCProxy(mockTransport({ release: undefined }));
            expect(remote[Symbol.dispose]).toBeUndefined();
        });

        it('uses an attached disposer when outer request cleanup defines one', () => {
            const release = vi.fn();
            const attached = vi.fn();
            const remote = createPureRPCProxy(mockTransport({ release }));
            Object.defineProperty(remote, Symbol.dispose, { value: attached, configurable: true });

            remote[Symbol.dispose]();

            expect(attached).toHaveBeenCalledOnce();
            expect(release).not.toHaveBeenCalled();
        });

        it('rejects later operations after the root is released', async () => {
            const remote = createPureRPCProxy(mockTransport({ release: vi.fn() }));
            remote[Symbol.dispose]();

            await expect((async () => await remote.count)()).rejects.toThrow('released');
            await expect(remote.increment()).rejects.toThrow('released');
        });
    });

    describe('get - path accumulation and flush', () => {
        it('does not call the transport until the chain is actually awaited', () => {
            const transport = mockTransport();
            const remote = createPureRPCProxy(transport);

            const chain = remote.a.b.c;

            expect(transport.get).not.toHaveBeenCalled();
            void chain;
        });

        it('awaiting a chain sends exactly one get with the full accumulated path', async () => {
            const transport = mockTransport({ get: vi.fn(async (path) => { void path; return 42; }) });
            const remote = createPureRPCProxy(transport);

            const result = await remote.a.b.c;

            expect(result).toBe(42);
            expect(transport.get).toHaveBeenCalledTimes(1);
            expect(transport.get).toHaveBeenCalledWith(['a', 'b', 'c']);
        });

        it('a single top-level property access sends a one-element path', async () => {
            const transport = mockTransport({ get: vi.fn(async () => 5) });
            const remote = createPureRPCProxy(transport);

            expect(await remote.count).toBe(5);
            expect(transport.get).toHaveBeenCalledWith(['count']);
        });

        it('two independent property accesses are two independent chains, each with their own path', async () => {
            const transport = mockTransport({ get: vi.fn(async (path) => path.join('.')) });
            const remote = createPureRPCProxy(transport);

            expect(await remote.a).toBe('a');
            expect(await remote.b.c).toBe('b.c');
            expect(transport.get).toHaveBeenCalledTimes(2);
        });

        it('a rejected get propagates to the awaiting caller', async () => {
            const transport = mockTransport({ get: vi.fn(async () => { throw new Error('boom'); }) });
            const remote = createPureRPCProxy(transport);

            // `remote.missing` is a thenable, not a native Promise - go through an async
            // function (which does chase a thenable correctly via `await`) rather than
            // `expect(...).rejects`, whose thenable-detection isn't guaranteed the same way.
            await expect((async () => await remote.missing)()).rejects.toThrow('boom');
        });
    });

    describe('apply - method calls', () => {
        it('calling a chain sends an apply with the path and args', async () => {
            const transport = mockTransport({ apply: vi.fn(async (path, args) => `${path.join('.')}(${args.join(',')})`) });
            const remote = createPureRPCProxy(transport);

            const result = await remote.increment(1, 2);

            expect(result).toBe('increment(1,2)');
            expect(transport.apply).toHaveBeenCalledWith(['increment'], [1, 2]);
        });

        it('calling a nested chain includes the full path', async () => {
            const transport = mockTransport({ apply: vi.fn(async (path) => path.join('.')) });
            const remote = createPureRPCProxy(transport);

            expect(await remote.inner.method()).toBe('inner.method');
        });

        it('does not also call get - apply is a distinct trap', async () => {
            const transport = mockTransport({ apply: vi.fn(async () => 'result') });
            const remote = createPureRPCProxy(transport);

            await remote.method();

            expect(transport.get).not.toHaveBeenCalled();
        });
    });

    describe('set', () => {
        it('returns synchronously (true) without the caller having to await it', () => {
            const transport = mockTransport();
            const remote = createPureRPCProxy(transport);

            expect(() => { remote.count = 10; }).not.toThrow();
        });

        it('sends the path and value to the transport', () => {
            const transport = mockTransport();
            const remote = createPureRPCProxy(transport);

            remote.inner.count = 10;

            expect(transport.set).toHaveBeenCalledWith(['inner', 'count'], 10);
        });

        it('a set that eventually rejects does not produce an unhandled rejection', async () => {
            const transport = mockTransport({ set: vi.fn(async () => { throw new Error('write failed'); }) });
            const remote = createPureRPCProxy(transport);

            remote.count = 10;
            // If the rejection weren't handled internally, this would surface as an unhandled
            // rejection in the test run.
            await new Promise(resolve => setTimeout(resolve, 10));
        });
    });

    describe('set/get ordering (audit finding A2)', () => {
        it('a get waits for an outstanding set before it flushes', async () => {
            const order: string[] = [];
            let releaseSet: () => void;
            const setPromise = new Promise<void>(resolve => { releaseSet = resolve; });

            const transport = mockTransport({
                set: vi.fn(async () => { await setPromise; order.push('set-done'); }),
                get: vi.fn(async () => { order.push('get-done'); return 'value'; }),
            });
            const remote = createPureRPCProxy(transport);

            remote.count = 10;
            const getPromise = remote.count;

            // The set hasn't resolved yet - the get must not have flushed either.
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(order).toEqual([]);

            releaseSet!();
            await getPromise;

            expect(order).toEqual(['set-done', 'get-done']);
        });

        it('a set that fails does not block a later get from resolving', async () => {
            const transport = mockTransport({
                set: vi.fn(async () => { throw new Error('write failed'); }),
                get: vi.fn(async () => 'value'),
            });
            const remote = createPureRPCProxy(transport);

            remote.count = 10;
            await expect(remote.count).resolves.toBe('value');
        });

        it('an apply also waits for an outstanding set on the same handle', async () => {
            const order: string[] = [];
            let releaseSet: () => void;
            const setPromise = new Promise<void>(resolve => { releaseSet = resolve; });

            const transport = mockTransport({
                set: vi.fn(async () => { await setPromise; order.push('set-done'); }),
                apply: vi.fn(async () => { order.push('apply-done'); }),
            });
            const remote = createPureRPCProxy(transport);

            remote.count = 10;
            const applyPromise = remote.increment();

            await new Promise(resolve => setTimeout(resolve, 10));
            expect(order).toEqual([]);

            releaseSet!();
            await applyPromise;

            expect(order).toEqual(['set-done', 'apply-done']);
        });

        it('a get started before a set only waits for sets that were already pending, not later ones', async () => {
            // Not a strict ordering guarantee across unrelated calls - this documents the
            // "snapshot at call time" behavior rather than asserting a stronger guarantee.
            const transport = mockTransport({ get: vi.fn(async () => 'value') });
            const remote = createPureRPCProxy(transport);

            const getPromise = remote.count;
            remote.count = 10;

            await expect(getPromise).resolves.toBe('value');
        });
    });
});
