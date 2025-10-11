type EventSource = 'local' | 'remote';
type Listener = (source: EventSource, ...args: any[]) => void;

type EventListeners = {
    [event: string]: Listener[];
};

export class NetworkEventListener {
    private _listeners: EventListeners = {};
    private _anyListeners: Listener[] = [];

    /**
     * Register an event listener for a specific event.
     */
    public on(event: string, listener: Listener): void {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(listener);
    }

    /**
     * Register an event listener for a specific event that will only be called once.
     */
    public once(event: string, listener: Listener): void {
        const onceListener = (source: EventSource, ...args: any[]) => {
            this.off(event, onceListener);
            listener(source, ...args);
        };
        this.on(event, onceListener);
    }

    /**
     * Register an event listener at the beginning of the listeners array.
     */
    public prependListener(event: string, listener: Listener): void {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].unshift(listener);
    }

    /**
     * Register an event listener at the beginning that will only be called once.
     */
    public prependOnceListener(event: string, listener: Listener): void {
        const onceListener = (source: EventSource, ...args: any[]) => {
            this.off(event, onceListener);
            listener(source, ...args);
        };
        this.prependListener(event, onceListener);
    }

    /**
     * Unregister an event listener for a specific event.
     * @param event - The name of the event to stop listening to.
     * @param listener - The callback function to remove.
     */
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
    public onAny(listener: Listener): void {
        this._anyListeners.push(listener);
    }

    /**
     * @internal
     */
    _emitWithSource(event: string, source: EventSource, ...args: any[]): void {
        // Call listeners for the specific event
        if (this._listeners[event]) {
            this._listeners[event].forEach((listener) => listener(source, ...args));
        }

        // Call any listeners
        this._anyListeners.forEach((listener) => listener(source, event, ...args));
    }


    /**
     * Emit an event, invoking all registered listeners for the event and any general listeners.
     */
    emit(event: string, ...args: any[]): void {
        this._emitWithSource(event, 'local', ...args);
    }

    /**
     * Unregister a listener for any event.
     */
    public offAny(listener: Listener): void {
        this._anyListeners = this._anyListeners.filter(l => l !== listener);
    }

    /**
     * Remove all listeners for a specific event or all events.
     */
    public removeAllListeners(event?: string): void {
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
    public listenerCount(event: string): number {
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
    public listeners(event: string): Listener[] {
        return this._listeners[event] || [];
    }

    /**
     * Get all raw listeners for a specific event (including once wrappers).
     */
    public rawListeners(event: string): Listener[] {
        return this.listeners(event);
    }
}
