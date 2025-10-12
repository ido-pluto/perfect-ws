type BinaryType = 'blob' | 'arraybuffer';
type BinaryTypeWSPackage = 'nodebuffer' | 'arraybuffer' | 'fragments';
type EventListenerOptions = boolean | { capture?: boolean; };
type AddEventListenerOptions = EventListenerOptions & { once?: boolean, passive?: boolean; };
type EventListenerOrEventListenerObject = (evt: MessageEvent) => unknown;

export interface MessageEvent<T = any> extends Event {
    readonly data: T;
}

type CloseEventInit = EventInit & {
    code?: number;
    reason?: string;
    wasClean?: boolean;
}

class CloseEvent extends Event {

    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;

    constructor(type: string, init: CloseEventInit) {
        super(type, init);
        this.code = init.code ?? 1000;
        this.reason = init.reason ?? '';
        this.wasClean = init.wasClean ?? true;
    }
}

interface WebSocketForceEventMap {
    close: CloseEvent;
    error: Event;
    message: MessageEvent;
    open: Event;
}


export interface WSLike {
    url: string;
    protocol: string;
    extensions: string;
    binaryType: BinaryType | BinaryTypeWSPackage;
    bufferedAmount: number;
    readyState: number;
    dispatchEvent?(event: Event): boolean;
    emit?(event: string, ...args: any[]): boolean;
    close(code?: number, reason?: string): void;
    send(data: string | ArrayBufferLike): void;
    addEventListener(type: string, listener: any, options?: any): void;
    removeEventListener(type: string, listener: any, options?: any): void;
    onopen?: ((ev: any) => any) | null;
    onclose?: ((ev: any) => any) | null;
    onerror?: ((ev: any) => any) | null;
    onmessage?: ((ev: any) => any) | null;
}

export class WebSocketForce<WSType extends WSLike = WSLike> {
    private _ws: WSType;
    private _closeListeners: Set<Function> = new Set();
    private _forceClosed: boolean = false;
    private _virtualCloseListeners: Array<{ listener: Function; once?: boolean; }> = [];
    private _nativeCloseHandler: ((event: any) => void) | null = null;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    constructor(ws: WSType) {
        this._ws = ws;
    }

    private _registerNativeCloseHandler(): void {
        if (this._nativeCloseHandler !== null) {
            return;
        }

        this._nativeCloseHandler = (event: any) => {
            this._triggerVirtualCloseListeners(event);
        };

        this._ws.addEventListener('close', this._nativeCloseHandler as any);
    }

    private _unregisterNativeCloseHandler(): void {
        if (this._nativeCloseHandler !== null) {
            this._ws.removeEventListener('close', this._nativeCloseHandler as any);
            this._nativeCloseHandler = null;
        }
    }

    private _triggerVirtualCloseListeners(event?: any): void {
        const closeEvent = event || new CloseEvent('close', {
            code: 1000,
            reason: '',
            wasClean: !this._forceClosed
        });

        const listenersToRemove: Function[] = [];

        for (const entry of this._virtualCloseListeners) {
            try {
                entry.listener.call(this._ws, closeEvent);
                if (entry.once) {
                    listenersToRemove.push(entry.listener);
                }
            } catch (error) {
                console.error('Error in virtual close listener:', error);
            }
        }

        for (const listener of listenersToRemove) {
            this._closeListeners.delete(listener);
            const index = this._virtualCloseListeners.findIndex(e => e.listener === listener);
            if (index > -1) {
                this._virtualCloseListeners.splice(index, 1);
            }
        }
    }

    get url(): string {
        return this._ws.url;
    }

    get readyState(): number {
        if (this._forceClosed) {
            return this.CLOSED;
        }
        return this._ws.readyState;
    }

    get bufferedAmount(): number {
        return this._ws.bufferedAmount;
    }

    get extensions(): string {
        return this._ws.extensions;
    }

    get protocol(): string {
        return this._ws.protocol;
    }

    get binaryType() {
        return this._ws.binaryType;
    }

    set binaryType(type) {
        this._ws.binaryType = type;
    }

    get onopen() {
        return this._ws.onopen;
    }

    set onopen(handler) {
        this._ws.onopen = handler;
    }

    get onclose() {
        return this._ws.onclose;
    }

    set onclose(handler) {
        if (this._ws.onclose) {
            this._closeListeners.delete(this._ws.onclose);
        }
        if (handler) {
            this._closeListeners.add(handler);
        }
        this._ws.onclose = handler;
    }

    get onerror() {
        return this._ws.onerror;
    }

    set onerror(handler) {
        this._ws.onerror = handler;
    }

    get onmessage() {
        return this._ws.onmessage;
    }

    set onmessage(handler) {
        this._ws.onmessage = handler;
    }

    close(code?: number, reason?: string): void {
        this._ws.close(code, reason);
    }

    send(data: string | ArrayBufferLike): void {
        this._ws.send(data);
    }

    addEventListener<K extends keyof WebSocketForceEventMap>(
        type: K,
        listener: (this: WebSocketForce, ev: WebSocketForceEventMap[K]) => unknown,
        options?: boolean | AddEventListenerOptions
    ): void;
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ): void;
    addEventListener(type: string, listener: unknown, options?: unknown): void {
        if (type === 'close' && typeof listener === 'function') {
            this._closeListeners.add(listener);
            const once = typeof options === 'object' && options !== null && 'once' in options ? !!(options as any).once : false;
            this._virtualCloseListeners.push({ listener, once });

            if (this._virtualCloseListeners.length === 1) {
                this._registerNativeCloseHandler();
            }
            return;
        }
        this._ws.addEventListener(type as never, listener as never, options as never);
    }

    removeEventListener<K extends keyof WebSocketForceEventMap>(
        type: K,
        listener: (this: WebSocketForce, ev: WebSocketForceEventMap[K]) => unknown,
        options?: boolean | EventListenerOptions
    ): void;
    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
    ): void;
    removeEventListener(type: string, listener: unknown, options?: unknown): void {
        if (type === 'close' && typeof listener === 'function') {
            this._closeListeners.delete(listener);
            const index = this._virtualCloseListeners.findIndex(e => e.listener === listener);
            if (index > -1) {
                this._virtualCloseListeners.splice(index, 1);
            }

            if (this._virtualCloseListeners.length === 0) {
                this._unregisterNativeCloseHandler();
            }
            return;
        }
        this._ws.removeEventListener(type as never, listener as never, options as never);
    }

    dispatchEvent(event: Event): boolean {
        if (this._ws.dispatchEvent) {
            return this._ws.dispatchEvent(event);
        }

        if (this._ws.emit) {
            return this._ws.emit(event.type, event);
        }

        return false;
    }

    emit(event: string, ...args: any[]): boolean {
        if (this._ws.emit) {
            return this._ws.emit(event, ...args);
        }

        if (this._ws.dispatchEvent) {
            const evt = new Event(event);
            (evt as any).args = args;
            return this._ws.dispatchEvent(evt);
        }

        return false;
    }

    on<K extends keyof WebSocketForceEventMap>(type: K, listener: (this: WebSocketForce, ev: WebSocketForceEventMap[K]) => unknown): this;
    on(type: string, listener: EventListenerOrEventListenerObject): this;
    on(type: string, listener: unknown): this {
        this.addEventListener(type as never, listener as never);
        return this;
    }

    off<K extends keyof WebSocketForceEventMap>(type: K, listener: (this: WebSocketForce, ev: WebSocketForceEventMap[K]) => unknown): this;
    off(type: string, listener: EventListenerOrEventListenerObject): this;
    off(type: string, listener: unknown): this {
        this.removeEventListener(type as never, listener as never);
        return this;
    }

    once<K extends keyof WebSocketForceEventMap>(
        type: K
    ): Promise<WebSocketForceEventMap[K]>;
    once(type: string): Promise<Event> {
        if (type === 'close' && this.readyState === this.CLOSED) {
            const immediateCloseEvent: CloseEvent = new CloseEvent('close', { code: 1000, reason: '', wasClean: true });
            return Promise.resolve(immediateCloseEvent);
        }

        return new Promise((resolve) => {
            const handler = (ev: Event) => {
                this.removeEventListener(type, handler);
                resolve(ev);
            };
            this.addEventListener(type, handler, { once: true });
        });
    }

    forceClose(code: number = 1000, reason: string = 'Force closed'): void {
        if (this._forceClosed) {
            return;
        }

        this._forceClosed = true;

        try {
            const anyWs = this._ws as any;
            if (typeof anyWs.forceClose === 'function') {
                try { anyWs.forceClose(code, reason); } catch { }
            }
            this._ws.close(code, reason);
        } catch { }

        const closeEvent: CloseEvent = new CloseEvent('close', { code, reason, wasClean: false });
        this._triggerVirtualCloseListeners(closeEvent);
    }

    setMaxListeners(n: number): void {
        if ('setMaxListeners' in this._ws && typeof (this._ws as any).setMaxListeners === 'function') {
            (this._ws as any).setMaxListeners(n);
        }
    }
}
