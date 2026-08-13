import { WebSocketServer } from 'ws';
import { PerfectWS, PerfectWSAdvanced, PureRPC } from 'perfect-ws';
import { MoneyTransform } from '../shared/Money.js';

class Counter extends PureRPC {
  count = 0;
  labels = new Set(['node']);

  add(amount: number) {
    this.count += amount;
    return this.count;
  }

  async calculate(callback: (value: number) => Promise<number>, value: number) {
    return await callback(value);
  }
}

export async function startAcceptanceServer() {
  const base = PerfectWS.server();
  const advanced = PerfectWSAdvanced.server();
  const wss = new WebSocketServer({ port: 0 });
  let lastRequestAbort: unknown;

  for (const router of [base.router, advanced.router]) {
    router.config.runPingLoop = false;
    router.config.requestTimeout = 5_000;
    router.config.reconnectTimeout = 5_000;
  }
  advanced.router.config.fullTrustedRPC = true;
  advanced.router.transformers.push(new MoneyTransform());

  base.router.use((data: any) => {
    data.trace ??= [];
    data.trace.push('root');
  });
  const api = PerfectWS.Router();
  api.use((data: any) => data.trace.push('api'));
  const users = PerfectWS.Router();
  users.use((data: any) => data.trace.push('users'));
  users.on('/echo', (data: any) => ({ value: data.value, trace: data.trace }));
  api.mount('/users', users);
  base.router.mount('/api', api);

  base.router.on('/stream', async (_data, { send }) => {
    await send({ progress: 25 }, false);
    await send({ progress: 75 }, false);
    return { progress: 100 };
  });
  base.router.on('/wait-for-abort', async (_data, { abortSignal, send }) => {
    await send({ started: true }, false);
    if (!abortSignal.aborted) {
      await new Promise<void>(resolve => abortSignal.addEventListener('abort', () => resolve(), { once: true }));
    }
    lastRequestAbort = abortSignal.reason;
    return { aborted: true };
  });
  base.router.on('/abort-status', () => ({ reason: lastRequestAbort }));

  advanced.router.on('/complex', async (data: any) => {
    const bytes = data.values.get('bytes');
    const response: any = {
      callbackResult: await data.callback(7),
      callbackIdentity: data.callback === data.values.get('callback'),
      money: data.values.get('money'),
      bytes,
      bytesSeenByNode: [...bytes],
      byteLengthSeenByNode: bytes.byteLength,
      nodeBuffer: Buffer.from([9, 8, 7]),
      set: data.set,
      regexp: data.regexp,
      error: Object.assign(new Error('from node'), { code: 'NODE_SIDE' }),
      callback: data.callback,
    };
    response.self = response;
    return response;
  });
  advanced.router.on('/node-callback', () => (value: number) => value + 1);
  advanced.router.on('/counter', () => new Counter());
  advanced.router.on('/signal', async (data: { first: AbortSignal; second: AbortSignal }) => {
    const same = data.first === data.second;
    if (!data.first.aborted) {
      await new Promise<void>(resolve => data.first.addEventListener('abort', () => resolve(), { once: true }));
    }
    return { same, reason: data.first.reason };
  });

  wss.on('connection', (socket, request) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/base') base.attachClient(socket);
    else if (path === '/advanced') advanced.attachClient(socket);
    else socket.close(1008, 'Unknown PerfectWS test endpoint');
  });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('Browser acceptance server has no TCP port');

  return {
    port: address.port,
    async close() {
      base.unregister();
      advanced.unregister();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close(error => error ? reject(error) : resolve());
      });
    },
  };
}
