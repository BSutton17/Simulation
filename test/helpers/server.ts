import { spawn, type ChildProcess } from "node:child_process";

export interface RunningServer {
  child: ChildProcess;
  port: number;
  /** All stdout+stderr captured from the server so far. */
  output: () => string;
  /** Kills the server and resolves once it has exited. */
  stop: () => Promise<void>;
}

/**
 * Boots the real server (`src/index.ts`) in a child process with the given
 * environment and resolves once it logs that it is listening. Used to test
 * startup and end-to-end client-server communication against a live server.
 */
export function startServer(
  env: Record<string, string>,
  timeoutMs = 20_000,
): Promise<RunningServer> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });

  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));

  const port = Number(env.PORT);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not start in ${timeoutMs}ms:\n${out}`));
    }, timeoutMs);

    const poll = setInterval(() => {
      if (out.includes("Server listening")) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ child, port, output: () => out, stop: () => stop(child) });
      }
    }, 100);

    child.on("error", (e) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(e);
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill();
  });
}
