/**
 * Browser-safe PerfectWS entry point. Authentication hosts are intentionally
 * excluded because they depend on Node.js HTTP and WebSocket server APIs.
 */
export { PrototypeTransform } from './PerfectWSAdvanced/transform/BaseCustomTransformers/PrototypeTransform.js';
export { TransformInstruction } from './PerfectWSAdvanced/transform/CustomTransformers.js';
export { PerfectWS } from './PerfectWS.js';
export { PerfectWSAdvanced } from './PerfectWSAdvanced/PerfectWSAdvanced.js';
export { PureRPC } from './PerfectWSAdvanced/PureRPC.js';
export { PerfectWSError } from './PerfectWSError.js';
export { NetworkEventListener } from './utils/NetworkEventListener.js';
export { WebSocketForce } from './utils/WebSocketForce.js';

export { validateWithZod } from './middleware/zodValidation.js';
export type { ValidationOptions } from './middleware/zodValidation.js';
export type { WSDataMiddleware } from './middleware/dataMiddleware.js';

export type {
    WSListenCallback,
    WSCallbackOptions,
    WSListenCallbackSend,
    WSRequestOptions,
    WSErrorShape,
    PerfectWSConfig,
    WSClientOptions,
    WSClientResult,
    WSServerResult,
} from './PerfectWS.js';
export type { PerfectWSSubRoute as PerfectWSRouter } from './PerfectWSSubRoute.js';
export type { WSLike } from './utils/WebSocketForce.js';
