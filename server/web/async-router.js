'use strict';

/**
 * Express 4 ignores a rejected promise, so an async handler's error would never reach the error
 * handler (the request would hang). A router made here wraps every handler it is given: a returned
 * promise that rejects is passed to next(err). Error handlers (four arguments) are left as they are.
 *
 *   const r = asyncRouter(express.Router());
 *   r.get('/x', async (req, res) => { res.json(await something()); });
 */
const METHODS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'use'];

function catching(fn) {
    if (typeof fn !== 'function' || fn.length >= 4) return fn;
    return function asyncHandler(req, res, next) {
        let out;
        try { out = fn(req, res, next); } catch (e) { return next(e); }
        if (out && typeof out.then === 'function') out.then(undefined, next);
        return undefined;
    };
}

function asyncRouter(router) {
    for (const m of METHODS) {
        const orig = router[m].bind(router);
        router[m] = (...args) => orig(...args.map((a) => (Array.isArray(a) ? a.map(catching) : catching(a))));
    }
    return router;
}

module.exports = { asyncRouter, catching };
