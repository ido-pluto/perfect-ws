import { beforeAll } from "vitest";

beforeAll(() => {
    process.on('unhandledRejection', () => { });
});