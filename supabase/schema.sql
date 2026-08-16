-- ============================================================================
-- Distributed CMA-ES job queue for the Elementals balance search.
--
-- Run once in: Supabase Dashboard -> SQL Editor -> New Query -> Run.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS FOR
-- One coordinator owns the CMA-ES state and asks it for a population. Each
-- candidate becomes a job here. Five or six Kaggle notebooks claim jobs, run
-- the simulation, and write results back. The coordinator waits for the whole
-- population, orders the results by candidate index, and calls tell() once.
--
-- This database is ONLY the live queue. The authoritative CMA-ES checkpoint
-- stays in the Kaggle Dataset, unchanged.
--
-- THE ONE PROPERTY THAT MATTERS
-- Results must come back paired with the right candidate. cma.tell() takes the
-- correspondence between candidate and score from array position alone, so a
-- mispaired result trains the strategy on nonsense and raises no error. That is
-- why jobs carry candidate_index and candidate_hash, and why the coordinator
-- re-checks both before using anything from here.
-- ============================================================================

-- ============================================================================
-- TABLES
-- ============================================================================

-- One row per optimisation run. Its identity is what stops a worker built from
-- a different commit, schema or seed from contributing results that would
-- silently corrupt the search.
create table if not exists experiments (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  status              text not null default 'active'
                        check (status in ('active', 'paused', 'complete', 'abandoned')),
  engine_sha          text not null,
  schema_version      text not null,
  catalog_hash        text not null,
  seed                integer not null,
  population_size     integer not null check (population_size > 0),
  sigma               double precision not null,
  scope               text not null,
  fitness_version     text not null,
  weights_name        text not null,
  generations_target  integer not null check (generations_target > 0),
  current_generation  integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One row per candidate per generation.
create table if not exists jobs (
  id                uuid primary key default gen_random_uuid(),
  experiment_id     uuid not null references experiments(id) on delete cascade,
  generation_number integer not null,
  candidate_index   integer not null,
  candidate_id      text not null,
  candidate_hash    text not null,
  tier              text not null check (tier in ('screen', 'full', 'validation')),
  parameters        jsonb not null,
  status            text not null default 'pending'
                      check (status in ('pending', 'running', 'complete', 'failed')),
  worker_id         text,
  lease_expires_at  timestamptz,
  attempts          integer not null default 0,
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  -- A candidate appears exactly once per generation per tier. Makes publishing
  -- a generation idempotent: a coordinator restart cannot duplicate the work.
  unique (experiment_id, generation_number, candidate_index, tier)
);

-- job_id is the primary key, so a duplicate submission is a no-op rather than a
-- second row. A worker that crashes after evaluating but before submitting will
-- have its job reclaimed and evaluated again; both answers are identical
-- because evaluation is deterministic, and only the first is kept.
create table if not exists results (
  job_id            uuid primary key references jobs(id) on delete cascade,
  experiment_id     uuid not null references experiments(id) on delete cascade,
  generation_number integer not null,
  candidate_index   integer not null,
  candidate_hash    text not null,
  fitness           jsonb,
  failure           text,
  duration_ms       integer,
  matches           integer,
  worker_id         text,
  created_at        timestamptz not null default now()
);

-- Observability only. Nothing depends on this for correctness: a job returns to
-- the pool because its lease expired, not because a worker was marked dead.
create table if not exists workers (
  worker_id      text primary key,
  experiment_id  uuid references experiments(id) on delete set null,
  status         text not null default 'idle',
  last_heartbeat timestamptz not null default now(),
  jobs_completed integer not null default 0,
  jobs_failed    integer not null default 0,
  created_at     timestamptz not null default now()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- The claim query's exact shape: pending or expired, for one generation,
-- lowest candidate_index first.
create index if not exists jobs_claimable_idx
  on jobs (experiment_id, generation_number, status, lease_expires_at, candidate_index);

-- The coordinator's "is the generation done yet?" poll.
create index if not exists results_generation_idx
  on results (experiment_id, generation_number, candidate_index);

create index if not exists workers_heartbeat_idx on workers (experiment_id, last_heartbeat desc);

-- ============================================================================
-- FUNCTIONS
--
-- All job mutation happens here rather than through direct table access. That
-- is what lets the six worker notebooks hold nothing but the publishable key:
-- they can execute these functions and cannot touch the tables underneath.
-- ============================================================================

-- Atomically hand one job to one worker.
--
-- FOR UPDATE SKIP LOCKED is the whole point. A SELECT followed by an UPDATE
-- would let two workers read the same pending row and both believe they own it,
-- and with 12 workers polling that is not a rare race, it is the normal case.
-- SKIP LOCKED makes concurrent claimers step over rows another transaction is
-- already taking.
--
-- A job whose lease has expired is claimable again. That is the entire failure
-- story for a dead worker: no heartbeat monitor, no reaper, just a timeout.
create or replace function claim_job(
  p_experiment_id uuid,
  p_generation    integer,
  p_worker_id     text,
  p_lease_minutes integer default 30
)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed jobs;
begin
  update jobs
     set status           = 'running',
         worker_id        = p_worker_id,
         lease_expires_at = now() + make_interval(mins => p_lease_minutes),
         attempts         = attempts + 1,
         started_at       = coalesce(started_at, now())
   where id = (
     select j.id
       from jobs j
      where j.experiment_id     = p_experiment_id
        and j.generation_number = p_generation
        and (
              j.status = 'pending'
           or (j.status = 'running' and j.lease_expires_at < now())
        )
      order by j.candidate_index
        for update skip locked
      limit 1
   )
  returning * into claimed;

  if found then
    update workers
       set status = 'busy', last_heartbeat = now()
     where worker_id = p_worker_id;
  end if;

  return claimed;
end;
$$;

-- Record a result and close the job.
--
-- Rejects anything that does not match the job it claims to answer. A worker
-- whose lease expired mid-evaluation may still try to submit; if the job was
-- reclaimed and finished by someone else, that late answer is discarded rather
-- than overwriting a good one.
create or replace function submit_result(
  p_job_id         uuid,
  p_worker_id      text,
  p_candidate_hash text,
  p_fitness        jsonb,
  p_failure        text default null,
  p_duration_ms    integer default null,
  p_matches        integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target jobs;
begin
  select * into target from jobs where id = p_job_id;

  if not found then
    raise exception 'unknown job %', p_job_id;
  end if;

  -- The hash is the candidate's identity. A mismatch means this result belongs
  -- to a different candidate, which is the one error that would silently
  -- corrupt the optimisation.
  if target.candidate_hash <> p_candidate_hash then
    raise exception 'candidate hash mismatch for job %: expected %, got %',
      p_job_id, target.candidate_hash, p_candidate_hash;
  end if;

  -- Already answered. Not an error: a duplicate submission is expected after a
  -- reclaim, and the deterministic engine means both answers agree.
  if target.status = 'complete' then
    return false;
  end if;

  insert into results (job_id, experiment_id, generation_number, candidate_index,
                       candidate_hash, fitness, failure, duration_ms, matches, worker_id)
  values (p_job_id, target.experiment_id, target.generation_number, target.candidate_index,
          p_candidate_hash, p_fitness, p_failure, p_duration_ms, p_matches, p_worker_id)
  on conflict (job_id) do nothing;

  update jobs
     set status = 'complete', completed_at = now(), lease_expires_at = null
   where id = p_job_id;

  update workers
     set status         = 'idle',
         last_heartbeat = now(),
         jobs_completed = jobs_completed + case when p_failure is null then 1 else 0 end,
         jobs_failed    = jobs_failed    + case when p_failure is null then 0 else 1 end
   where worker_id = p_worker_id;

  return true;
end;
$$;

-- Extend a lease on a job still being worked. Long evaluations outlive the
-- default lease, and without this the job would be reclaimed while a perfectly
-- healthy worker was still running it.
create or replace function renew_lease(
  p_job_id        uuid,
  p_worker_id     text,
  p_lease_minutes integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated integer;
begin
  update jobs
     set lease_expires_at = now() + make_interval(mins => p_lease_minutes)
   where id = p_job_id and worker_id = p_worker_id and status = 'running';
  get diagnostics updated = row_count;

  update workers set last_heartbeat = now() where worker_id = p_worker_id;
  return updated > 0;
end;
$$;

create or replace function register_worker(
  p_worker_id     text,
  p_experiment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into workers (worker_id, experiment_id, status, last_heartbeat)
  values (p_worker_id, p_experiment_id, 'idle', now())
  on conflict (worker_id)
    do update set experiment_id = excluded.experiment_id,
                  last_heartbeat = now(),
                  status = 'idle';
end;
$$;

-- How far along the current generation is. One round trip instead of counting
-- rows client-side.
create or replace function generation_progress(
  p_experiment_id uuid,
  p_generation    integer
)
returns table (total bigint, pending bigint, running bigint, complete bigint, failed bigint)
language sql
stable
security definer
set search_path = public
as $$
  select count(*),
         count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'running'),
         count(*) filter (where status = 'complete'),
         count(*) filter (where status = 'failed')
    from jobs
   where experiment_id = p_experiment_id and generation_number = p_generation;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY
--
-- Every table is locked by default. Workers reach the queue only through the
-- functions above, which run as their owner and so are not subject to these
-- policies. The practical effect: a leaked publishable key lets someone claim
-- and answer jobs, and lets them read progress. It does not let them delete a
-- run, rewrite results, or alter an experiment's identity.
-- ============================================================================

alter table experiments enable row level security;
alter table jobs        enable row level security;
alter table results     enable row level security;
alter table workers     enable row level security;

-- Workers must read the experiment to check that their engine SHA, schema
-- version and seed match before evaluating anything.
drop policy if exists experiments_read on experiments;
create policy experiments_read on experiments for select to anon, authenticated using (true);

-- Read-only visibility for progress reporting. No direct writes: every mutation
-- goes through a function.
drop policy if exists jobs_read on jobs;
create policy jobs_read on jobs for select to anon, authenticated using (true);

drop policy if exists results_read on results;
create policy results_read on results for select to anon, authenticated using (true);

drop policy if exists workers_read on workers;
create policy workers_read on workers for select to anon, authenticated using (true);

-- ============================================================================
-- PERMISSIONS
-- ============================================================================

grant usage on schema public to anon, authenticated;
grant select on experiments, jobs, results, workers to anon, authenticated;

grant execute on function claim_job(uuid, integer, text, integer)                                to anon, authenticated;
grant execute on function submit_result(uuid, text, text, jsonb, text, integer, integer)         to anon, authenticated;
grant execute on function renew_lease(uuid, text, integer)                                       to anon, authenticated;
grant execute on function register_worker(text, uuid)                                            to anon, authenticated;
grant execute on function generation_progress(uuid, integer)                                     to anon, authenticated;

-- Creating experiments and publishing jobs is NOT granted here. Only the
-- coordinator does those, once per generation, using the secret key. Granting
-- them to anon would let anything holding a worker key start or reshape a run.

-- ============================================================================
-- VERIFY
-- ============================================================================
-- select tablename from pg_tables where schemaname = 'public' order by 1;
-- select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1;
