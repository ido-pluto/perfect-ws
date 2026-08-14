const forbiddenKeys = new Set([
	'__proto__',
	'prototype',
	'constructor',
]);

export function isForbiddenPropertyKey(key: PropertyKey): boolean {
	return typeof key === 'string' && forbiddenKeys.has(key);
}

export function isPrimitivePropertyKey(key: unknown): key is PropertyKey {
	return typeof key === 'string' || typeof key === 'symbol';
}

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
	return value !== null && (
		typeof value === 'object' ||
		typeof value === 'function'
	);
}

export function encodePathKey(key: string | symbol): string | null {
	if (typeof key === 'symbol') {
		const registered = Symbol.keyFor(key);
		return registered === undefined ? null : '!' + escapeSegment(registered);
	}

	return escapeSegment(key);
}

function escapeSegment(key: string) {
	return key.replace(/[\\.!]/g, match => '\\' + match);
}

function splitPath(path: string): string[] {
	const segments: string[] = [];
	let current = '';

	for (let i = 0; i < path.length; i++) {
		const char = path[i];

		if (char === '\\' && i + 1 < path.length) {
			current += char + path[i + 1];
			i++;
			continue;
		}

		if (char === '.') {
			segments.push(current);
			current = '';
			continue;
		}

		current += char;
	}

	segments.push(current);
	return segments;
}

export function decodePathKey(segment: string, globalSymbols?: Map<string, symbol>): string | symbol | undefined {
	const isSymbol = segment.startsWith('!');
	const key = (isSymbol ? segment.slice(1) : segment).replace(/\\(.)/g, '$1');

	return isSymbol ? globalSymbols?.get(key) : key;
}

export function getProperty(
	object: unknown,
	path: string,
	globalSymbols?: Map<string, symbol>,
): unknown {
	let current: unknown = object;

	for (const segment of splitPath(path)) {
		if (!isObjectLike(current)) {
			return undefined;
		}

		const propertyKey = decodePathKey(segment, globalSymbols);
		if (propertyKey === undefined) return undefined;
		if (isForbiddenPropertyKey(propertyKey)) {
			return undefined;
		}

		if (!Object.hasOwn(current, propertyKey)) {
			return undefined;
		}

		current = current[propertyKey];
	}

	return current;
}
