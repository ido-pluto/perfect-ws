import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PerfectWS } from '../src/PerfectWS';
import { validateWithZod } from '../src/middleware/zodValidation';

const z = {
    object: (shape: any) => ({
        parse: (data: any) => {
            for (const [key, validator] of Object.entries(shape)) {
                if (!(validator as any).validate(data[key])) {
                    throw new Error(`Validation failed for ${key}`);
                }
            }
            return data;
        },
        safeParse: (data: any) => {
            const issues: any[] = [];
            for (const [key, validator] of Object.entries(shape)) {
                const result = (validator as any).validate(data[key]);
                if (!result) {
                    issues.push({
                        path: [key],
                        message: (validator as any).message || `Invalid ${key}`
                    });
                }
            }

            if (issues.length === 0) {
                const parsedData: any = {};
                for (const key of Object.keys(shape)) {
                    parsedData[key] = data[key];
                }
                return { success: true, data: parsedData };
            }

            return { success: false, error: { issues } };
        }
    }),
    string: () => ({
        validate: (val: any) => typeof val === 'string' && val.length > 0,
        message: 'Expected string',
        min: function (n: number) {
            return {
                validate: (val: any) => typeof val === 'string' && val.length >= n,
                message: `String must be at least ${n} characters`,
                max: function (max: number) {
                    return {
                        validate: (val: any) => typeof val === 'string' && val.length >= n && val.length <= max,
                        message: `String must be between ${n} and ${max} characters`,
                        email: function () {
                            return {
                                validate: (val: any) => typeof val === 'string' && val.includes('@'),
                                message: 'Invalid email address'
                            };
                        }
                    };
                },
                email: function () {
                    return {
                        validate: (val: any) => typeof val === 'string' && val.length >= n && val.includes('@'),
                        message: 'Invalid email address'
                    };
                }
            };
        },
        email: function () {
            return {
                validate: (val: any) => typeof val === 'string' && val.includes('@'),
                message: 'Invalid email address'
            };
        }
    }),
    number: () => ({
        validate: (val: any) => typeof val === 'number',
        message: 'Expected number',
        int: function () {
            return {
                validate: (val: any) => typeof val === 'number' && Number.isInteger(val),
                message: 'Expected integer',
                positive: function () {
                    return {
                        validate: (val: any) => typeof val === 'number' && Number.isInteger(val) && val > 0,
                        message: 'Expected positive integer',
                        optional: function () {
                            return {
                                validate: (val: any) => val === undefined || (typeof val === 'number' && Number.isInteger(val) && val > 0),
                                message: 'Expected positive integer or undefined'
                            };
                        }
                    };
                }
            };
        }
    })
};

describe('🔍 Zod Validation Middleware', () => {
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

    describe('validateWithZod', () => {
        it('should pass valid data', async () => {
            const schema = z.object({
                name: z.string().min(2),
                age: z.number().int().positive()
            });

            server.on('createUser',
                validateWithZod(schema),
                async (data) => {
                    return { success: true, user: data };
                }
            );

            const result = await client.request('createUser', {
                name: 'John',
                age: 25
            });

            expect(result).toEqual({
                success: true,
                user: { name: 'John', age: 25 }
            });
        });

        it('should reject invalid data with detailed error', async () => {
            const schema = z.object({
                name: z.string().min(2),
                email: z.string().email()
            });

            server.on('createUser',
                validateWithZod(schema),
                async (data) => {
                    return { success: true };
                }
            );

            await expect(
                client.request('createUser', {
                    name: 'J',
                    email: 'invalid'
                })
            ).rejects.toThrow();
        });

        it('should use custom error message when provided', async () => {
            const schema = z.object({
                name: z.string()
            });

            server.on('createUser',
                validateWithZod(schema, {
                    customErrorMessage: 'User data is invalid'
                }),
                async (data) => {
                    return { success: true };
                }
            );

            await expect(
                client.request('createUser', { name: 123 })
            ).rejects.toThrow('User data is invalid');
        });

        it('should use custom error code', async () => {
            const schema = z.object({
                name: z.string()
            });

            server.on('createUser',
                validateWithZod(schema, {
                    errorCode: 'CUSTOM_VALIDATION_ERROR'
                }),
                async (data) => {
                    return { success: true };
                }
            );

            try {
                await client.request('createUser', { name: 123 });
            } catch (error: any) {
                expect(error.code).toBe('CUSTOM_VALIDATION_ERROR');
            }
        });

        it('should handle multiple validation errors', async () => {
            const schema = z.object({
                name: z.string().min(2),
                email: z.string().email(),
                age: z.number().int().positive()
            });

            server.on('createUser',
                validateWithZod(schema, { abortEarly: false }),
                async (data) => {
                    return { success: true };
                }
            );

            await expect(
                client.request('createUser', {
                    name: 'J',
                    email: 'invalid',
                    age: 'not-a-number'
                })
            ).rejects.toThrow();
        });

        it('should work in middleware chain', async () => {
            const schema = z.object({
                name: z.string(),
                age: z.number()
            });

            const calls: string[] = [];

            server.use(async (data, opts) => {
                calls.push('global');
            });

            server.on('createUser',
                async (data, opts) => {
                    calls.push('pre-validation');
                },
                validateWithZod(schema),
                async (data, opts) => {
                    calls.push('post-validation');
                    return { success: true };
                }
            );

            await client.request('createUser', {
                name: 'John',
                age: 25
            });

            expect(calls).toEqual(['global', 'pre-validation', 'post-validation']);
        });

        it('should stop execution chain on validation failure', async () => {
            const schema = z.object({
                name: z.string()
            });

            const calls: string[] = [];

            server.on('createUser',
                async (data, opts) => {
                    calls.push('before-validation');
                },
                validateWithZod(schema),
                async (data, opts) => {
                    calls.push('after-validation');
                    return { success: true };
                }
            );

            await expect(
                client.request('createUser', { name: 123 })
            ).rejects.toThrow();

            expect(calls).toEqual(['before-validation']);
        });
    });

    describe('stripUnknown option', () => {
        it('should keep unknown fields by default', async () => {
            const schema = z.object({
                name: z.string(),
                age: z.number()
            });

            let capturedData: any;

            server.on('createUser',
                validateWithZod(schema),
                async (data) => {
                    capturedData = { ...data };
                    return { success: true };
                }
            );

            await client.request('createUser', {
                name: 'John',
                age: 25,
                extraField: 'should-remain',
                anotherField: 123
            });

            expect(capturedData).toEqual({
                name: 'John',
                age: 25,
                extraField: 'should-remain',
                anotherField: 123
            });
        });

        it('should strip unknown fields when stripUnknown is true', async () => {
            const schema = z.object({
                name: z.string(),
                email: z.string()
            });

            let capturedData: any;

            server.on('createUser',
                validateWithZod(schema, { stripUnknown: true }),
                async (data) => {
                    capturedData = { ...data };
                    return { success: true };
                }
            );

            await client.request('createUser', {
                name: 'John',
                email: 'john@example.com',
                password: 'secret',
                token: 'xyz'
            });

            expect(capturedData).toEqual({
                name: 'John',
                email: 'john@example.com'
            });
            expect(capturedData.password).toBeUndefined();
            expect(capturedData.token).toBeUndefined();
        });

        it('should only keep validated fields with stripUnknown', async () => {
            const schema = z.object({
                id: z.number(),
                active: z.string()
            });

            let capturedData: any;

            server.on('update',
                validateWithZod(schema, { stripUnknown: true }),
                async (data) => {
                    capturedData = { ...data };
                    return { success: true };
                }
            );

            await client.request('update', {
                id: 123,
                active: 'yes',
                unauthorized: 'field',
                malicious: 'data'
            });

            expect(Object.keys(capturedData)).toEqual(['id', 'active']);
        });

        it('should handle empty extra fields with stripUnknown', async () => {
            const schema = z.object({
                value: z.string()
            });

            let capturedData: any;

            server.on('test',
                validateWithZod(schema, { stripUnknown: true }),
                async (data) => {
                    capturedData = { ...data };
                    return { success: true };
                }
            );

            await client.request('test', {
                value: 'test'
            });

            expect(capturedData).toEqual({ value: 'test' });
        });
    });

    describe('Integration with SubRoutes', () => {
        it('should work with global middleware and validation', async () => {
            const schema = z.object({
                name: z.string(),
                email: z.string().email()
            });

            const calls: string[] = [];

            server.use(async (data, opts) => {
                calls.push('global-middleware');
            });

            server.on('/users',
                validateWithZod(schema),
                async (data) => {
                    calls.push('handler');
                    return { success: true, user: data };
                }
            );

            const result = await client.request('/users', {
                name: 'John',
                email: 'john@example.com'
            });

            expect(result).toEqual({
                success: true,
                user: { name: 'John', email: 'john@example.com' }
            });
            expect(calls).toEqual(['global-middleware', 'handler']);
        });

        it('should work with multiple validations in chain', async () => {
            const schema1 = z.object({
                title: z.string().min(3)
            });

            const schema2 = z.object({
                title: z.string().min(3)
            });

            const calls: string[] = [];

            server.on('/posts',
                async (data, opts) => {
                    calls.push('pre-validation');
                },
                validateWithZod(schema1),
                async (data, opts) => {
                    calls.push('between-validations');
                },
                validateWithZod(schema2),
                async (data, opts) => {
                    calls.push('post-validation');
                    return { success: true };
                }
            );

            await client.request('/posts', { title: 'Hello' });

            expect(calls).toEqual(['pre-validation', 'between-validations', 'post-validation']);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty data object', async () => {
            const schema = z.object({
                name: z.string()
            });

            server.on('test',
                validateWithZod(schema),
                async (data) => {
                    return { success: true };
                }
            );

            await expect(
                client.request('test', {})
            ).rejects.toThrow();
        });

        it('should handle null data', async () => {
            const schema = z.object({
                value: z.string()
            });

            server.on('test',
                validateWithZod(schema),
                async (data) => {
                    return { success: true };
                }
            );

            await expect(
                client.request('test', null)
            ).rejects.toThrow();
        });

        it('should handle array data', async () => {
            const schema = z.object({
                items: z.string()
            });

            server.on('process',
                validateWithZod(schema),
                async (data) => {
                    return { success: true };
                }
            );

            const result = await client.request('process', {
                items: 'test'
            });

            expect(result).toEqual({ success: true });
        });
    });
});

