const boundFunctions = new WeakMap<Function, WeakMap<object, Function>>();
const safeRemoteSetters = new WeakMap<Function, (value: unknown) => void>();

/** Returns one weakly cached wrapper for a function/receiver pair. */
export function bindFunction<T extends Function>(callback: T, receiver: object): T {
    let receivers = boundFunctions.get(callback);
    if (!receivers) {
        receivers = new WeakMap();
        boundFunctions.set(callback, receivers);
    }
    let bound = receivers.get(receiver);
    if (!bound) {
        const created = Function.prototype.bind.call(callback, receiver) as Function;
        bound = created;
        receivers.set(receiver, bound);
    }
    return bound! as T;
}

/** Keeps one rejection-consuming wrapper for each received remote setter. */
export function safeRemoteSetter(setter: Function): (value: unknown) => void {
    let safe = safeRemoteSetters.get(setter);
    if (!safe) {
        safe = (value: unknown) => {
            try {
                void Promise.resolve(Reflect.apply(setter, undefined, [value])).catch(() => { });
            } catch { }
        };
        safeRemoteSetters.set(setter, safe);
    }
    return safe;
}
