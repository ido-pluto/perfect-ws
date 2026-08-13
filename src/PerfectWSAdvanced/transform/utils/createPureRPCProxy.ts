export type PureRPCTransport = {
    get(path: readonly PropertyKey[]): Promise<any>;
    set(path: readonly PropertyKey[], value: any): Promise<void>;
    apply(path: readonly PropertyKey[], args: any[]): Promise<any>;
    release?(): void;
};

const finalizationRegistry = typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<() => void>(release => release())
    : undefined;

function createProxyState(transport: PureRPCTransport) {
    const pendingSets = new Set<Promise<void>>();
    const unregisterToken = {};
    let released = false;

    const release = () => {
        if (released) return;
        released = true;
        finalizationRegistry?.unregister(unregisterToken);
        transport.release?.();
    };

    const assertActive = () => {
        if (released) {
            throw new Error('PureRPC handle has been released');
        }
    };

    const waitForPendingSets = async () => {
        if (pendingSets.size > 0) {
            await Promise.allSettled([...pendingSets]);
        }
    };

    return { transport, pendingSets, unregisterToken, release, assertActive, waitForPendingSets };
}

export function createPureRPCProxy(transport: PureRPCTransport): any {
    const state = createProxyState(transport);
    const leaseAnchor: { root?: object; } = {};

    const build = (path: readonly PropertyKey[]): any => {
        const target = function pureRPCHandle(...args: any[]) {
            return (async () => {
                state.assertActive();
                await state.waitForPendingSets();
                const result = await transport.apply(path, args);
                void leaseAnchor;
                return result;
            })();
        };

        const handler: ProxyHandler<typeof target> & { leaseAnchor: object; } = {
            leaseAnchor,
            get(target, key) {
                if (key === Symbol.dispose || key === Symbol.asyncDispose) {
                    if (Object.hasOwn(target, key)) {
                        return Reflect.get(target, key);
                    }

                    if (path.length === 0 && transport.release) {
                        return key === Symbol.asyncDispose ? async () => state.release() : state.release;
                    }
                    return undefined;
                }

                if (key === 'then') {
                    if (path.length === 0) {
                        return undefined;
                    }

                    return (resolve: (value: any) => void, reject: (reason: any) => void) => {
                        (async () => {
                            state.assertActive();
                            await state.waitForPendingSets();
                            const result = await transport.get(path);
                            void leaseAnchor;
                            return result;
                        })().then(resolve, reject);
                    };
                }

                return build([...path, key]);
            },

            set(_target, key, value) {
                state.assertActive();
                const pending = transport.set([...path, key], value);
                state.pendingSets.add(pending);
                pending.catch(() => { }).finally(() => {
                    state.pendingSets.delete(pending);
                    void leaseAnchor;
                });
                return true;
            },

            apply(target, thisArg, args) {
                return Reflect.apply(target, thisArg, args);
            },

            has() {
                return true;
            }
        };

        return new Proxy(target, handler);
    };

    const root = build([]);
    leaseAnchor.root = root;

    if (finalizationRegistry && transport.release) {
        finalizationRegistry.register(leaseAnchor, state.release, state.unregisterToken);
    }

    return root;
}
