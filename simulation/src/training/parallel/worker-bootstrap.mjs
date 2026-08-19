/**
 * Worker entry point for the NEAT match pool.
 *
 * Plain JavaScript on purpose, for the same reason as the balance pool's
 * bootstrap: `new Worker()` cannot be handed a TypeScript file, because Node
 * filters `--import` out of a worker's `execArgv`, so the tsx loader the parent
 * is running under is NOT inherited and the worker cannot resolve the `.js`
 * specifiers our TypeScript sources use. Registering the loader here, before
 * importing anything typed, is what lets `npm run neat:train` and the test
 * suite spawn workers straight from source.
 *
 * When running compiled output the pool loads `worker.js` directly and this
 * file is not involved.
 */
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
