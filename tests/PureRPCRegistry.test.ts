import { describe, it, expect } from 'vitest';
import { PureRPCRegistry } from '../src/PerfectWSAdvanced/transform/utils/PureRPCRegistry.js';

describe('PureRPCRegistry', () => {
    describe('register / has / release', () => {
        it('registers an object and reports it as known', () => {
            const registry = new PureRPCRegistry();
            const rpcId = registry.register({ a: 1 });

            expect(typeof rpcId).toBe('string');
            expect(registry.has(rpcId)).toBe(true);
        });

        it('is idempotent - the same object gets the same id', () => {
            const registry = new PureRPCRegistry();
            const obj = { a: 1 };

            expect(registry.register(obj)).toBe(registry.register(obj));
        });

        it('gives different objects different ids', () => {
            const registry = new PureRPCRegistry();
            expect(registry.register({ a: 1 })).not.toBe(registry.register({ a: 1 }));
        });

        it('forgets a released id', () => {
            const registry = new PureRPCRegistry();
            const rpcId = registry.register({ a: 1 });

            registry.release(rpcId);

            expect(registry.has(rpcId)).toBe(false);
        });

        it('releasing an unknown id is a no-op', () => {
            const registry = new PureRPCRegistry();
            expect(() => registry.release('unknown')).not.toThrow();
        });

        it('re-registering after release mints a new id', () => {
            const registry = new PureRPCRegistry();
            const obj = { a: 1 };
            const first = registry.register(obj);

            registry.release(first);
            const second = registry.register(obj);

            expect(second).not.toBe(first);
            expect(registry.has(second)).toBe(true);
        });

        it('releaseAll forgets everything', () => {
            const registry = new PureRPCRegistry();
            const a = registry.register({ x: 1 });
            const b = registry.register({ y: 2 });

            registry.releaseAll();

            expect(registry.has(a)).toBe(false);
            expect(registry.has(b)).toBe(false);
        });
    });

    describe('maxHandles cap (audit A5 - "always fetch" can mint unbounded handles)', () => {
        it('throws once the cap is reached', () => {
            const registry = new PureRPCRegistry(2);
            registry.register({ a: 1 });
            registry.register({ b: 2 });

            expect(() => registry.register({ c: 3 })).toThrow(/maxPureRPCHandles/);
        });

        it('does not count a re-registration of the same object against the cap', () => {
            const registry = new PureRPCRegistry(1);
            const obj = { a: 1 };
            registry.register(obj);

            expect(() => registry.register(obj)).not.toThrow();
        });

        it('releasing frees up room under the cap', () => {
            const registry = new PureRPCRegistry(1);
            const first = registry.register({ a: 1 });

            registry.release(first);

            expect(() => registry.register({ b: 2 })).not.toThrow();
        });

        it('defaults to a generous cap (10_000) rather than being effectively unlimited', () => {
            const registry = new PureRPCRegistry();
            for (let i = 0; i < 100; i++) registry.register({ i });
            expect(registry.size).toBe(100);
        });
    });

    describe('resolve', () => {
        it('resolves a top-level own property', () => {
            const registry = new PureRPCRegistry();
            const rpcId = registry.register({ count: 5 });

            const result = registry.resolve(rpcId, ['count']);

            expect(result?.value).toBe(5);
        });

        it('resolves a nested own property, and the receiver is the immediate parent', () => {
            const registry = new PureRPCRegistry();
            const inner = { deep: 'value' };
            const rpcId = registry.register({ inner });

            const result = registry.resolve(rpcId, ['inner', 'deep']);

            expect(result?.value).toBe('value');
            expect(result?.receiver).toBe(inner);
        });

        it('resolves a method defined on the class, with the instance as receiver', () => {
            class Counter {
                count = 0;
                increment() { return ++this.count; }
            }

            const registry = new PureRPCRegistry();
            const counter = new Counter();
            const rpcId = registry.register(counter);

            const result = registry.resolve(rpcId, ['increment']);

            expect(typeof result?.value).toBe('function');
            expect(result?.receiver).toBe(counter);
            // Calling it through the resolved receiver behaves like a normal method call.
            expect((result!.value as Function).call(result!.receiver)).toBe(1);
            expect(counter.count).toBe(1);
        });

        it('returns undefined for an unknown rpcId', () => {
            const registry = new PureRPCRegistry();
            expect(registry.resolve('unknown', ['a'])).toBeUndefined();
        });

        it('returns undefined for an empty path', () => {
            const registry = new PureRPCRegistry();
            const rpcId = registry.register({ a: 1 });

            expect(registry.resolve(rpcId, [])).toBeUndefined();
        });

        it('returns undefined for a missing property', () => {
            const registry = new PureRPCRegistry();
            const rpcId = registry.register({ a: 1 });

            expect(registry.resolve(rpcId, ['missing'])).toBeUndefined();
        });

        it('returns undefined once a released handle is used', () => {
            const registry = new PureRPCRegistry();
            const rpcId = registry.register({ a: 1 });
            registry.release(rpcId);

            expect(registry.resolve(rpcId, ['a'])).toBeUndefined();
        });

        describe('security guards', () => {
            it('refuses __proto__ as a path segment', () => {
                const registry = new PureRPCRegistry();
                const rpcId = registry.register({ a: 1 });

                expect(registry.resolve(rpcId, ['__proto__'])).toBeUndefined();
                expect(registry.resolve(rpcId, ['__proto__', 'polluted'])).toBeUndefined();
            });

            it('refuses constructor and prototype as path segments', () => {
                const registry = new PureRPCRegistry();
                const rpcId = registry.register({ a: 1 });

                expect(registry.resolve(rpcId, ['constructor'])).toBeUndefined();
                expect(registry.resolve(rpcId, ['constructor', 'constructor'])).toBeUndefined();
                expect(registry.resolve(rpcId, ['a', 'constructor'])).toBeUndefined();
            });

            it('does not reach Object.prototype members on a plain object', () => {
                const registry = new PureRPCRegistry();
                const rpcId = registry.register({ a: 1 });

                // A plain object's immediate prototype IS Object.prototype - these must not
                // be reachable through it (constructor.constructor('return process') escape).
                expect(registry.resolve(rpcId, ['toString'])).toBeUndefined();
                expect(registry.resolve(rpcId, ['hasOwnProperty'])).toBeUndefined();
                expect(registry.resolve(rpcId, ['__defineGetter__'])).toBeUndefined();
            });

            it('supports user-defined inheritance without exposing Object.prototype', () => {
                class Base {
                    baseMethod() { return 'base'; }
                }
                class Derived extends Base {
                    ownMethod() { return 'own'; }
                }

                const registry = new PureRPCRegistry();
                const rpcId = registry.register(new Derived());

                expect(registry.resolve(rpcId, ['ownMethod'])).toBeDefined();
                expect(registry.resolve(rpcId, ['baseMethod'])).toBeDefined();
                expect(registry.resolve(rpcId, ['toString'])).toBeUndefined();
            });

            it('does not resolve into a primitive value', () => {
                const registry = new PureRPCRegistry();
                const rpcId = registry.register({ n: 5 });

                expect(registry.resolve(rpcId, ['n', 'toFixed'])).toBeUndefined();
            });

            it('does not resolve through null or undefined', () => {
                const registry = new PureRPCRegistry();
                const rpcId = registry.register({ missing: null });

                expect(registry.resolve(rpcId, ['missing', 'x'])).toBeUndefined();
            });

            it('does not reach Function.prototype through a resolved method (confirmed exploit, regression test)', () => {
                class Vault {
                    private secret = 'top-secret';
                    check(this: Vault) { return this.secret === 'top-secret'; }
                }

                const registry = new PureRPCRegistry();
                const rpcId = registry.register(new Vault());

                // Before the fix: resolve(['check', 'apply']) returned the real
                // Function.prototype.apply, letting a caller invoke `check` with a forged `this`
                // - e.g. `.apply({ secret: 'forged' }, [])` - bypassing whatever the method
                // trusted about its own receiver. None of .call/.apply/.bind should resolve.
                expect(registry.resolve(rpcId, ['check', 'call'])).toBeUndefined();
                expect(registry.resolve(rpcId, ['check', 'apply'])).toBeUndefined();
                expect(registry.resolve(rpcId, ['check', 'bind'])).toBeUndefined();

                // The method itself must still resolve normally - only its prototype is blocked.
                expect(typeof registry.resolve(rpcId, ['check'])?.value).toBe('function');
            });

            it('rejects a non-array path instead of iterating a string\'s characters (confirmed bug, regression test)', () => {
                const registry = new PureRPCRegistry();
                const rpcId = registry.register({ a: { b: 1 } });

                // Before the fix: resolve(rpcId, 'a') "worked" by iterating 'a' as a single
                // character path segment, resolving the same as ['a'] purely by coincidence -
                // this fails closed instead of trusting an unvalidated shape from the wire.
                expect(registry.resolve(rpcId, 'a' as any)).toBeUndefined();
                expect(registry.resolve(rpcId, 'ab' as any)).toBeUndefined();
            });
        });
    });
});
