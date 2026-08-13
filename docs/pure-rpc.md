# PureRPC

PureRPC lets one side use a live object owned by the other side. The object is not copied: property reads, writes, and method calls are sent to the original object.

Use PureRPC for a stateful service or resource. For one callable value, return a normal function instead.

## Complete example

Both peers must explicitly select `PerfectWSAdvanced` and enable `fullTrustedRPC`. Only enable it between peers you trust, because the peer can access the exposed object's properties and methods.

```typescript
// server.ts
import { PerfectWSAdvanced, PureRPC, ServerHost } from 'perfect-ws';

class Counter extends PureRPC {
  count = 0;

  increment() {
    return ++this.count;
  }

  add(amount: number) {
    this.count += amount;
    return this.count;
  }
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
// client.ts
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
console.log(await counter.add(4));      // 5

counter.count = 20;
console.log(await counter.count);       // 20
```

No `using` option, `using` declaration, or `Symbol.dispose` call is required.

If deterministic scope cleanup is useful, the returned handle supports JavaScript's `using` syntax:

```typescript
{
  using counter: any = await remote.router.request('counter');
  console.log(await counter.increment());
} // the handle is disposed here
```

This is optional. Without it, automatic garbage-collection cleanup remains the default.

Raw `using` syntax requires a runtime with explicit resource-management support, or TypeScript transpilation. Node.js 22 cannot parse it directly; use automatic cleanup there.

## How operations behave

- `await handle.property` reads the current owner-side value.
- `await handle.method(args)` calls the original method with the correct `this` value.
- `handle.property = value` starts an ordered write. A later read or call waits for earlier writes.
- A missing property, thrown method, failed connection, or released handle rejects instead of hanging.
- Methods inherited from your own base classes work; `Object.prototype`, `Function.prototype`, and unsafe keys such as `constructor` are not exposed.
- `then` is reserved so a returned handle is not mistaken for a Promise. Expose an owner method with another name if the original object has a `then` member.
- Each read or call is a network round trip, so prefer methods that do useful work over tight loops of property operations.

The result is normally typed as `any`. The same JavaScript property must support both assignment (`counter.count = 20`) and an asynchronous read (`await counter.count`), which a regular local-object type cannot express accurately.

## Values, Maps, and Sets

PureRPC keeps the exposed object remote; it does not make every returned value another live handle. A property read or method result follows the normal serialization rules:

```typescript
const snapshot: Set<string> = await service.tags;
snapshot.add('local-only'); // changes only this local copy

await service.tags.add('owner-side'); // calls Set.prototype.add on the owner
console.log(await service.tags.has('owner-side')); // true
```

The same applies to `Map`: `await service.metadata` is a snapshot, while `await service.metadata.set(key, value)` mutates the owner-side map. A returned class that extends `PureRPC` becomes its own live handle; ordinary objects, arrays, maps, sets, and custom transformed classes are copied values.

Callbacks and `AbortSignal`s are the exceptions. They remain live when returned directly or inside a copied container. Repeated references to the same callback, signal, or PureRPC object on one request channel deserialize to the same wrapper object.

## Lifetime and cleanup

PerfectWS manages live resources automatically:

1. A returned handle keeps its request channel and owner-side object alive.
2. The root handle, derived paths such as `counter.count`, and in-flight operations share the lease.
3. After none of them are reachable, garbage collection releases the remote object.
4. When the request has no remaining PureRPC handles, callbacks, or transferred signals, both sides remove the channel.

The cleanup is automatic but not immediate because JavaScript decides when garbage collection runs. If the transport references must be released at an exact moment, use a `using` declaration or the root handle's `counter[Symbol.dispose]()` escape hatch.

Automatic handle cleanup releases PerfectWS references; it does not call an application method such as `close()`. If the owner object holds a file descriptor, lock, or transaction that must end deterministically, expose and call an explicit owner-side method for that resource. See the [remote file writer](common-use-cases.md#control-an-owner-side-resource) for a practical pattern.

Stopping or unregistering a router releases all its live channels immediately.

## Reconnection

A live handle remains the same object across a normal reconnect of the same `RemoteClient` or `PerfectWSAdvanced.client()` instance. The reconnect handshake restores its request channel, so it can be used again after the connection returns.

A read, write, or method call on a live handle waits through a temporary disconnect and resumes on the replacement socket. It has no independent reconnect deadline: it settles after delivery, local channel release/router shutdown, or synchronization confirms that the peer no longer knows the request. Cleanup follows the same rule, so a collected or disposed handle is released after reconnection. The live channel itself has no idle or disconnection timeout because `router.config.requestTimeout` stopped applying when the original request returned.

A new process or a new router instance cannot resume old handles, even if it reuses the same client id; the JavaScript objects and request ids no longer exist locally.

Two separate `.request()` calls use separate resource channels. Even if their handlers return the same owner-side object, do not compare the two received handles by identity. Identity reuse is guaranteed for aliases traveling through the same live request channel.

## Returning an existing object

If the class cannot extend `PureRPC`, wrap its instance:

```typescript
const service = new ExistingService();
host.router.on('service', () => new PureRPC(service));
```

Prefer explicit subclasses or wrappers so the exposed API is easy to audit. `router.config.autoWrapUnknownClasses = true` can expose otherwise-unrecognized class instances automatically, but it should be reserved for controlled environments.

## Function properties

Calling a method directly is the usual form:

```typescript
console.log(await counter.increment());
```

Reading a method returns a normal serialized callback that remains bound to the original object:

```typescript
const increment = await counter.increment;
console.log(await increment());
```

That callback has its own automatic lease. It remains callable while it is reachable, even if the parent PureRPC handle is collected first.

Callback and PureRPC operations are deduplicated until their response is acknowledged, so reconnect replay does not run the operation twice. `maxRPCOperations` (default 10,000 per request channel) bounds in-flight or unacknowledged operation state.

## Using `PerfectWSAdvanced` directly

Authenticated classes default to base `PerfectWS`. Pass `perfectWSConstructor: PerfectWSAdvanced` to both auth peers as shown above. When wiring WebSockets yourself, use the advanced factory on both sides and enable PureRPC before sending a handle:

```typescript
import { PerfectWSAdvanced } from 'perfect-ws';

const { router: server, attachClient } = PerfectWSAdvanced.server();
server.config.fullTrustedRPC = true;

const { router: client, setServer } = PerfectWSAdvanced.client();
client.config.fullTrustedRPC = true;
```

Connect the sockets with `attachClient(serverSocket)` and `setServer(clientSocket)`, then register and request routes exactly as in the complete example.
