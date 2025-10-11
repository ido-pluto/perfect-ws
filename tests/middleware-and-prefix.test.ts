import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS';
import { PerfectWSSubRoute } from '../src/PerfectWSSubRoute';

describe('🔧 Middleware and Prefix Features', () => {
    let server: PerfectWS;
    let client: PerfectWS;
    let serverWs: any;
    let clientWs: any;
    let attachClient: (ws: any) => void;
    let setServer: (ws: any) => void;

    beforeEach(() => {
        const serverSetup = PerfectWS.server();
        server = serverSetup.router;
        attachClient = serverSetup.attachClient;

        const clientSetup = PerfectWS.client();
        client = clientSetup.router;
        setServer = clientSetup.setServer;

        let serverMessageHandler: any;
        let clientMessageHandler: any;

        serverWs = {
            readyState: 1,
            addEventListener: vi.fn((event, handler) => {
                if (event === 'message') serverMessageHandler = handler;
            }),
            removeEventListener: vi.fn(),
            send: vi.fn((data) => {
                if (clientMessageHandler) {
                    setTimeout(() => clientMessageHandler({ data }), 0);
                }
            })
        };

        clientWs = {
            readyState: 1,
            addEventListener: vi.fn((event, handler) => {
                if (event === 'message') clientMessageHandler = handler;
            }),
            removeEventListener: vi.fn(),
            send: vi.fn((data) => {
                if (serverMessageHandler) {
                    setTimeout(() => serverMessageHandler({ data }), 0);
                }
            })
        };

        attachClient(serverWs);
        setServer(clientWs);
    });

    describe('Multiple Callbacks', () => {
        it('should execute multiple callbacks in sequence', async () => {
            const executionOrder: number[] = [];

            server.on('test',
                async (data, opts) => {
                    executionOrder.push(1);
                },
                async (data, opts) => {
                    executionOrder.push(2);
                },
                async (data, opts) => {
                    executionOrder.push(3);
                    return 'final';
                }
            );

            const response = await client.request('test', { value: 'hello' });

            expect(executionOrder).toEqual([1, 2, 3]);
            expect(response).toBe('final');
        });

        it('should pass data through callback chain', async () => {
            let capturedData: any;

            server.on('chain',
                async (data, opts) => {
                    expect(data).toEqual({ value: 'input' });
                },
                async (data, opts) => {
                    capturedData = data;
                    return { result: 'processed' };
                }
            );

            const response = await client.request('chain', { value: 'input' });

            expect(capturedData).toEqual({ value: 'input' });
            expect(response).toEqual({ result: 'processed' });
        });

        it('should stop execution when response ends early', async () => {
            const executionOrder: number[] = [];

            server.on('earlyEnd',
                async (data, opts) => {
                    executionOrder.push(1);
                },
                async (data, opts) => {
                    executionOrder.push(2);
                    await opts.send('early response', true);
                },
                async (data, opts) => {
                    executionOrder.push(3);
                }
            );

            const response = await client.request('earlyEnd', {});

            expect(executionOrder).toEqual([1, 2]);
            expect(response).toBe('early response');
        });

        it('should stop execution when reject is called', async () => {
            const executionOrder: number[] = [];

            server.on('earlyReject',
                async (data, opts) => {
                    executionOrder.push(1);
                },
                async (data, opts) => {
                    executionOrder.push(2);
                    opts.reject('Validation failed', 'validationError');
                },
                async (data, opts) => {
                    executionOrder.push(3);
                }
            );

            await expect(client.request('earlyReject', {}))
                .rejects.toThrow('Validation failed');

            expect(executionOrder).toEqual([1, 2]);
        });
    });

    describe('Global Middleware', () => {
        it('should apply middleware to all routes', async () => {
            const middlewareCalled: string[] = [];

            const authMiddleware = async (data: any, opts: any) => {
                middlewareCalled.push('auth');
            };

            const loggingMiddleware = async (data: any, opts: any) => {
                middlewareCalled.push('logging');
            };

            server.use(authMiddleware, loggingMiddleware);

            server.on('route1', async (data, opts) => {
                middlewareCalled.push('route1');
                return 'r1';
            });

            server.on('route2', async (data, opts) => {
                middlewareCalled.push('route2');
                return 'r2';
            });

            await client.request('route1', {});
            expect(middlewareCalled).toEqual(['auth', 'logging', 'route1']);

            middlewareCalled.length = 0;

            await client.request('route2', {});
            expect(middlewareCalled).toEqual(['auth', 'logging', 'route2']);
        });

        it('should allow middleware to modify request context', async () => {
            let capturedUserId: string | undefined;

            const authMiddleware = async (data: any, opts: any) => {
                (data as any).__userId = 'user123';
            };

            server.use(authMiddleware);

            server.on('protected', async (data, opts) => {
                capturedUserId = (data as any).__userId;
                return 'success';
            });

            await client.request('protected', {});

            expect(capturedUserId).toBe('user123');
        });

        it('should allow middleware to reject requests', async () => {
            const authMiddleware = async (data: any, opts: any) => {
                if (!(data as any).token) {
                    opts.reject('Unauthorized', 'unauthorized');
                }
            };

            server.use(authMiddleware);

            server.on('secured', async (data, opts) => {
                return 'secret data';
            });

            await expect(client.request('secured', {}))
                .rejects.toThrow('Unauthorized');

            const validResponse = await client.request('secured', { token: 'valid' });
            expect(validResponse).toBe('secret data');
        });
    });

    describe('SubRoute with Prefix', () => {
        it('should prefix routes correctly', async () => {
            const router = new PerfectWSSubRoute('/api');

            router.on('/users', async (data, opts) => {
                return 'users list';
            });

            router.on('/posts', async (data, opts) => {
                return 'posts list';
            });

            server.use(router);

            const usersResponse = await client.request('/api/users', {});
            expect(usersResponse).toBe('users list');

            const postsResponse = await client.request('/api/posts', {});
            expect(postsResponse).toBe('posts list');
        });

        it('should handle empty prefix', async () => {
            const router = new PerfectWSSubRoute();

            router.on('test', async (data, opts) => {
                return 'no prefix';
            });

            server.use(router);

            const response = await client.request('test', {});
            expect(response).toBe('no prefix');
        });

        it('should work with multiple routers with different prefixes', async () => {
            const apiRouter = new PerfectWSSubRoute('/api');
            const adminRouter = new PerfectWSSubRoute('/admin');

            apiRouter.on('/data', async (data, opts) => {
                return 'api data';
            });

            adminRouter.on('/data', async (data, opts) => {
                return 'admin data';
            });

            server.use(apiRouter, adminRouter);

            const apiResponse = await client.request('/api/data', {});
            expect(apiResponse).toBe('api data');

            const adminResponse = await client.request('/admin/data', {});
            expect(adminResponse).toBe('admin data');
        });
    });

    describe('SubRoute Middleware', () => {
        it('should apply middleware to subroute only', async () => {
            const middlewareCalls: string[] = [];

            const apiMiddleware = async (data: any, opts: any) => {
                middlewareCalls.push('api-middleware');
            };

            const router = new PerfectWSSubRoute('/api');
            router.use(apiMiddleware);

            router.on('/protected', async (data, opts) => {
                middlewareCalls.push('protected-handler');
                return 'protected';
            });

            server.on('/public', async (data, opts) => {
                middlewareCalls.push('public-handler');
                return 'public';
            });

            server.use(router);

            await client.request('/api/protected', {});
            expect(middlewareCalls).toEqual(['api-middleware', 'protected-handler']);

            middlewareCalls.length = 0;

            await client.request('/public', {});
            expect(middlewareCalls).toEqual(['public-handler']);
        });

        it('should combine global and subroute middleware', async () => {
            const calls: string[] = [];

            const globalMiddleware = async (data: any, opts: any) => {
                calls.push('global');
            };

            const routerMiddleware = async (data: any, opts: any) => {
                calls.push('router');
            };

            server.use(globalMiddleware);

            const router = new PerfectWSSubRoute('/api');
            router.use(routerMiddleware);

            router.on('/test', async (data, opts) => {
                calls.push('handler');
                return 'ok';
            });

            server.use(router);

            await client.request('/api/test', {});
            expect(calls).toEqual(['global', 'router', 'handler']);
        });

        it('should apply multiple middleware to subroute', async () => {
            const calls: string[] = [];

            const middleware1 = async (data: any, opts: any) => {
                calls.push('m1');
            };

            const middleware2 = async (data: any, opts: any) => {
                calls.push('m2');
            };

            const router = new PerfectWSSubRoute('/api');
            router.use(middleware1, middleware2);

            router.on('/test', async (data, opts) => {
                calls.push('handler');
                return 'done';
            });

            server.use(router);

            await client.request('/api/test', {});
            expect(calls).toEqual(['m1', 'm2', 'handler']);
        });
    });

    describe('Nested SubRoutes', () => {
        it('should handle nested subroutes with prefix composition', async () => {
            const apiRouter = new PerfectWSSubRoute('/api');
            const v1Router = new PerfectWSSubRoute('/v1');

            v1Router.on('/users', async (data, opts) => {
                return 'v1 users';
            });

            apiRouter.use(v1Router);
            server.use(apiRouter);

            const response = await client.request('/api/v1/users', {});
            expect(response).toBe('v1 users');
        });

        it('should compose middleware in nested subroutes', async () => {
            const calls: string[] = [];

            const apiMiddleware = async (data: any, opts: any) => {
                calls.push('api');
            };

            const v1Middleware = async (data: any, opts: any) => {
                calls.push('v1');
            };

            const apiRouter = new PerfectWSSubRoute('/api');
            apiRouter.use(apiMiddleware);

            const v1Router = new PerfectWSSubRoute('/v1');
            v1Router.use(v1Middleware);

            v1Router.on('/test', async (data, opts) => {
                calls.push('handler');
                return 'result';
            });

            apiRouter.use(v1Router);
            server.use(apiRouter);

            await client.request('/api/v1/test', {});
            expect(calls).toEqual(['api', 'v1', 'handler']);
        });

        it('should handle deeply nested subroutes', async () => {
            const calls: string[] = [];

            const level1 = new PerfectWSSubRoute('/l1');
            const level2 = new PerfectWSSubRoute('/l2');
            const level3 = new PerfectWSSubRoute('/l3');

            level1.use(async (data: any, opts: any) => { calls.push('m1'); });
            level2.use(async (data: any, opts: any) => { calls.push('m2'); });
            level3.use(async (data: any, opts: any) => { calls.push('m3'); });

            level3.on('/endpoint', async (data, opts) => {
                calls.push('handler');
                return 'deep';
            });

            level2.use(level3);
            level1.use(level2);
            server.use(level1);

            const response = await client.request('/l1/l2/l3/endpoint', {});
            expect(response).toBe('deep');
            expect(calls).toEqual(['m1', 'm2', 'm3', 'handler']);
        });

        it('should prevent double connection of subroutes', async () => {
            const router = new PerfectWSSubRoute('/api');
            router.on('/test', async (data, opts) => 'ok');

            const parent1 = new PerfectWSSubRoute('/p1');
            const parent2 = new PerfectWSSubRoute('/p2');

            parent1.use(router);
            parent2.use(router);

            server.use(parent1);

            await expect(async () => {
                server.use(parent2);
            }).rejects.toThrow('This subroute is already connected to a parent subroute');
        });
    });

    describe('Mixed Usage Scenarios', () => {
        it('should handle global middleware, subroute middleware, and multiple callbacks', async () => {
            const calls: string[] = [];

            const globalAuth = async (data: any, opts: any) => {
                calls.push('global-auth');
            };

            const apiLogger = async (data: any, opts: any) => {
                calls.push('api-logger');
            };

            server.use(globalAuth);

            const apiRouter = new PerfectWSSubRoute('/api');
            apiRouter.use(apiLogger);

            apiRouter.on('/multi',
                async (data, opts) => {
                    calls.push('callback1');
                },
                async (data, opts) => {
                    calls.push('callback2');
                    return 'response';
                }
            );

            server.use(apiRouter);

            await client.request('/api/multi', {});
            expect(calls).toEqual(['global-auth', 'api-logger', 'callback1', 'callback2']);
        });

        it('should handle complex routing with multiple nested routers', async () => {
            const apiRouter = new PerfectWSSubRoute('/api');
            const adminRouter = new PerfectWSSubRoute('/admin');
            const usersRouter = new PerfectWSSubRoute('/users');
            const postsRouter = new PerfectWSSubRoute('/posts');
            const adminUsersRouter = new PerfectWSSubRoute('/users');

            usersRouter.on('/list', async (data, opts) => 'users list');
            usersRouter.on('/create', async (data, opts) => 'user created');

            postsRouter.on('/list', async (data, opts) => 'posts list');
            postsRouter.on('/create', async (data, opts) => 'post created');

            adminUsersRouter.on('/list', async (data, opts) => 'users list');

            apiRouter.use(usersRouter, postsRouter);
            adminRouter.use(adminUsersRouter);

            server.use(apiRouter, adminRouter);

            expect(await client.request('/api/users/list', {})).toBe('users list');
            expect(await client.request('/api/users/create', {})).toBe('user created');
            expect(await client.request('/api/posts/list', {})).toBe('posts list');
            expect(await client.request('/api/posts/create', {})).toBe('post created');
            expect(await client.request('/admin/users/list', {})).toBe('users list');
        });

        it('should handle middleware that modifies data through chain', async () => {
            let finalData: any;

            const enrichMiddleware = async (data: any, opts: any) => {
                (data as any).enriched = true;
            };

            const validateMiddleware = async (data: any, opts: any) => {
                (data as any).validated = true;
            };

            server.use(enrichMiddleware);

            const router = new PerfectWSSubRoute('/api');
            router.use(validateMiddleware);

            router.on('/test', async (data, opts) => {
                finalData = data;
                return 'success';
            });

            server.use(router);

            await client.request('/api/test', { value: 'test' });

            expect(finalData).toEqual({
                value: 'test',
                enriched: true,
                validated: true
            });
        });
    });

    describe('Edge Cases', () => {
        it('should handle routes with no prefix or trailing slash', async () => {
            const router = new PerfectWSSubRoute('');
            router.on('test', async (data, opts) => 'no prefix');

            server.use(router);

            expect(await client.request('test', {})).toBe('no prefix');
        });

        it('should handle empty callback arrays', async () => {
            server.on('empty', async (data, opts) => 'default');

            expect(await client.request('empty', {})).toBe('default');
        });

        it('should maintain proper order with mixed sync and async callbacks', async () => {
            const calls: number[] = [];

            server.on('mixed',
                (data, opts) => {
                    calls.push(1);
                },
                async (data, opts) => {
                    calls.push(2);
                    await new Promise(resolve => setTimeout(resolve, 10));
                    calls.push(3);
                },
                (data, opts) => {
                    calls.push(4);
                    return 'done';
                }
            );

            await client.request('mixed', {});
            expect(calls).toEqual([1, 2, 3, 4]);
        });

        it('should handle middleware accessing abort signal', async () => {
            let abortSignalExists = false;

            const middleware = async (data: any, opts: any) => {
                abortSignalExists = opts.abortSignal instanceof AbortSignal;
            };

            server.use(middleware);

            server.on('signalTest', async (data, opts) => {
                return 'ok';
            });

            await client.request('signalTest', {});
            expect(abortSignalExists).toBe(true);
        });
    });

    describe('Advanced Middleware Patterns', () => {
        it('should handle async middleware with promises', async () => {
            const calls: string[] = [];

            server.use(
                async (data, opts) => {
                    calls.push('start');
                    await new Promise(resolve => setTimeout(resolve, 5));
                    calls.push('middle');
                },
                async (data, opts) => {
                    await new Promise(resolve => setTimeout(resolve, 5));
                    calls.push('end');
                }
            );

            server.on('asyncTest', async (data, opts) => {
                calls.push('handler');
                return 'done';
            });

            await client.request('asyncTest', {});
            expect(calls).toEqual(['start', 'middle', 'end', 'handler']);
        });

        it('should handle middleware that throws errors', async () => {
            server.use(async (data, opts) => {
                if (!(data as any).valid) {
                    throw new Error('Invalid data');
                }
            });

            server.on('errorTest', async (data, opts) => 'success');

            await expect(client.request('errorTest', { valid: false }))
                .rejects.toThrow();

            const result = await client.request('errorTest', { valid: true });
            expect(result).toBe('success');
        });

        it('should handle middleware modifying the same data property', async () => {
            let finalValue: number = 0;

            server.use(
                async (data, opts) => {
                    (data as any).counter = 0;
                },
                async (data, opts) => {
                    (data as any).counter += 10;
                },
                async (data, opts) => {
                    (data as any).counter += 5;
                }
            );

            server.on('counterTest', async (data, opts) => {
                finalValue = (data as any).counter;
                return 'ok';
            });

            await client.request('counterTest', {});
            expect(finalValue).toBe(15);
        });

        it('should handle 10 layers of middleware', async () => {
            const calls: number[] = [];

            for (let i = 0; i < 10; i++) {
                const index = i;
                server.use(async (data, opts) => {
                    calls.push(index);
                });
            }

            server.on('manyLayers', async (data, opts) => {
                calls.push(999);
                return 'done';
            });

            await client.request('manyLayers', {});
            expect(calls).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 999]);
        });
    });

    describe('Complex Prefix Scenarios', () => {
        it('should handle prefixes with special characters', async () => {
            const router = new PerfectWSSubRoute('/api-v1');
            router.on('/get-data', async (data, opts) => 'special-chars');

            server.use(router);

            const result = await client.request('/api-v1/get-data', {});
            expect(result).toBe('special-chars');
        });

        it('should handle empty route name with prefix', async () => {
            const router = new PerfectWSSubRoute('/base');
            router.on('', async (data, opts) => 'empty-route');

            server.use(router);

            const result = await client.request('/base', {});
            expect(result).toBe('empty-route');
        });

        it('should handle multiple slashes correctly', async () => {
            const router1 = new PerfectWSSubRoute('/level1/');
            const router2 = new PerfectWSSubRoute('/level2');

            router2.on('/endpoint', async (data, opts) => 'found');
            router1.use(router2);
            server.use(router1);

            const result = await client.request('/level1//level2/endpoint', {});
            expect(result).toBe('found');
        });

        it('should distinguish routes with similar prefixes', async () => {
            const api = new PerfectWSSubRoute('/api');
            const apiV1 = new PerfectWSSubRoute('/apiv1');
            const apiV2 = new PerfectWSSubRoute('/apiv2');

            api.on('/test', async (data, opts) => 'api');
            apiV1.on('/test', async (data, opts) => 'v1');
            apiV2.on('/test', async (data, opts) => 'v2');

            server.use(api, apiV1, apiV2);

            expect(await client.request('/api/test', {})).toBe('api');
            expect(await client.request('/apiv1/test', {})).toBe('v1');
            expect(await client.request('/apiv2/test', {})).toBe('v2');
        });

        it('should handle 5 levels of nested routing', async () => {
            const l1 = new PerfectWSSubRoute('/l1');
            const l2 = new PerfectWSSubRoute('/l2');
            const l3 = new PerfectWSSubRoute('/l3');
            const l4 = new PerfectWSSubRoute('/l4');
            const l5 = new PerfectWSSubRoute('/l5');

            l5.on('/deep', async (data, opts) => 'very-deep');
            l4.use(l5);
            l3.use(l4);
            l2.use(l3);
            l1.use(l2);
            server.use(l1);

            const result = await client.request('/l1/l2/l3/l4/l5/deep', {});
            expect(result).toBe('very-deep');
        });
    });

    describe('Middleware + Prefix Interaction', () => {
        it('should apply middleware from all nesting levels', async () => {
            const calls: string[] = [];

            const l1 = new PerfectWSSubRoute('/a');
            const l2 = new PerfectWSSubRoute('/b');
            const l3 = new PerfectWSSubRoute('/c');

            server.use(async (data, opts) => { calls.push('global'); });
            l1.use(async (data, opts) => { calls.push('l1'); });
            l2.use(async (data, opts) => { calls.push('l2'); });
            l3.use(async (data, opts) => { calls.push('l3'); });

            l3.on('/end', async (data, opts) => {
                calls.push('handler');
                return 'done';
            });

            l2.use(l3);
            l1.use(l2);
            server.use(l1);

            await client.request('/a/b/c/end', {});
            expect(calls).toEqual(['global', 'l1', 'l2', 'l3', 'handler']);
        });

        it('should allow middleware to modify data seen by nested routes', async () => {
            let finalData: any;

            const outer = new PerfectWSSubRoute('/outer');
            const inner = new PerfectWSSubRoute('/inner');

            server.use(async (data, opts) => {
                (data as any).fromGlobal = 'global';
            });

            outer.use(async (data, opts) => {
                (data as any).fromOuter = 'outer';
            });

            inner.use(async (data, opts) => {
                (data as any).fromInner = 'inner';
            });

            inner.on('/test', async (data, opts) => {
                finalData = data;
                return 'ok';
            });

            outer.use(inner);
            server.use(outer);

            await client.request('/outer/inner/test', { original: 'data' });

            expect(finalData).toEqual({
                original: 'data',
                fromGlobal: 'global',
                fromOuter: 'outer',
                fromInner: 'inner'
            });
        });

        it('should handle middleware rejecting at different nesting levels', async () => {
            const l1 = new PerfectWSSubRoute('/protected');
            const l2 = new PerfectWSSubRoute('/admin');

            l1.use(async (data, opts) => {
                if (!(data as any).authenticated) {
                    opts.reject('Not authenticated', 'auth');
                }
            });

            l2.use(async (data, opts) => {
                if (!(data as any).isAdmin) {
                    opts.reject('Not admin', 'admin');
                }
            });

            l2.on('/secret', async (data, opts) => 'secret-data');

            l1.use(l2);
            server.use(l1);

            await expect(client.request('/protected/admin/secret', {}))
                .rejects.toThrow('Not authenticated');

            await expect(client.request('/protected/admin/secret', { authenticated: true }))
                .rejects.toThrow('Not admin');

            const result = await client.request('/protected/admin/secret', {
                authenticated: true,
                isAdmin: true
            });
            expect(result).toBe('secret-data');
        });
    });

    describe('Edge Cases and Error Scenarios', () => {
        it('should handle route with no handlers', async () => {
            const router = new PerfectWSSubRoute('/empty');
            server.use(router);

            await expect(client.request('/empty/nonexistent', {}))
                .rejects.toThrow('Method "/empty/nonexistent" not found');
        });

        it('should handle many routers at same level', async () => {
            for (let i = 0; i < 20; i++) {
                const router = new PerfectWSSubRoute(`/route${i}`);
                router.on('/test', async (data, opts) => `response${i}`);
                server.use(router);
            }

            for (let i = 0; i < 20; i++) {
                const result = await client.request(`/route${i}/test`, {});
                expect(result).toBe(`response${i}`);
            }
        });

        it('should handle middleware with no await', async () => {
            const calls: string[] = [];

            server.use(
                (data, opts) => {
                    calls.push('sync1');
                },
                (data, opts) => {
                    calls.push('sync2');
                }
            );

            server.on('syncTest', async (data, opts) => {
                calls.push('handler');
                return 'done';
            });

            await client.request('syncTest', {});
            expect(calls).toEqual(['sync1', 'sync2', 'handler']);
        });

        it('should handle middleware returning values (should be ignored)', async () => {
            const calls: string[] = [];

            server.use(
                async (data, opts) => {
                    calls.push('m1');
                    return 'this-should-be-ignored';
                },
                async (data, opts) => {
                    calls.push('m2');
                    return { ignored: true };
                }
            );

            server.on('returnTest', async (data, opts) => {
                calls.push('handler');
                return 'final-response';
            });

            const result = await client.request('returnTest', {});
            expect(result).toBe('final-response');
            expect(calls).toEqual(['m1', 'm2', 'handler']);
        });

        it('should handle middleware with complex async operations', async () => {
            const calls: string[] = [];

            server.use(async (data, opts) => {
                await Promise.all([
                    new Promise(resolve => setTimeout(resolve, 5)),
                    new Promise(resolve => setTimeout(resolve, 5))
                ]);
                calls.push('parallel');
            });

            server.on('parallelTest', async (data, opts) => {
                calls.push('handler');
                return 'done';
            });

            await client.request('parallelTest', {});
            expect(calls).toEqual(['parallel', 'handler']);
        });

        it('should handle subroute with many endpoints', async () => {
            const router = new PerfectWSSubRoute('/api');

            for (let i = 0; i < 50; i++) {
                router.on(`/endpoint${i}`, async (data, opts) => `result${i}`);
            }

            server.use(router);

            for (let i = 0; i < 50; i++) {
                const result = await client.request(`/api/endpoint${i}`, {});
                expect(result).toBe(`result${i}`);
            }
        });

        it('should handle mixed middleware and multiple callbacks on same route', async () => {
            const calls: string[] = [];

            server.use(async (data, opts) => { calls.push('global'); });

            const router = new PerfectWSSubRoute('/mixed');
            router.use(async (data, opts) => { calls.push('router'); });

            router.on('/test',
                async (data, opts) => { calls.push('cb1'); },
                async (data, opts) => { calls.push('cb2'); },
                async (data, opts) => {
                    calls.push('cb3');
                    return 'done';
                }
            );

            server.use(router);

            await client.request('/mixed/test', {});
            expect(calls).toEqual(['global', 'router', 'cb1', 'cb2', 'cb3']);
        });

        it('should handle router being added after routes are defined', async () => {
            const router = new PerfectWSSubRoute('/late');

            router.on('/endpoint1', async (data, opts) => 'e1');
            router.on('/endpoint2', async (data, opts) => 'e2');

            const result1 = await client.request('/other', {}).catch(e => 'not-found');
            expect(result1).toBe('not-found');

            server.use(router);

            const result2 = await client.request('/late/endpoint1', {});
            expect(result2).toBe('e1');
        });
    });

    describe('Data Flow and Transformation', () => {
        it('should maintain data integrity through middleware chain', async () => {
            const original = {
                id: 123,
                nested: { value: 'test' },
                array: [1, 2, 3]
            };

            let capturedData: any;

            server.use(
                async (data, opts) => {
                    (data as any).middleware1 = true;
                },
                async (data, opts) => {
                    (data as any).middleware2 = true;
                }
            );

            server.on('integrityTest', async (data, opts) => {
                capturedData = data;
                return 'ok';
            });

            await client.request('integrityTest', original);

            expect(capturedData.id).toBe(123);
            expect(capturedData.nested.value).toBe('test');
            expect(capturedData.array).toEqual([1, 2, 3]);
            expect(capturedData.middleware1).toBe(true);
            expect(capturedData.middleware2).toBe(true);
        });

        it('should handle large data objects through middleware', async () => {
            const largeData: any = {};
            for (let i = 0; i < 100; i++) {
                largeData[`key${i}`] = `value${i}`;
            }

            let capturedSize = 0;

            server.use(async (data, opts) => {
                capturedSize = Object.keys(data).length;
            });

            server.on('largeDataTest', async (data, opts) => 'ok');

            await client.request('largeDataTest', largeData);
            expect(capturedSize).toBe(100);
        });
    });

    describe('Performance and Stress Scenarios', () => {
        it('should handle rapid sequential requests with middleware', async () => {
            let counter = 0;

            server.use(async (data, opts) => {
                counter++;
            });

            server.on('rapidTest', async (data, opts) => 'ok');

            const promises: Promise<any>[] = [];
            for (let i = 0; i < 20; i++) {
                promises.push(client.request('rapidTest', {}));
            }

            await Promise.all(promises);
            expect(counter).toBe(20);
        });

        it('should handle concurrent requests to different routes with shared middleware', async () => {
            const calls: string[] = [];

            server.use(async (data, opts) => {
                calls.push(`global-${(data as any).id}`);
            });

            server.on('route1', async (data, opts) => 'r1');
            server.on('route2', async (data, opts) => 'r2');
            server.on('route3', async (data, opts) => 'r3');

            await Promise.all([
                client.request('route1', { id: 1 }),
                client.request('route2', { id: 2 }),
                client.request('route3', { id: 3 })
            ]);

            expect(calls).toContain('global-1');
            expect(calls).toContain('global-2');
            expect(calls).toContain('global-3');
        });
    });
});

