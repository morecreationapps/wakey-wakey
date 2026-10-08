-- Add the written ISO account date preference; all other validation stays unchanged.
-- The source hashes below describe public function code, not user data.
-- CREATE OR REPLACE keeps this function's OID, owner and existing ACL.
do $written_iso$
declare
  validator_oid oid := pg_catalog.to_regprocedure('private.validate_snapshot(text)');
  before_source text;
  before_metadata jsonb;
  definition text;
  expected_source text;
  after_source text;
  after_metadata jsonb;
begin
  if validator_oid is null then
    raise exception 'Expected account snapshot validator is missing.';
  end if;
  select p.prosrc, pg_catalog.to_jsonb(p) - 'prosrc' - 'prosqlbody'
    into before_source, before_metadata
    from pg_catalog.pg_proc p where p.oid = validator_oid;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid = validator_oid and p.prokind = 'f' and l.lanname = 'plpgsql'
      and p.provolatile = 's' and not p.prosecdef and not p.proisstrict
      and p.prorettype = 'pg_catalog.void'::pg_catalog.regtype
      and pg_catalog.oidvectortypes(p.proargtypes) = 'text'
      and p.proconfig = array['search_path=""']::text[]
  ) or pg_catalog.has_function_privilege('anon', validator_oid, 'EXECUTE')
    or pg_catalog.has_function_privilege('authenticated', validator_oid, 'EXECUTE')
    or exists (
      select 1 from pg_catalog.pg_proc p,
        lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      where p.oid = validator_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ) then
    raise exception 'Unexpected snapshot validator attributes or client privileges.';
  end if;
  if pg_catalog.md5(before_source) = '6bc4e6a11bef1255ebbc72bb954e1223' then
    return; -- Safe repeated deployment: the exact expanded validator already exists.
  end if;
  if pg_catalog.md5(before_source) <> '2c7894f9922608526bd412e299d2ff0e' then
    raise exception 'Unexpected snapshot validator source; review before applying preferences.';
  end if;
  expected_source := pg_catalog.replace(before_source,
    $old_date$perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO','LONG']);$old_date$,
    $new_date$perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO','LONG','LONG_ISO']);$new_date$);
  definition := pg_catalog.replace(pg_catalog.pg_get_functiondef(validator_oid),
    $old_date$perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO','LONG']);$old_date$,
    $new_date$perform private.check_choice(settings->'dateFormat','settings.dateFormat',array['UK','ISO','LONG','LONG_ISO']);$new_date$);
  execute definition;
  select p.prosrc, pg_catalog.to_jsonb(p) - 'prosrc' - 'prosqlbody'
    into after_source, after_metadata
    from pg_catalog.pg_proc p where p.oid = validator_oid;
  if after_source is distinct from expected_source or pg_catalog.md5(after_source) <> '6bc4e6a11bef1255ebbc72bb954e1223'
    or after_metadata is distinct from before_metadata then
    raise exception 'Preference update changed unexpected validator source or metadata.';
  end if;
end;
$written_iso$;
