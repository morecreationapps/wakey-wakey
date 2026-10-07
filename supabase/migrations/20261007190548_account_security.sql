-- Account storage and trusted legacy migration for Wakey-Wakey!.
-- Only these four public, SECURITY INVOKER wrappers are exposed as app RPCs.
create schema if not exists private;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter default privileges in schema private revoke execute on functions from public;

create table public.planner_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload text not null check (octet_length(payload) <= 10000000),
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null default now()
);
alter table public.planner_snapshots enable row level security;
revoke all on public.planner_snapshots from public, anon, authenticated;
grant select on public.planner_snapshots to authenticated;

create table private.account_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role = 'admin'),
  established_at timestamptz not null default now()
);
create table private.admin_migration_grants (
  user_id uuid primary key references auth.users(id) on delete cascade,
  backup_digest text not null check (backup_digest ~ '^[a-f0-9]{64}$'),
  prepared_at timestamptz not null default now(),
  completed_at timestamptz,
  migrated_revision bigint
);
create table private.migration_reservations (
  email text primary key check (email = lower(trim(email)) and email <> ''),
  backup_digest text not null check (backup_digest ~ '^[a-f0-9]{64}$'),
  reserved_at timestamptz not null default now()
);
create table private.planner_write_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  minute timestamptz not null,
  requests integer not null
);
alter table private.account_roles enable row level security;
alter table private.admin_migration_grants enable row level security;
alter table private.migration_reservations enable row level security;
alter table private.planner_write_limits enable row level security;
revoke all on private.account_roles, private.admin_migration_grants,
  private.migration_reservations, private.planner_write_limits from public, anon, authenticated;

-- Never use user_metadata, a submitted email address, or a client admin flag.
-- Auth's signed password AMR and current server-side user/session records are required.
create function private.verified_password_session() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    auth.uid() is not null
    and (auth.jwt()->>'client_id') is null
    and jsonb_typeof(auth.jwt()->'amr') = 'array'
    and exists (select 1 from jsonb_array_elements(auth.jwt()->'amr') a
      where a->>'method' = 'password')
    and not exists (select 1 from jsonb_array_elements(auth.jwt()->'amr') a
      where coalesce(a->>'method', '') <> 'password')
    and exists (
      select 1 from auth.users u join auth.sessions s on s.user_id = u.id
      where u.id = auth.uid()
        and u.email_confirmed_at is not null and not coalesce(u.is_anonymous, false)
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until < now())
        and s.id::text = auth.jwt()->>'session_id'
        and (s.not_after is null or s.not_after > now())
    ), false
  );
$$;
revoke all on function private.verified_password_session() from public, anon;
grant execute on function private.verified_password_session() to authenticated;
create policy own_verified_password_snapshot on public.planner_snapshots
for select to authenticated using (
  user_id = (select auth.uid()) and (select private.verified_password_session())
);

create function private.require_password_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.verified_password_session() then
    raise exception 'A verified email-and-password session is required.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
create function private.require_migration_approval(p_user uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from private.migration_reservations r join auth.users u
    on lower(u.email) = r.email where u.id = p_user)
    and not exists (select 1 from private.admin_migration_grants where user_id = p_user) then
    raise exception 'Administrator setup is awaiting trusted migration approval.' using errcode = '42501';
  end if;
end;
$$;

-- Validate all fields used by schema 1, without normalising or reserialising the snapshot.
create function private.check_value(v jsonb, p text, kind text,
  max_value integer default 10000, nullable boolean default false) returns void
language plpgsql immutable set search_path = '' as $$
declare t text;
begin
  if nullable and v = 'null'::jsonb then return; end if;
  if v is null then raise exception 'Invalid snapshot: missing %.', p using errcode = '22023'; end if;
  t := v #>> '{}';
  if kind in ('text', 'id', 'date', 'time', 'local') then
    if jsonb_typeof(v) <> 'string' or length(t) > max_value then
      raise exception 'Invalid snapshot: % must be bounded text.', p using errcode = '22023';
    end if;
    if kind = 'id' and (length(trim(t)) = 0 or t ~ E'[\\r\\n]') then
      raise exception 'Invalid snapshot: % is an invalid identifier.', p using errcode = '22023';
    elsif kind = 'date' and (t !~ '^\d{4}-\d{2}-\d{2}$' or to_char(t::date, 'YYYY-MM-DD') <> t) then
      raise exception 'Invalid snapshot: % is an invalid date.', p using errcode = '22023';
    elsif kind = 'time' and t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Invalid snapshot: % is an invalid time.', p using errcode = '22023';
    elsif kind = 'local' then
      if t !~ '^\d{4}-\d{2}-\d{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
        raise exception 'Invalid snapshot: % is an invalid local datetime.', p using errcode = '22023';
      end if;
      perform t::timestamp;
    end if;
  elsif kind = 'number' then
    if jsonb_typeof(v) <> 'number' or t::numeric < 0 or t::numeric > max_value then
      raise exception 'Invalid snapshot: % is outside its numeric range.', p using errcode = '22023';
    end if;
  elsif kind = 'boolean' then
    if jsonb_typeof(v) <> 'boolean' then
      raise exception 'Invalid snapshot: % must be boolean.', p using errcode = '22023';
    end if;
  elsif kind = 'object' then
    if jsonb_typeof(v) <> 'object' or v ?| array['__proto__','prototype','constructor'] then
      raise exception 'Invalid snapshot: % must be a safe object.', p using errcode = '22023';
    end if;
  elsif kind = 'array' then
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > max_value then
      raise exception 'Invalid snapshot: % must be a bounded array.', p using errcode = '22023';
    end if;
  else raise exception 'Unsupported validation kind.';
  end if;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'Invalid snapshot: % has an invalid date or time.', p using errcode = '22023';
end;
$$;
create function private.check_choice(v jsonb, p text, choices text[]) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(v) is distinct from 'string' or not (v #>> '{}') = any(choices) then
    raise exception 'Invalid snapshot: % has an invalid choice.', p using errcode = '22023';
  end if;
end;
$$;
create function private.check_records(v jsonb, p text, max_items integer) returns void
language plpgsql immutable set search_path = '' as $$
declare item jsonb;
begin
  perform private.check_value(v,p,'array',max_items);
  for item in select value from jsonb_array_elements(v) loop
    perform private.check_value(item,p,'object');
    perform private.check_value(item->'id',p||'.id','id',300);
  end loop;
  if exists (select 1 from jsonb_array_elements(v) i group by i->>'id' having count(*) > 1) then
    raise exception 'Invalid snapshot: % contains duplicate IDs.', p using errcode = '22023';
  end if;
end;
$$;
create function private.validate_snapshot(p_payload text) returns void
language plpgsql stable set search_path = '' as $$
declare s jsonb; settings jsonb; item jsonb; child jsonb; k text;
  categories text[] := array['Early','Middle','Late','Night','Custom'];
  statuses text[] := array['Work','Rest','Holiday','Sick','OtherLeave','Unknown'];
  task_states text[] := array['pending','accepted','completed','skipped','deferred'];
begin
  if p_payload is null or octet_length(p_payload) > 10000000 then
    raise exception 'Invalid snapshot: exceeds 10 MB.' using errcode = '22023';
  end if;
  s := p_payload::jsonb;
  perform private.check_value(s,'root','object');
  if s->'schemaVersion' is distinct from '1'::jsonb or
    exists(select 1 from jsonb_object_keys(s) key where key <> all(array[
      'schemaVersion','settings','entries','templates','patterns','tasks','sleepLogs'])) then
    raise exception 'Invalid snapshot schema.' using errcode = '22023';
  end if;
  settings := s->'settings';
  perform private.check_value(settings,'settings','object');
  foreach k in array array['name','role','travelMode'] loop
    perform private.check_value(settings->k,'settings.'||k,'text',1000);
  end loop;
  perform private.check_value(settings->'timezone','settings.timezone','text',200);
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = settings->>'timezone') then
    raise exception 'Invalid settings timezone.' using errcode = '22023';
  end if;
  foreach k in array array['safetyCritical','timezoneConfirmed','additionalPrepConfirmed',
    'consistentWake','caffeine','remindersEnabled','onboardingComplete'] loop
    perform private.check_value(settings->k,'settings.'||k,'boolean');
  end loop;
  if settings ? 'onboardingRotaPending' then
    perform private.check_value(settings->'onboardingRotaPending','settings.onboardingRotaPending','boolean');
  end if;
  if settings ? 'caffeineBeforeBed' then
    perform private.check_value(settings->'caffeineBeforeBed','settings.caffeineBeforeBed','number',2880);
  end if;
  perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO']);
  perform private.check_choice(settings->'clockFormat','settings.clockFormat',array['24','12']);
  perform private.check_choice(settings->'firstDay','settings.firstDay',array['Monday','Sunday']);
  perform private.check_choice(settings->'theme','settings.theme',array['light','dark','system']);
  foreach k in array array['outboundMin','outboundMax','returnMinutes','arrivalBuffer',
    'sleepTarget','latency','windDown','postWorkMinutes'] loop
    perform private.check_value(settings->k,'settings.'||k,'number',2880,true);
  end loop;
  if (settings->>'outboundMin')::numeric > (settings->>'outboundMax')::numeric then
    raise exception 'Invalid commute range.' using errcode = '22023';
  end if;
  perform private.check_value(settings->'freeMinutes','settings.freeMinutes','number',1440);
  perform private.check_value(settings->'onboardingStep','settings.onboardingStep','number',20);
  if (settings->>'onboardingStep')::numeric <> trunc((settings->>'onboardingStep')::numeric) then
    raise exception 'Invalid onboarding step.' using errcode = '22023';
  end if;
  foreach k in array array['earlyBed','earlyWake','lateBed','lateWake','restBed','restWake'] loop
    perform private.check_value(settings->k,'settings.'||k,'time',5,true);
  end loop;
  perform private.check_value(settings->'reminderKinds','settings.reminderKinds','array',20);
  for child in select value from jsonb_array_elements(settings->'reminderKinds') loop
    perform private.check_choice(child,'reminderKinds',array['prepare','windDown','bedtime',
      'wake','departure','appointment','transition','caffeine']);
  end loop;
  perform private.check_value(settings->'origins','settings.origins','object');
  for k in select jsonb_object_keys(settings->'origins') loop
    if length(k) > 200 then raise exception 'Invalid origin key.' using errcode = '22023'; end if;
    perform private.check_choice(settings->'origins'->k,'settings.origins',array['entered','suggested','needed']);
  end loop;
  perform private.check_records(settings->'routines','routines',200);
  for item in select value from jsonb_array_elements(settings->'routines') loop
    perform private.check_value(item->'name','routine.name','text',1000);
    perform private.check_value(item->'minutes','routine.minutes','number',1440,true);
    perform private.check_value(item->'essential','routine.essential','boolean');
    perform private.check_value(item->'includes','routine.includes','array',100);
    for child in select value from jsonb_array_elements(item->'includes') loop
      perform private.check_value(child,'routine.includes','text',300);
    end loop;
  end loop;
  perform private.check_records(s->'entries','entries',30000);
  for item in select value from jsonb_array_elements(s->'entries') loop
    perform private.check_value(item->'date','entry.date','date',10);
    perform private.check_value(item->'duty','entry.duty','text',1000);
    perform private.check_choice(item->'category','entry.category',categories);
    perform private.check_choice(item->'status','entry.status',statuses);
    foreach k in array array['start','end'] loop
      perform private.check_value(item->k,'entry.'||k,'local',19,true);
    end loop;
    if item ? 'actualEnd' then perform private.check_value(item->'actualEnd','entry.actualEnd','local',19,true); end if;
    perform private.check_value(item->'timezone','entry.timezone','text',200);
    if not exists(select 1 from pg_catalog.pg_timezone_names where name = item->>'timezone') then
      raise exception 'Invalid entry timezone.' using errcode = '22023';
    end if;
    perform private.check_value(item->'location','entry.location','text',2000);
    perform private.check_value(item->'notes','entry.notes','text',20000);
    perform private.check_value(item->'overtimeMinutes','entry.overtimeMinutes','number',2880);
    foreach k in array array['breakMinutes','paidMinutes'] loop
      perform private.check_value(item->k,'entry.'||k,'number',2880,true);
    end loop;
    if item ? 'disambiguation' then perform private.check_choice(item->'disambiguation','entry.disambiguation',array['earlier','later']); end if;
    if item ? 'leaveApproval' then perform private.check_choice(item->'leaveApproval','entry.leaveApproval',array['requested','confirmed']); end if;
    if item ? 'patternId' then perform private.check_value(item->'patternId','entry.patternId','id',300); end if;
    if item ? 'exception' then perform private.check_value(item->'exception','entry.exception','boolean'); end if;
    if item->>'status' = 'Work' and ((item->>'start') is null or (item->>'end') is null or
      (item->>'end')::timestamp <= (item->>'start')::timestamp) then
      raise exception 'Invalid work shift times.' using errcode = '22023';
    end if;
  end loop;
  perform private.check_records(s->'templates','templates',1000);
  for item in select value from jsonb_array_elements(s->'templates') loop
    foreach k in array array['name','duty'] loop perform private.check_value(item->k,'template.'||k,'text',1000); end loop;
    perform private.check_choice(item->'category','template.category',categories);
    foreach k in array array['start','end'] loop perform private.check_value(item->k,'template.'||k,'time',5); end loop;
  end loop;
  perform private.check_records(s->'patterns','patterns',1000);
  for item in select value from jsonb_array_elements(s->'patterns') loop
    perform private.check_value(item->'name','pattern.name','text',1000);
    foreach k in array array['startDate','until'] loop perform private.check_value(item->k,'pattern.'||k,'date',10); end loop;
    if item->>'until' < item->>'startDate' then raise exception 'Invalid pattern range.' using errcode = '22023'; end if;
    perform private.check_value(item->'days','pattern.days','array',366);
    if jsonb_array_length(item->'days') = 0 then raise exception 'Empty pattern.' using errcode = '22023'; end if;
    for child in select value from jsonb_array_elements(item->'days') loop
      perform private.check_value(child,'pattern.day','object');
      perform private.check_choice(child->'status','pattern.day.status',statuses);
      if child->>'status' = 'Work' or child ? 'templateId' then
        perform private.check_value(child->'templateId','pattern.templateId','id',300);
        if not exists(select 1 from jsonb_array_elements(s->'templates') t where t->>'id' = child->>'templateId') then
          raise exception 'Unknown pattern template.' using errcode = '22023';
        end if;
      end if;
    end loop;
  end loop;
  perform private.check_records(s->'tasks','tasks',10000);
  for item in select value from jsonb_array_elements(s->'tasks') loop
    foreach k in array array['title','location'] loop perform private.check_value(item->k,'task.'||k,'text',2000); end loop;
    perform private.check_choice(item->'kind','task.kind',array['fixed','essential','flexible','optional']);
    perform private.check_choice(item->'recurrence','task.recurrence',array['none','daily','weekly']);
    perform private.check_choice(item->'state','task.state',task_states);
    perform private.check_value(item->'minutes','task.minutes','number',1440);
    if (item->>'minutes')::numeric < 1 then raise exception 'Invalid task duration.' using errcode = '22023'; end if;
    perform private.check_value(item->'travelMinutes','task.travelMinutes','number',1440);
    perform private.check_value(item->'priority','task.priority','number',1000);
    foreach k in array array['deadline','earliest'] loop perform private.check_value(item->k,'task.'||k,'local',19); end loop;
    if (item->>'deadline')::timestamp < (item->>'earliest')::timestamp then raise exception 'Invalid task range.' using errcode = '22023'; end if;
    perform private.check_value(item->'scheduledStart','task.scheduledStart','local',19,true);
    foreach k in array array['windowStart','windowEnd'] loop perform private.check_value(item->k,'task.'||k,'time',5); end loop;
    foreach k in array array['movable','splittable','locked'] loop perform private.check_value(item->k,'task.'||k,'boolean'); end loop;
    if item ? 'linkedShiftId' then perform private.check_value(item->'linkedShiftId','task.linkedShiftId','id',300); end if;
    if item ? 'occurrenceStates' then
      perform private.check_value(item->'occurrenceStates','task.occurrenceStates','object');
      if (select count(*) from jsonb_object_keys(item->'occurrenceStates')) > 30000 then raise exception 'Too many task occurrences.' using errcode = '22023'; end if;
      for k in select jsonb_object_keys(item->'occurrenceStates') loop
        perform private.check_value(to_jsonb(k),'task.occurrence.date','date',10);
        perform private.check_choice(item->'occurrenceStates'->k,'task.occurrence.state',task_states);
      end loop;
    end if;
  end loop;
  perform private.check_records(s->'sleepLogs','sleepLogs',30000);
  for item in select value from jsonb_array_elements(s->'sleepLogs') loop
    perform private.check_value(item->'date','sleepLog.date','date',10);
    foreach k in array array['bedtime','wake'] loop perform private.check_value(item->k,'sleepLog.'||k,'local',19); end loop;
    if (item->>'wake')::timestamp <= (item->>'bedtime')::timestamp then raise exception 'Invalid sleep interval.' using errcode = '22023'; end if;
    perform private.check_value(item->'estimatedMinutes','sleepLog.estimatedMinutes','number',1440,true);
    perform private.check_value(item->'awakenings','sleepLog.awakenings','number',100,true);
    perform private.check_value(item->'rested','sleepLog.rested','text',1000);
  end loop;
exception when invalid_text_representation then
  raise exception 'Invalid snapshot JSON.' using errcode = '22023';
end;
$$;

create function private.lock_planner(p_user uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text, 713));
$$;
create function private.check_write_limit(p_user uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare n integer;
begin
  insert into private.planner_write_limits as limits(user_id,minute,requests)
    values(p_user,date_trunc('minute',clock_timestamp()),1)
    on conflict(user_id) do update set
      minute = excluded.minute,
      requests = case when limits.minute = excluded.minute then limits.requests + 1 else 1 end
    returning requests into n;
  if n > 120 then raise exception 'Too many saves. Please wait a minute.' using errcode = '54000'; end if;
end;
$$;

create function private.planner_load() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := private.require_password_user(); result jsonb;
begin
  perform private.require_migration_approval(u);
  select jsonb_build_object('payload',payload,'revision',revision) into result
    from public.planner_snapshots where user_id = u;
  return coalesce(result,jsonb_build_object('payload',null,'revision',0));
end;
$$;
create function private.planner_save(p_payload text,p_expected_revision bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare u uuid := private.require_password_user(); current_revision bigint; saved_revision bigint;
begin
  perform private.lock_planner(u);
  perform private.require_migration_approval(u);
  if exists(select 1 from private.admin_migration_grants where user_id = u and completed_at is null) then
    raise exception 'Existing settings must be migrated before saving.' using errcode = '55000';
  end if;
  select revision into current_revision from public.planner_snapshots where user_id = u;
  if p_expected_revision is null or p_expected_revision < 0 or coalesce(current_revision,0) <> p_expected_revision then
    raise exception 'Saved settings changed elsewhere. Reload before saving.' using errcode = '40001';
  end if;
  perform private.validate_snapshot(p_payload);
  perform private.check_write_limit(u);
  saved_revision := coalesce(current_revision,0) + 1;
  insert into public.planner_snapshots(user_id,payload,revision) values(u,p_payload,saved_revision)
    on conflict(user_id) do update set payload = excluded.payload, revision = excluded.revision, updated_at = now();
  return jsonb_build_object('payload',p_payload,'revision',saved_revision);
end;
$$;
create function private.planner_migration_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u uuid := private.require_password_user(); result jsonb;
begin
  perform private.require_migration_approval(u);
  select jsonb_build_object('eligible',true,'completed',completed_at is not null,'digest',backup_digest)
    into result from private.admin_migration_grants where user_id = u;
  return coalesce(result,jsonb_build_object('eligible',false,'completed',false));
end;
$$;
create function private.planner_migrate_legacy(p_payload text,p_digest text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare u uuid := private.require_password_user(); migration private.admin_migration_grants%rowtype;
  saved public.planner_snapshots%rowtype; actual_digest text;
begin
  perform private.lock_planner(u);
  select * into migration from private.admin_migration_grants where user_id = u for update;
  if not found or p_digest is distinct from migration.backup_digest then
    raise exception 'This account has no matching legacy migration grant.' using errcode = '42501';
  end if;
  if migration.completed_at is not null then
    select * into saved from public.planner_snapshots where user_id = u;
    if not found then raise exception 'Migration receipt has no saved data. Contact support.' using errcode = '55000'; end if;
    return jsonb_build_object('payload',saved.payload,'revision',saved.revision,'digest',migration.backup_digest);
  end if;
  if exists(select 1 from public.planner_snapshots where user_id = u) then
    raise exception 'Existing account settings will not be overwritten.' using errcode = '55000';
  end if;
  perform private.validate_snapshot(p_payload);
  actual_digest := encode(extensions.digest(convert_to(p_payload,'UTF8'),'sha256'),'hex');
  if actual_digest <> migration.backup_digest then
    raise exception 'Legacy backup does not match its trusted digest.' using errcode = '22023';
  end if;
  insert into public.planner_snapshots(user_id,payload,revision) values(u,p_payload,1);
  select * into saved from public.planner_snapshots where user_id = u;
  -- Read back and compare exact UTF-8 bytes before atomically recording completion.
  if saved.payload is distinct from p_payload or
    encode(extensions.digest(convert_to(saved.payload,'UTF8'),'sha256'),'hex') <> migration.backup_digest then
    raise exception 'Migration comparison failed; no data was committed.' using errcode = '55000';
  end if;
  update private.admin_migration_grants set completed_at = now(), migrated_revision = saved.revision where user_id = u;
  return jsonb_build_object('payload',saved.payload,'revision',saved.revision,'digest',migration.backup_digest);
end;
$$;

-- Reserve before signup/first login, so defaults cannot race the existing-data migration.
-- A reservation conveys no role or access to settings and is never readable by the app.
create function private.reserve_admin_migration(p_approved_email text,p_backup_digest text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_email text := lower(trim(p_approved_email)); old_digest text;
begin
  if v_email is null or v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    or p_backup_digest is null or p_backup_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid trusted migration reservation.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_email, 719));
  select backup_digest into old_digest from private.migration_reservations where email = v_email;
  if found and old_digest <> p_backup_digest then
    raise exception 'A different backup is already reserved for this email.' using errcode = '55000';
  end if;
  if old_digest is null and exists(select 1 from auth.users u join public.planner_snapshots s
    on s.user_id = u.id where lower(u.email) = v_email) then
    raise exception 'This account already has saved settings; migration refused.' using errcode = '55000';
  end if;
  insert into private.migration_reservations(email,backup_digest) values(v_email,p_backup_digest)
    on conflict(email) do nothing;
  return jsonb_build_object('digest',p_backup_digest,'reserved',true);
end;
$$;

-- Trusted operator SQL only. It neither creates users nor changes any password.
create function private.prepare_admin_migration(p_user_id uuid,p_approved_email text,p_backup_digest text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare account auth.users%rowtype; old_grant private.admin_migration_grants%rowtype;
begin
  select * into account from auth.users where id = p_user_id;
  if not found or p_approved_email is null or trim(p_approved_email) = ''
    or lower(account.email) <> lower(p_approved_email)
    or account.email_confirmed_at is null or coalesce(account.is_anonymous,false)
    or account.deleted_at is not null or account.encrypted_password is null or account.encrypted_password = '' then
    raise exception 'The approved account must already own a verified email and password.' using errcode = '42501';
  end if;
  if p_backup_digest is null or p_backup_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid trusted backup digest.' using errcode = '22023';
  end if;
  if not exists(select 1 from private.migration_reservations r
    where r.email = lower(trim(p_approved_email)) and r.backup_digest = p_backup_digest) then
    raise exception 'A matching trusted reservation is required before binding.' using errcode = '42501';
  end if;
  perform private.lock_planner(p_user_id);
  select * into old_grant from private.admin_migration_grants where user_id = p_user_id;
  if found and old_grant.backup_digest <> p_backup_digest then
    raise exception 'A different backup is already bound to this account.' using errcode = '55000';
  end if;
  if old_grant.user_id is null and exists(select 1 from public.planner_snapshots where user_id = p_user_id) then
    raise exception 'This account already has saved settings; migration refused.' using errcode = '55000';
  end if;
  insert into private.account_roles(user_id,role) values(p_user_id,'admin') on conflict(user_id) do nothing;
  insert into private.admin_migration_grants(user_id,backup_digest) values(p_user_id,p_backup_digest) on conflict(user_id) do nothing;
  return jsonb_build_object('user_id',p_user_id,'digest',p_backup_digest,'completed',old_grant.completed_at is not null);
end;
$$;

-- Private elevated implementations are callable only through explicitly granted, guarded methods.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.verified_password_session(), private.planner_load(),
  private.planner_save(text,bigint), private.planner_migration_status(),
  private.planner_migrate_legacy(text,text) to authenticated;

create function public.planner_load() returns jsonb language sql stable security invoker
set search_path = '' as $$ select private.planner_load(); $$;
create function public.planner_save(p_payload text,p_expected_revision bigint) returns jsonb
language sql volatile security invoker set search_path = ''
as $$ select private.planner_save(p_payload,p_expected_revision); $$;
create function public.planner_migration_status() returns jsonb language sql stable security invoker
set search_path = '' as $$ select private.planner_migration_status(); $$;
create function public.planner_migrate_legacy(p_payload text,p_digest text) returns jsonb
language sql volatile security invoker set search_path = ''
as $$ select private.planner_migrate_legacy(p_payload,p_digest); $$;
revoke all on function public.planner_load(), public.planner_save(text,bigint),
  public.planner_migration_status(), public.planner_migrate_legacy(text,text) from public, anon;
grant execute on function public.planner_load(), public.planner_save(text,bigint),
  public.planner_migration_status(), public.planner_migrate_legacy(text,text) to authenticated;
