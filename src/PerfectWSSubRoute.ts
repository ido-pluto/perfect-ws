import { WSListenCallback, PerfectWS } from './PerfectWS.js';
import { PerfectWSError } from './PerfectWSError.js';
import type { WSDataMiddleware } from './middleware/dataMiddleware.js';

/**
 * A mountable RPC router scope. Create one with `PerfectWS.Router()`, add
 * router-wide middleware with `use()`, and attach children with `mount()`.
 */
export class PerfectWSSubRoute {
    public _listenForRequests = new Map<string, { method: string; callbacks: WSListenCallback[] }>();
    private _protocol: PerfectWS<any> | null = null;
    private _parent: PerfectWSSubRoute | null = null;
    private _mounts: Array<{ prefix: string; router: PerfectWSSubRoute; }> = [];
    private _fullPrefix = '';
    private _middleware: WSListenCallback[] = [];

    public constructor() {
        if (arguments.length > 0) {
            throw new PerfectWSError(
                'PerfectWS.Router() no longer accepts a prefix; pass the prefix to parent.mount(prefix, router)',
                'routerPrefixMovedToMount'
            );
        }
    }

    public on<Data>(method: string, validator: WSDataMiddleware<Data>, ...callbacks: WSListenCallback<Data>[]): this;
    public on(method: string, ...callbacks: WSListenCallback[]): this;
    public on(method: string, ...callbacks: WSListenCallback[]): this {
        this._listenForRequests.set(method, { method, callbacks });
        this._protocol?.__registerSubRoute(this._getFullMethod(method), callbacks, () => this._getMiddleware(), this);
        return this;
    }

    public off(method: string): this {
        this._listenForRequests.delete(method);
        this._protocol?.__unregisterSubRoute(this._getFullMethod(method), this);
        return this;
    }

    /** Add middleware that applies to every route in this router and its descendants. */
    public use(...middleware: WSListenCallback[]): this {
        for (const callback of middleware) {
            if (typeof callback !== 'function') {
                throw new PerfectWSError('use() accepts middleware functions only; attach child routers with mount(prefix, router)', 'invalidMiddleware');
            }
            this._middleware.push(callback);
        }
        return this;
    }

    /** Mount a child router under a prefix owned by this parent router. */
    public mount(prefix: string, router: PerfectWSSubRoute): this {
        this._validateMount(prefix, router);
        router._parent = this;
        this._mounts.push({ prefix, router });
        if (this._protocol) router.__connect(this._protocol, this._getFullMethod(prefix));
        return this;
    }

    private _validateMount(prefix: string, router: PerfectWSSubRoute): void {
        if (typeof prefix !== 'string' || !(router instanceof PerfectWSSubRoute)) {
            throw new PerfectWSError('mount() requires a string prefix and a router created by PerfectWS.Router()', 'invalidMount');
        }
        if (router._protocol || router._parent) {
            throw new PerfectWSError('This router is already mounted', 'routerAlreadyMounted');
        }
        for (let parent: PerfectWSSubRoute | null = this; parent; parent = parent._parent) {
            if (parent === router) {
                throw new PerfectWSError('A router cannot be mounted inside itself or one of its descendants', 'circularRouterMount');
            }
        }
    }

    private _getFullMethod(method: string): string {
        return this._fullPrefix + method;
    }

    private _getMiddleware(): WSListenCallback[] {
        return (this._parent?._getMiddleware() ?? []).concat(this._middleware);
    }

    /** @internal */
    public __connect(protocol: PerfectWS<any, any>, fullPrefix = ''): void {
        if (this._protocol) {
            throw new PerfectWSError('This router is already mounted', 'routerAlreadyMounted');
        }
        this._protocol = protocol;
        this._fullPrefix = fullPrefix;

        for (const [method, { callbacks }] of this._listenForRequests) {
            protocol.__registerSubRoute(this._getFullMethod(method), callbacks, () => this._getMiddleware(), this);
        }

        for (const { prefix, router } of this._mounts) {
            router.__connect(protocol, this._getFullMethod(prefix));
        }
    }
}
