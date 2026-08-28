-- Constant-time Custody queue readiness proof.
--
-- The detailed custody_pending_queue_health RPC intentionally reports exact
-- historical counts and can exceed a hosted statement timeout once the
-- evidence ledger becomes large. Doctor needs only an authoritative schema and
-- index capability check, so keep that readiness path independent of ledger
-- cardinality.

begin;

create or replace function public.custody_pending_queue_capabilities(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_due_index regclass := to_regclass('public.custody_pending_events_due_v2_idx');
  v_wake_index regclass := to_regclass('public.custody_pending_events_wake_v2_idx');
  v_expiry_index regclass := to_regclass('public.custody_pending_events_expiry_v2_idx');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role is required';
  end if;
  if p_user_id is null then
    raise exception using errcode = '22023', message = 'user_id is required';
  end if;

  return jsonb_build_object(
    'schemaVersion', 2,
    'indexesReady',
      v_due_index is not null
      and v_wake_index is not null
      and v_expiry_index is not null,
    'dueIndexReady', v_due_index is not null,
    'wakeIndexReady', v_wake_index is not null,
    'expiryIndexReady', v_expiry_index is not null,
    'generatedAt', now()
  );
end;
$$;

revoke all on function public.custody_pending_queue_capabilities(uuid)
  from public, anon, authenticated;
grant execute on function public.custody_pending_queue_capabilities(uuid)
  to service_role;

commit;
