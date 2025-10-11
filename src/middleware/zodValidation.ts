import type { WSListenCallback } from '../PerfectWS.js';
import { PerfectWSError } from '../PerfectWSError.js';

type ZodSchema = {
    safeParse(data: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ path: Array<string | number>; message: string; }>; }; };
};

export interface ValidationOptions {
    stripUnknown?: boolean;
    abortEarly?: boolean;
    customErrorMessage?: string;
    errorCode?: string;
}

export function validateWithZod(
    schema: ZodSchema,
    options: ValidationOptions = {}
): WSListenCallback {
    const {
        stripUnknown = false,
        abortEarly = true,
        customErrorMessage,
        errorCode = 'validationError'
    } = options;

    return (data: any) => {
        const result = schema.safeParse(data);

        if (!result.success) {
            const errors = result.error?.issues || [];

            let errorMessage: string;

            if (customErrorMessage) {
                errorMessage = customErrorMessage;
            } else if (abortEarly && errors.length > 0) {
                const firstError = errors[0];
                const path = firstError.path.join('.');
                errorMessage = path ? `${path}: ${firstError.message}` : firstError.message;
            } else {
                errorMessage = errors
                    .map(err => {
                        const path = err.path.join('.');
                        return path ? `${path}: ${err.message}` : err.message;
                    })
                    .join(', ');
            }

            throw new PerfectWSError(errorMessage, errorCode);
        }

        if (stripUnknown && result.data) {
            for (const key in data) {
                delete data[key];
            }
            Object.assign(data, result.data);
        }
    };
}

