import express from 'express';

const METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete'];

/** Forward a rejected promise to next(), the way Express 5 does natively. */
function wrap(handler) {
  if (typeof handler !== 'function' || handler.length === 4) return handler; // error handlers keep their arity
  return function asyncSafe(req, res, next) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
      return result;
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * An express.Router whose handlers may be async. Express 4 ignores the promise
 * a handler returns, so one rejected query became an unhandledRejection and
 * Node took the whole backend down with it. Here it reaches the app's error
 * handler and costs one 500.
 */
export function Router(options) {
  const router = express.Router(options);
  for (const method of METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
}
