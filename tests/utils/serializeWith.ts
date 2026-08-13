import { PureValueClone } from '../../src/PerfectWSAdvanced/transform/utils/PureValueClone.js';

/**
 * Individual transforms no longer take a value - they write into the shared clone tree that
 * `TransformAll` threads through every pass. This runs one transform the way `TransformAll`
 * would and hands back the resulting tree, so tests can keep asserting on a plain value.
 */
export function serializeWith(transform: { serialize(pureValueClone: PureValueClone): unknown; }, data: any) {
    const pureValueClone = new PureValueClone(data);
    transform.serialize(pureValueClone);
    return pureValueClone.cloneRoot.root;
}
