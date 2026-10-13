-- Prepared only. Deploy with the secured wakey-delete-account Edge endpoint.
begin;

-- Validate the provider's signed password AMR and the live session. This is a
-- read-only assertion; only the Edge Function's service client deletes users.
create function public.planner_assert_account_deletion() returns boolean
language sql stable security invoker set search_path = '' as $$
  select (select private.verified_password_session()) and exists (
    select 1 from jsonb_array_elements(auth.jwt()->'amr') item
    where item->>'method'='password'
      and (item->>'timestamp')::numeric >= extract(epoch from now()) - 300
      and (item->>'timestamp')::numeric <= extract(epoch from now()) + 30
  );
$$;
revoke all on function public.planner_assert_account_deletion() from public, anon;
grant execute on function public.planner_assert_account_deletion() to authenticated;

-- Every UUID-owned application table already uses ON DELETE CASCADE. The
-- legacy migration reservation is email-keyed, so remove it within the same
-- Auth hard-delete transaction. No client gets access to this trigger helper.
create function private.remove_deleted_account_reservation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.migration_reservations where email = lower(trim(old.email));
  return old;
end;
$$;
revoke all on function private.remove_deleted_account_reservation() from public, anon, authenticated;
create trigger wakey_remove_deleted_account_reservation
after delete on auth.users for each row
execute function private.remove_deleted_account_reservation();

commit;
