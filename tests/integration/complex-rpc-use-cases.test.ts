import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkEventListener, PerfectWSAdvanced, PureRPC, TransformInstruction } from '../../src/index.js';
import { createDuplexPair } from '../utils/createDuplexPair.js';

class Money {
    constructor(public cents: number, public currency: string) { }
}

class MoneyTransform extends TransformInstruction<Money> {
    uniqueId = 'integration.money';

    check(data: any): data is Money {
        return data instanceof Money;
    }

    serialize(data: Money) {
        return { cents: data.cents, currency: data.currency };
    }

    deserialize(data: { cents: number; currency: string; }) {
        return new Money(data.cents, data.currency);
    }
}

describe('complex serialization and PureRPC use cases', () => {
    const cleanups: (() => void)[] = [];
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const directory of temporaryDirectories.splice(0)) {
            await rm(directory, { recursive: true, force: true });
        }
    });

    const createPair = async ({ trusted = false, customTransforms = false } = {}) => {
        const serverResult = PerfectWSAdvanced.server();
        const clientResult = PerfectWSAdvanced.client();
        serverResult.router.config.fullTrustedRPC = trusted;
        clientResult.router.config.fullTrustedRPC = trusted;

        if (customTransforms) {
            serverResult.router.transformers.push(new MoneyTransform());
            clientResult.router.transformers.push(new MoneyTransform());
        }

        const { clientWs, serverWs } = createDuplexPair();
        serverResult.attachClient(serverWs as any);
        clientResult.setServer(clientWs as any);
        await clientResult.router.serverOpen;
        cleanups.push(clientResult.unregister, serverResult.unregister);

        return { client: clientResult.router, server: serverResult.router };
    };

    it('round trips a dense ordinary payload by value while preserving live callback and signal identity', async () => {
        const { client, server } = await createPair({ customTransforms: true });
        const controller = new AbortController();
        const calculate = (value: number) => value * 3;
        const circular: any = { label: 'root' };
        circular.self = circular;

        server.on('inspectPayload', async (data: any) => {
            const signalFromSet = [...data.values].find((value: unknown) => value instanceof AbortSignal);
            const response: any = {
                callbackResult: await data.calculate(7),
                callbackIdentity: data.calculate === data.lookup.get('calculate'),
                signalIdentity: data.signal === signalFromSet,
                circularIdentity: data.circular.self === data.circular,
                mapIsMap: data.lookup instanceof Map,
                setIsSet: data.values instanceof Set,
                bytes: data.lookup.get('bytes'),
                price: data.lookup.get('price'),
                calculate: data.calculate,
                signal: data.signal,
            };
            response.self = response;
            return response;
        });

        const result: any = await client.request('inspectPayload', {
            calculate,
            signal: controller.signal,
            circular,
            lookup: new Map<string, unknown>([
                ['calculate', calculate],
                ['bytes', new Uint8Array([4, 5, 6])],
                ['price', new Money(1299, 'USD')],
            ]),
            values: new Set<unknown>([controller.signal, 9n, new URL('https://example.com/item')]),
        });

        expect(result.callbackResult).toBe(21);
        expect(result.callbackIdentity).toBe(true);
        expect(result.signalIdentity).toBe(true);
        expect(result.circularIdentity).toBe(true);
        expect(result.mapIsMap).toBe(true);
        expect(result.setIsSet).toBe(true);
        expect(result.bytes).toBeInstanceOf(Uint8Array);
        expect([...result.bytes]).toEqual([4, 5, 6]);
        expect(result.price).toBeInstanceOf(Money);
        expect(result.price).toEqual(new Money(1299, 'USD'));
        expect(result.calculate).toBe(calculate);
        expect(result.signal).toBe(controller.signal);
        expect(result.self).toBe(result);
    });

    it('rejects immediately when a response cannot be serialized', async () => {
        class UnserializableResponse { }
        const { client, server } = await createPair();
        server.transformers.push({
            uniqueId: 'integration.throwing-response',
            check: (value: unknown): value is UnserializableResponse => value instanceof UnserializableResponse,
            serialize: () => { throw new Error('response serialization failed'); },
            deserialize: value => value,
        });
        server.on('unserializableResponse', () => new UnserializableResponse());

        await expect(client.request('unserializableResponse', null, { timeout: 250 })).rejects.toMatchObject({
            code: 'serializeFailed',
            message: 'response serialization failed',
        });
    });

    it('rejects a PureRPC operation whose result cannot be serialized', async () => {
        class UnserializableResult { }
        class Service extends PureRPC {
            result() {
                return new UnserializableResult();
            }
        }
        const { client, server } = await createPair({ trusted: true });
        server.transformers.push({
            uniqueId: 'integration.throwing-rpc-result',
            check: (value: unknown): value is UnserializableResult => value instanceof UnserializableResult,
            serialize: () => { throw new Error('RPC result serialization failed'); },
            deserialize: value => value,
        });
        server.on('unserializableRPCResult', () => new Service());

        const remote: any = await client.request('unserializableRPCResult');
        await expect(remote.result()).rejects.toMatchObject({
            code: 'pureRPCError',
            message: 'RPC result serialization failed',
        });
    });

    it('rejects a callback operation whose client-owned result cannot be serialized', async () => {
        class UnserializableResult { }
        const { client, server } = await createPair();
        client.transformers.push({
            uniqueId: 'integration.throwing-callback-result',
            check: (value: unknown): value is UnserializableResult => value instanceof UnserializableResult,
            serialize: () => { throw new Error('callback result serialization failed'); },
            deserialize: value => value,
        });
        server.on('invokeUnserializableCallback', async ({ callback }: any) => callback());

        await expect(client.request('invokeUnserializableCallback', {
            callback: () => new UnserializableResult(),
        })).rejects.toMatchObject({
            code: 'callbackError',
            message: 'callback result serialization failed',
        });
    });

    it('rejects a callback operation whose server-owned result cannot be serialized', async () => {
        class UnserializableResult { }
        const { client, server } = await createPair();
        server.transformers.push({
            uniqueId: 'integration.throwing-server-callback-result',
            check: (value: unknown): value is UnserializableResult => value instanceof UnserializableResult,
            serialize: () => { throw new Error('server callback result failed'); },
            deserialize: value => value,
        });
        server.on('serverCallback', () => () => new UnserializableResult());

        const callback: any = await client.request('serverCallback');
        await expect(callback()).rejects.toMatchObject({
            code: 'callbackError',
            message: 'server callback result failed',
        });
    });

    it('rejects an unserializable argument to a returned callback without closing its channel', async () => {
        class UnserializableArgument { }
        const { client, server } = await createPair();
        client.transformers.push({
            uniqueId: 'integration.throwing-callback-argument',
            check: (value: unknown): value is UnserializableArgument => value instanceof UnserializableArgument,
            serialize: () => { throw new Error('callback argument failed'); },
            deserialize: value => value,
        });
        server.on('argumentCallback', () => (value: unknown) => value);

        const callback: any = await client.request('argumentCallback');
        await expect(callback(new UnserializableArgument())).rejects.toMatchObject({
            code: 'callbackError',
            message: 'callback argument failed',
        });
        await expect(callback('still live')).resolves.toBe('still live');
    });

    it('rejects a client-owned PureRPC result that cannot be serialized', async () => {
        class UnserializableResult { }
        class ClientService extends PureRPC {
            result() { return new UnserializableResult(); }
        }
        const { client, server } = await createPair({ trusted: true });
        client.transformers.push({
            uniqueId: 'integration.throwing-client-rpc-result',
            check: (value: unknown): value is UnserializableResult => value instanceof UnserializableResult,
            serialize: () => { throw new Error('client RPC result failed'); },
            deserialize: value => value,
        });
        server.on('invokeClientService', async ({ service }: any) => service.result());

        await expect(client.request('invokeClientService', { service: new ClientService() }))
            .rejects.toMatchObject({ code: 'pureRPCError', message: 'client RPC result failed' });
    });

    it('contains serialization failure of a custom response event', async () => {
        class UnserializableEvent { }
        const { client, server } = await createPair();
        server.transformers.push({
            uniqueId: 'integration.throwing-event',
            check: (value: unknown): value is UnserializableEvent => value instanceof UnserializableEvent,
            serialize: () => { throw new Error('event serialization failed'); },
            deserialize: value => value,
        });
        server.on('badEvent', (_data, { events }) => {
            events.on('___request.sendFailed', () => { throw new Error('observer failed'); });
            events.emit('custom', new UnserializableEvent());
            return 'finished';
        });
        const events = new NetworkEventListener();

        await expect(client.request('badEvent', null, { events })).resolves.toBe('finished');
    });

    it('does not let a stale callback release invalidate a reacquired callback', async () => {
        const { client, server } = await createPair();
        const owned = () => 'still-live';
        server.on('callbackLease', (_data, options) => ({
            callback: owned,
            reacquire: () => {
                options.events.emit('release-old-callback');
                return owned;
            },
        }));

        const result: any = await client.request('callbackLease');
        const active = [...(client as any)._activeRequests.values()][0];
        active.events.on('release-old-callback', () => {
            (client as any)._getTransforms(active.events)._callbacks.releaseReceivedFunction(result.callback);
        });

        const fresh = await result.reacquire();
        await expect(fresh()).resolves.toBe('still-live');
    });

    it('does not let a stale PureRPC release invalidate a reacquired handle', async () => {
        class CounterHandle extends PureRPC {
            value = 0;
            increment() { return ++this.value; }
        }
        const { client, server } = await createPair({ trusted: true });
        const owned = new CounterHandle();
        server.on('handleLease', (_data, options) => ({
            handle: owned,
            reacquire: () => {
                options.events.emit('release-old-handle');
                return owned;
            },
        }));

        const result: any = await client.request('handleLease');
        result.reacquire;
        const active = [...(client as any)._activeRequests.values()][0];
        active.events.on('release-old-handle', () => result.handle[Symbol.dispose]());

        const fresh = await result.reacquire();
        await expect(fresh.increment()).resolves.toBe(1);
    });

    it('isolates one PureRPC argument serialization failure from concurrent calls', async () => {
        class BadArgument { }
        let finish!: (value: string) => void;
        class Service extends PureRPC {
            wait() { return new Promise<string>(resolve => { finish = resolve; }); }
            echo(value: unknown) { return value; }
        }
        const { client, server } = await createPair({ trusted: true });
        client.transformers.push({
            uniqueId: 'integration.bad-rpc-argument',
            check: (value: unknown): value is BadArgument => value instanceof BadArgument,
            serialize: () => { throw new Error('bad argument'); },
            deserialize: value => value,
        });
        server.on('isolatedRPCFailure', () => new Service());
        const remote: any = await client.request('isolatedRPCFailure');

        const valid = remote.wait();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        await expect(remote.echo(new BadArgument())).rejects.toMatchObject({
            code: 'pureRPCError',
            message: 'bad argument',
        });
        finish('completed');
        await expect(valid).resolves.toBe('completed');
    });

    it('supports registered symbols in PureRPC paths', async () => {
        const operation = Symbol.for('integration.double');
        class Service extends PureRPC {
            [operation](value: number) { return value * 2; }
        }
        const { client, server } = await createPair({ trusted: true });
        server.on('symbolRPC', () => new Service());

        const remote: any = await client.request('symbolRPC');
        await expect(remote[operation](4)).resolves.toBe(8);
    });

    it('preserves circular values in both directions on a retained request event channel', async () => {
        const { client, server } = await createPair();
        const events = new NetworkEventListener();

        server.on('eventChannel', (_data, options) => {
            options.events.on('cycle.request', (source, payload: any) => {
                if (source !== 'remote') return;
                const reply: any = { receivedCycle: payload.self === payload };
                reply.self = reply;
                options.events.emit('cycle.response', reply);
            });
            return () => 'channel alive';
        });

        const response = Promise.withResolvers<any>();
        events.on('cycle.response', (source, payload) => {
            if (source === 'remote') response.resolve(payload);
        });

        const keepAlive: any = await client.request('eventChannel', null, { events });
        const request: any = { name: 'cycle' };
        request.self = request;
        events.emit('cycle.request', request);

        const received = await response.promise;
        expect(received.receivedCycle).toBe(true);
        expect(received.self).toBe(received);
        await expect(keepAlive()).resolves.toBe('channel alive');
    });

    it('keeps repeated PureRPC handles, returned callbacks, and signals identical on one channel', async () => {
        class Toolkit extends PureRPC {
            readonly stopController = new AbortController();
            readonly stopSignal = this.stopController.signal;
            readonly transform = (value: number) => value + 10;
            readonly resources = new Map<string, unknown>([
                ['signal', this.stopSignal],
                ['transform', this.transform],
            ]);

            getSelf() { return this; }
            getSignal() { return this.stopSignal; }
            getTransform() { return this.transform; }
        }

        const { client, server } = await createPair({ trusted: true });
        const toolkit = new Toolkit();
        server.on('toolkit', () => ({
            primary: toolkit,
            aliases: new Map([['same', toolkit]]),
        }));

        const result: any = await client.request('toolkit');
        const remote = result.primary;

        expect(result.aliases).toBeInstanceOf(Map);
        expect(result.aliases.get('same')).toBe(remote);
        expect(await remote.getSelf()).toBe(remote);

        const firstTransform = await remote.getTransform();
        const secondTransform = await remote.resources.get('transform');
        expect(secondTransform).toBe(firstTransform);
        await expect(firstTransform(5)).resolves.toBe(15);

        const firstSignal = await remote.stopSignal;
        const secondSignal = await remote.getSignal();
        const thirdSignal = await remote.resources.get('signal');
        expect(secondSignal).toBe(firstSignal);
        expect(thirdSignal).toBe(firstSignal);

        const aborted = new Promise<void>(resolve => firstSignal.addEventListener('abort', () => resolve(), { once: true }));
        toolkit.stopController.abort('maintenance');
        await aborted;
        expect(firstSignal.reason).toBe('maintenance');
    });

    it('mutates owner-side Map and Set methods remotely but returns property reads as snapshots', async () => {
        class CollectionStore extends PureRPC {
            tags = new Set(['server']);
            metadata = new Map<string, number>([['revision', 1]]);
        }

        const { client, server } = await createPair({ trusted: true });
        const store = new CollectionStore();
        server.on('collections', () => store);

        const remote: any = await client.request('collections');
        await remote.tags.add('remote');
        await remote.metadata.set('revision', 2);

        expect(store.tags).toEqual(new Set(['server', 'remote']));
        expect(store.metadata.get('revision')).toBe(2);

        const tagsSnapshot = await remote.tags;
        const metadataSnapshot = await remote.metadata;
        tagsSnapshot.add('local-only');
        metadataSnapshot.set('revision', 99);

        expect(store.tags.has('local-only')).toBe(false);
        expect(store.metadata.get('revision')).toBe(2);
        expect(await remote.tags.has('remote')).toBe(true);
        expect(await remote.metadata.get('revision')).toBe(2);
    });

    it('uses a custom class as a remote file writer with binary chunks, callbacks, cancellation, Maps, and Sets', async () => {
        class RemoteFileWriter extends PureRPC {
            readonly #path: string;
            readonly tags = new Set(['open']);
            readonly metadata = new Map<string, string>([['encoding', 'utf8']]);
            readonly closedController = new AbortController();
            readonly closed = this.closedController.signal;

            constructor(path: string) {
                super();
                this.#path = path;
            }

            async appendBatch(options: {
                chunks: Set<Uint8Array>;
                attributes: Map<string, string>;
                signal: AbortSignal;
                onProgress: (written: number) => Promise<void>;
            }) {
                let written = 0;
                for (const chunk of options.chunks) {
                    if (options.signal.aborted) throw new Error(String(options.signal.reason ?? 'cancelled'));
                    await appendFile(this.#path, chunk);
                    written += chunk.byteLength;
                    await options.onProgress(written);
                }
                for (const [key, value] of options.attributes) this.metadata.set(key, value);
                return new Map<string, unknown>([
                    ['written', written],
                    ['tags', new Set(this.tags)],
                    ['metadata', new Map(this.metadata)],
                ]);
            }

            async read() {
                return new Uint8Array(await readFile(this.#path));
            }

            close(reason: string) {
                this.tags.add('closed');
                this.closedController.abort(reason);
            }
        }

        const directory = await mkdtemp(join(tmpdir(), 'perfect-ws-rpc-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'remote.txt');
        const writer = new RemoteFileWriter(path);
        const { client, server } = await createPair({ trusted: true });
        server.on('openWriter', () => writer);

        const remote: any = await client.request('openWriter');
        await expect((async () => await remote.path)()).rejects.toMatchObject({ code: 'pureRPCError' });
        const progress: number[] = [];
        const controller = new AbortController();
        const result = await remote.appendBatch({
            chunks: new Set([
                new TextEncoder().encode('hello '),
                new TextEncoder().encode('world'),
            ]),
            attributes: new Map([['owner', 'remote-client']]),
            signal: controller.signal,
            onProgress: async (written: number) => { progress.push(written); },
        });

        expect(result).toBeInstanceOf(Map);
        expect(result.get('written')).toBe(11);
        expect(result.get('tags')).toEqual(new Set(['open']));
        expect(result.get('metadata')).toEqual(new Map([
            ['encoding', 'utf8'],
            ['owner', 'remote-client'],
        ]));
        expect(progress).toEqual([6, 11]);
        expect(await readFile(path, 'utf8')).toBe('hello world');
        expect(new TextDecoder().decode(await remote.read())).toBe('hello world');

        const closed = await remote.closed;
        await remote.close('finished');
        expect(closed.aborted).toBe(true);
        expect(closed.reason).toBe('finished');
        expect(await remote.tags.has('closed')).toBe(true);

        const cancelled = new AbortController();
        cancelled.abort('cancelled before write');
        await expect(remote.appendBatch({
            chunks: new Set([new Uint8Array([1])]),
            attributes: new Map(),
            signal: cancelled.signal,
            onProgress: async () => undefined,
        })).rejects.toThrow('cancelled before write');
    });
});
