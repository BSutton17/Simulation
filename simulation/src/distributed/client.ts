import { gzipSync, gunzipSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SearchCheckpoint } from "../search/index.js";
import type { EvaluationTier } from "../search/index.js";
import { identityMismatches } from "./protocol.js";
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

/**
 * A transport the Realtime client is given and never uses.
 *
 * `createClient` builds a RealtimeClient eagerly in its constructor — there is
 * no option to skip it — and that constructor resolves a WebSocket:
 *
 *     result.transport = options?.transport ?? WebSocketFactory.getWebSocketConstructor()
 *
 * On Node 22+ the factory finds the global WebSocket and everything works. On
 * Node 20 there is no global WebSocket and it throws "Node.js detected but
 * native WebSocket not found", before a single query can run. That is why this
 * passed on a developer machine and failed on Kaggle, which runs Node 20.19.
 *
 * Supplying `transport` means the factory is never consulted. Nothing ever
 * constructs it, because this queue only uses PostgREST — `.from()` for tables
 * and `.rpc()` for the claim and submit functions — and never opens a channel
 * or subscribes to anything. If some future code did try to use Realtime, this
 * throws rather than silently connecting to nothing.
 *
 * Preferred over the alternatives: adding a `ws` dependency would pull a
 * package in purely to satisfy a code path we do not exercise, and pinning an
 * older supabase-js would trade a live bug for an unmaintained one.
 */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error(
      "Realtime is not available in this client: the distributed queue uses " +
        "PostgREST only. Supply a real WebSocket transport if you need channels.",
    );
  }
}

// Derived from createClient's own signature rather than imported from
// @supabase/realtime-js. That package is a transitive dependency we do not
// declare, and importing it directly would break the moment supabase-js
// restructured its internals — which the boundary test correctly refuses to
// allow.
type TransportOption = NonNullable<
  NonNullable<Parameters<typeof createClient>[2]>["realtime"]
>["transport"];

const UNUSED_TRANSPORT = UnusedRealtimeTransport as unknown as TransportOption;

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

/**
 * A short, stable fingerprint of everything that makes two runs incomparable.
 *
 * Deliberately NOT the seed, population size or sigma: those legitimately
 * differ between runs a person means to keep apart by name, and folding them in
 * would give every ordinary parameter tweak its own experiment. This covers
 * only what can change silently underneath a name — the engine, the schema, the
 * ability catalog, the fitness definition, the weights and the allocation.
 */
const NEWLINE = "\n";

export function identityFingerprint(identity: ExperimentIdentity): string {
  const material = [
    identity.engineSha,
    identity.schemaVersion,
    identity.catalogHash,
    identity.scope,
    identity.fitnessVersion,
    identity.weightsName,
    identity.allocation,
  ].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
      realtime: { transport: UNUSED_TRANSPORT },
    });
  }

  /** Fails with the Supabase message but never echoes the request, which can
   *  carry the key in a header. */
  private static fail(operation: string, error: { message: string } | null): never {
    throw new Error(`supabase ${operation} failed: ${error?.message ?? "unknown error"}`);
  }

  // --- coordinator only -----------------------------------------------------

  /**
   * Returns the experiment for this build, resuming only when it is genuinely
   * the same run.
   *
   * ⚠️ Looking up by NAME ALONE was the bug this exists to prevent. A restart
   * needs to rejoin its own run, so the name was the key — but a name says
   * nothing about what produced the numbers underneath it. When the ability
   * catalog changed, `elementals-balance-v3-v2-s20260813` still existed, so the
   * coordinator resumed a run built under catalog f8f4ea6b with a build on
   * e1370e21, and the contradiction only surfaced later when a WORKER refused
   * its first batch. By then the coordinator had already adopted the old run's
   * generation counter.
   *
   * So the name selects a CANDIDATE and the identity decides. A row whose
   * identity differs is not this run and is never resumed; the search moves to
   * an identity-suffixed name instead and starts clean there.
   *
   * The suffix is derived from the identity rather than from a clock or a
   * random value, deliberately: every coordinator restart on the same build
   * must land on the same experiment, or a restart would fork the run — which
   * is the failure the name-based lookup was protecting against in the first
   * place.
   */
  async ensureExperiment(
    name: string,
    identity: ExperimentIdentity,
    generationsTarget: number,
  ): Promise<{ id: string; currentGeneration: number; name: string; created: boolean }> {
    // Requested name first so existing compatible runs resume exactly as before;
    // then the identity-qualified name, which is where an incompatible build
    // gets its own experiment.
    const candidates = [name, `${name}-${identityFingerprint(identity)}`];
    const rejected: string[] = [];

    for (const candidate of candidates) {
      const existing = await this.db
        .from("experiments")
        .select(
          "id, current_generation, engine_sha, schema_version, catalog_hash, seed, " +
            "population_size, sigma, scope, fitness_version, weights_name, allocation",
        )
        .eq("name", candidate)
        .maybeSingle();
      if (existing.error) QueueClient.fail("select experiment", existing.error);

      if (!existing.data) {
        const created = await this.db.from("experiments").insert({
          name: candidate,
          engine_sha: identity.engineSha,
          schema_version: identity.schemaVersion,
          catalog_hash: identity.catalogHash,
          seed: identity.seed,
          population_size: identity.populationSize,
          sigma: identity.sigma,
          scope: identity.scope,
          fitness_version: identity.fitnessVersion,
          weights_name: identity.weightsName,
          allocation: identity.allocation,
          generations_target: generationsTarget,
        }).select("id, current_generation").single();
        if (created.error) QueueClient.fail("insert experiment", created.error);
        return {
          id: created.data.id as string,
          currentGeneration: created.data.current_generation as number,
          name: candidate,
          created: true,
        };
      }

      const d = existing.data as unknown as Record<string, unknown>;
      const mismatches = identityMismatches(identity, {
        engineSha: d.engine_sha as string,
        schemaVersion: d.schema_version as string,
        catalogHash: d.catalog_hash as string,
        seed: d.seed as number,
        populationSize: d.population_size as number,
        sigma: d.sigma as number,
        scope: d.scope as string,
        fitnessVersion: d.fitness_version as string,
        weightsName: d.weights_name as string,
        allocation: d.allocation as string,
      });

      if (mismatches.length === 0) {
        return {
          id: d.id as string,
          currentGeneration: d.current_generation as number,
          name: candidate,
          created: false,
        };
      }
      rejected.push(`  "${candidate}" — ${mismatches.join("; ")}`);
    }

    // Both names are taken by runs this build does not match. Refusing is the
    // only safe answer: the alternative is mixing two game configurations in
    // one curve, which is precisely what the identity check exists to stop.
    throw new Error(
      [
        "cannot start or resume an experiment for this build.",
        ...rejected,
        "Pass --name <something-new> to start a fresh run.",
      ].join(NEWLINE),
    );
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

  /**
   * Writes the search's durable state.
   *
   * The previous run's checkpoint lived in `/kaggle/working`, which the session
   * deletes on exit. Everything needed to continue was computed and written
   * correctly, and then thrown away — the restart began at generation 0 with
   * thirteen generations of search lost. Supabase is the only storage both a
   * dying coordinator and its replacement can see.
   *
   * Compressed because the checkpoint carries the evaluation cache, which grows
   * every generation; uncompressed it outgrows what PostgREST will accept.
   */
  async saveCheckpoint(experimentId: string, checkpoint: SearchCheckpoint): Promise<void> {
    const payload = gzipSync(Buffer.from(JSON.stringify(checkpoint), "utf8")).toString("base64");
    const { error } = await this.db.from("checkpoints").upsert(
      {
        experiment_id: experimentId,
        generation: checkpoint.completedGenerations,
        stage: checkpoint.stage,
        encoding: "gzip+base64",
        payload,
        bytes: payload.length,
        written_at: new Date().toISOString(),
      },
      { onConflict: "experiment_id,generation,stage" },
    );
    if (error) QueueClient.fail("save checkpoint", error);
  }

  /**
   * The most recent checkpoint, or null when the experiment has none.
   *
   * Ordered by write time rather than generation because stages advance within
   * a generation: after the last generation the run writes stage "validation"
   * at the same generation count, and that is the more advanced state.
   */
  async loadCheckpoint(experimentId: string): Promise<SearchCheckpoint | null> {
    const { data, error } = await this.db.from("checkpoints")
      .select("payload, encoding")
      .eq("experiment_id", experimentId)
      .order("written_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) QueueClient.fail("load checkpoint", error);
    if (!data) return null;
    if (data.encoding !== "gzip+base64") {
      throw new Error(`checkpoint has unknown encoding "${data.encoding}"`);
    }
    return JSON.parse(
      gunzipSync(Buffer.from(data.payload as string, "base64")).toString("utf8"),
    ) as SearchCheckpoint;
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
      .select("engine_sha, schema_version, catalog_hash, seed, population_size, sigma, scope, fitness_version, weights_name, allocation")
      .eq("id", experimentId).single();
    if (error) QueueClient.fail("read experiment", error);
    return {
      engineSha: data.engine_sha, schemaVersion: data.schema_version,
      catalogHash: data.catalog_hash, seed: data.seed,
      populationSize: data.population_size, sigma: data.sigma, scope: data.scope,
      fitnessVersion: data.fitness_version, weightsName: data.weights_name,
      // Rows written before the column existed read as v1, which is what they
      // in fact ran.
      allocation: (data.allocation as string | null) ?? "v1",
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
