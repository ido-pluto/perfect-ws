import { IncomingMessage } from "http";
import { WSLike } from "../../utils/WebSocketForce.js";

type PasswordValidationOptions = {
    password?: string | string[] | ((password: any, ws: WSLike, request?: IncomingMessage) => boolean | Promise<boolean>);
    forceSocket: WSLike;
    request?: IncomingMessage;
}

export async function validatePassword(password: any, { forceSocket, request, password: assertPassword }: PasswordValidationOptions) {
    if (typeof assertPassword === 'string') {
        return password === assertPassword;
    } else if (Array.isArray(assertPassword)) {
        return assertPassword.includes(password);
    } else if (typeof assertPassword === 'function') {
        return assertPassword(password, forceSocket, request);
    }

    return true;
}