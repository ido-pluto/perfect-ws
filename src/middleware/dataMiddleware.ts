import type { WSListenCallback } from '../PerfectWS.js';

declare const DATA_MIDDLEWARE_OUTPUT: unique symbol;
const requestDataReplacements = new WeakSet<object>();

/** A middleware whose parsed output becomes the input of the following route handlers. */
export type WSDataMiddleware<Output> = WSListenCallback & {
    readonly [DATA_MIDDLEWARE_OUTPUT]: Output;
};

type RequestDataReplacement<Output = unknown> = {
    readonly data: Output;
};

/** @internal */
export function replaceRequestData<Output>(data: Output): RequestDataReplacement<Output> {
    const replacement = { data };
    requestDataReplacements.add(replacement);
    return replacement;
}

/** @internal */
export function isRequestDataReplacement(value: unknown): value is RequestDataReplacement {
    return typeof value === 'object'
        && value !== null
        && requestDataReplacements.has(value);
}
