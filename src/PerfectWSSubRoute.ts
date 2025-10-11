import { WSListenCallback, PerfectWS } from "./PerfectWS.js";
import { PerfectWSError } from "./PerfectWSError.js";

export class PerfectWSSubRoute {
    public _listenForRequests = new Map<string, { method: string; callbacks: WSListenCallback[] }>();
    private _protocol: PerfectWS<any> | null = null;
    private _routesToConnect: [string, WSListenCallback[]][] = [];
    private _routersToConnect: PerfectWSSubRoute[] = [];
    private _prefix: string = '';
    private _parentPrefix: string = '';
    private _middleware: WSListenCallback[] = [];
    private _parentConnected = false;

    constructor(prefix: string = '') {
        this._prefix = prefix;
    }

    on(method: string, ...callbacks: WSListenCallback[]) {
        this._listenForRequests.set(method, { method, callbacks });
        if (this._protocol) {
            this._protocol.on(this._getFullPrefix(method), ...this._middleware.concat(callbacks));
        } else {
            this._routesToConnect.push([method, callbacks]);
        }
    }

    off(method: string) {
        this._listenForRequests.delete(method);
        if (this._protocol) {
            this._protocol.off(method);
        }
    }

    use(...routers: (PerfectWSSubRoute | WSListenCallback)[]): void {
        for (const router of routers) {
            if (router instanceof PerfectWSSubRoute) {
                this._routersToConnect.push(router);
            } else {
                this._middleware.push(router);
            }
        }
    }

    private _getFullPrefix(method: string = '') {
        return this._parentPrefix + this._prefix + method;
    }

    /**
     * @internal
     */
    __connect(protocol: PerfectWS<any, any>) {
        this._protocol = protocol;

        for (const [method, callbacks] of this._routesToConnect) {
            this._protocol.on(this._getFullPrefix(method), ...this._middleware.concat(callbacks));
        }

        this._routesToConnect.length = 0;

        for (const router of this._routersToConnect) {
            if(router._parentConnected){
                throw new PerfectWSError('This subroute is already connected to a parent subroute', 'subrouteAlreadyConnected');
            }

            router._parentPrefix = this._getFullPrefix();
            router._middleware = this._middleware.concat(router._middleware);
            router._parentConnected = true;
            router.__connect(protocol);
        }

        this._routersToConnect.length = 0;
    }
}