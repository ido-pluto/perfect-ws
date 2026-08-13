# Browser clients

Browser clients use the core protocol directly. `ServerHost`, `ClientHost`, `RemoteClient`, and `RemoteServer` are Node-only because they create HTTP/WebSocket servers and manage password handshakes.

## Connect

Use the explicit browser entry when you want to guarantee that Node-only hosts cannot enter the bundle:

```typescript
import { PerfectWS } from 'perfect-ws/browser';

const socket = new WebSocket('wss://api.example.com/rpc');
const connection = PerfectWS.client(socket, {
  clientId: crypto.randomUUID(),
});

await connection.router.serverOpen;
const result = await connection.router.request('profile.get', { id: '42' });
```

Vite and other condition-aware bundlers also resolve `import { PerfectWS } from 'perfect-ws'` to the browser build. The explicit subpath is useful for browser-only TypeScript projects and tools that do not apply package conditions.

On Node, attach each accepted socket to a server router:

```typescript
import { WebSocketServer } from 'ws';
import { PerfectWS } from 'perfect-ws';

const wss = new WebSocketServer({ port: 8080 });
const server = PerfectWS.server();

server.router.on('profile.get', ({ id }) => loadProfile(id));
wss.on('connection', socket => server.attachClient(socket));
```

## Advanced RPC

Select `PerfectWSAdvanced` on both sides for callbacks, `Map`/`Set`, typed arrays, custom transforms, transferred signals, and PureRPC. Enable `fullTrustedRPC` only when both peers are trusted:

```typescript
import { PerfectWSAdvanced } from 'perfect-ws/browser';

const connection = PerfectWSAdvanced.client(new WebSocket(url));
connection.router.config.fullTrustedRPC = true;
await connection.router.serverOpen;
```

The browser and Node routers must register the same custom transforms in the same way. Transform `uniqueId` values identify them across the wire.
Node `Buffer` values arrive in the browser as `Uint8Array`, because browsers do not provide the Node `Buffer` class.

## Reconnect

Keep the same client result and replace only its WebSocket:

```typescript
connection.setServer(new WebSocket(url));
await connection.router.serverOpen;
```

The same in-memory router and `clientId` let active requests and live RPC values synchronize. Creating a new router with the same id does not restore the old router's resources.

Authenticate and authorize the WebSocket before calling `server.attachClient`. Native browser WebSockets cannot set arbitrary handshake headers, so common choices are secure cookies, a short-lived token in the URL or subprotocol, or an authenticated upgrade handled by your web framework. Always use `wss://` outside a trusted local environment.
