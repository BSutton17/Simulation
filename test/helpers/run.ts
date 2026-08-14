import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a TypeScript fixture in a fresh child process (Node + tsx loader) with a
 * controlled environment, and resolves once it exits. Passing `undefined` for an
 * env value unsets that variable so tests can exercise "not configured" paths.
 *
 * Using `node --import tsx` (not the `tsx` CLI) keeps everything in a single
 * process, so the returned handle maps directly to the running program.
 */
export function runFixture(
  file: string,
  env: Record<string, string | undefined> = {},
  timeoutMs = 20_000,
): Promise<RunResult> {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      cwd: process.cwd(),
      env: merged,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`fixture "${file}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
