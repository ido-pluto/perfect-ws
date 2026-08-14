# Production & Resilience

perfect-ws has several independent safety nets - the ACK system, ping-based liveness checks, reconnect backoff, and (for the [auth classes](authentication.md)) connection/message-size limits and password rate limiting. This walks through tuning them for a real deployment, and how they interact.

See the [API Reference's Configuration section](api-reference.md#configuration) for the full list of `router.config` options and their defaults - this page focuses on how to *reason about* the ones that matter most in production, together.

## The ACK system

Every message (`enableAckSystem: true`, the default) requires an acknowledgment. The initial attempt waits up to `ackTimeout` (default 1s); each retry is sent immediately when the prior wait expires and uses the corresponding `ackRetryDelays` entry as its ACK wait timeout (default 3s, then 5s). If all attempts fail, the socket is force-closed, which triggers the normal reconnect path.

```typescript
router.config.ackTimeout = 2000;         // slower/higher-latency links
router.config.ackRetryDelays = [1000, 3000, 5000]; // more retries before giving up
```

Turn it off (`enableAckSystem: false`) only if you're on a transport that already guarantees delivery at a layer you trust more than this one, or when debugging (`debugging: true` disables it automatically, along with the ping loop, so a paused debugger doesn't trip false timeouts).

Received packet IDs are retained for `processedPacketsRetention` (default 60s) to suppress transport retries. Per-client and router-wide packet limits bound memory; PerfectWS closes the responsible socket instead of silently evicting a still-retryable ID. Live callback and PureRPC operation IDs remain deduplicated until their response is acknowledged, even beyond this transport horizon. Application handlers should still be idempotent across process restarts, where in-memory operation history is unavailable.

## Ping / liveness

Independent of the ACK system, an idle connection is verified with periodic pings (`pingIntervalMs`, default 5s). If no ping is received within `pingReceiveTimeout` (default 10s - keep this comfortably larger than `pingIntervalMs` to allow for latency), the connection is treated as dead and closed, which triggers a reconnect on whichever side is watching for it (`PerfectWS.server().autoReconnect(...)`, or the [auth classes'](authentication.md) built-in reconnect loops).

```typescript
router.config.pingIntervalMs = 10_000;
router.config.pingReceiveTimeout = 30_000; // tolerate longer gaps (mobile networks, sleep/wake)
```

This is what catches connections that *look* open at the TCP level but have gone silent - a common failure mode for mobile clients moving between networks, or proxies that silently drop idle connections without sending a close frame.

## Reconnect backoff

- Core `PerfectWS.server().autoReconnect(url)` and the [auth classes](authentication.md) both wait before retrying a dropped connection - `config.delayBeforeReconnect` / `delayBeforeReconnect` respectively, both defaulting to 3s.
- `sendRequestRetries` (default 2) is the total send-attempt budget on one connected socket, including the first attempt. A disconnect waits for the next connection and restarts that per-socket budget.
- `reconnectTimeout` (default 60s) caps the reconnect wait for an ordinary request-send retry or non-lifecycle channel event. A live callback/PureRPC call, cleanup, and transferred `AbortSignal` notification remain queued so the operation and lifecycle state can be reconciled after a later reconnect.

For a client that should keep trying indefinitely in the background (a long-lived worker) but individual requests shouldn't hang for a minute, lower `reconnectTimeout` and let the caller retry the request itself:

```typescript
try {
  await router.request('doWork', data, { timeout: 5000 });
} catch (err) {
  // retry your own request-level logic here, independent of the connection reconnecting
}
```

## Request memory limits

`maxActiveRequests` (default 10,000) caps request channels on both the requester and owner; beyond that, new application requests reject immediately with `tooManyRequests`. Internal synchronization requests remain available so reconnect can reconcile and release existing channels. `requestTimeout` (default 15 minutes) is the maximum duration of a pending request, including time spent waiting for connection or reconnection. Override it per call with `{ timeout: milliseconds }`, or use `{ timeout: 0 }` or `{ timeout: Infinity }` for no request deadline. Negative values, `NaN`, and `-Infinity` reject with `invalidTimeout`. The owner enforces the transmitted deadline independently, so disconnected callers cannot leave timed-out request channels behind.

After the final response, a channel retained by a callback, signal, or PureRPC handle is no longer governed by `requestTimeout`. It has no idle timeout and is released only through resource cleanup, explicit disposal, router shutdown, or peer synchronization. Callback/PureRPC calls, cleanup messages, and transferred AbortSignal notifications wait for that channel to reconnect so a temporary outage cannot silently lose a live-resource operation.

## Auth-layer limits (`ServerHost`/`ClientHost`)

```typescript
new ServerHost({
  password: 'shared-secret',
  maxConnections: 5000,               // default: 10_000 - pending + attached
  maxMessageSize: 10 * 1024 * 1024,   // default: 30MB
  passwordRateLimit: {
    maxAttempts: 5,                   // default
    windowMs: 60_000,                 // default: 1 minute
  },
});
```

`maxConnections` counts every socket from the moment it's accepted, including ones still mid-handshake - so a burst of connection attempts (even unauthenticated ones) can't exhaust your process's resources past this ceiling. `maxMessageSize` is enforced at the WebSocket layer before a message is even parsed, protecting against oversized payloads from a hostile or misbehaving peer. See [Authentication](authentication.md#rate-limiting) for `passwordRateLimit` details, including how to key it off a trusted proxy header instead of the raw socket address.

If you customize `passwordRateLimit.maxAttempts`/`windowMs` here, update `passwordFailureDelay` on the connecting `RemoteClient`/`RemoteServer` to match - see [Backing off further after a password rejection](authentication.md#backing-off-further-after-a-password-rejection). The remote side can't learn your configured values on its own, and its default assumes the defaults here.

## Putting it together

A reasonable starting point for a public-facing `ServerHost` behind a reverse proxy that already terminates TLS and does its own basic DDoS protection:

```typescript
const host = new ServerHost({
  password: process.env.SHARED_SECRET!,
  maxConnections: 20_000,
  maxMessageSize: 5 * 1024 * 1024,
  passwordRateLimit: {
    maxAttempts: 5,
    windowMs: 60_000,
    getClientKey: (request) => request?.headers['x-forwarded-for'] as string,
  },
});

host.router.config.pingIntervalMs = 15_000;
host.router.config.pingReceiveTimeout = 45_000; // generous, for mobile clients
```

Then load-test with your actual traffic shape before trusting any of these numbers - the defaults are reasonable starting points, not guarantees for your workload.
