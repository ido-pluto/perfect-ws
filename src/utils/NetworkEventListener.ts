import { EventEmitter, type EventMap } from "./EventEmitter.js";

type EventSource = 'local' | 'remote';
export class NetworkEventListener<Events extends EventMap = EventMap> extends EventEmitter<Events, [source: EventSource]> {
    /**
     * @internal
     */
    public _emitWithSource<K extends Extract<keyof Events, string>>(event: K, source: EventSource, ...args: Events[K]): void;
    /** @internal */
    public _emitWithSource(event: string, source: EventSource, ...args: any[]): void;
    /** @internal */
    public _emitWithSource(event: string, source: EventSource, ...args: any[]): void {
        this.dispatch(event, args, [source]);
    }

    /**
     * Emit an event, invoking all registered listeners for the event and any general listeners.
     */
    public override emit<K extends Extract<keyof Events, string>>(event: K, ...args: Events[K]): void;
    public override emit(event: string, ...args: any[]): void;
    public override emit(event: string, ...args: any[]): void {
        this._emitWithSource(event, 'local', ...args);
    }
}
