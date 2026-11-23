export const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

export async function forEachInSlices(iterable, visit, {
    now = () => performance.now(), yieldTask: pause = yieldTask, budgetMs = 4, signal
} = {}) {
    let started = now();
    for (const item of iterable) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        visit(item);
        if (now() - started >= budgetMs) { await pause(); started = now(); }
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

export async function collectInSlices(iterable, options) {
    const output = [];
    await forEachInSlices(iterable,item=>output.push(item),options);
    return output;
}

export async function filterInSlices(items,predicate,options) {
    const output = [];
    await forEachInSlices(items,item=>{if (predicate(item)) output.push(item);},options);
    return output;
}
