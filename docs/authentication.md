# Authentication

perfect-ws includes a password-authenticated pairing on top of the base protocol, in two flavors that mirror each other:

| | Hosts a `WebSocketServer` | Dials in |
|---|---|---|
| **Plays the PerfectWS "server" role** (registers `.on()` handlers) | `ServerHost` | `RemoteServer` |
| **Plays the PerfectWS "client" role** (calls `.request()`) | `ClientHost` | `RemoteClient` |

- **`ServerHost` + `RemoteClient`** is the common case: you run a real server, clients dial in with a password. This is what most apps want.
- **`ClientHost` + `RemoteServer`** is the inverted case: something you host waits for a remote "server" to connect to it and register handlers - useful for a dashboard/hub that outlives the individual backend processes reporting in to it.

All four classes are exported directly (`import { ServerHost } from 'perfect-ws'`), and also grouped as convenience bundles:

```typescript
import { clientHost, serverHost } from 'perfect-ws';

clientHost.Client // === ClientHost
clientHost.Server // === RemoteServer
serverHost.Client // === RemoteClient
serverHost.Server // === ServerHost
```

The key names describe the PerfectWS role the class plays (`Client` = calls `.request()`, `Server` = registers `.on()` handlers), not which side happens to host the socket.

## Basic usage

```typescript
import { ServerHost, RemoteClient } from 'perfect-ws';

// Server
const host = new ServerHost({ password: 'shared-secret', port: 8080 });
host.router.on('echo', (data) => ({ received: data }));
host.start();

// Client
const remote = new RemoteClient({ password: 'shared-secret', url: 'ws://localhost:8080' });
remote.start();
await remote.router.request('echo', { message: 'hi' });
```

`host.router` and `remote.router` are base `PerfectWS` routers by default. This security-conscious default supports BSON-compatible request/response values without automatically enabling function, descriptor, symbol, or live-object transforms. Middleware, mounted child routers, streaming, request cancellation, and reconnect behavior still work normally.

Opt into advanced serialization explicitly and symmetrically when an application needs callbacks, preserved native types, custom transforms, transferred `AbortSignal` values, or PureRPC:

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

Set `perfectWSConstructor: PerfectWSAdvanced` on both peers. `fullTrustedRPC: true` additionally enables PureRPC and is rejected unless that advanced constructor is explicitly selected.

## Password forms

The validating side (`ServerHost`/`ClientHost`) accepts three password shapes:

Omitting `password` disables credential validation and accepts any peer-provided value. Only use that open mode on a transport that is already trusted and access-controlled; set a password for ordinary network-facing use.

```typescript
// A single shared secret
new ServerHost({ password: 'shared-secret' });

// Any of several valid secrets (e.g. rotating credentials)
new ServerHost({ password: ['secret-v1', 'secret-v2'] });

// Custom validation - sync or async, gets the connection wrapper and HTTP upgrade request
new ServerHost({
  password: async (password, ws, request) => {
    return await lookUpApiKey(password, request?.socket?.remoteAddress);
  },
});
```

The side that *supplies* the password (`RemoteClient`/`RemoteServer`) only ever takes a single string - it presents one credential, it doesn't know about the validator's logic.

If validation fails, the connection is closed before application handlers run: code `3001` means a wrong password and `3002` means rate limited. No `initializeClient`/`initializeServer` hook runs, and the request never reaches `.on()` routes.

## Rate limiting

`ServerHost`/`ClientHost` throttle repeated failed password attempts per connecting key (by default, `request.socket.remoteAddress` - override via `getClientKey` to read a trusted proxy header like `CF-Connecting-IP` instead):

```typescript
new ServerHost({
  password: 'shared-secret',
  passwordRateLimit: {
    maxAttempts: 5,      // default
    windowMs: 60_000,    // default: 1 minute
    getClientKey: (request) => request?.headers['cf-connecting-ip'] as string,
  },
});
```

Set `passwordRateLimit: false` to disable it explicitly. It's already disabled automatically whenever `debugging: true` is set, so local development isn't throttled while you're stepping through a debugger.

## Auth flow logging

Set `logAuthFlow: true` on any of the four classes to log handshake lifecycle events - connected, rejected (wrong password / rate limited), disconnected, and unusual throws/closes during `initializeClient`/`initializeServer`/`initializeMethods`. It prints the same lines `verbose` does for these specific events, without turning on `verbose`'s full per-request tracing:

```
[PerfectWS::ServerHost] Connection accepted (203.0.113.4)
[PerfectWS::ServerHost] Client connected (cli-1)
[PerfectWS::ServerHost] Client disconnected - wrong password
[PerfectWS::ServerHost] Connection rejected - too many failed password attempts (203.0.113.4)
[PerfectWS::ServerHost] Client disconnected (cli-1)
```

`logAuthFlow` defaults to following `debugging` - set it explicitly to decouple the two, e.g. to keep this logging in production without disabling ping timeouts/the ACK system:

```typescript
new ServerHost({ password: 'shared-secret', debugging: false, logAuthFlow: true });
```

`verbose: true` always forces `logAuthFlow` on too, even if you pass `logAuthFlow: false` explicitly - these events are a subset of what `verbose` already logs, so there's no combination where `verbose` is on but this logging is off.

## Connection lifecycle hooks

Override `initializeClient`/`initializeServer`/`initializeMethods` in a subclass to run code after authentication but before the connection is promoted to "live". They run in pairs, one on each side of the connection, and **the router each hook receives plays whichever PerfectWS role lets that side talk to the other during the handshake** - it's not the same role the class settles into afterward:

- The **host** classes (`ServerHost.initializeClient`, `ClientHost.initializeServer`) always receive a **client** - a temporary `PerfectWS.client()` you can call `.request()` on, to ask the connecting remote something before finishing the handshake. This is true even for `ServerHost`, whose *real*, persistent router (`host.router`) is a server - during the handshake specifically, the host is the one asking questions, so it's temporarily a client.
- The **remote** classes (`RemoteClient.initializeMethods`, `RemoteServer.initializeMethods`) always receive a **server** - the same temporary `PerfectWS.server()` already handling the built-in password/id handshake requests. Register `.on()` handlers on it for the host side to call into.

Put together, this lets you run your own request/response exchange during the handshake, in addition to the built-in password + id: the remote side registers a method, the host side calls it.

```typescript
import {
  PerfectWS,
  RemoteClient,
  ServerHost,
  type InitializedClient,
  type InitializeRemoteClient,
} from 'perfect-ws';

type HostHandshakeRouter = ReturnType<typeof PerfectWS.client>['router'];
type RemoteHandshakeRouter = ReturnType<typeof PerfectWS.server>['router'];

// Remote side - registers a handshake-time method the host can call.
class MyRemoteClient extends RemoteClient {
  protected override initializeMethods(
    router: RemoteHandshakeRouter,
    _options: InitializeRemoteClient,
  ) {
    router.on('capabilities', () => ({ version: 2, features: ['streaming'] }));
  }
}

// Host side - calls it before deciding whether to accept the connection.
class MyServerHost extends ServerHost {
  protected override async initializeClient(
    router: HostHandshakeRouter,
    { clientId }: InitializedClient,
  ) {
    const caps = await router.request('capabilities', {});
    if (caps.version < 2) {
      throw new Error(`client ${clientId} is too old`); // rejects the connection
    }
  }
}
```

Full signatures:

- `ServerHost.initializeClient(client, { ws, clientId, request })`
- `ClientHost.initializeServer(client, { ws, serverId, request })`
- `RemoteClient.initializeMethods(server, { ws, serverId })`
- `RemoteServer.initializeMethods(server, { ws, clientId })`

**The direction only works one way: the remote side registers, the host side calls - not the other way around.** `initializeMethods` runs while the remote side is *responding* to the built-in id exchange, which necessarily happens before the host side has received that response and calls its own `initializeClient`/`initializeServer`. If you register on the host side and try to call from the remote side's `initializeMethods` instead, the call fires before the host has registered anything to handle it, and just hangs until it times out.

**Throwing (or returning a rejected promise) from any of these closes the connection** - it never reaches the "connected" state, and the remote side's connection attempt fails/retries as usual.

Both routers are disposable and scoped to this one handshake - once it finishes, each side's temporary router is unregistered (its message listener is detached from the socket) and the real, persistent router (`.router`, on whichever class applies) takes over the same connection. Anything you registered with `.on()` on the temporary server becomes unreachable at that point, so don't rely on those routes still existing after the handshake - register any routes meant for ongoing use on the real router instead (e.g. `host.router.on(...)`, outside these hooks).

These must be overridden as ordinary class methods (`protected override foo() {}`), not reassigned as instance properties - the base implementations are plain prototype methods specifically so subclassing works with normal JS/TS inheritance.

## Reconnecting with the same id

`ClientHost`/`ServerHost` key their state on `serverId`/`clientId`. If a **new** connection arrives claiming an id that's already actively connected, the host waits for the old socket to close before accepting the new one (rather than running both simultaneously) - so a client that reconnects quickly (e.g. after a network blip) doesn't race its own previous connection:

```typescript
const remote = new RemoteClient({
  password: 'shared-secret',
  url: 'ws://localhost:8080',
  id: 'worker-7', // stable id across restarts - omit to auto-generate one
});
```

If the old socket is already closed (just not yet cleaned up), the host closes it immediately instead of waiting, so a genuinely dead connection never blocks a reconnect.

## Auto-reconnect and backoff

`RemoteClient`/`RemoteServer` auto-reconnect when given a `url` (an already-open `WebSocket`/`WSLike` instance disables auto-reconnect - there's nothing to redial). On each drop, they wait `delayBeforeReconnect` (default 3s) before retrying, to avoid hammering a server that's down:

```typescript
new RemoteClient({
  password: 'shared-secret',
  url: 'ws://localhost:8080',
  autoReconnect: true,       // default
  delayBeforeReconnect: 1000, // default: 3000ms
});
```

### Backing off further after a password rejection

A connection closed specifically because of a wrong password or the [rate limit](#rate-limiting) is a different situation from a network blip: retrying every `delayBeforeReconnect` would just burn through the rate limiter's `maxAttempts` and get blocked outright. `RemoteClient`/`RemoteServer` detect this case (the host closes with a dedicated code, not string-matching the close reason) and use a separate `passwordFailureDelay` instead.

The rate limiter allows `maxAttempts` failures within `windowMs` before blocking, so the default spaces retries at `windowMs / maxAttempts` plus a small safety margin - using the *full* allowance every cycle instead of wasting it on a single attempt per window, while still landing each retry right as the previous window resets:

```typescript
new RemoteClient({
  password: 'shared-secret',
  url: 'ws://localhost:8080',
  passwordFailureDelay: 20_000, // default: ceil(windowMs / maxAttempts) + a small margin
});
```

If the host customizes `passwordRateLimit.maxAttempts`/`windowMs`, set `passwordFailureDelay` on the remote side to match (`windowMs / maxAttempts` + a couple seconds of margin) - the remote side has no way to learn the host's configured values automatically.

## `RemoteServer` with multiple hosts

Unlike `RemoteClient` (one connection at a time), a single `RemoteServer` can `attachClient()` several `ClientHost`s simultaneously - each gets tracked independently in `remote.clients` (`Map<clientId, WSLike>`):

```typescript
const remote = new RemoteServer({ password: 'shared-secret' });
remote.router.on('ping', (data, { clientId }) => ({ clientId }));

const stopA = await remote.attachClient('ws://host-a:8080');
const stopB = await remote.attachClient('ws://host-b:8080');

while (remote.clients.size < 2) {
  await new Promise(resolve => setTimeout(resolve, 25));
}

console.log(remote.clients.size); // 2 authenticated hosts
```

`attachClient(ws)` starts the connection/reconnect loop and promptly returns an unregister function; it does not wait for authentication. Observe `remote.clients` (as above) when application work must wait for readiness. The unregister function closes that specific connection, whether it is mid-handshake or fully connected, and stops its reconnect loop.

## Cleanup

Call `.stop()` on whichever class you constructed to close its connection(s), stop any reconnect loop, and release timers (`ServerHost`/`ClientHost` also stop listening for new connections).
