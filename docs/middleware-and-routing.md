# Middleware & Routing

The [common use cases guide](common-use-cases.md#add-middleware-to-every-request) shows the basic middleware pattern. This page combines global middleware, per-route validation, and nested route groups in one application.

This example uses Zod as an optional validator. Install it first with `npm install zod`, or use any schema object that provides a compatible `safeParse()` method.

```typescript
import { ServerHost, PerfectWS, validateWithZod } from 'perfect-ws';
import { z } from 'zod';

const host = new ServerHost({
  password: 'shared-secret',
  port: 8080,
});

// 1. Root middleware - runs for every application route.
host.router.use((data, opts) => {
  data.requestStart = Date.now();
});

host.router.use((data, opts) => {
  console.log(`[${opts.clientId}] ${opts.requestId}`);
});

// 2. A child router with its own middleware scope.
const apiRouter = PerfectWS.Router();

apiRouter.use(async (data, opts) => {
  const user = await verifyToken(data.token);
  if (!user) {
    opts.reject('Invalid token', 'unauthorized');
    return;
  }
  data.user = user;
});

// 3. A nested child router with per-route validation.
const usersRouter = PerfectWS.Router();

const createUserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  user: z.custom<Awaited<ReturnType<typeof verifyToken>>>(),
});

usersRouter.on('/create',
  validateWithZod(createUserSchema, { stripUnknown: true }),
  async (data, opts) => {
    // Inferred as z.output<typeof createUserSchema>.
    // The schema explicitly retains data.user, while unrelated input is stripped.
    return await createUser(data, data.user);
  }
);

usersRouter.on('/list', async (data, opts) => {
  return { users: await listUsers(data.user) };
});

// 4. Prefixes belong to the parent mount, not the child router.
apiRouter.mount('/users', usersRouter);
host.router.mount('/api', apiRouter);

host.start();
```

Execution order for a call to `/api/users/create`:

1. Global middleware (elapsed-time tracking, logging)
2. `/api` middleware (token check - can reject before the request ever reaches `/users`)
3. `/users/create`'s own callback chain (`validateWithZod`, then the handler)

```typescript
// Client
import { RemoteClient } from 'perfect-ws';

const remote = new RemoteClient({ password: 'shared-secret', url: 'ws://localhost:8080' });
remote.start();

await remote.router.request('/api/users/create', {
  token: 'user-token',
  name: 'Ada',
  email: 'ada@example.com',
  isAdmin: true, // stripped by stripUnknown - never reaches createUser()
});
```

## A few things worth calling out

- **`use()` is only for middleware.** Attach a child router with `mount(prefix, router)`. Keeping those operations separate makes their scope explicit.
- **Router middleware is scope-wide.** It applies to every route in that router and its descendants, whether `use()` is called before or after `on()`. Adding middleware later affects subsequent requests to routes that are already mounted; a request already running keeps the middleware snapshot it started with.
- **Middleware order is structural.** Root middleware runs first, followed by parent routers from outermost to innermost, then route-local callbacks in the order passed to `on()`.
- **Middleware can reject or fully respond.** `opts.reject(message, code)` stops the chain and rejects the client's promise with a `PerfectWSError`. `opts.send(data, down)` can stream a response from *any* middleware in the chain, not just the final handler - useful for e.g. a caching middleware that short-circuits with a cached value.
- **`data` is mutated in place and shared down the chain.** Anything a middleware adds to `data` (like `data.user` above) is visible to every subsequent middleware and the final handler for that same request. Don't rely on it surviving past the request, though - it's not persisted anywhere.
- **Child-router middleware is scoped.** The `/api` token-check middleware only runs for requests under that mount - a route registered directly on `host.router` never sees it.
- **`opts.clientId`** identifies which authenticated connection made the request - see [Authentication](authentication.md) and [Reconnection & Streaming](reconnection-and-streaming.md) for what it's used for beyond logging (rate limiting keys, request-isolation across reconnects).
- **Validation runs per-route, not globally**, because different routes usually need different schemas. If you have a truly universal validation need (e.g. "every request must have a valid `requestVersion` field"), a global middleware is a better fit than repeating a schema check on every route.

## Parsed data and type inference

When `validateWithZod()` is the first callback registered for a route, every
following handler infers its `data` parameter from the schema's parsed output:

```typescript
const schema = z.object({
  count: z.coerce.number(),
  name: z.string().transform(value => value.trim()),
});

host.router.on('/calculate',
  validateWithZod(schema),
  async data => {
    // data is z.output<typeof schema>: { count: number; name: string }
    return data.count * 2;
  },
);
```

The handler receives Zod's parsed values at runtime too, so coercions, defaults,
and transforms are applied before it runs. By default, extra properties from the
original request remain available for backward compatibility. Pass
`{ stripUnknown: true }` when the handler should receive only properties retained
by the schema. This inference applies to both root and child routers.

## Router composition

Create routers without a prefix. A parent assigns the prefix when it mounts the
child, which keeps the child modular and makes the final route visible at the
composition point:

```typescript
// users.ts
export const users = PerfectWS.Router()
  .use(requireUser)
  .on('/list', listUsers)
  .on('/create', validateWithZod(createUserSchema), createUser);

// server.ts
const api = PerfectWS.Router();
api.mount('/users', users);
host.router.mount('/api', api);
```

The resulting methods are `/api/users/list` and `/api/users/create`. Routers and
routes may be added after their parent is mounted. One router instance can have
only one parent; create another router instance if the same route definitions
must be mounted in two places.
