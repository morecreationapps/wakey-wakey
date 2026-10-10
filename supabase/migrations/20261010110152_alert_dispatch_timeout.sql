begin;

-- Allow the bounded four-worker Edge sender to finish ordinary due bursts.
-- Reuse pg_get_functiondef so ownership, security mode, search_path, signature
-- and existing EXECUTE grants survive the replacement unchanged.
do $$
declare definition text; expected text := 'timeout_milliseconds:=15000';
begin
  select pg_get_functiondef('private.dispatch_wakey_reminders()'::regprocedure)
    into definition;
  if (length(definition) - length(replace(definition, expected, ''))) / length(expected) <> 1 then
    raise exception 'Expected one original reminder dispatcher timeout; review the function before applying this migration';
  end if;
  execute replace(definition, expected, 'timeout_milliseconds:=50000');
end;
$$;

commit;
