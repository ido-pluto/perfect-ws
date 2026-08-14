import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../src/utils/EventEmitter.js';
import { WebSocketForce, type WSLike } from '../src/utils/WebSocketForce.js';
import { attachDispose } from '../src/utils/attachDispose.js';
import { PasswordRateLimiter } from '../src/auth/utils/PasswordRateLimiter.js';
import { validatePassword } from '../src/auth/utils/validatePassword.js';
import { generateRemoteId } from '../src/auth/utils/generateRemoteId.js';
import { validateWithZod } from '../src/middleware/zodValidation.js';
import { PerfectWSSubRoute } from '../src/PerfectWSSubRoute.js';
import { PerfectWSAdvanced } from '../src/PerfectWSAdvanced/PerfectWSAdvanced.js';
import { sleep } from '../src/utils/sleepPromise.js';
import { isFinitePositiveTimeout, isValidRequestTimeout, setLongTimeout } from '../src/utils/setLongTimeout.js';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('remaining small utility paths', () => {
    it('only enables finite positive timeouts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        expect(isValidRequestTimeout(0)).toBe(true);
        expect(isValidRequestTimeout(1)).toBe(true);
        expect(isValidRequestTimeout(Infinity)).toBe(true);
        expect(isValidRequestTimeout(-1)).toBe(false);
        expect(isValidRequestTimeout(-Infinity)).toBe(false);
        expect(isValidRequestTimeout(NaN)).toBe(false);
        expect(isValidRequestTimeout('1')).toBe(false);
        expect(isValidRequestTimeout(null)).toBe(false);
        expect(isValidRequestTimeout(undefined)).toBe(false);
        expect(isValidRequestTimeout(1n)).toBe(false);
        expect(isValidRequestTimeout(Symbol('timeout'))).toBe(false);
        expect(isValidRequestTimeout(new Number(1))).toBe(false);
        const valueOf = vi.fn(() => 1);
        expect(isValidRequestTimeout({ valueOf })).toBe(false);
        expect(valueOf).not.toHaveBeenCalled();
        expect(isFinitePositiveTimeout(1)).toBe(true);
        expect(isFinitePositiveTimeout(0)).toBe(false);
        expect(isFinitePositiveTimeout(-1)).toBe(false);
        expect(isFinitePositiveTimeout(Infinity)).toBe(false);
        expect(isFinitePositiveTimeout(-Infinity)).toBe(false);
        expect(isFinitePositiveTimeout(NaN)).toBe(false);

        const callback = vi.fn();
        setLongTimeout(callback, Infinity);
        setLongTimeout(callback, 0);
        setLongTimeout(callback, -1);
        setLongTimeout(callback, -Infinity);
        setLongTimeout(callback, NaN);
        expect(vi.getTimerCount()).toBe(0);

        setLongTimeout(callback, 10);
        await vi.advanceTimersByTimeAsync(10);
        expect(callback).toHaveBeenCalledOnce();
    });

    it('chunks durations beyond the native timer limit and remains cancellable between chunks', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const nativeTimerLimit = 0x7fff_ffff;
        const callback = vi.fn();

        setLongTimeout(callback, nativeTimerLimit + 10);
        await vi.advanceTimersByTimeAsync(nativeTimerLimit);
        expect(callback).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(9);
        expect(callback).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(callback).toHaveBeenCalledOnce();

        const cancelledCallback = vi.fn();
        const cancel = setLongTimeout(cancelledCallback, nativeTimerLimit + 10);
        await vi.advanceTimersByTimeAsync(nativeTimerLimit);
        cancel();
        await vi.advanceTimersByTimeAsync(10);
        expect(cancelledCallback).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a pending sleep immediately and accepts an already-aborted signal', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const pending = sleep(60_000, controller.signal);

        controller.abort('stop');
        await expect(pending).resolves.toBeUndefined();
        await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('prepends into a previously unseen event', () => {
        const emitter = new EventEmitter();
        const listener = vi.fn();
        emitter.prependListener('new', listener);
        emitter.emit('new');
        expect(listener).toHaveBeenCalledOnce();
    });

    it('covers synchronous fallback and repeated async disposal', async () => {
        const existing = vi.fn();
        const release = vi.fn();
        const value = Object.assign([], { [Symbol.dispose]: existing });
        const attached = attachDispose(value, release);

        await attached[Symbol.asyncDispose]();
        await attached[Symbol.asyncDispose]();

        expect(existing).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
    });

    it('covers null-prototype objects and functions in attachDispose', () => {
        const nullPrototype = Object.assign(Object.create(null), { value: 1 });
        expect(attachDispose(nullPrototype, vi.fn())).not.toBe(nullPrototype);

        const callable = () => 1;
        expect(attachDispose(callable, vi.fn())).toBe(callable);
    });

    it('covers every password limiter lifecycle and capacity branch', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const limiter = new PasswordRateLimiter(2, 100, 1);

        expect(limiter.isBlocked('missing')).toBe(false);
        limiter.recordFailure('a');
        (limiter as any)._startSweepIfNeeded();
        limiter.recordFailure('a');
        expect(limiter.isBlocked('a')).toBe(true);

        limiter.recordFailure('b');
        expect((limiter as any)._attempts.has('a')).toBe(false);
        vi.setSystemTime(1_101);
        expect(limiter.isBlocked('b')).toBe(false);

        limiter.recordFailure('c');
        vi.setSystemTime(1_202);
        (limiter as any)._sweep();
        expect((limiter as any)._attempts.size).toBe(0);

        limiter.reset('missing');
        limiter.stop();
        limiter.stop();
    });

    it('accepts a missing password policy and passes callback arguments', async () => {
        const socket = {} as WSLike;
        expect(await validatePassword('anything', { forceSocket: socket })).toBe(true);
        const request = {} as any;
        const policy = vi.fn(() => true);
        expect(await validatePassword('secret', { forceSocket: socket, request, password: policy })).toBe(true);
        expect(policy).toHaveBeenCalledWith('secret', socket, request);
    });

    it('generates an id when navigator is unavailable', () => {
        vi.stubGlobal('navigator', undefined);
        expect(generateRemoteId('server')).toMatch(/^server-unknown-/);
    });

    it('formats validation errors with and without paths and missing issue arrays', () => {
        const noIssues = validateWithZod({ safeParse: () => ({ success: false }) });
        expect(() => noIssues({})).toThrow();

        const firstWithoutPath = validateWithZod({
            safeParse: () => ({ success: false, error: { issues: [{ path: [], message: 'root' }] } }),
        });
        expect(() => firstWithoutPath({})).toThrow('root');

        const allErrors = validateWithZod({
            safeParse: () => ({
                success: false,
                error: { issues: [{ path: [], message: 'root' }, { path: ['x'], message: 'bad' }] },
            }),
        }, { abortEarly: false });
        expect(() => allErrors({})).toThrow('root, x: bad');

        const symbolPath = validateWithZod({
            safeParse: () => ({
                success: false,
                error: { issues: [{ path: [Symbol.for('field')], message: 'bad' }] },
            }),
        });
        expect(() => symbolPath({})).toThrow('Symbol(field): bad');
    });

    it('leaves successful data alone when stripping has no result data', () => {
        const data = { keep: true };
        validateWithZod({ safeParse: () => ({ success: true }) }, { stripUnknown: true })(data);
        expect(data).toEqual({ keep: true });
    });
});

function socket(overrides: Partial<WSLike> = {}): WSLike {
    return {
        url: 'ws://test',
        protocol: 'p',
        extensions: 'e',
        binaryType: 'arraybuffer',
        bufferedAmount: 2,
        readyState: 1,
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close: vi.fn(),
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...overrides,
    };
}

describe('remaining WebSocketForce paths', () => {
    it('delegates all metadata and DOM handler accessors', () => {
        const raw = socket();
        const force = new WebSocketForce(raw);
        const open = vi.fn();
        const close = vi.fn();
        const error = vi.fn();
        const message = vi.fn();

        force.binaryType = 'blob';
        force.onopen = open;
        force.onclose = close;
        force.onerror = error;
        force.onmessage = message;

        expect(force.url).toBe('ws://test');
        expect(force.bufferedAmount).toBe(2);
        expect(force.extensions).toBe('e');
        expect(force.protocol).toBe('p');
        expect(force.binaryType).toBe('blob');
        expect(force.onopen).toBe(open);
        expect(force.onclose).toBe(close);
        expect(force.onerror).toBe(error);
        expect(force.onmessage).toBe(message);

        force.onclose = null;
        force.onclose = null;
    });

    it('does not double-register native close and isolates throwing virtual listeners', () => {
        const raw = socket();
        const force = new WebSocketForce(raw);
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const throwing = () => { throw new Error('listener failed'); };
        const once = vi.fn();

        force.addEventListener('close', throwing);
        (force as any)._registerNativeCloseHandler();
        force.addEventListener('close', once, { once: true });
        (force as any)._triggerVirtualCloseListeners();
        (force as any)._triggerVirtualCloseListeners();

        expect(log).toHaveBeenCalled();
        expect(once).toHaveBeenCalledOnce();
        force.removeEventListener('close', throwing);
        force.removeEventListener('close', throwing);
    });

    it('registers the same close listener once and dispatches close only once', () => {
        const force = new WebSocketForce(socket());
        const listener = vi.fn();

        force.addEventListener('close', listener);
        force.addEventListener('close', listener, { once: true });
        (force as any)._triggerVirtualCloseListeners();
        (force as any)._triggerVirtualCloseListeners();

        expect(listener).toHaveBeenCalledOnce();
        expect((force as any)._virtualCloseListeners).toHaveLength(1);
    });

    it('does not skip the next close listener when one removes itself', () => {
        const force = new WebSocketForce(socket());
        const calls: string[] = [];
        const first = () => {
            calls.push('first');
            force.removeEventListener('close', first);
        };
        const second = () => {
            calls.push('second');
            force.removeEventListener('close', second);
        };

        force.addEventListener('close', first);
        force.addEventListener('close', second);
        (force as any)._triggerVirtualCloseListeners();

        expect(calls).toEqual(['first', 'second']);
        expect((force as any)._virtualCloseListeners).toHaveLength(0);
    });

    it('skips a close listener removed by an earlier listener in the same dispatch', () => {
        const force = new WebSocketForce(socket());
        const second = vi.fn();
        const first = vi.fn(() => force.removeEventListener('close', second));

        force.addEventListener('close', first);
        force.addEventListener('close', second);
        (force as any)._triggerVirtualCloseListeners();

        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
    });

    it('covers dispatch and emit fallbacks', () => {
        const event = new Event('ping');
        const dispatch = vi.fn(() => true);
        expect(new WebSocketForce(socket({ dispatchEvent: dispatch })).dispatchEvent(event)).toBe(true);

        const emit = vi.fn(() => true);
        expect(new WebSocketForce(socket({ emit })).dispatchEvent(event)).toBe(true);
        expect(new WebSocketForce(socket()).dispatchEvent(event)).toBe(false);

        expect(new WebSocketForce(socket({ emit })).emit('ping', 1)).toBe(true);
        expect(new WebSocketForce(socket({ dispatchEvent: dispatch })).emit('ping', 1)).toBe(true);
        expect(new WebSocketForce(socket()).emit('ping')).toBe(false);
    });

    it('resolves close immediately after forced closure and covers forceClose variants', async () => {
        const nativeForceClose = vi.fn(() => { throw new Error('native failure'); });
        const raw = socket({ forceClose: nativeForceClose } as any);
        const force = new WebSocketForce(raw);

        force.forceClose();
        force.forceClose();
        expect(force.readyState).toBe(WebSocketForce.CLOSED);
        await expect(force.once('close')).resolves.toMatchObject({ type: 'close' });

        const throwingClose = new WebSocketForce(socket({ close: () => { throw new Error('close failed'); } }));
        expect(() => throwingClose.forceClose(3000, 'failed')).not.toThrow();
    });

    it('covers setMaxListeners when present and absent', () => {
        const setMaxListeners = vi.fn();
        new WebSocketForce(socket({ setMaxListeners } as any)).setMaxListeners(5);
        new WebSocketForce(socket()).setMaxListeners(5);
        expect(setMaxListeners).toHaveBeenCalledWith(5);
    });
});

describe('remaining route and advanced factory paths', () => {
    it('registers and removes routes after a subroute is connected', () => {
        const protocol = { __registerSubRoute: vi.fn(), __unregisterSubRoute: vi.fn() } as any;
        const route = new PerfectWSSubRoute();
        route.__connect(protocol, '/api/');
        const handler = vi.fn();
        route.on('ping', handler);
        route.off('ping');

        expect(protocol.__registerSubRoute).toHaveBeenCalledWith('/api/ping', [handler], expect.any(Function), route);
        expect(protocol.__unregisterSubRoute).toHaveBeenCalledWith('/api/ping', route);
    });

    it('removes a queued subroute before it is connected', () => {
        const protocol = { __registerSubRoute: vi.fn(), __unregisterSubRoute: vi.fn() } as any;
        const route = new PerfectWSSubRoute();
        route.on('ping', vi.fn());
        route.off('ping');
        route.__connect(protocol, '/api/');

        expect(protocol.__registerSubRoute).not.toHaveBeenCalled();
    });

    it('constructs the advanced subclass through its static factory', () => {
        expect((PerfectWSAdvanced as any)._newInstance()).toBeInstanceOf(PerfectWSAdvanced);
    });
});
