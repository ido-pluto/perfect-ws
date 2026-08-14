# Serialization & Transforms

`PerfectWS` serializes request/response data with plain BSON. `PerfectWSAdvanced` (same API, drop-in) layers additional transforms on top, applied in this order on send:

1. **Property descriptors** - accessors and unusual data-property flags are preserved
2. **Native types** - `Map`, `Set`, `BigInt`, `Error`, `URL`, `Date`, `RegExp`, and sparse arrays
3. **`AbortSignal`**, followed by another descriptor/native pass for its reason
4. **Binary data** - `Buffer`, typed arrays, `ArrayBuffer`, `DataView`
5. **Custom class transforms** (your own `TransformInstruction`/`PrototypeTransform` subclasses)
6. **Circular references**
7. **PureRPC handles**
8. **Functions/callbacks**
9. **`undefined`, registered symbol values and keys, and well-known symbol values**

Receiving unwinds them in a slightly different order, so that a value nested inside another transform's output is decoded before the outer one is rebuilt.

The passes chain: a later transform walks into an earlier one's output, so a `Buffer` or a function stored inside a `Map`, or the `get`/`set` of a property descriptor, still get converted. A getter therefore stays a live accessor across the wire - reading it calls back to the sender, so it resolves to a promise.

Serializing never mutates the value you pass in - the transforms build a copy. Ordinary values cross the connection by value, never by JavaScript reference. An unregistered class may lose its prototype or serialize incorrectly through BSON, and its nested values are not guaranteed to receive advanced transforms. Register a custom transform for a value copy, or expose it explicitly with [PureRPC](pure-rpc.md) when it must remain on its owner.

The authenticated classes default to base `PerfectWS` so advanced transforms are never enabled implicitly. Select `PerfectWSAdvanced` on both peers when the application needs the features on this page:

```typescript
import { PerfectWSAdvanced, ServerHost, RemoteClient } from 'perfect-ws';

const host = new ServerHost({
  password: 'shared-secret',
  port: 8080,
  perfectWSConstructor: PerfectWSAdvanced,
});
host.start();

const remote = new RemoteClient({
  password: 'shared-secret',
  url: 'ws://localhost:8080',
  perfectWSConstructor: PerfectWSAdvanced,
});
remote.start();

// host.router and remote.router are both PerfectWSAdvanced instances
```

When wiring sockets directly, use `PerfectWSAdvanced.server()` and `PerfectWSAdvanced.client()` on the two sides. Do not mix base and advanced protocols on one connection.

## Binary data

`Buffer` (Node), `Uint8Array`/`Int8Array`/`Uint16Array`/`Int32Array`/`Float32Array`/`Float64Array`, `ArrayBuffer`, and `DataView` all round-trip as their original type - a `Uint8Array` sent from the client arrives as a `Uint8Array` on the server, not a plain BSON `Binary` blob:

```typescript
host.router.on('upload', async (data) => {
  console.log(data.bytes instanceof Uint8Array); // true
  return { size: data.bytes.byteLength };
});

await remote.router.request('upload', { bytes: new Uint8Array([1, 2, 3]) });
```

Each received view owns an exact-size backing buffer. If two sent typed views overlap the same `ArrayBuffer`, they arrive as independent value copies rather than overlapping views of one reconstructed buffer.

### Size limit

Set `maxMessageSize` (bytes) on the router to reject an oversized binary value at send time, with a `messageTooLarge` `PerfectWSError`, instead of framing it and having the peer drop the connection on its own `maxPayload`. Unlimited by default; the auth hosts accept payloads up to 30MB, so match that if you use them:

```typescript
remote.router.config.maxMessageSize = 30 * 1024 * 1024;
```

## Native types

BSON has no encoding for a few everyday values and mangles them silently - a `Set` becomes `{}`, a `Map` loses every non-string key, an `Error` becomes `{}`. These round-trip properly:

```typescript
host.router.on('report', async (data) => {
  console.log(data.seen instanceof Set);      // true
  console.log(data.counts.get(2));            // 'two'  (numeric key survives)
  console.log(data.id === 9007199254740993n); // true   (no precision loss)
  console.log(data.failure instanceof TypeError); // true
  console.log(data.failure.code);             // 'E_BAD'  (own properties come along)
});

await remote.router.request('report', {
  seen: new Set(['a', 'b']),
  counts: new Map([[2, 'two']]),
  id: 9007199254740993n,
  failure: Object.assign(new TypeError('bad'), { code: 'E_BAD' })
});
```

`Error` carries `name`, `message`, `stack` and its own enumerable properties. A custom subclass arrives as a plain `Error` with `name` preserved, since the receiving side has no way to construct your class.

`Map` and `Set` contents are transformed too, so a `Buffer` inside a `Map`, or a `Map` inside a `Set`, works. `undefined`, sparse array holes, circular references, and shared object identity are preserved. `Date`, `RegExp` flags, and `RegExp.lastIndex` round-trip. `NaN` and the infinities use BSON directly.

Global symbols created with `Symbol.for()` and well-known values such as `Symbol.iterator` round-trip. Local symbols cannot be recreated on another JavaScript realm and are unsupported. One router accepts at most 10,000 distinct received global-symbol keys across all of its request channels, preventing unbounded process-global symbol registration from wire input; configure this with `maxGlobalSymbols`.

Maps and sets are copied values. Mutating the received container does not update the sender's container. If a map or set is a property of a PureRPC object, call its method through the live path (`await remote.map.set(key, value)`) to mutate the owner-side container; `await remote.map` still returns a snapshot.

## `AbortSignal`

Pass an `AbortSignal` as part of your request data and the remote side receives a *live* signal wired back to the original - aborting it locally propagates over the wire and fires `abort` on the copy:

```typescript
// Client
const controller = new AbortController();
remote.router.request('longJob', { cancelSignal: controller.signal });
setTimeout(() => controller.abort('user cancelled'), 5000);

// Server
host.router.on('longJob', async (data) => {
  data.cancelSignal.addEventListener('abort', () => {
    console.log('client cancelled:', data.cancelSignal.reason);
  });
  // ...
});
```

This is independent of the built-in per-request `abortSignal` (`options.abortSignal` on `.request()`, and `WSCallbackOptions.abortSignal` in handlers) - use that for cancelling the request itself; use a transferred `AbortSignal` when you need to cancel something *else*, unrelated to the request lifecycle, from either side.

An already-aborted signal arrives already aborted and does not create a live channel. Otherwise, the channel remains active until the signal aborts or the received signal is garbage-collected. If it aborts while disconnected, that notification waits for reconnection even after `reconnectTimeout`; it is lifecycle state, not a new ordinary RPC operation.

## Custom class transforms

Register a `TransformInstruction` subclass to control exactly how a class serializes:

```typescript
import { TransformInstruction } from 'perfect-ws';

class Money {
  constructor(public cents: number) {}
}

class MoneyTransform extends TransformInstruction<Money> {
  uniqueId = 'Money'; // must be unique across all registered transformers

  check(data: any) {
    return data instanceof Money;
  }

  serialize(obj: Money) {
    return obj.cents; // whatever's BSON-serializable
  }

  deserialize(cents: number) {
    return new Money(cents);
  }
}

host.router.transformers.push(new MoneyTransform());
remote.router.transformers.push(new MoneyTransform()); // register on both sides
```

`check()` is run against every object in the payload during serialization (depth-first, up to `maxTransformDepth`, default 100) - the first matching transformer wins, so put more specific checks before more general ones if you register several. Register the *same* transformers on both sides; a class only round-trips correctly if both sides agree on how to encode/decode it.

Keep `serialize()` output to plain BSON-safe data. If the class owns live callbacks, signals, maps, sets, or mutable state that should stay on the original instance, PureRPC is the clearer model.

### Prototype RPC

When you don't want to serialize an entire object - just let the remote side call a few of its methods - use `PrototypeTransform` instead. The receiving side gets a stub whose listed methods are proxied back to the original instance as async calls, instead of a real reconstructed object:

```typescript
import { PrototypeTransform } from 'perfect-ws';

class RemoteFile {
  constructor(private path: string) {}
  async readChunk(offset: number) { /* ... */ }
  async stat() { /* ... */ }
}

class RemoteFileTransform extends PrototypeTransform<RemoteFile> {
  uniqueId = 'RemoteFile';
  serializePrototypes = ['readChunk', 'stat'];

  check(data: any) {
    return data instanceof RemoteFile;
  }
}

host.router.transformers.push(new RemoteFileTransform());
remote.router.transformers.push(new RemoteFileTransform()); // register on both sides, same as custom class transforms
```

```typescript
// Server: hands back a real RemoteFile - the transform turns it into a stub in transit.
host.router.on('openFile', async (data) => {
  const file = new RemoteFile(data.path);
  return { file };
});
```

```typescript
// Client: `file` is a stub here, not a real RemoteFile.
const { file } = await remote.router.request('openFile', { path: '/data.bin' });
const chunk = await file.readChunk(0); // RPC call back to the server-side instance
```

Every proxied call is a full request/response round trip, so treat them like any other network call (they can fail, and each one costs a round trip - don't call one in a tight loop if you can batch instead).

`PrototypeTransform` is useful when you want an explicit, limited method list. If the remote side needs live property access as well as every method on an object, see [PureRPC](pure-rpc.md). PureRPC has a stronger trust model and keeps the original object reachable on its owner while the remote handle is live.

## Circular references

Handled automatically, no configuration needed:

```typescript
const node: any = { name: 'root' };
node.self = node;

await remote.router.request('accept', node); // does not throw, does not infinite-loop

host.router.on('accept', (data) => {
  console.log(data.self === data); // true - the cycle survives the round trip
});
```

Internally, a repeated object is replaced with a reference marker (a dot-path back to where it first appeared in the same payload) and resolved on the receiving end. This only reconstructs cycles that exist *within a single payload* - it doesn't create shared references across separate requests.

## Functions / callbacks

Functions in request or response data become live RPC callbacks on the other side:

```typescript
host.router.on('calculate', async (data) => {
  const result = await data.operation(10, 20); // calls back to the client
  return { result };
});

const response = await remote.router.request('calculate', {
  operation: (a: number, b: number) => a + b,
});
console.log(response.result); // 30
```

A few things worth knowing when you lean on this heavily:

- Each call is a real message round trip over the same request's `events` channel, not a separate request with its own timeout - if you need a call to give up after some time, wrap it yourself (e.g. `Promise.race` against a timer).
- Callbacks can be nested arbitrarily deep in the payload (inside arrays, inside other objects) and are still wired up correctly.
- Passed and returned callbacks keep the channel alive while the receiving wrapper is reachable. Garbage collection releases the sender's original function and closes the channel when no other live resources remain.
- Live callbacks survive a reconnect of the same router instance. If synchronization finds that the peer no longer knows the request, later calls reject.
