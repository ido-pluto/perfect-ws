export const INTERNAL_EVENTS = [
    '___request.finished',
    '___request.connected',
    '___request.disconnected',
    '___request.resourcesChanged',
    '___request.sendFailed',
    '___request.operationSettled',
    '___request.eventDelivered',
    '___session.release'
];

export const CAPACITY_EXEMPT_METHODS = new Set(['___syncRequests', '___hasRequest', '___ping']);
export const NOOP_REQUEST_CALLBACK = () => { };

export function isDurableControlEvent(content: any): boolean {
    const eventName = content?.event?.eventName;
    const message = content?.event?.args?.[0];
    return eventName === '___callback.release'
        || eventName === '___pureRPC.request' && message?.op === 'release'
        || eventName === '___abort'
        || eventName === '___request.release'
        || eventName === '___callback.request'
        || eventName === '___callback.response'
        || eventName === '___pureRPC.request'
        || eventName === '___pureRPC.response';
}

export function operationFailure(content: any, message: string, code = 'sendFailed') {
    const eventName = content?.event?.eventName;
    const operation = content?.event?.args?.[0];
    return {
        message,
        code,
        eventName,
        operationId: operation?.callId ?? operation?.requestId,
    };
}

export function operationIdentity(content: any) {
    const eventName = content?.event?.eventName;
    const operation = content?.event?.args?.[0];
    return { eventName, operationId: operation?.callId ?? operation?.requestId };
}
