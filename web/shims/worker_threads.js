// The browser build runs in one Web Worker already; webcrack's large-stack retry is skipped.
module.exports = { isMainThread: true, workerData: null, Worker: class { constructor() { throw new Error('nested workers are not available in the browser build'); } } };
