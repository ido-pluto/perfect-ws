# API Reference

The core protocol API: types, the two ways to get a router, request/handler signatures, and the full `router.config` reference. For the recommended way to actually set up a connection, see [Authentication](authentication.md) - this page documents what `.router` (on `ServerHost`/`ClientHost`/`RemoteClient`/`RemoteServer`) gives you underneath, and applies equally if you use `PerfectWS`/`PerfectWSAdvanced` directly.

## Types

```typescript
import type { WSClientResult, WSServerResult, WSClientOptions, WSCallbackOptions, WSListenCallback } from 'perfect-ws';
```

- **`WSClientResult<WSType, Router>`** - return type of `PerfectWS.client()`
- **`WSServerResult<WSType, Router>`** - return type of `PerfectWS.server()`
- **`WSClientOptions`** - `{ temp?: boolean; debugging?: boolean; clientId?: string }`
- **`WSCallbackOptions`** - the second argument every handler/middleware receives (see below)

The authentication constructors also accept `perfectWSConstructor`. It defaults to `PerfectWS`; pass `PerfectWSAdvanced` explicitly on both peers to enable advanced transforms. `fullTrustedRPC: true` requires this explicit advanced constructor.

## `PerfectWS.client(config)` / `PerfectWS.client(server, config?)`

```typescript
PerfectWS.client(config?: WSClientOptions): WSClientResult
PerfectWS.client(server: WebSocket, config?: WSClientOptions): WSClientResult
```

- `server` (optional): a `WebSocket` to use immediately, instead of calling `setServer()` separately.
- `config.temp`: disables request syncing and unknown-response abortion - used internally for handshake-scoped routers (see [Authentication](authentication.md#connection-lifecycle-hooks)); you generally won't set this yourself.
- `config.clientId`: a persistent id - see [Reconnection & Streaming](reconnection-and-streaming.md#explicit-id).

**Returns:** `{ router, setServer(ws), unregister() }`.

`await router.serverOpen` resolves after the current socket is open and request synchronization has completed, so retained callbacks, signals, streams, and PureRPC handles are ready to use after a reconnect.

## `PerfectWS.server()`

```typescript
PerfectWS.server(): WSServerResult
```

**Returns:** `{ router, attachClient(ws), autoReconnect(url, webSocketConstructor?), unregister() }`.

`ServerHost`/`ClientHost`/`RemoteClient`/`RemoteServer` build on exactly these two factories. They default to base `PerfectWS`; pass `perfectWSConstructor: PerfectWSAdvanced` to both auth peers when advanced serialization is required.

## `router.request(method, data?, options?)`

Makes a request (client-role routers only - which includes `RemoteClient.router` and `ClientHost.router`).

```typescript
import type { WSRequestOptions } from 'perfect-ws';

const options: WSRequestOptions<{ message: string }> = {
  callback: (data, error, done) => {
    if (!done && data) console.log(data.message);
    if (error) console.error(error.code);
  },
  abortSignal: controller.signal,
  timeout: 30_000,
};

await remote.router.request('echo', { message: 'hi' }, options);
```

Other options are `events?: NetworkEventListener`, `requestId?: string`, and `doNotWaitForConnection?: boolean`.

**Returns:** a promise resolving to the response data, or rejecting with a `PerfectWSError`. See [Return an application error](common-use-cases.md#return-an-application-error).

The timeout runs only until the final response. Callbacks, transferred signals, and [PureRPC handles](pure-rpc.md) automatically retain the completed request's live channel while they are reachable, with no idle timeout. They do not require a request option or manual disposal.

## `router.on(method, ...handlers)`

Registers a request handler (server-role routers only - `ServerHost.router`, `RemoteServer.router`). Multiple handlers run in sequence as a middleware chain - see [Middleware & Routing](middleware-and-routing.md).

```typescript
host.router.on('method', (data, options: WSCallbackOptions) => {
  // data: request data from the caller
  return responseData; // or use options.send() to stream instead
});
```

`WSCallbackOptions`:

| Field | Type | |
|---|---|---|
| `send` | `(data, down?, allowPackageLoss?) => void \| Promise<void>` | Send a streaming chunk (`down: true` ends the response) |
| `reject` | `(message, code) => void` | Reject with a `PerfectWSError` |
| `events` | `NetworkEventListener` | Bidirectional custom events for this request |
| `abortSignal` | `AbortSignal` | Fires if the caller cancels |
| `ws` | `WebSocketForce` | The underlying connection |
| `requestId` | `string` | Unique id for this request |
| `clientId` | `string` | The persistent id of the requesting client - see [Reconnection & Streaming](reconnection-and-streaming.md) |

`on()` and `off()` return the router, so chaining is optional.

## Middleware and child routers

`use()` accepts middleware functions only. Middleware applies to every
application route in that router scope and every mounted descendant, independent
of whether it was added before or after the route:

```typescript
host.router.use(authenticate, logRequest);
```

Create a prefix-free child router and mount it explicitly:

```typescript
const users = PerfectWS.Router();
users.use(requireUser);
users.on('/list', listUsers);

host.router.mount('/api/users', users);
```

The resulting method is `/api/users/list`. Nested routers use the same
`parent.mount(prefix, child)` call. `use()` and `mount()` return their router for
optional chaining. A router instance may be mounted only once.

## Events

`NetworkEventListener` carries bidirectional custom events alongside a request, independent of its return value:

```typescript
import { NetworkEventListener } from 'perfect-ws';

// Caller
const events = new NetworkEventListener();
events.on('progress', (source, percent) => {
  if (source === 'remote') console.log(`progress: ${percent}%`);
});
await remote.router.request('longTask', {}, { events });

// Handler
host.router.on('longTask', async (data, { events }) => {
  for (let i = 0; i <= 100; i += 10) {
    events.emit('progress', i);
    await sleep(100);
  }
  return 'done';
});
```

Every listener receives `source` (`'local'` or `'remote'`) as its first argument, so you can tell which side an event actually came from.

## Configuration

Configure behavior via `router.config` (e.g. `host.router.config.pingIntervalMs = 10_000`). See [Production & Resilience](production-resilience.md) for how to reason about these together for a real deployment.

#### Request Management

**`clearOldRequestsDelay`** (default: 10000ms / 10 seconds)
- **Purpose**: Interval for the fallback scan of unfinished requests.
- **How it works**: The scan validates stale pending requests with the peer and removes requests that no longer exist. Completed channels containing live callbacks, signals, or PureRPC handles are excluded.

**`maxActiveRequests`** (default: 10000)
- **Purpose**: Maximum number of active requests that can be stored in memory.
- **How it works**: When a client sends a request, it will be stored in memory. If the number of active requests exceeds this limit, the client will reject the request with the error `tooManyRequests`.

**`maxInternalRequests`** (default: 3)
- **Purpose**: Reserved per-method capacity for each internal ping/synchronization route.
- **How it works**: Internal recovery traffic does not consume application request capacity, but a peer still cannot create an unbounded number of requests for one internal method.

**`requestTimeout`** (default: 900000ms / 15 minutes)
- **Purpose**: Default maximum duration from calling `request()` until its final response.
- **How it works**: Override it for one call with `{ timeout: milliseconds }`; use `{ timeout: 0 }` or `{ timeout: Infinity }` to disable the deadline. The deadline is sent to the owner, so its handler `abortSignal` also fires if the connection is down when the caller times out. Both timers stop when the final response is produced.
- **Valid values**: `0`, positive finite millisecond values, and `Infinity`. Negative values, `NaN`, and `-Infinity` reject with `invalidTimeout`.
- **Completed resources**: A returned callback, signal, or PureRPC handle is not expired by `requestTimeout`, even while disconnected. Its channel remains until automatic garbage-collection cleanup, explicit disposal, router shutdown, or synchronization proves that the peer no longer owns the request.

**`syncRequestsTimeout`** (default: 5000ms / 5 seconds)
- **Purpose**: Verification timeout when checking if requests are still alive between client and server
- **How it works**: During reconnection, client and server exchange lists of active request IDs to synchronize state. This timeout ensures the handshake completes quickly or fails fast if one side is unresponsive
- **Example scenario**: Client reconnects after network switch → has 5 seconds to confirm with server which of the 10 pending requests are still valid

#### Connection Management

**`connectionTimeout`** (default: 3000ms)
- Maximum time to wait for a connection to be established
- If exceeded, the connection is considered unhealthy and may be closed
- Helps detect network issues or unresponsive peers quickly

**`pingRequestTimeout`** (default: 5000ms)
- Maximum time to wait for a ping response
- If exceeded, the connection is considered unhealthy and may be closed
- Helps detect network issues or unresponsive peers quickly

**`pingIntervalMs`** (default: 5000ms)
- Interval between ping requests sent to maintain and verify connection health
- Keeps the connection alive through firewalls and proxies
- Lower values provide faster detection of connection issues but increase network traffic

**`pingReceiveTimeout`** (default: 10000ms)
- Maximum time the server will wait without receiving a ping before closing the connection
- Prevents zombie connections from consuming resources
- Should be greater than `pingIntervalMs` to account for network latency

**`delayBeforeReconnect`** (default: 3000ms)
- Time to wait before attempting to reconnect after a connection loss
- Prevents aggressive reconnection attempts that could overwhelm the server
- Gives the network/server time to recover from temporary issues
- The [auth classes](authentication.md#auto-reconnect-and-backoff) have their own equivalent `delayBeforeReconnect` constructor option

#### Reliability & Performance

**`sendRequestRetries`** (default: 2)
- Total send attempts made on one connected socket (minimum one), including the initial attempt.
- A disconnect waits for reconnection and restarts this per-socket attempt budget.

**`reconnectTimeout`** (default: 60000ms / 1 minute)
- Maximum reconnect wait for an ordinary request-send retry or non-lifecycle channel event.
- Calls made through a live callback or PureRPC handle, cleanup, and transferred AbortSignal notifications are durable: they remain queued until reconnect, local channel release, or peer synchronization reports the request unknown.
- The original request is bounded separately by `requestTimeout`; a completed live-resource channel has no idle timeout.

**`maxListeners`** (default: 1000)
- Listener-count warning threshold passed to Node/EventEmitter-style WebSockets.
- It does not reject or cap listener registration; Node.js warns when the threshold is exceeded.

**`maxTransformDepth`** (default: 100)
- Maximum depth for serializing nested objects with transforms (only for `PerfectWSAdvanced`)
- Prevents stack overflow from deeply nested or circular structures
- Values beyond this depth are left for BSON without further advanced-transform traversal; they are not replaced with `null`

**`maxMessageSize`** (default: `Infinity`, `PerfectWSAdvanced` only)
- Maximum binary value size accepted by the advanced binary transform. Auth hosts separately default their WebSocket payload limit to 30MB.

**`fullTrustedRPC`** (default: false, `PerfectWSAdvanced` only)
- Enables [PureRPC](pure-rpc.md) live handles. Both peers must opt in.

**`maxPureRPCHandles`** (default: 10000, `PerfectWSAdvanced` only)
- Maximum number of owner-side PureRPC objects retained by one request channel.

**`maxRPCOperations`** (default: 10000, `PerfectWSAdvanced` only)
- Maximum in-flight or not-yet-acknowledged callback and PureRPC operations retained by one request channel.

**`autoWrapUnknownClasses`** (default: false, `PerfectWSAdvanced` only)
- Automatically exposes otherwise-unrecognized class instances as PureRPC handles. Prefer explicit `PureRPC` wrappers for auditable APIs.

**`maxGlobalSymbols`** (default: 10000, `PerfectWSAdvanced` only)
- Maximum distinct `Symbol.for()` keys accepted across all request channels owned by one router. Local symbols are not transferable.

**`syncRequestsWhenServerOpen`** (default: true)
- Whether to sync requests when the server is opened (cancel requests that does not exist on both sides)
- If false, the server will not sync requests when the server is opened (you can call `syncRequests` method manually to sync requests)
- See [Reconnection & Streaming](reconnection-and-streaming.md) for what this sync actually does

**`abortUnknownResponses`** (default: true)
- Sends an abort when a non-final response arrives for a request this router no longer owns.

**`runPingLoop`** (default: true)
- Enables periodic liveness pings. Set false only when another layer owns liveness or while debugging.

**`clientId`** (generated by `PerfectWS.client()`)
- Stable logical caller id used to isolate requests and reconnect the same in-memory router. Prefer the `clientId` factory option instead of mutating this value later.

#### ACK System (Acknowledgment)

The ACK system ensures reliable message delivery by requiring acknowledgment for each packet. When enabled, every message gets a unique packet ID and the system automatically retries if acknowledgment is not received.

**`enableAckSystem`** (default: true)
- Enables the packet acknowledgment system for reliable message delivery
- When enabled, each message requires an ACK response or will be retried

**`ackTimeout`** (default: 1000ms)
- Maximum time to wait for acknowledgment before considering the packet lost
- After this timeout, the system will retry sending the packet

**`ackRetryDelays`** (default: [3000, 5000])
- ACK wait timeout for each retry attempt after the initial `ackTimeout` window.
- With the default, the initial attempt waits 1 second, the first retry waits 3 seconds, and the second retry waits 5 seconds.
- If all attempts fail, the socket is force-closed and normal reconnect and request-timeout behavior takes over.

**`processedPacketsCleanupInterval`** (default: 60000ms / 1 minute)
- Interval for cleaning up old processed packet IDs from memory
- Prevents memory buildup from tracking processed packets

**`maxProcessedPackets`** (default: 1000)
- Maximum processed packet IDs retained for one client identity
- If unexpired entries reach this capacity, that socket is closed instead of evicting a still-retryable ID

**`maxTotalProcessedPackets`** (default: 10000) and **`maxProcessedPacketClients`** (default: 1000)
- Router-wide ceilings for retained packet IDs and client-identity buckets

**`processedPacketsRetention`** (default: 60000ms / 1 minute)
- Minimum duplicate-suppression horizon for processed packet IDs
- Keep it longer than the largest ACK retry/reconnect window used by your deployment

**`maxPendingAcks`** (default: 100)
- Per-socket hard limit enforced before a new acknowledgment wait is created.

**`maxTotalPendingAcks`** (default: 1000)
- Router-wide ceiling for acknowledgment waits across all attached sockets.

**`maxPendingAcksKept`** (default: 50)
- Fallback cleanup target for stale state detected by the periodic safety scan.

**`maxPendingAborts`** (default: 1000)
- Maximum unknown early-abort entries retained per client. Aborts for already-running requests do not use this quota.

**`maxTotalPendingAborts`** (default: 10000)
- Router-wide ceiling for unknown early-abort entries.

**`pendingAbortsMinAge`** (default: 3000ms)
- Minimum age (in milliseconds) before a pending abort entry can be removed
- Prevents premature cleanup of recently aborted requests

#### Debugging

`debugging` is a factory/auth-constructor option, not a `router.config` key. It disables the ACK and ping loops when the router is created so paused breakpoints do not cause false timeouts.

**`verbose`** (default: false)
- Enables console logging for debugging connection and request issues
- Useful for troubleshooting connection problems and request lifecycle
- All four [auth classes](authentication.md) accept this same option directly in their constructor, and apply it to every router they create (including handshake-scoped ones)

### Timeout Hierarchy

The protocol uses multiple timeout mechanisms that work together:

1. **Request duration** uses `options.timeout ?? requestTimeout`; `0` or `Infinity` disables this deadline
2. **Connection loss** triggers `delayBeforeReconnect` before attempting reconnection
3. **During reconnection**, `syncRequestsTimeout` determines how long to wait for synchronization
4. **While pending**, the original request deadline continues across reconnection
5. **After the final response**, live callbacks, signals, and PureRPC handles have no idle deadline
6. **Background cleanup** runs every `clearOldRequestsDelay` as a fallback for unfinished requests only
