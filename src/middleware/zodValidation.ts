import { PerfectWSError } from '../PerfectWSError.js';
import { replaceRequestData, type WSDataMiddleware } from './dataMiddleware.js';

type ZodSchema = {
    safeParse(data: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string; }>; }; };
};

type ZodOutput<Schema extends ZodSchema> =
    Extract<ReturnType<Schema['safeParse']>, { success: true; }> extends { data: infer Output; }
        ? Output
        : ReturnType<Schema['safeParse']> extends { data?: infer Output; }
            ? Exclude<Output, undefined>
            : never;

export interface ValidationOptions {
    stripUnknown?: boolean;
    abortEarly?: boolean;
    customErrorMessage?: string;
    errorCode?: string;
}

export function validateWithZod<Schema extends ZodSchema>(
    schema: Schema,
    options: ValidationOptions = {}
): WSDataMiddleware<ZodOutput<Schema>> {
    const {
        stripUnknown = false,
        abortEarly = true,
        customErrorMessage,
        errorCode = 'validationError'
    } = options;

    return ((data: any) => {
        const result = schema.safeParse(data);

        if (!result.success) {
            const errors = result.error?.issues || [];

            let errorMessage: string;

            if (customErrorMessage) {
                errorMessage = customErrorMessage;
            } else if (abortEarly && errors.length > 0) {
                const firstError = errors[0];
                const path = firstError.path.map(String).join('.');
                errorMessage = path ? `${path}: ${firstError.message}` : firstError.message;
            } else {
                errorMessage = errors
                    .map(err => {
                        const path = err.path.map(String).join('.');
                        return path ? `${path}: ${err.message}` : err.message;
                    })
                    .join(', ');
            }

            throw new PerfectWSError(errorMessage, errorCode);
        }

        const parsedData = mergeParsedData(data, result.data, stripUnknown);
        return replaceRequestData(parsedData);
    }) as unknown as WSDataMiddleware<ZodOutput<Schema>>;
}

function mergeParsedData(input: unknown, parsed: unknown, stripUnknown: boolean): unknown {
    if (!isPlainRecord(input) || !isPlainRecord(parsed)) return parsed;

    if (stripUnknown) {
        for (const key of Object.keys(input)) delete input[key];
    }

    // Avoid Object.assign here: special own keys could reassign the target's
    // prototype or shadow language-level properties used by application code.
    for (const key of Object.keys(parsed)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        input[key] = parsed[key];
    }
    return input;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
