import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EvaluationTier } from "../search/index.js";
import type { ExperimentIdentity, JobRecord, ResultRecord } from "./protocol.js";

/**
 * The only place that talks to Supabase.
 *
 * Two roles share this client, with deliberately different privileges. Workers
 * hold the PUBLISHABLE key: row-level security stops them writing to any table,
 * and every mutation they need goes through a SECURITY DEFINER function that
 * validates its own inputs. A leaked worker key lets someone claim and answer
 * jobs; it cannot delete a run or rewrite a result.
 *
 * The coordinator holds the SECRET key because it inserts experiments and jobs,
 * and those grants are withheld from `anon` on purpose — anything holding a
 * worker key could otherwise start or reshape a run. Exactly one process ever
 * uses that key, and it never goes near a worker notebook.
 */

export type ClientRole = "coordinator" | "worker";

export interface ClientOptions {
  url?: string;
  key?: string;
  role: ClientRole;
}

/**
 * Reads credentials from the environment.
 *
 * The same variable names come from a local `.env` and from Kaggle Secrets, so
 * nothing differs between a development machine and a notebook. Nothing is ever
 * printed: the error paths name the variable, never the value.
 */
export function credentialsFor(role: ClientRole): { url: string; key: string } {
  const url = process.env.SUPABASE_URL?.trim();
  if (!url) {
    throw new Error("SUPABASE_URL is not set (local: .env, Kaggle: Add-ons -> Secrets)");
  }

  const publishable = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();

  if (role === "worker") {
    if (!publishable) throw new Error("SUPABASE_PUBLISHABLE_KEY is not set");
    // A worker must never run with elevated privileges, even if the secret is
    // present in the environment by accident.
    return { url, key: publishable };
  }

  if (!secret) {
    throw new Error(
      "SUPABASE_SECRET_KEY is not set. The coordinator needs it to create " +
        "experiments and publish jobs; those grants are deliberately withheld " +
        "from the publishable key.",
    );
  }
  return { url, key: secret };
}

export class QueueClient {
  private readonly db: SupabaseClient;
  readonly role: ClientRole;

  constructor(options: ClientOptions) {
    const fallback = options.url && options.key
      ? { url: options.url, key: options.key }
      : credentialsFor(options.role);
    this.role = options.role;
    this.db = createClient(fallback.url, fallback.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** Fails with the Supabase message but never echoes the request, which can
   *  carry the key in a header. */
  private static fail(operation: string, error: { message: string } | null): never {
    throw new Error(`supabase ${operation} failed: ${error?.message ?? "unknown error"}`);
  }

  // --- coordinator only -----------------------------------------------------

  /** Creates the experiment row, or returns the existing one by name so a
   *  coordinator restart rejoins its run instead of forking a new one. */
  async ensureExperiment(
    name: string,
    identity: ExperimentIdentity,
    generationsTarget: number,
  ): Promise<{ id: string; currentGeneration: number }> {
    const existing = await this.db
      .from("experiments").select("id, current_generation").eq("name", name).maybeSingle();
    if (existing.error) QueueClient.fail("select experiment", existing.error);
    if (existing.data) {
      return { id: existing.data.id as string, currentGeneration: existing.data.current_generation as number };
    }

    const created = await this.db.from("experiments").insert({
      name,
      engine_sha: identity.engineSha,
      schema_version: identity.schemaVersion,
      catalog_hash: identity.catalogHash,
      seed: identity.seed,
      population_size: identity.populationSize,
      sigma: identity.sigma,
      scope: identity.scope,
      fitness_version: identity.fitnessVersion,
      weights_name: identity.weightsName,
      generations_target: generationsTarget,
    }).select("id, current_generation").single();
    if (created.error) QueueClient.fail("insert experiment", created.error);
    return { id: created.data.id as string, currentGeneration: created.data.current_generation as number };
  }

  /**
   * Publishes a generation's jobs.
   *
   * `ignoreDuplicates` leans on the table's uniqueness constraint so a
   * coordinator that restarts mid-generation re-publishes harmlessly rather
   * than creating a second copy of the population.
   */
  async publishJobs(jobs: Omit<JobRecord, "id">[]): Promise<void> {
    if (jobs.length === 0) return;
    const { error } = await this.db.from("jobs").upsert(
      jobs.map((j) => ({
        experiment_id: j.experimentId,
        generation_number: j.generationNumber,
        candidate_index: j.candidateIndex,
        candidate_id: j.candidateId,
        candidate_hash: j.candidateHash,
        tier: j.tier,
        parameters: j.parameters,
      })),
      { onConflict: "experiment_id,generation_number,candidate_index,tier", ignoreDuplicates: true },
    );
    if (error) QueueClient.fail("publish jobs", error);
  }

  async setCurrentGeneration(experimentId: string, generation: number): Promise<void> {
    const { error } = await this.db.from("experiments")
      .update({ current_generation: generation, updated_at: new Date().toISOString() })
      .eq("id", experimentId);
    if (error) QueueClient.fail("update generation", error);
  }

  // --- both -----------------------------------------------------------------

  async experimentIdentity(experimentId: string): Promise<ExperimentIdentity> {
    const { data, error } = await this.db.from("experiments")
      .select("engine_sha, schema_version, catalog_hash, seed, population_size, sigma, scope, fitness_version, weights_name")
      .eq("id", experimentId).single();
    if (error) QueueClient.fail("read experiment", error);
    return {
      engineSha: data.engine_sha, schemaVersion: data.schema_version,
      catalogHash: data.catalog_hash, seed: data.seed,
      populationSize: data.population_size, sigma: data.sigma, scope: data.scope,
      fitnessVersion: data.fitness_version, weightsName: data.weights_name,
    };
  }

  /** Which generation the coordinator is currently running. Workers ask for
   *  work in this generation and nowhere else. */
  async currentGeneration(experimentId: string): Promise<number> {
    const { data, error } = await this.db.from("experiments")
      .select("current_generation").eq("id", experimentId).single();
    if (error) QueueClient.fail("read current generation", error);
    return (data?.current_generation as number) ?? 0;
  }

  async resultsFor(experimentId: string, generation: number): Promise<ResultRecord[]> {
    const { data, error } = await this.db.from("results")
      .select("job_id, generation_number, candidate_index, candidate_hash, fitness, failure, duration_ms, matches")
      .eq("experiment_id", experimentId).eq("generation_number", generation);
    if (error) QueueClient.fail("read results", error);
    return (data ?? []).map((r) => ({
      jobId: r.job_id, generationNumber: r.generation_number,
      candidateIndex: r.candidate_index, candidateHash: r.candidate_hash,
      fitness: r.fitness, failure: r.failure,
      durationMs: r.duration_ms ?? 0, matches: r.matches ?? 0,
    }));
  }

  async progress(experimentId: string, generation: number): Promise<{
    total: number; pending: number; running: number; complete: number; failed: number;
  }> {
    const { data, error } = await this.db.rpc("generation_progress", {
      p_experiment_id: experimentId, p_generation: generation,
    });
    if (error) QueueClient.fail("generation_progress", error);
    const row = Array.isArray(data) ? data[0] : data;
    return {
      total: Number(row?.total ?? 0), pending: Number(row?.pending ?? 0),
      running: Number(row?.running ?? 0), complete: Number(row?.complete ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  async activeWorkers(experimentId: string, withinSeconds = 300): Promise<number> {
    const cutoff = new Date(Date.now() - withinSeconds * 1000).toISOString();
    const { count, error } = await this.db.from("workers")
      .select("worker_id", { count: "exact", head: true })
      .eq("experiment_id", experimentId).gte("last_heartbeat", cutoff);
    if (error) QueueClient.fail("count workers", error);
    return count ?? 0;
  }

  // --- worker only ----------------------------------------------------------

  async registerWorker(workerId: string, experimentId: string): Promise<void> {
    const { error } = await this.db.rpc("register_worker", {
      p_worker_id: workerId, p_experiment_id: experimentId,
    });
    if (error) QueueClient.fail("register_worker", error);
  }

  /**
   * Claims one job, or returns null when the generation has none left.
   *
   * The atomicity lives in the database function, not here: it uses
   * FOR UPDATE SKIP LOCKED so two workers polling simultaneously cannot both
   * take the same row. With a dozen workers that is the normal case, not a
   * rare race, so a SELECT-then-UPDATE here would hand out duplicates
   * constantly.
   */
  async claimJob(experimentId: string, generation: number, workerId: string, leaseMinutes = 30):
      Promise<JobRecord | null> {
    const { data, error } = await this.db.rpc("claim_job", {
      p_experiment_id: experimentId, p_generation: generation,
      p_worker_id: workerId, p_lease_minutes: leaseMinutes,
    });
    if (error) QueueClient.fail("claim_job", error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id) return null;
    return {
      id: row.id, experimentId: row.experiment_id,
      generationNumber: row.generation_number, candidateIndex: row.candidate_index,
      candidateId: row.candidate_id, candidateHash: row.candidate_hash,
      tier: row.tier as EvaluationTier, parameters: row.parameters,
    };
  }

  /** Returns false when the job was already answered — expected after a
   *  reclaim, and not an error. */
  async submitResult(job: JobRecord, workerId: string, payload: {
    fitness: unknown | null; failure: string | null; durationMs: number; matches: number;
  }): Promise<boolean> {
    const { data, error } = await this.db.rpc("submit_result", {
      p_job_id: job.id, p_worker_id: workerId, p_candidate_hash: job.candidateHash,
      p_fitness: payload.fitness, p_failure: payload.failure,
      p_duration_ms: payload.durationMs, p_matches: payload.matches,
    });
    if (error) QueueClient.fail("submit_result", error);
    return data === true;
  }

  async renewLease(jobId: string, workerId: string, leaseMinutes = 30): Promise<boolean> {
    const { data, error } = await this.db.rpc("renew_lease", {
      p_job_id: jobId, p_worker_id: workerId, p_lease_minutes: leaseMinutes,
    });
    if (error) QueueClient.fail("renew_lease", error);
    return data === true;
  }
}
