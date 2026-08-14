# PerfectWS

<div align="center">

[![Build](https://github.com/ido-pluto/perfect-ws/actions/workflows/build.yml/badge.svg)](https://github.com/ido-pluto/perfect-ws/actions/workflows/build.yml)
[![Coverage](https://ido-pluto.github.io/perfect-ws/badge.svg)](https://ido-pluto.github.io/perfect-ws/)
[![License](https://badgen.net/badge/color/MIT/green?label=license)](https://www.npmjs.com/package/perfect-ws)
[![Types](https://badgen.net/badge/color/TypeScript/blue?label=types)](https://www.npmjs.com/package/perfect-ws)
[![npm downloads](https://img.shields.io/npm/dt/perfect-ws.svg)](https://www.npmjs.com/package/perfect-ws)
[![Version](https://badgen.net/npm/v/perfect-ws)](https://www.npmjs.com/package/perfect-ws)

</div>

> RPC over WebSockets for TypeScript and JavaScript. Register a handler on one side, call it from the other side.

PerfectWS includes password authentication, automatic reconnection, request timeouts, and streaming responses.

## Install

The Node side requires Node.js 22 or newer. Browser clients use the browser entry in modern browsers with native WebSocket support.

```bash
npm install perfect-ws
```

## Quick start

Create a server and register the methods clients may call:

```typescript
// server.ts
import { ServerHost } from 'perfect-ws';

const debugging = process.env.NODE_ENV !== 'production';

const host = new ServerHost({
  port: 8080,
  password: 'shared-secret',
  debugging,
});

host.router.on('greet', ({ name }: { name: string }) => {
  return { message: `Hello, ${name}!` };
});

host.start();
```

Connect a client and call the method:

```typescript
// client.ts
import { RemoteClient } from 'perfect-ws';

const debugging = process.env.NODE_ENV !== 'production';

const remote = new RemoteClient({
  url: 'ws://localhost:8080',
  password: 'shared-secret',
  debugging,
});

remote.start();

const result = await remote.router.request('greet', { name: 'Ada' });
console.log(result.message); // Hello, Ada!
```

#### Debugging without false reconnects

`debugging: true` prevents false connection loss during breakpoints. It also logs the handshake and RPC flow, including request IDs, route names, and errors.


## Browser client

A browser can be the client as well. See [Browser clients](docs/browser.md) for details.

```typescript
// browser.ts
import { RemoteClient } from 'perfect-ws/browser';
```

### Request timeouts

A request may remain pending for 15 minutes by default. This is a maximum request duration, not an idle timeout. Set a longer limit for one request, or use `0` or `Infinity` when it must have no deadline:

```typescript
const result = await remote.router.request('report.create', input, {
  timeout: 30 * 60_000, // 30 minutes
});

await remote.router.request('worker.watch', null, { 
  timeout: Infinity
  callback: (update, error, done) => {
    if (!error && !done) console.log(`Progress: ${update.progress}%`);
  }
});
```

### Async work and errors

Handlers may be asynchronous. Use `reject` when the caller should receive an error with an application-specific code:

```typescript
// server
host.router.on('user.get', async ({ id }, { reject }) => {
  const user = await database.users.find(id);

  if (!user) {
    reject('User not found', 'userNotFound');
    return;
  }

  return user;
});
```

```typescript
// client
import { PerfectWSError } from 'perfect-ws';

try {
  const user = await remote.router.request('user.get', { id: '42' });
} catch (error) {
  if (error instanceof PerfectWSError && error.code === 'userNotFound') {
    console.log('That user does not exist.');
  }
}
```

### Progress updates

Send non-final updates with `send(data, false)`, then return the final result normally:

```typescript
// server
host.router.on('report.create', async (_data, { send }) => {
  await send({ progress: 25 }, false);
  await createReport();
  await send({ progress: 100 }, false);
  return { url: '/reports/latest.pdf' };
});
```

```typescript
// client
const report = await remote.router.request('report.create', null, {
  callback: (update, error, done) => {
    if (!error && !done) console.log(`${update.progress}%`);
  },
});

console.log(report.url);
```

## PerfectWSAdvanced
An advance serialization protocol for more RPC features:
- Callbacks,
- Map, Set, URL, Binary data, errors, and native types,
- Symbols
- AbortSignal
- Circular objects
- Getters and setters


#### Passing or returning a function

With `PerfectWSAdvanced` selected on both peers, functions are serialized as RPC callbacks:

```typescript
// server
host.router.on('job.run', async ({ onProgress }) => {
  await onProgress(50);
  await finishJob();
  await onProgress(100);
  return { done: true };
});
```

```typescript
// client
await remote.router.request('job.run', {
  onProgress: (percent: number) => console.log(`${percent}%`),
});
```

A handler may return a function in the same way:

```typescript
host.router.on('formatter', () => (name: string) => `Hello, ${name}!`);

const format = await remote.router.request('formatter');
console.log(await format('Ada')); // Hello, Ada!
```

PerfectWS keeps the callback usable while your code can still reach it and releases both sides after it is garbage-collected.

See [Common use cases](docs/common-use-cases.md) for cancellation, binary data, middleware, and route groups.

### Routing and middleware

For route groups, `use()` adds middleware and `mount()` attaches a child router:

```typescript
import { PerfectWS } from 'perfect-ws';

const accounts = PerfectWS.Router();
accounts.use(async (data,{ ws }) => {
  if (!ws.user) throw new Error('Not authenticated');
});

accounts.on('/get', data => data.user);


host.router.mount('/accounts', accounts);
```

## Live remote objects with PureRPC

Use `PureRPC` when an object should remain on its owner but the peer needs to read its current properties or call its methods. Enable `fullTrustedRPC` on both sides, and only use it between peers you trust.

```typescript
// server
import { PerfectWSAdvanced, PureRPC, ServerHost } from 'perfect-ws';

class Counter extends PureRPC {
  count = 0;
  increment() { return ++this.count; }
}

const globalCounter = new Counter();

const host = new ServerHost({
  port: 8080,
  password: 'shared-secret',
  perfectWSConstructor: PerfectWSAdvanced,
  fullTrustedRPC: true,
});

host.router.on('counter', () => globalCounter);
host.start();
```

```typescript
// client
import { PerfectWSAdvanced, RemoteClient } from 'perfect-ws';

const remote = new RemoteClient({
  url: 'ws://localhost:8080',
  password: 'shared-secret',
  perfectWSConstructor: PerfectWSAdvanced,
  fullTrustedRPC: true,
});

remote.start();

const counter: any = await remote.router.request('counter');

console.log(await counter.count);       // 0
console.log(await counter.increment()); // 1

counter.count = 10;
console.log(await counter.count);       // 10
```

No `using` declaration or `Symbol.dispose` call is required. PerfectWS keeps the remote object alive while the handle or any derived property handle is reachable, then automatically releases both sides after garbage collection. The same handle survives a normal reconnect of the same `RemoteClient` instance.

Use a `using` declaration when you want deterministic cleanup at the end of a scope:

```typescript
{
  using counter: any = await remote.router.request('counter');
  console.log(await counter.increment());
} // released here
```

This optional syntax needs a runtime that supports explicit resource management, or TypeScript transpilation. Node.js 22 cannot parse a raw `using` declaration; automatic cleanup works on every supported Node.js version.

A property read such as `await remote.items` returns a value snapshot. To mutate an owner-side `Map` or `Set`, invoke its method through the handle, for example `await remote.items.add(value)`. See the [PureRPC guide](docs/pure-rpc.md) for the trust model, container behavior, and lifetime details.

## Where to go next

- [Common use cases](docs/common-use-cases.md) - short recipes for everyday tasks
- [Authentication](docs/authentication.md) - credentials, rate limiting, reconnect options, and reverse connections
- [Browser clients](docs/browser.md) - connect a native browser WebSocket to a Node server
- [Middleware and routing](docs/middleware-and-routing.md) - validation, shared middleware, and route groups
- [Reconnection and streaming](docs/reconnection-and-streaming.md) - continuity during connection loss
- [Serialization and transforms](docs/serialization-and-transforms.md) - callbacks, binary data, native types, and custom classes
- [PureRPC](docs/pure-rpc.md) - live remote objects and automatic cleanup
- [Production and resilience](docs/production-resilience.md) - timeouts, limits, pings, and ACK tuning
- [API reference](docs/api-reference.md) - core types, signatures, and configuration

## Upgrading to v2

The familiar client, server, router, and request pattern remains, while v2 expands the public types and RPC APIs. The v1 and v2 wire protocols are incompatible, so upgrade both sides of a connection together.

Child routers are also a breaking API change: create them without a prefix,
use `use()` only for middleware, and attach them with
`parent.mount(prefix, child)`.
