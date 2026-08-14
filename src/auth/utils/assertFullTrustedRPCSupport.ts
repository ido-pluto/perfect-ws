import { PerfectWS } from '../../PerfectWS.js';
import { PerfectWSAdvanced } from '../../PerfectWSAdvanced/PerfectWSAdvanced.js';
import { PerfectWSError } from '../../PerfectWSError.js';

/**
 * Auth routers deliberately default to base PerfectWS. PureRPC must be an explicit capability
 * choice, so `fullTrustedRPC` is rejected unless the caller also selects PerfectWSAdvanced (or
 * a subclass) through `perfectWSConstructor`.
 */
export function assertFullTrustedRPCSupport(perfectWSConstructor: (typeof PerfectWS) | undefined, className: string): void {
    const Ctor = perfectWSConstructor ?? PerfectWS;

    if (Ctor !== PerfectWSAdvanced && !(Ctor.prototype instanceof PerfectWSAdvanced)) {
        throw new PerfectWSError(
            `${ className }: fullTrustedRPC requires PerfectWSAdvanced (or a subclass) - the provided perfectWSConstructor does not extend it`,
            'invalidConfiguration'
        );
    }
}
