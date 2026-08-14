
import { randomUUID } from '../../utils/randomUUID.js';

export function generateRemoteId(type: 'client' | 'server') {
    const random = randomUUID().replace(/-/g, '');
    return `${type}-${ typeof navigator !== 'undefined' ? navigator.platform : 'unknown' }-${ random }`;
}