-- Balance V3: durable coordinator state and a recorded match-budget split.
--
-- Run this once in the Supabase SQL editor. It is additive and idempotent:
-- existing experiments keep working and read as allocation 'v1', which is what
-- they in fact ran.

-- ---------------------------------------------------------------------------
-- 1. Which match-budget split produced an experiment's numbers.
-- ---------------------------------------------------------------------------
-- On the experiment row rather than in each notebook's environment because
-- workers do the evaluating. A worker configured for a different split than its
-- coordinator would return scores measured on a different instrument, and
-- nothing downstream would notice.
alter table experiments
  add column if not exists allocation text not null default 'v1';

alter table experiments
  drop constraint if exists experiments_allocation_known;
alter table experiments
  add constraint experiments_allocation_known check (allocation in ('v1', 'v2'));

-- ---------------------------------------------------------------------------
-- 2. Durable CMA-ES state.
-- ---------------------------------------------------------------------------
-- The previous run died because the checkpoint lived in /kaggle/working, which
-- is deleted when the session ends. Everything needed to continue was written
-- correctly and then thrown away, so a restart began at generation 0 having
-- lost thirteen generations of search.
--
-- The payload is the whole SearchCheckpoint: CMA snapshot, schema, generation
-- records, evaluation cache, counters, stage and identity. It is gzipped and
-- base64'd because the cache grows with every generation and an uncompressed
-- twenty-generation checkpoint runs to megabytes, which PostgREST will refuse.
create table if not exists checkpoints (
  experiment_id uuid    not null references experiments(id) on delete cascade,
  -- Generations FULLY completed at the time of writing. The search resumes here.
  generation    integer not null,
  -- 'search' | 'validation' | 'complete'. Part of the key so a validation-stage
  -- write cannot overwrite the final search-stage checkpoint for the same
  -- generation count; a session killed inside validation still has both.
  stage         text    not null,
  encoding      text    not null default 'gzip+base64',
  payload       text    not null,
  bytes         integer not null,
  written_at    timestamptz not null default now(),
  primary key (experiment_id, generation, stage)
);

-- Resume reads exactly one row: the most recent write, which is always the most
-- advanced state because generations complete in order.
create index if not exists checkpoints_latest
  on checkpoints (experiment_id, written_at desc);

-- ---------------------------------------------------------------------------
-- 3. Row-level security.
-- ---------------------------------------------------------------------------
-- Only the coordinator touches this table, and only the coordinator holds the
-- secret key. Workers hold the publishable key and must not be able to read or
-- rewrite search state: a leaked worker key can claim and answer jobs, and that
-- is the whole of the blast radius. No policy is created for `anon`, so RLS
-- denies it by default while the service role bypasses RLS entirely.
alter table checkpoints enable row level security;

revoke all on checkpoints from anon;

-- ---------------------------------------------------------------------------
-- 4. Verification — safe to re-run, returns one row per check.
-- ---------------------------------------------------------------------------
-- select 'allocation column' as check,
--        count(*) filter (where column_name = 'allocation') = 1 as ok
--   from information_schema.columns where table_name = 'experiments'
-- union all
-- select 'checkpoints table', count(*) = 1 from information_schema.tables
--  where table_name = 'checkpoints';
