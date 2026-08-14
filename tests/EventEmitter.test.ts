import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../src/utils/EventEmitter.ts';

/**
 * NetworkEventListener already exercises most of this logic indirectly (it extends
 * EventEmitter and adds the local/remote source-prefix argument), but EventEmitter is
 * also usable entirely standalone with no prefix args - this covers that plain usage
 * directly, plus prependListener ordering, which is easy to silently break.
 */
describe('EventEmitter (standalone, no prefix args)', () => {
    it('invokes listeners registered with on() in registration order', () => {
        const emitter = new EventEmitter<{ ping: [count: number] }>();
        const calls: number[] = [];

        emitter.on('ping', (count) => calls.push(count));
        emitter.on('ping', (count) => calls.push(count * 10));

        emitter.emit('ping', 3);

        expect(calls).toEqual([3, 30]);
    });

    it('once() fires exactly once and self-removes', () => {
        const emitter = new EventEmitter<{ tick: [] }>();
        const listener = vi.fn();

        emitter.once('tick', listener);
        emitter.emit('tick');
        emitter.emit('tick');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(emitter.listenerCount('tick')).toBe(0);
    });

    it('off() removes only the specified listener', () => {
        const emitter = new EventEmitter<{ tick: [] }>();
        const a = vi.fn();
        const b = vi.fn();

        emitter.on('tick', a);
        emitter.on('tick', b);
        emitter.off('tick', a);
        emitter.emit('tick');

        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('prependListener runs before previously registered listeners', () => {
        const emitter = new EventEmitter<{ tick: [] }>();
        const order: string[] = [];

        emitter.on('tick', () => order.push('first'));
        emitter.prependListener('tick', () => order.push('prepended'));
        emitter.emit('tick');

        expect(order).toEqual(['prepended', 'first']);
    });

    it('prependOnceListener runs first and only once', () => {
        const emitter = new EventEmitter<{ tick: [] }>();
        const order: string[] = [];

        emitter.on('tick', () => order.push('regular'));
        emitter.prependOnceListener('tick', () => order.push('once'));

        emitter.emit('tick');
        emitter.emit('tick');

        expect(order).toEqual(['once', 'regular', 'regular']);
    });

    it('onAny receives the event name and args for every emitted event', () => {
        const emitter = new EventEmitter();
        const seen: any[] = [];

        emitter.onAny((event, ...args) => seen.push([event, args]));
        emitter.emit('a', 1);
        emitter.emit('b', 2, 3);

        expect(seen).toEqual([
            ['a', [1]],
            ['b', [2, 3]],
        ]);
    });

    it('offAny removes a specific onAny listener without affecting others', () => {
        const emitter = new EventEmitter();
        const kept = vi.fn();
        const removed = vi.fn();

        emitter.onAny(kept);
        emitter.onAny(removed);
        emitter.offAny(removed);
        emitter.emit('x');

        expect(kept).toHaveBeenCalledTimes(1);
        expect(removed).not.toHaveBeenCalled();
    });

    it('removeAllListeners(event) clears only that event', () => {
        const emitter = new EventEmitter<{ a: []; b: [] }>();
        const onA = vi.fn();
        const onB = vi.fn();

        emitter.on('a', onA);
        emitter.on('b', onB);
        emitter.removeAllListeners('a');

        emitter.emit('a');
        emitter.emit('b');

        expect(onA).not.toHaveBeenCalled();
        expect(onB).toHaveBeenCalledTimes(1);
    });

    it('removeAllListeners() with no args clears every event and onAny listeners', () => {
        const emitter = new EventEmitter<{ a: []; b: [] }>();
        const onA = vi.fn();
        const onAny = vi.fn();

        emitter.on('a', onA);
        emitter.onAny(onAny);
        emitter.removeAllListeners();

        emitter.emit('a');

        expect(onA).not.toHaveBeenCalled();
        expect(onAny).not.toHaveBeenCalled();
        expect(emitter.eventNames()).toEqual([]);
    });

    it('eventNames() only lists events with at least one live listener', () => {
        const emitter = new EventEmitter<{ a: []; b: [] }>();
        const listener = vi.fn();

        emitter.on('a', listener);
        emitter.on('b', listener);
        emitter.off('b', listener);

        expect(emitter.eventNames()).toEqual(['a']);
    });

    it('listeners()/rawListeners() return the live listener array for an event', () => {
        const emitter = new EventEmitter<{ a: [] }>();
        const listener = vi.fn();

        emitter.on('a', listener);

        expect(emitter.listeners('a')).toEqual([listener]);
        expect(emitter.rawListeners('a')).toEqual([listener]);
        expect(emitter.listeners('unknown')).toEqual([]);
    });

    it('a listener throwing aborts the rest of that emit() dispatch (forEach is not isolated per-listener)', () => {
        const emitter = new EventEmitter<{ tick: [] }>();
        const after = vi.fn();

        emitter.on('tick', () => { throw new Error('boom'); });
        emitter.on('tick', after);

        expect(() => emitter.emit('tick')).toThrow('boom');
        expect(after).not.toHaveBeenCalled();
    });
});
