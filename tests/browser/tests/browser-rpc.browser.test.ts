import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import * as conditionalEntry from 'perfect-ws';
import * as browserEntry from 'perfect-ws/browser';
import { Money, MoneyTransform } from '../shared/Money.js';

type ClientResult = ReturnType<typeof browserEntry.PerfectWS.client<WebSocket>>;

const clients: ClientResult[] = [];
const sockets: WebSocket[] = [];

function url(path: 'base' | 'advanced') {
  return `ws://127.0.0.1:${inject('rpcPort')}/${path}`;
}

function openClient(advanced = false, clientId = crypto.randomUUID()) {
  const socket = new WebSocket(url(advanced ? 'advanced' : 'base'));
  const result = advanced
    ? browserEntry.PerfectWSAdvanced.client<WebSocket>(socket, { clientId })
    : browserEntry.PerfectWS.client<WebSocket>(socket, { clientId });
  result.router.config.runPingLoop = false;
  result.router.config.requestTimeout = 5_000;
  result.router.config.reconnectTimeout = 5_000;
  if (advanced) {
    const router = result.router as browserEntry.PerfectWSAdvanced<WebSocket>;
    router.config.fullTrustedRPC = true;
    router.transformers.push(new MoneyTransform());
  }
  clients.push(result);
  sockets.push(socket);
  return { result, socket };
}

afterEach(async () => {
  for (const result of clients.splice(0)) result.unregister();
  await Promise.all(sockets.splice(0).map(async socket => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>(resolve => {
      socket.addEventListener('close', () => resolve(), { once: true });
      socket.addEventListener('error', () => resolve(), { once: true });
    });
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 1_000))]);
  }));
});

describe('browser package entry', () => {
  it('uses the browser export condition and excludes Node-only auth hosts', () => {
    expect(conditionalEntry.PerfectWS).toBe(browserEntry.PerfectWS);
    expect(conditionalEntry.PerfectWSAdvanced).toBe(browserEntry.PerfectWSAdvanced);
    expect('ServerHost' in conditionalEntry).toBe(false);
    expect('ClientHost' in conditionalEntry).toBe(false);
  });
});

describe('browser to Node base PerfectWS', () => {
  it('runs nested Express-style routers and middleware in order', async () => {
    const { result } = openClient();
    await result.router.serverOpen;

    await expect(result.router.request('/api/users/echo', { value: 'browser', trace: [] })).resolves.toEqual({
      value: 'browser',
      trace: ['root', 'api', 'users'],
    });
  });

  it('streams ordered progress events before the final response', async () => {
    const { result } = openClient();
    await result.router.serverOpen;
    const received: Array<{ progress: number; done: boolean }> = [];

    const final = await result.router.request('/stream', {}, {
      callback(data: any, error, done) {
        expect(error).toBeNull();
        received.push({ progress: data.progress, done });
      },
    });

    expect(final).toEqual({ progress: 100 });
    expect(received).toEqual([
      { progress: 25, done: false },
      { progress: 75, done: false },
      { progress: 100, done: true },
    ]);
  });

  it('propagates browser request cancellation to the Node handler', async () => {
    const { result } = openClient();
    await result.router.serverOpen;
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const pending = result.router.request('/wait-for-abort', {}, {
      abortSignal: controller.signal,
      callback(data: any, error, done) {
        if (!done && !error && data.started) started.resolve();
      },
    });
    await started.promise;
    controller.abort('cancelled in browser');

    await expect(pending).rejects.toMatchObject({ code: 'abort' });
    await vi.waitFor(async () => {
      await expect(result.router.request('/abort-status', {})).resolves.toEqual({ reason: 'cancelled in browser' });
    });
  });
});

describe('browser to Node PerfectWSAdvanced', () => {
  it('round trips complex values, custom classes, callbacks, and circular identity', async () => {
    const { result } = openClient(true);
    await result.router.serverOpen;
    const callback = (value: number) => value * 3;
    const payload = {
      callback,
      values: new Map<string, unknown>([
        ['callback', callback],
        ['money', new Money(1299, 'EUR')],
        ['bytes', new Uint16Array([4, 8, 15, 16, 23, 42])],
      ]),
      set: new Set<unknown>([1n, new URL('https://example.com/browser')]),
      regexp: /perfect-ws/giu,
    };

    const response: any = await result.router.request('/complex', payload);

    expect(response.callbackResult).toBe(21);
    expect(response.callbackIdentity).toBe(true);
    expect(response.money).toBeInstanceOf(Money);
    expect(response.money).toEqual(new Money(1299, 'EUR'));
    expect(response.bytes).toBeInstanceOf(Uint16Array);
    expect(response.bytesSeenByNode).toEqual([4, 8, 15, 16, 23, 42]);
    expect(response.byteLengthSeenByNode).toBe(12);
    expect([...response.bytes]).toEqual([4, 8, 15, 16, 23, 42]);
    expect(response.nodeBuffer).toBeInstanceOf(Uint8Array);
    expect([...response.nodeBuffer]).toEqual([9, 8, 7]);
    expect(response.set).toBeInstanceOf(Set);
    expect(response.regexp).toEqual(/perfect-ws/giu);
    expect(response.error).toBeInstanceOf(Error);
    expect(response.error).toMatchObject({ message: 'from node', code: 'NODE_SIDE' });
    expect(response.callback).toBe(callback);
    expect(response.self).toBe(response);
  });

  it('controls a live Node-owned PureRPC class including nested Set methods', async () => {
    const { result } = openClient(true);
    await result.router.serverOpen;
    const counter: any = await result.router.request('/counter', null);

    expect(await counter.count).toBe(0);
    expect(await counter.add(5)).toBe(5);
    await counter.labels.add('browser');
    expect(await counter.labels.has('browser')).toBe(true);
    expect(await counter.calculate((value: number) => value + 10, 7)).toBe(17);

    counter[Symbol.dispose]();
  });

  it('preserves a duplicated live AbortSignal and its browser-side abort', async () => {
    const { result } = openClient(true);
    await result.router.serverOpen;
    const controller = new AbortController();
    const response = result.router.request('/signal', {
      first: controller.signal,
      second: controller.signal,
    });
    controller.abort('browser signal stopped');

    await expect(response).resolves.toEqual({ same: true, reason: 'browser signal stopped' });
  });

  it('keeps a returned callback alive across a real browser WebSocket reconnect', async () => {
    const clientId = crypto.randomUUID();
    const { result, socket } = openClient(true, clientId);
    await result.router.serverOpen;
    const remoteCallback: any = await result.router.request('/node-callback', null);

    const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
    socket.close(4000, 'browser reconnect test');
    await closed;

    const replacement = new WebSocket(url('advanced'));
    sockets.push(replacement);
    result.setServer(replacement);
    await result.router.serverOpen;

    await expect(remoteCallback(9)).resolves.toBe(10);
  });
});
