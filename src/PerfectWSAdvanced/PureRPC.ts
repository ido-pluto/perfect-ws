/** Marks an object whose properties and methods should remain live across the RPC boundary. */
export class PureRPC<T extends object = object> {
    constructor(public root?: T) {
        if (root !== undefined && (root === null || typeof root !== 'object' && typeof root !== 'function')) {
            throw new TypeError('PureRPC can only wrap an object or function');
        }
    }
}
