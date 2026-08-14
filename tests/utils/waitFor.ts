export async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 1000) {
    const start = Date.now();

    // Must await: an un-awaited async predicate is a Promise object, which is always
    // truthy, so `!predicate()` would be permanently false and the loop would exit on
    // the very first check regardless of what the predicate actually resolves to.
    while (!(await predicate())) {
        if (Date.now() - start > timeout) {
            throw new Error('Timed out waiting for condition');
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}