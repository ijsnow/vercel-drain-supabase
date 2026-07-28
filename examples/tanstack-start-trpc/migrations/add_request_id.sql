-- Your application tables need a place for the stamp. Nullable text,
-- indexed, no foreign key — logs are ephemeral, your rows are not.
alter table public.reservations add column if not exists request_id text;

create index if not exists reservations_request_id_idx
  on public.reservations (request_id)
  where request_id is not null;
