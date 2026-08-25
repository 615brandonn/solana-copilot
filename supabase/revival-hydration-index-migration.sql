-- Revival Campaign tracker: bounded startup hydration index.
-- Additive and safe to rerun. This index supports the observer's per-version
-- UUID keyset scan without changing or deleting any evidence.

create index if not exists revival_events_hydration_idx
  on public.revival_events (user_id, strategy_version_id, id);

create index if not exists revival_events_projection_repair_idx
  on public.revival_events (user_id, strategy_version_id, id)
  where campaign_id is null;
