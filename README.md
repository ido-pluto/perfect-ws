# PerfectWS

<div align="center">

[![Build](https://github.com/ido-pluto/perfect-ws/actions/workflows/build.yml/badge.svg)](https://github.com/ido-pluto/perfect-ws/actions/workflows/build.yml)
[![Coverage](https://ido-pluto.github.io/perfect-ws/badge.svg)](https://ido-pluto.github.io/perfect-ws/)
[![License](https://badgen.net/badge/color/MIT/green?label=license)](https://www.npmjs.com/package/perfect-ws)
[![Types](https://badgen.net/badge/color/TypeScript/blue?label=types)](https://www.npmjs.com/package/perfect-ws)
[![npm downloads](https://img.shields.io/npm/dt/perfect-ws.svg)](https://www.npmjs.com/package/perfect-ws)
[![Version](https://badgen.net/npm/v/perfect-ws)](https://www.npmjs.com/package/perfect-ws)

</div>

RPC over WebSockets for TypeScript and JavaScript. Register a handler on one side, call it from the other, and receive the result as a promise.

PerfectWS includes password authentication, automatic reconnection, request timeouts, and streaming responses. Auth connections use the BSON-only `PerfectWS` protocol by default; advanced serialization for functions, binary/native types, circular objects, and PureRPC is an explicit opt-in.

## Install

PerfectWS requires Node.js 22 or newer.

```bash
npm install perfect-ws
```

## Quick start

Create a server and register the methods clients may call:

```typescript
// server.ts
import { ServerHost } from 'perfect-ws';

const host = new ServerHost({
  port: 8080,
  password: 'shared-secret',
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

const remote = new RemoteClient({
  url: 'ws://localhost:8080',
  password: 'shared-secret',
});

remote.start();

const result = await remote.router.request('greet', { name: 'Ada' });
console.log(result.message); // Hello, Ada!
```

Requests wait for the connection by default, so they can be made immediately after `remote.start()`. Call `remote.stop()` and `host.stop()` when a short-lived program is finished.

`ServerHost`, `ClientHost`, `RemoteClient`, and `RemoteServer` deliberately default to base `PerfectWS`. This keeps the default serialization surface limited to BSON-compatible values. To pass functions, preserve advanced native types, use custom transforms, or enable PureRPC, explicitly select `PerfectWSAdvanced` on both peers:

```typescript
import { PerfectWSAdvanced, RemoteClient, ServerHost } from 'perfect-ws';

const host = new ServerHost({
  password: 'shared-secret',
  port: 8080,
  perfectWSConstructor: PerfectWSAdvanced,
});

const remote = new RemoteClient({
  password: 'shared-secret',
  url: 'ws://localhost:8080',
  perfectWSConstructor: PerfectWSAdvanced,
});
```

Use the same protocol constructor on both ends of a connection.

### Request timeouts

A request may remain pending for 15 minutes by default. This is a maximum request duration, not an idle timeout. Set a longer limit for one request, or use `0` or `Infinity` when it must have no deadline:

```typescript
const result = await remote.router.request('report.create', input, {
  timeout: 30 * 60_000, // 30 minutes
});

await remote.router.request('worker.watch', null, { timeout: Infinity });
```

Change `remote.router.config.requestTimeout` to set a different default. Once a request returns its final response, this timer is finished. Returned callbacks, signals, and PureRPC handles have no idle timeout; they remain live until released by garbage collection, explicit disposal, router shutdown, or reconnection synchronization with a peer that no longer knows the request.

## Common use cases

Most applications only need these patterns:

| You need to | Use |
|---|---|
| Return one result | Return a value from the handler |
| Report progress | Call `send(update, false)` before returning |
| Let the server call the client | Opt into `PerfectWSAdvanced`, then pass a function |
| Cancel work | Pass an `AbortSignal` in the request options |
| Work with live remote state | Opt into `PerfectWSAdvanced`, then return `PureRPC` |
| Group related methods | Create `PerfectWS.Router()` and attach it with `mount(prefix, router)` |

Base `PerfectWS` handles BSON-compatible objects and arrays by value. With `PerfectWSAdvanced` explicitly selected on both peers, `Map`s and `Set`s are preserved, functions and transferred `AbortSignal`s stay live, and `PureRPC` can keep an object on its owner for remote operations.

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

### Passing or returning a function

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

For route groups, `use()` adds middleware and `mount()` attaches a child router:

```typescript
import { PerfectWS } from 'perfect-ws';

const accounts = PerfectWS.Router();
accounts.use(requireUser);
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

const host = new ServerHost({
  port: 8080,
  password: 'shared-secret',
  perfectWSConstructor: PerfectWSAdvanced,
  fullTrustedRPC: true,
});

host.router.on('counter', () => new Counter());
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
- [Middleware and routing](docs/middleware-and-routing.md) - validation, shared middleware, and route groups
- [Reconnection and streaming](docs/reconnection-and-streaming.md) - continuity during connection loss
- [Serialization and transforms](docs/serialization-and-transforms.md) - callbacks, binary data, native types, and custom classes
- [PureRPC](docs/pure-rpc.md) - live remote objects and automatic cleanup
- [Production and resilience](docs/production-resilience.md) - timeouts, limits, pings, and ACK tuning
- [API reference](docs/api-reference.md) - core types, signatures, and configuration

For local debugging, pass `debugging: true` to the host and client. This logs the authentication flow and disables the ping loop and ACK system so breakpoints do not close the connection. Do not leave it enabled in production: ACKs are what detect a packet lost at the edge of a disconnect and retry it after reconnection.

## Upgrading to v2

The familiar client, server, router, and request pattern remains, while v2 expands the public types and RPC APIs. The v1 and v2 wire protocols are incompatible, so upgrade both sides of a connection together.

Child routers are also a breaking API change: create them without a prefix,
use `use()` only for middleware, and attach them with
`parent.mount(prefix, child)`.
