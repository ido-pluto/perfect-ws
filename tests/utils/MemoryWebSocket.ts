export class MemoryWebSocket {
    public url = 'ws://memory';
    public protocol = '';
    public extensions = '';
    public binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
    public bufferedAmount = 0;
    public readyState = 1;
    public onopen: ((event: Event) => void) | null = null;
    public onclose: ((event: Event) => void) | null = null;
    public onerror: ((event: Event) => void) | null = null;
    public onmessage: ((event: MessageEvent) => void) | null = null;

    private _peer?: MemoryWebSocket;
    private _listeners = new Map<string, Set<(event: any) => void>>();

    connect(peer: MemoryWebSocket) {
        this._peer = peer;
    }

    addEventListener(type: string, listener: (event: any) => void) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, new Set());
        }

        this._listeners.get(type)?.add(listener);
    }

    removeEventListener(type: string, listener: (event: any) => void) {
        this._listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event: Event) {
        this._emit(event.type, event);
        return true;
    }

    send(data: string | ArrayBuffer) {
        if (this.readyState !== 1 || !this._peer) {
            throw new Error('Socket not open');
        }

        queueMicrotask(() => {
            this._peer?._emit('message', { type: 'message', data });
        });
    }

    close(code = 1000, reason = '') {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        queueMicrotask(() => {
            this._emit('close', { type: 'close', code, reason, wasClean: true });
            this._peer?._closeFromPeer(code, reason);
        });
    }

    private _closeFromPeer(code: number, reason: string) {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        this._emit('close', { type: 'close', code, reason, wasClean: true });
    }

    private _emit(type: string, event: any) {
        // Snapshot listeners before invoking, matching real EventTarget/EventEmitter
        // semantics: a listener added by another listener during this dispatch must
        // not be invoked for the event currently being dispatched.
        for (const listener of [...(this._listeners.get(type) ?? [])]) {
            listener(event);
        }

        const handler = this[`on${type}` as 'onopen' | 'onclose' | 'onerror' | 'onmessage'];
        handler?.(event);
    }
}