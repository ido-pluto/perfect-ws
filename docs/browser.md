# Browser clients

Browser clients can use the browser-safe `RemoteClient` and `RemoteServer` authentication wrappers. `ServerHost` and `ClientHost` remain Node-only because they create HTTP/WebSocket servers. This lets a browser use the same built-in password handshake as a Node client without copying private handshake routes.

## Connect

Use the explicit browser entry when you want to guarantee that Node-only hosts cannot enter the bundle:

```typescript
import { RemoteClient } from 'perfect-ws/browser';

const connection = new RemoteClient({
  password: 'shared-secret',
  id: crypto.randomUUID(),
  url: 'wss://api.example.com/rpc'
});
connection.start();

await connection.router.serverOpen;
const result = await connection.router.request('profile.get', { id: '42' });
```

Vite and other condition-aware bundlers also resolve `import { PerfectWS } from 'perfect-ws'` to the browser build. The explicit subpath is useful for browser-only TypeScript projects and tools that do not apply package conditions.

On Node, attach each accepted socket to a server router:

```typescript
import { ServerHost } from 'perfect-ws';

const host = new ServerHost({ password: 'shared-secret', port: 8080 });
host.router.on('profile.get', ({ id }) => loadProfile(id));
host.start();
```

## Advanced RPC

Select `PerfectWSAdvanced` on both sides for callbacks, `Map`/`Set`, typed arrays, custom transforms, transferred signals, and PureRPC. Enable `fullTrustedRPC` only when both peers are trusted:

```typescript
import { PerfectWSAdvanced, RemoteClient } from 'perfect-ws/browser';

const connection = new RemoteClient({
  password: 'shared-secret',
  id: crypto.randomUUID(),
  url,
  perfectWSConstructor: PerfectWSAdvanced,
  fullTrustedRPC: true,
});
connection.start();
await connection.router.serverOpen;
```

The browser and Node routers must register the same custom transforms in the same way. Transform `uniqueId` values identify them across the wire.
Node `Buffer` values arrive in the browser as `Uint8Array`, because browsers do not provide the Node `Buffer` class.

## Reconnect

Keep the same auth wrapper and let it replace the underlying WebSocket automatically:

```typescript
// `autoReconnect` is enabled by default. Keep this same instance and id.
const connection = new RemoteClient({
  password: 'shared-secret',
  id: crypto.randomUUID(),
  url,
  autoReconnect: true,
});
connection.start();
await connection.router.serverOpen;
```

The same in-memory router and `id` let active requests and live RPC values synchronize after a network drop. Creating a new wrapper/router with the same id does not restore the old router's resources.

The browser-safe auth wrappers use the normal WebSocket constructor and do not require private protocol code in the application. Always use `wss://` outside a trusted local environment. `ServerHost`/`ClientHost` are the matching Node-side hosts; `RemoteClient`/`RemoteServer` are the dial-in wrappers.
