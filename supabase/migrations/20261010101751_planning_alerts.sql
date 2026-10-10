-- Device opt-in Web Push, with service-only storage and authenticated Edge API.
-- No planner payload is changed and no client gets another account's records.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Keep the existing validator's owner/ACL and all unrelated validation intact.
do $coverage$
declare definition text; source text;
begin
  select prosrc into source from pg_catalog.pg_proc where oid='private.validate_snapshot(text)'::regprocedure;
  if position($old$'wake','departure','appointment','transition','caffeine']);$old$ in source) = 0 then
    raise exception 'Unexpected reminder validation source; review before applying.';
  end if;
  definition := pg_catalog.pg_get_functiondef('private.validate_snapshot(text)'::regprocedure);
  definition := replace(definition,
    $old$'wake','departure','appointment','transition','caffeine']);$old$,
    $new$'wake','departure','appointment','transition','caffeine','activity','task']);$new$);
  execute definition;
end;
$coverage$;

create table private.reminder_devices (
  device_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  subscription jsonb not null,
  enabled boolean not null default true,
  revision text not null default '',
  snapshot_revision bigint not null default 0,
  schedule jsonb not null default '[]',
  refreshed_at timestamptz not null default '-infinity',
  checked_at timestamptz not null default '-infinity',
  last_seen timestamptz not null default now(),
  check (jsonb_typeof(schedule)='array' and jsonb_array_length(schedule)<=1000),
  check (jsonb_typeof(subscription)='object' and octet_length(subscription::text)<8192)
);
create index reminder_devices_owner on private.reminder_devices(user_id);
create index reminder_devices_session on private.reminder_devices(session_id);
create table private.reminder_deliveries (
  device_id uuid not null references private.reminder_devices(device_id) on delete cascade,
  fingerprint text not null,
  claimed_at timestamptz not null default now(),
  outcome text not null default 'claimed' check(outcome in('claimed','accepted','failed')),
  primary key(device_id,fingerprint)
);
create index reminder_delivery_age on private.reminder_deliveries(claimed_at);
create table private.reminder_config (
  singleton boolean primary key default true check(singleton),
  public_key text not null,
  private_key text not null
);
alter table private.reminder_devices enable row level security;
alter table private.reminder_deliveries enable row level security;
alter table private.reminder_config enable row level security;
revoke all on private.reminder_devices, private.reminder_deliveries, private.reminder_config from public,anon,authenticated;

-- Vault secret is generated on the server, never pasted into a client or repo.
select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),
  'wakey_reminder_cron','Private credential for the minute reminder dispatcher')
where not exists(select 1 from vault.secrets where name='wakey_reminder_cron');

-- Every branch is available only to the Edge Function's built-in service role.
-- The Edge API checks the user's signed JWT and planner_load password session.
create function public.wakey_reminder_service(p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid := (p_data->>'userId')::uuid; d uuid := (p_data->>'deviceId')::uuid;
  session uuid := (p_data->>'sessionId')::uuid; result jsonb; previous_owner uuid;
  saved_revision bigint; reminders_opted_in boolean; affected integer;
begin
  if p_action='config' then
    return (select jsonb_build_object('publicKey',c.public_key,'privateKey',c.private_key,
      'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='wakey_reminder_cron'))
      from private.reminder_config c where singleton);
  elsif p_action='init' then
    insert into private.reminder_config(public_key,private_key)
      values(p_data->>'publicKey',p_data->>'privateKey') on conflict(singleton) do nothing;
    return public.wakey_reminder_service('config');
  elsif p_action='subscribe' then
    if not exists(select 1 from auth.sessions s join auth.users a on a.id=s.user_id
      where s.id=session and s.user_id=u and (s.not_after is null or s.not_after>now())
      and a.email_confirmed_at is not null and a.deleted_at is null and not coalesce(a.is_anonymous,false)
      and (a.banned_until is null or a.banned_until<now())) then
      raise exception 'Verified account session required.' using errcode='42501';
    end if;
    if (select count(*) from private.reminder_devices where user_id=u and enabled and device_id<>d)>=8 then
      raise exception 'Eight notification devices are already registered.' using errcode='22023';
    end if;
    select user_id into previous_owner from private.reminder_devices where device_id=d;
    if previous_owner is distinct from u then
      delete from private.reminder_deliveries where device_id=d;
    end if;
    insert into private.reminder_devices(device_id,user_id,session_id,subscription)
      values(d,u,session,p_data->'subscription') on conflict(device_id) do update set
      user_id=excluded.user_id,session_id=excluded.session_id,subscription=excluded.subscription,
      enabled=true,schedule='[]',snapshot_revision=0,last_seen=now(),refreshed_at='-infinity';
    return jsonb_build_object('registered',true,'scheduled',0,'through',null);
  elsif p_action='device' then
    return (select jsonb_build_object('deviceId',w.device_id,'userId',w.user_id,
      'subscription',w.subscription,'revision',w.revision,'schedule',w.schedule,
      'snapshotRevision',s.revision,'cachedRevision',w.snapshot_revision,'payload',s.payload)
      from private.reminder_devices w join public.planner_snapshots s on s.user_id=w.user_id
      where w.device_id=d and w.user_id=u and w.enabled);
  elsif p_action='devices' then
    -- Fair bounded batches, with no stale or revoked account/session subscribers.
    select coalesce(jsonb_agg(record),'[]') into result from (
      select jsonb_build_object('deviceId',w.device_id,'userId',w.user_id,
        'subscription',w.subscription,'revision',w.revision,'schedule',w.schedule,
        'snapshotRevision',s.revision,'cachedRevision',w.snapshot_revision,
        'refresh',w.refreshed_at<now()-interval '12 hours',
        'payload',case when w.snapshot_revision<>s.revision or w.refreshed_at<now()-interval '12 hours' then s.payload else null end) as record
      from private.reminder_devices w join public.planner_snapshots s on s.user_id=w.user_id
      join auth.sessions x on x.id=w.session_id join auth.users a on a.id=w.user_id
      where w.enabled and w.last_seen>now()-interval '30 days'
        and (x.not_after is null or x.not_after>now()) and a.deleted_at is null
        and a.email_confirmed_at is not null and not coalesce(a.is_anonymous,false)
        and (a.banned_until is null or a.banned_until<now())
        and coalesce((s.payload::jsonb->'settings'->>'remindersEnabled')::boolean,false)
        and (d is null or w.device_id=d)
      order by w.checked_at,w.device_id limit 1
    ) t;
    return result;
  elsif p_action='cache' then
    update private.reminder_devices w set schedule=p_data->'reminders',
      snapshot_revision=(p_data->>'snapshotRevision')::bigint,refreshed_at=now(),checked_at=now(),
      revision=case when p_data ? 'revision' then p_data->>'revision' else w.revision end,
      last_seen=case when coalesce((p_data->>'client')::boolean,false) then now() else w.last_seen end
    where w.device_id=d and w.user_id=u and w.enabled and exists(
      select 1 from public.planner_snapshots s where s.user_id=u and s.revision=(p_data->>'snapshotRevision')::bigint);
    get diagnostics affected=row_count;
    return jsonb_build_object('updated',affected=1);
  elsif p_action='touch' then
    update private.reminder_devices set checked_at=now() where device_id=d and user_id=u;
    return 'true';
  elsif p_action='claim' then
    perform 1 from private.reminder_devices w where w.device_id=d and w.user_id=u and w.enabled
      and exists(select 1 from auth.sessions x join auth.users a on a.id=x.user_id
        where x.id=w.session_id and x.user_id=u and (x.not_after is null or x.not_after>now())
          and a.deleted_at is null and a.email_confirmed_at is not null
          and not coalesce(a.is_anonymous,false) and (a.banned_until is null or a.banned_until<now()))
      for update;
    if not found then return 'false'; end if;
    select s.revision,coalesce((s.payload::jsonb->'settings'->>'remindersEnabled')::boolean,false)
      into saved_revision,reminders_opted_in from public.planner_snapshots s where s.user_id=u;
    if saved_revision is distinct from (p_data->>'snapshotRevision')::bigint or not reminders_opted_in then return 'false'; end if;
    insert into private.reminder_deliveries(device_id,fingerprint) values(d,p_data->>'fingerprint') on conflict do nothing;
    get diagnostics affected=row_count;
    return to_jsonb(affected=1);
  elsif p_action='outcome' then
    update private.reminder_deliveries set outcome=p_data->>'outcome'
      where device_id=d and fingerprint=p_data->>'fingerprint';
    return 'true';
  elsif p_action='status' then
    return (select jsonb_build_object('registered',w.enabled,'scheduled',
      case when w.enabled and coalesce((s.payload::jsonb->'settings'->>'remindersEnabled')::boolean,false)
      then (select count(*) from jsonb_array_elements(w.schedule) r where (r->>'at')::numeric>extract(epoch from now())*1000) else 0 end,
      'through',(select max((r->>'at')::numeric) from jsonb_array_elements(w.schedule) r),
      'revision',w.revision,'lastRefreshed',w.refreshed_at)
      from private.reminder_devices w join public.planner_snapshots s on s.user_id=w.user_id where w.device_id=d and w.user_id=u);
  elsif p_action='disable' then
    update private.reminder_devices set enabled=false,schedule='[]' where device_id=d and user_id=u;
    return jsonb_build_object('registered',false,'scheduled',0,'through',null);
  elsif p_action='prune' then
    delete from private.reminder_deliveries where claimed_at<now()-interval '30 days';
    return 'true';
  else raise exception 'Unsupported reminder action.' using errcode='22023'; end if;
end;
$$;
revoke all on function public.wakey_reminder_service(text,jsonb) from public,anon,authenticated;
grant execute on function public.wakey_reminder_service(text,jsonb) to service_role;

create function private.dispatch_wakey_reminders() returns integer
language plpgsql security definer set search_path='' as $$
declare item record; dispatched integer:=0; credential text;
begin
  select decrypted_secret into credential from vault.decrypted_secrets where name='wakey_reminder_cron';
  delete from private.reminder_deliveries where claimed_at<now()-interval '30 days';
  -- Fan out only due/dirty subscriptions, one device per Edge invocation.
  -- Empty apps make no network call. Independent sends cannot hold up another
  -- device, and no arbitrary global subscriber cap drops due notifications.
  for item in select w.device_id from private.reminder_devices w
    join public.planner_snapshots s on s.user_id=w.user_id
    join auth.sessions x on x.id=w.session_id join auth.users a on a.id=w.user_id
    where w.enabled and w.last_seen>now()-interval '30 days'
      and (x.not_after is null or x.not_after>now()) and a.deleted_at is null
      and a.email_confirmed_at is not null and not coalesce(a.is_anonymous,false)
      and (a.banned_until is null or a.banned_until<now())
      and coalesce((s.payload::jsonb->'settings'->>'remindersEnabled')::boolean,false)
      and (w.snapshot_revision<>s.revision or w.refreshed_at<now()-interval '12 hours'
        or exists(select 1 from jsonb_array_elements(w.schedule) r
          where (r->>'at')::numeric between (extract(epoch from now())*1000-90000) and extract(epoch from now())*1000))
  loop
    perform net.http_post(
      url:='https://zhdoydzgtuskiflnzzxh.supabase.co/functions/v1/wakey-reminders',
      headers:=jsonb_build_object('Content-Type','application/json','x-wakey-cron',credential),
      body:=jsonb_build_object('action','dispatch','deviceId',item.device_id),timeout_milliseconds:=15000);
    dispatched:=dispatched+1;
  end loop;
  return dispatched;
end;
$$;
revoke all on function private.dispatch_wakey_reminders() from public,anon,authenticated;
select cron.schedule('wakey-due-alerts','* * * * *','select private.dispatch_wakey_reminders();');
commit;
