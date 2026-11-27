-- Ajustes do banco aplicados a cada publicação (pode rodar várias vezes sem problema).
-- A publicação (GitHub Actions) manda este arquivo para o Supabase usando o token de acesso.

alter table public.ofertas add column if not exists so_computador boolean not null default false;
alter table public.ofertas add column if not exists da_busca boolean not null default false;

alter table public.produtos add column if not exists preco_min double precision;
alter table public.produtos add column if not exists busca text;
alter table public.produtos add column if not exists modo text not null default 'exato';
alter table public.produtos add column if not exists foto_lembrete text;
alter table public.produtos add column if not exists buscado_em timestamptz;
alter table public.produtos add column if not exists buscado_computador_em timestamptz;

-- Pesquisas por texto: a nuvem guarda o que achou e o computador completa com as lojas que bloqueiam a nuvem
create table if not exists public.buscas (
  id bigint generated always as identity primary key,
  usuario uuid not null default auth.uid() references auth.users on delete cascade,
  termo text not null,
  criado_em timestamptz not null default now(),
  resultados jsonb not null default '[]',
  computador_em timestamptz
);
alter table public.buscas enable row level security;
drop policy if exists buscas_dono_le on public.buscas;
create policy buscas_dono_le on public.buscas for select to authenticated using (usuario = (select auth.uid()));
create index if not exists buscas_pendentes on public.buscas (computador_em, criado_em);
