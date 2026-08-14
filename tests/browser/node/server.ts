import { createServer } from 'node:net';
import { PerfectWS, PerfectWSAdvanced, PureRPC, ServerHost } from 'perfect-ws';
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
  const password = 'browser-acceptance-secret';
  const [basePort, advancedPort] = await getAvailablePorts(2);
  const base = new ServerHost({
    id: 'browser-base-server',
    password,
    perfectWSConstructor: PerfectWS,
    port: basePort,
    host: '127.0.0.1',
    debugging: true,
  });
  const advanced = new ServerHost({
    id: 'browser-advanced-server',
    password,
    perfectWSConstructor: PerfectWSAdvanced,
    fullTrustedRPC: true,
    port: advancedPort,
    host: '127.0.0.1',
    debugging: true,
  });
  base.start();
  advanced.start();
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
  base.router.on('/drop-connection', (_data, { ws }) => {
    setTimeout(() => ws.forceClose(4000, 'browser reconnect test'), 10);
    return { dropping: true };
  });

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
  advanced.router.on('/drop-connection', (_data, { ws }) => {
    setTimeout(() => ws.forceClose(4000, 'browser reconnect test'), 10);
    return { dropping: true };
  });

  return {
    basePort,
    advancedPort,
    async close() {
      base.stop();
      advanced.stop();
    },
  };
}

async function getAvailablePorts(count: number) {
  const reservations = Array.from({ length: count }, () => createServer());
  try {
    return await Promise.all(reservations.map(server => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to allocate a browser acceptance port'));
          return;
        }
        resolve(address.port);
      });
    })));
  } finally {
    await Promise.all(reservations.map(server => new Promise<void>(resolve => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
  }
}
