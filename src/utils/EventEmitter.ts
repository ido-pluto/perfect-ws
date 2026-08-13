export type EventMap = Record<string, any[]>;

type EventKey<Events extends EventMap> = Extract<keyof Events, string>;

type Listener<Args extends any[] = any[]> = (...args: Args) => void;

type EventListeners = Record<string, Listener[]>;

export class EventEmitter<Events extends EventMap = EventMap, PrefixArgs extends any[] = []> {
    private _listeners: EventListeners = {};
    private _anyListeners: Listener[] = [];

    /**
     * Register an event listener for a specific event.
     */
    public on<K extends EventKey<Events>>(event: K, listener: Listener<[...PrefixArgs, ...Events[K]]>): void;
    public on(event: string, listener: Listener): void;
    public on(event: string, listener: Listener): void {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(listener);
    }

    /**
     * Register an event listener for a specific event that will only be called once.
     */
    public once<K extends EventKey<Events>>(event: K, listener: Listener<[...PrefixArgs, ...Events[K]]>): void;
    public once(event: string, listener: Listener): void;
    public once(event: string, listener: Listener): void {
        const onceListener: Listener = (...args: any[]) => {
            this.off(event, onceListener);
            listener(...args);
        };
        this.on(event, onceListener);
    }

    /**
     * Register an event listener at the beginning of the listeners array.
     */
    public prependListener<K extends EventKey<Events>>(event: K, listener: Listener<[...PrefixArgs, ...Events[K]]>): void;
    public prependListener(event: string, listener: Listener): void;
    public prependListener(event: string, listener: Listener): void {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].unshift(listener);
    }

    /**
     * Register an event listener at the beginning that will only be called once.
     */
    public prependOnceListener<K extends EventKey<Events>>(event: K, listener: Listener<[...PrefixArgs, ...Events[K]]>): void;
    public prependOnceListener(event: string, listener: Listener): void;
    public prependOnceListener(event: string, listener: Listener): void {
        const onceListener: Listener = (...args: any[]) => {
            this.off(event, onceListener);
            listener(...args);
        };
        this.prependListener(event, onceListener);
    }

    /**
     * Unregister an event listener for a specific event.
     * @param event - The name of the event to stop listening to.
     * @param listener - The callback function to remove.
     */
    public off<K extends EventKey<Events>>(event: K, listener: Listener<[...PrefixArgs, ...Events[K]]>): void;
    public off(event: string, listener: Listener): void;
    public off(event: string, listener: Listener): void {
        if (!this._listeners[event]) return;

        this._listeners[event] = this._listeners[event].filter(
            (registeredListener) => registeredListener !== listener
        );
    }

    /**
     * Register a listener for any event.
     * @param listener - The callback function to invoke for any event.
     */
    public onAny<K extends EventKey<Events>>(listener: Listener<[...PrefixArgs, event: K, ...args: Events[K]]>): void;
    public onAny(listener: Listener<[...PrefixArgs, event: string, ...args: any[]]>): void;
    public onAny(listener: Listener): void {
        this._anyListeners.push(listener);
    }


    protected dispatch(event: string, eventArgs: any[], prefixArgs: any[] = []): void {
        if (this._listeners[event]) {
            this._listeners[event].forEach((listener) => listener(...prefixArgs, ...eventArgs));
        }

        this._anyListeners.forEach((listener) => listener(...prefixArgs, event, ...eventArgs));
    }

    /**
     * Emit an event, invoking all registered listeners for the event and any general listeners.
     */
    public emit<K extends EventKey<Events>>(event: K, ...args: Events[K]): void;
    public emit(event: string, ...args: any[]): void;
    public emit(event: string, ...args: any[]): void {
        this.dispatch(event, args);
    }

    /**
     * Unregister a listener for any event.
     */
    public offAny<K extends EventKey<Events>>(listener: Listener<[...PrefixArgs, event: K, ...args: Events[K]]>): void;
    public offAny(listener: Listener<[...PrefixArgs, event: string, ...args: any[]]>): void;
    public offAny(listener: Listener): void {
        this._anyListeners = this._anyListeners.filter(l => l !== listener);
    }

    /**
     * Remove all listeners for a specific event or all events.
     */
    public removeAllListeners<K extends EventKey<Events>>(event?: K | string): void {
        if (event) {
            delete this._listeners[event];
        } else {
            this._listeners = {};
            this._anyListeners = [];
        }
    }

    /**
     * Get the number of listeners for a specific event.
     */
    public listenerCount<K extends EventKey<Events>>(event: K | string): number {
        return this._listeners[event]?.length || 0;
    }

    /**
     * Get all event names that have listeners.
     */
    public eventNames(): string[] {
        return Object.keys(this._listeners).filter(event => this._listeners[event].length > 0);
    }

    /**
     * Get all listeners for a specific event.
     */
    public listeners<K extends EventKey<Events>>(event: K): Listener<[...PrefixArgs, ...Events[K]]>[];
    public listeners(event: string): Listener[];
    public listeners(event: string): Listener[] {
        return this._listeners[event] || [];
    }

    /**
     * Get all raw listeners for a specific event (including once wrappers).
     */
    public rawListeners<K extends EventKey<Events>>(event: K): Listener<[...PrefixArgs, ...Events[K]]>[];
    public rawListeners(event: string): Listener[];
    public rawListeners(event: string): Listener[] {
        return this.listeners(event);
    }
}