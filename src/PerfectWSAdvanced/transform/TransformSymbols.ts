import { transformReceivedLookBackRecursive, transformSendLookBackRecursive } from './utils/lookBackChangeType.js';
import { PureValueClone } from './utils/PureValueClone.js';
import { PerfectWSError } from '../../PerfectWSError.js';
import { createTransformMarker, isTransformMarker } from './utils/changeType.js';

export class TransformSymbols {
    constructor(private _maxDepth: number = 100, private _receivedGlobalSymbols = new Map<string, symbol>(), private _maxGlobalSymbols = 10_000) {
    }

    deserialize(data: any) {
        const decodeValue = (value: any): { found: boolean; value?: any; } => {
            if (isTransformMarker(value, 'undefined')) return { found: true, value: undefined };
            if (!isTransformMarker(value, 'symbolValue')) return { found: false };

            if (value.kind === 'wellKnown' && typeof value.key === 'string') {
                const symbol = (Symbol as unknown as Record<string, unknown>)[value.key];
                return typeof symbol === 'symbol' ? { found: true, value: symbol } : { found: false };
            }
            if (value.kind === 'global' && typeof value.key === 'string') {
                let symbol = this._receivedGlobalSymbols.get(value.key);
                if (symbol === undefined && this._receivedGlobalSymbols.size < this._maxGlobalSymbols) {
                    symbol = Symbol.for(value.key);
                    this._receivedGlobalSymbols.set(value.key, symbol);
                }
                if (symbol === undefined) {
                    throw new PerfectWSError('Global symbol limit reached', 'symbolLimit');
                }
                return { found: true, value: symbol };
            }
            return { found: false };
        };

        const rootValue = decodeValue(data);
        if (rootValue.found) return rootValue.value;

        return transformReceivedLookBackRecursive(data, {
            maxDepth: this._maxDepth,
            transformData: (data, key, parent) => {
                if (isTransformMarker(data, 'symbol') && (data.symbolKey === undefined || typeof data.symbolKey === 'string')) {
                    const symbolKey = data.symbolKey ?? key.toString();
                    let symbol = this._receivedGlobalSymbols.get(symbolKey);
                    if (symbol === undefined && this._receivedGlobalSymbols.size < this._maxGlobalSymbols) {
                        symbol = Symbol.for(symbolKey);
                        this._receivedGlobalSymbols.set(symbolKey, symbol);
                    }
                    if (symbol === undefined) {
                        throw new PerfectWSError('Global symbol limit reached', 'symbolLimit');
                    }
                    delete parent[key];
                    parent[symbol] = data.value;
                    return true;
                }

                const decoded = decodeValue(data);
                if (decoded.found) {
                    parent[key] = decoded.value;
                    return true;
                }

                return false;
            }
        });
    }

    serialize(pureValueClone: PureValueClone) {
        const encodeValue = (value: any) => {
            if (value === undefined) return createTransformMarker('undefined', {});
            if (typeof value !== 'symbol') return undefined;

            const globalKey = Symbol.keyFor(value);
            if (globalKey !== undefined) {
                return createTransformMarker('symbolValue', { kind: 'global', key: globalKey });
            }
            for (const key of Object.getOwnPropertyNames(Symbol)) {
                if ((Symbol as unknown as Record<string, unknown>)[key] === value) {
                    return createTransformMarker('symbolValue', { kind: 'wellKnown', key });
                }
            }
            return undefined;
        };

        const encodedRoot = encodeValue(pureValueClone.cloneRoot.root);
        if (encodedRoot !== undefined) {
            pureValueClone.cloneRoot.root = pureValueClone.own(encodedRoot);
            return;
        }

        return transformSendLookBackRecursive(pureValueClone, {
            maxDepth: this._maxDepth,
            transformData: (current, key, parent) => {
                if (typeof key !== 'symbol') {
                    const encodedValue = encodeValue(current[key]);
                    if (encodedValue === undefined) return false;
                    parent[key] = pureValueClone.own(encodedValue);
                    return encodedValue;
                }

                const symbolKey = Symbol.keyFor(key);
                if (symbolKey === undefined) {
                    return false;
                }

                const value = Object.hasOwn(parent, key) ? parent[key] : current[key];
                delete parent[key];

                let wireKey = '___symbol';
                while (Object.hasOwn(parent, wireKey)) {
                    wireKey += '_';
                }

                return parent[wireKey] = createTransformMarker('symbol', {
                    symbolKey,
                    value
                });
            }
        });
    }

    releaseAll(): void {
    }
}
