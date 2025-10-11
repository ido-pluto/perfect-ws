# PerfectWS


<div align="center">

[![Build](https://github.com/ido-pluto/perfect-ws/actions/workflows/build.yml/badge.svg)](https://github.com/ido-pluto/perfect-ws/actions/workflows/build.yml)
[![Coverage](https://ido-pluto.github.io/perfect-ws/badge.svg)](https://ido-pluto.github.io/perfect-ws/)
[![License](https://badgen.net/badge/color/MIT/green?label=license)](https://www.npmjs.com/package/perfect-ws)
[![Types](https://badgen.net/badge/color/TypeScript/blue?label=types)](https://www.npmjs.com/package/perfect-ws)
[![npm downloads](https://img.shields.io/npm/dt/perfect-ws.svg)](https://www.npmjs.com/package/perfect-ws)
[![Version](https://badgen.net/npm/v/perfect-ws)](https://www.npmjs.com/package/perfect-ws)

</div>

A robust WebSocket protocol implementation with automatic reconnection, request/response patterns, and advanced serialization capabilities for TypeScript/JavaScript applications.

## Features

- 🔄 **Automatic Reconnection** - Handles connection drops gracefully with configurable retry logic
- 📡 **Request/Response Pattern** - Promise-based request/response communication over WebSockets
- 🎯 **Event-Driven Architecture** - Rich event system for handling real-time updates
- 🔐 **AbortSignal Support** - Cancel in-flight requests using standard AbortController
- 📦 **BSON Serialization** - Efficient binary serialization with BSON
- 🔌 **Transform System** - Serialize complex objects, functions, and custom classes
- ⏱️ **Timeout Handling** - Configurable timeouts for requests and connections
- 🏭 **Sub-routing** - Modular route organization with PerfectWSSubRoute

## Installation

```bash
npm install perfect-ws
```

**Optional: For Zod validation middleware**
```bash
npm install zod
```

## Quick Start

### Basic Client/Server Setup

**Server:**
```typescript
import { PerfectWS } from 'perfect-ws';
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
const { router, attachClient } = PerfectWS.server();

router.on('echo', (data) => {
  return { received: data };
});

router.on('stream', async (data, { send }) => {
  for (let i = 0; i < 5; i++) {
    send({ count: i }, false); // false = not final message
    await sleep(100);
  }
  send({ count: 5, done: true }, true); // true = final message
});

// Attach incoming clients
wss.on('connection', (ws) => {
  attachClient(ws);
});
```

**Client:**
```typescript
import { PerfectWS } from 'perfect-ws';

const { router, setServer } = PerfectWS.client();

// Connect to server
const ws = new WebSocket('ws://localhost:8080');
setServer(ws);

// Make requests
const response = await router.request('echo', { message: 'Hello' });
console.log(response); // { received: { message: 'Hello' } }

// Handle streaming responses
await router.request('stream', null, {
  callback: (data, error, done) => {
    if (data) console.log('Stream data:', data);
    if (done) console.log('Stream complete');
  }
});
```

### Middleware

PerfectWS supports middleware functions that execute before route handlers, enabling powerful patterns like authentication, logging, validation, and data transformation.

#### Global Middleware

Apply middleware to all routes:

```typescript
import { PerfectWS } from 'perfect-ws';

const { router, attachClient } = PerfectWS.server();

// Authentication middleware
router.use(async (data, opts) => {
  if (!data.token) {
    opts.reject('Authentication required', 'unauthorized');
    return;
  }
  // Verify token and add user info to data
  data.user = await verifyToken(data.token);
});

// Logging middleware
router.use((data, opts) => {
  console.log(`Request from user: ${data.user.id}`);
});

// Now all routes will execute these middleware first
router.on('getData', (data) => {
  return { data: 'secret', userId: data.user.id };
});
```

#### Multiple Callbacks per Route

Routes can have multiple callbacks that execute in sequence:

```typescript
router.on('processData',
  // Validation callback
  (data, opts) => {
    if (!data.value) {
      opts.reject('Value is required', 'validation');
      return;
      // also throwing an error would be the same
      // throw new PerfectWSError('Value is required', 'validation');
    }
  },
  // Processing callback
  (data, opts) => {
    data.processed = true;
  },
  // Final handler
  (data, opts) => {
    return { result: data.value, processed: data.processed };
  }
);
```

#### SubRoute with Prefix and Middleware

Organize routes with prefixes and scoped middleware:

```typescript
import { PerfectWS } from 'perfect-ws';

const { router } = PerfectWS.server();

// Create a subroute with prefix
const apiRouter = PerfectWS.Router('/api');

// Add middleware specific to this subroute
apiRouter.use((data, opts) => {
  console.log('API route accessed');
});

// Define routes - they'll be prefixed with /api
apiRouter.on('/users', (data) => {
  return { users: [] };
});

apiRouter.on('/posts', (data) => {
  return { posts: [] };
});

// Attach the subroute
router.use(apiRouter);

// Client calls with full path
await client.request('/api/users', {});  // Works!
await client.request('/api/posts', {});  // Works!
```

#### Nested SubRoutes

Create deeply nested routing structures:

```typescript
const { router } = PerfectWS.server();

// Global middleware
router.use((data, opts) => {
  data.timestamp = Date.now();
});

// API routes
const apiRouter = PerfectWS.Router('/api');
apiRouter.use(async (data, opts) => {
  // API-level rate limiting
  await checkRateLimit(data.user);
});

// Version-specific routes
const v1Router = PerfectWS.Router('/v1');
v1Router.use((data, opts) => {
  data.apiVersion = 'v1';
});

v1Router.on('/users', (data) => {
  return { users: [], version: data.apiVersion };
});

// Nest the routers
apiRouter.use(v1Router);
router.use(apiRouter);

// Client calls: /api/v1/users
// Middleware execution order: global → api → v1 → handler
await client.request('/api/v1/users', {});
```

#### Middleware Execution Order

Middleware and callbacks execute in a predictable order:

1. **Global middleware** (registered with `router.use()`)
2. **SubRoute middleware** (registered with `subroute.use()`)
3. **Route callbacks** (registered with `on()`)

Each middleware can:
- **Modify data**: Add properties that subsequent middleware/handlers can access
- **Reject early**: Call `opts.reject()` to stop execution and return an error
- **Send responses**: Call `opts.send()` to stream data or end the response
- **Access request context**: Use `opts.abortSignal`, `opts.events`, `opts.ws`, etc.

#### Common Middleware Patterns

**Authentication:**
```typescript
router.use(async (data, opts) => {
  const user = await authenticateToken(data.token);
  if (!user) {
    opts.reject('Invalid token', 'auth_failed');
  }
  data.user = user;
});
```

**Validation with Zod:**

PerfectWS provides built-in Zod validation middleware. Install Zod separately: `npm install zod`

```typescript
import { validateWithZod } from 'perfect-ws';
import { z } from 'zod';

const userSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().int().positive().optional()
});

router.on('createUser', 
  validateWithZod(userSchema),
  async (data) => {
    return await createUser(data);
  }
);

// With custom options
router.on('updateUser',
  validateWithZod(userSchema, {
    stripUnknown: true,  // Remove fields not in schema
    customErrorMessage: 'Invalid user data',
    errorCode: 'USER_VALIDATION_ERROR',
    abortEarly: false  // Show all validation errors
  }),
  async (data) => {
    return await updateUser(data);
  }
);

// Strip unknown fields for security
const secureSchema = z.object({
  username: z.string(),
  password: z.string()
});

router.on('login',
  validateWithZod(secureSchema, { 
    stripUnknown: true  // Removes any malicious extra fields
  }),
  async (data) => {
    // data will only contain username and password
    return await authenticateUser(data.username, data.password);
  }
);
```

**Custom Validation:**
```typescript
const validateSchema = (schema) => (data, opts) => {
  const result = schema.validate(data);
  if (result.error) {
    opts.reject(result.error.message, 'validation_error');
    return;
  }
};

router.on('createPost', 
  validateSchema(postSchema),
  async (data) => {
    return await createPost(data);
  }
);
```

**Logging:**
```typescript
router.use((data, opts) => {
  const start = Date.now();
  console.log(`[${opts.requestId}] Request started`);
  
  opts.abortSignal.addEventListener('abort', () => {
    console.log(`[${opts.requestId}] Request aborted after ${Date.now() - start}ms`);
  });
});
```

**Data Transformation:**
```typescript
router.use((data, opts) => {
  // Normalize all date strings to Date objects
  for (const key in data) {
    if (typeof data[key] === 'string' && isDateString(data[key])) {
      data[key] = new Date(data[key]);
    }
  }
});
```

### Advanced Features with PerfectWSAdvanced

The advanced version adds support for functions transfer (call done over the network) and custom classes:

**Server:**
```typescript
import { PerfectWSAdvanced } from 'perfect-ws';

const { router: serverRouter } = PerfectWSAdvanced.server();

serverRouter.on('calculate', async (data) => {
  // Execute function sent from client
  const result = await data.operation(10, 20);
  return { result };
});
```

**Client:**
```typescript
const { router: clientRouter } = PerfectWSAdvanced.client();

// Send functions
const response = await clientRouter.request('calculate', {
  operation: (a, b) => a + b
});
console.log(response.result); // 30
```

### Custom Class Serialization

```typescript
import { PerfectWSAdvanced, TransformInstruction } from 'perfect-ws';

class CustomDate {
  constructor(public timestamp: number) {}
  toISOString() {
    return new Date(this.timestamp).toISOString();
  }
}

const { router } = PerfectWSAdvanced.server();

class CustomDateSerializer extends TransformInstruction<CustomDate> {
  uniqueId = 'CustomDate';

  check(data: any) {
    return data instanceof CustomDate;
  }

  serialize(obj: CustomDate) {
    return obj.timestamp.toString();
  }

  deserialize(str: string) {
    return new CustomDate(parseInt(str));
  }
}

// Register custom class transform
router.transformers.push(new CustomDateSerializer());

// Now CustomDate instances will be automatically serialized/deserialized
router.on('processDate', async (data) => {
  console.log(data.date instanceof CustomDate); // true
  return { processed: new CustomDate(Date.now()) };
});
```

#### Easy prototype rpc calls

Instead of serializing the whole object, you can just make a rpc call to the prototype method.

```typescript
import { PerfectWSAdvanced, PrototypeTransform } from 'perfect-ws';

class CustomDate {
  constructor(public timestamp: number) {}
  toISOString() {
    return new Date(this.timestamp).toISOString();
  }
}

const { router } = PerfectWSAdvanced.server();

class CustomDateSerializer extends PrototypeTransform<CustomDate> {
  uniqueId = 'CustomDate';
  serializePrototypes = ['toISOString'];

  check(data: any) {
    return data instanceof CustomDate;
  }
}

// Register custom class transform
router.transformers.push(new CustomDateSerializer());

// Now CustomDate instances prototype methods will be available as async functions
router.on('processDate', async (data) => {
  console.log(data.date instanceof CustomDate); // false
  return { processed: await data.date.toISOString() };
});
```

## API Reference

### Types

PerfectWS exports the following TypeScript types for use in your application:

```typescript
import { WSClientResult, WSServerResult, WSClientOptions } from 'perfect-ws';
```

- **`WSClientResult<WSType, Router>`** - Return type of `PerfectWS.client()`
- **`WSServerResult<WSType, Router>`** - Return type of `PerfectWS.server()`
- **`WSClientOptions`** - Configuration options for client instances
  - `temp?: boolean` - If true, disables request syncing and unknown response abortion

### PerfectWS.client(config) / PerfectWS.client(server, config?)

Creates a client instance. Has two signatures:

**Signature 1: Config only**
```typescript
PerfectWS.client(config: WSClientOptions): WSClientResult
```
- `config`: Configuration object for the client
  - `temp?: boolean` - If true, disables request syncing and unknown response abortion

**Signature 2: Server with optional config**
```typescript
PerfectWS.client(server: WebSocket, config?: WSClientOptions): WSClientResult
```
- `server`: WebSocket instance to use immediately
- `config` (optional): Configuration object for the client

**Returns:** `WSClientResult` object containing:
- `router`: PerfectWS instance for making requests
- `setServer(ws)`: Method to set/change the WebSocket connection
- `unregister()`: Method to cleanup resources

### PerfectWS.server()

Creates a server instance.

```typescript
PerfectWS.server(): WSServerResult
```

**Returns:** `WSServerResult` object containing:
- `router`: PerfectWS instance for registering handlers
- `attachClient(ws)`: Method to attach a WebSocket client (returns a function to stop and cleanup resources)
- `autoReconnect(url, webSocketConstructor?)`: Method to auto-reconnect to a URL (returns a function to stop and cleanup resources)
- `unregister()`: Method to cleanup resources

### router.request(method, data?, options?)

Makes a request to the server (client only).

**Parameters:**
- `method`: String identifier for the request
- `data`: Any serializable data to send
- `options`:
  - `callback?: (data, error, done) => void` - Streaming callback
  - `events?: NetworkEventListener` - Event emitter for bidirectional events
  - `abortSignal?: AbortSignal` - For cancellation
  - `requestId?: string` - Custom request ID
  - `timeout?: number` - Request timeout in ms
  - `doNotWaitForConnection?: boolean` - Fail immediately if not connected

**Returns:** Promise resolving to the response data

### router.on(method, handler)

Registers a request handler (server only).

**Parameters:**
- `method`: String identifier for the request
- `handler`: Async function handling the request

**Handler signature:**
```typescript
(data, { send, reject, events, abortSignal, ws, requestId }) => {
  // data: Request data from client
  // send: Function to send streaming responses
  // reject: Function to reject with error
  // events: NetworkEventListener for bidirectional events
  // abortSignal: AbortSignal if client cancels
  // ws: WebSocket connection
  // requestId: Unique request ID

  return responseData; // or use send() for streaming
}
```

### Configuration

Configure behavior via the `router.config` object.

##### Request Management

**`clearOldRequestsDelay`** (default: 10000ms / 10 seconds)
- **Purpose**: Periodic cleanup interval for checking and removing non-existing/orphaned requests
- **How it works**: Every 10 seconds, the system scans all pending requests and removes those that:
  - Have exceeded their timeout period
  - Belong to disconnected clients who haven't reconnected
  - Were never properly completed or cancelled
- **Example scenario**: Client browser crashes without sending cleanup signal → after 10 seconds, server removes the orphaned request to prevent memory leak

**`requestTimeout`** (default: 900000ms / 15 minutes)
- **Purpose**: Maximum lifetime for any request from a client that disconnects and doesn't reconnect
- **How it works**: When a client loses connection (network failure, browser close, app crash), their pending requests remain active for this duration. If they reconnect within this time, requests resume; otherwise, they're aborted
- **Example scenario**: Mobile app loses connection in tunnel for 5 minutes → request stays alive and resumes when connection restored. After 15 minutes → request aborted to free resources

**`syncRequestsTimeout`** (default: 5000ms / 5 seconds)
- **Purpose**: Verification timeout when checking if requests are still alive between client and server
- **How it works**: During reconnection, client and server exchange lists of active request IDs to synchronize state. This timeout ensures the handshake completes quickly or fails fast if one side is unresponsive
- **Example scenario**: Client reconnects after network switch → has 5 seconds to confirm with server which of the 10 pending requests are still valid

##### Connection Management

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

##### Reliability & Performance

**`sendRequestRetries`** (default: 2)
- Number of times to retry sending a request if the initial attempt fails
- Applies when connection is temporarily unavailable but expected to recover
- Each retry waits for reconnection before attempting to send again

**`maxListeners`** (default: 1000)
- Maximum number of event listeners that can be attached to a WebSocket
- Prevents memory leaks from accumulating event listeners
- Node.js will warn if this limit is exceeded

**`maxTransformDepth`** (default: 100)
- Maximum depth for serializing nested objects with transforms (only for PerfectWSAdvanced)
- Prevents stack overflow from deeply nested or circular structures
- Objects beyond this depth will return null

**`syncRequestsWhenServerOpen`** (default: true)
- Whether to sync requests when the server is opened (cancel requests that does not exist on both sides)
- If false, the server will not sync requests when the server is opened (you can call `syncRequests` method manually to sync requests)

##### Debugging

**`verbose`** (default: false)
- Enables console logging for debugging connection and request issues
- Useful for troubleshooting connection problems and request lifecycle

#### Timeout Hierarchy

The protocol uses multiple timeout mechanisms that work together:

1. **Per-request timeout** (if specified) takes precedence over `requestTimeout`
2. **Connection loss** triggers `delayBeforeReconnect` before attempting reconnection
3. **During reconnection**, `syncRequestsTimeout` determines how long to wait for synchronization
4. **After reconnection**, requests continue if they haven't exceeded `requestTimeout`
5. **Background cleanup** runs every `clearOldRequestsDelay` to remove timed-out requests

## Events

The `NetworkEventListener` can be used for bidirectional event communication during requests:

```typescript
// Client
const events = new NetworkEventListener();

events.on('progress', (source, percent) => {
  if (source === 'remote') {
    console.log(`Server progress: ${percent}%`);
  }
});

await router.request('longTask', data, { events });

// Server
router.on('longTask', async (data, { events }) => {
  for (let i = 0; i <= 100; i += 10) {
    events.emit('progress', i);
    await sleep(100);
  }
  return 'Complete';
});
```

## Sub-routing

Organize routes into modular structures with optional prefixes:

```typescript
// userRoutes.ts
import { PerfectWS } from 'perfect-ws';

// Create router with prefix
const userRouter = PerfectWS.Router('/users');

// Add middleware to all user routes
userRouter.use(async (data, opts) => {
  // Check if user has permission to access user routes
  if (!data.user?.canAccessUsers) {
    opts.reject('Insufficient permissions', 'forbidden');
  }
});

userRouter.on('/create', async (data) => {
  return { id: '123', ...data };
});

userRouter.on('/delete', async ({ id }) => {
  return { success: true };
});

userRouter.on('/list', async (data) => {
  return { users: [] };
});

export default userRouter;

// main.ts
import userRouter from './userRoutes';

const { router } = PerfectWS.server();
router.use(userRouter);

// Client makes requests with full path:
await client.request('/users/create', { name: 'John' });
await client.request('/users/delete', { id: '123' });
await client.request('/users/list', {});
```

You can also create routers without prefixes for simple modular organization:

```typescript
const adminRouter = PerfectWS.Router(); // No prefix

adminRouter.on('admin.settings', async (data) => {
  return { settings: {} };
});

router.use(adminRouter);

// Client calls without prefix:
await client.request('admin.settings', {});
```

## Error Handling

PerfectWS provides detailed error information:

```typescript
try {
  const response = await router.request('method', data);
} catch (error) {
  if (error instanceof PerfectWSError) {
    console.log('Error code:', error.code);

    switch(error.code) {
      case 'timeout':
        // Handle timeout
        break;
      case 'serverClosed':
        // Handle disconnection
        break;
      case 'notFound':
        // Handle method not found
        break;
    }
  }
}
```

## Advance Examples

### Reverse Client/Server Setup

Also you can switch places and use the server as a client and the client as a server.

**Server:**
```typescript
import { PerfectWS } from 'perfect-ws';

const { router, attachClient } = PerfectWS.server();

const ws = new WebSocket('ws://localhost:8080');
attachClient(ws);

router.on('echo', async (data) => {
  return { received: data };
});
```

**Client:**
```typescript
import { PerfectWS } from 'perfect-ws';

const { router, setServer } = PerfectWS.client();

const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  setServer(ws);
});

const response = await router.request('echo', { message: 'Hello' });
console.log(response); // { received: { message: 'Hello' } }
```

## Notice

### Syncing Request
When you connect to the server the first thing it does is syncing the requests. This is to ensure that the client and server are in sync.

But if you want to temporarily connect for just validation and then connect to the real server you can set `syncRequestsWhenServerOpen` to false.

If we will not use `syncRequestsWhenServerOpen` on temporarily connection, it will kill all the active responses from the server, because it will not know about the requests.

```typescript
export const realServerEveryoneUse = PerfectWS.client(); // <- We will connect after validation, it store the requests and sync request on 'setServer'

websocketServe.on('connection', (ws) => {
  const { router, setServer, unregister } = PerfectWS.client(ws, { temp: true });

  const result = await router.request('validateServer', { token: 'password' });

  unregister();

  if (result === 'expected-result') {
    realServerEveryoneUse.setServer(ws);
  } else {
    ws.close(1001, 'Invalid token');
  }
});
```