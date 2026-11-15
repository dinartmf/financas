-- =====================================================================
-- Controle Financeiro — estrutura do banco e regras de segurança
-- Rode este script inteiro no Supabase: SQL Editor → New query → Run
-- =====================================================================

-- 1) Estado atual de cada usuário (uma linha por usuário)
create table if not exists public.estado (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  dados      jsonb not null,
  versao     integer not null default 1,
  updated_at timestamptz not null default now(),
  constraint estado_dados_objeto  check (jsonb_typeof(dados) = 'object'),
  constraint estado_dados_tamanho check (pg_column_size(dados) < 2000000)  -- ~2 MB
);

-- 2) Histórico automático (últimas 50 versões) para recuperação
create table if not exists public.estado_historico (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users(id) on delete cascade,
  dados     jsonb not null,
  versao    integer not null,
  salvo_em  timestamptz not null default now()
);
create index if not exists estado_historico_user_idx on public.estado_historico (user_id, id desc);

-- 3) Row Level Security: cada usuário só enxerga a própria linha,
--    e somente com sessão verificada em duas etapas (aal2).
alter table public.estado            enable row level security;
alter table public.estado            force  row level security;
alter table public.estado_historico  enable row level security;
alter table public.estado_historico  force  row level security;

drop policy if exists estado_select on public.estado;
drop policy if exists estado_insert on public.estado;
drop policy if exists estado_update on public.estado;
drop policy if exists historico_select on public.estado_historico;

create policy estado_select on public.estado
  for select to authenticated
  using ( (select auth.uid()) = user_id and (select auth.jwt() ->> 'aal') = 'aal2' );

create policy estado_insert on public.estado
  for insert to authenticated
  with check ( (select auth.uid()) = user_id and (select auth.jwt() ->> 'aal') = 'aal2' );

create policy estado_update on public.estado
  for update to authenticated
  using      ( (select auth.uid()) = user_id and (select auth.jwt() ->> 'aal') = 'aal2' )
  with check ( (select auth.uid()) = user_id and (select auth.jwt() ->> 'aal') = 'aal2' );

-- Sem política de DELETE: ninguém apaga a linha pela API.

create policy historico_select on public.estado_historico
  for select to authenticated
  using ( (select auth.uid()) = user_id and (select auth.jwt() ->> 'aal') = 'aal2' );

-- Histórico só é gravado pelo gatilho abaixo (nunca pela API).

-- 4) Privilégios mínimos
revoke all on public.estado, public.estado_historico from anon, authenticated;
grant select, insert, update (dados) on public.estado to authenticated;
grant select on public.estado_historico to authenticated;

-- 5) Gatilhos: versão/datas controladas pelo servidor + histórico
create or replace function public.estado_before_insert()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.user_id    := auth.uid();
  new.versao     := 1;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.estado_before_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.estado_historico (user_id, dados, versao)
  values (old.user_id, old.dados, old.versao);

  delete from public.estado_historico h
   where h.user_id = old.user_id
     and h.id not in (select id from public.estado_historico
                       where user_id = old.user_id order by id desc limit 50);

  new.user_id    := old.user_id;
  new.versao     := old.versao + 1;
  new.updated_at := now();
  return new;
end $$;

revoke all on function public.estado_before_insert() from public, anon, authenticated;
revoke all on function public.estado_before_update() from public, anon, authenticated;

drop trigger if exists estado_bi on public.estado;
drop trigger if exists estado_bu on public.estado;
create trigger estado_bi before insert on public.estado for each row execute function public.estado_before_insert();
create trigger estado_bu before update on public.estado for each row execute function public.estado_before_update();
