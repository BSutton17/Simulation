/**
 * Worker entry point.
 *
 * Plain JavaScript on purpose. `new Worker()` cannot be handed a TypeScript
 * file directly: Node filters `--import` out of a worker's `execArgv`, so the
 * tsx loader the parent process is running under is NOT inherited, and the
 * worker fails to resolve the `.js` specifiers our TypeScript sources use.
 * Registering the loader here, before importing anything typed, is what makes
 * `npm run sim` and the test suite able to spawn workers from source.
 *
 * When running compiled output the pool loads `worker.js` directly and this
 * file is not involved.
 */
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");
