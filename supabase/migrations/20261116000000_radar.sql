-- Radar de Preço: tabelas na nuvem (Supabase / Postgres).
-- Cada linha tem o dono (usuario). As regras de segurança (RLS) garantem que cada pessoa só vê o que é dela.

create table public.produtos (
  id bigint generated always as identity primary key,
  usuario uuid not null default auth.uid() references auth.users on delete cascade,
  titulo text not null,
  foto text,
  ean text,
  preco_alvo double precision,
  criado_em timestamptz not null default now()
);

create table public.ofertas (
  id bigint generated always as identity primary key,
  produto_id bigint not null references public.produtos on delete cascade,
  usuario uuid not null references auth.users on delete cascade,
  link text not null,
  loja text not null,
  titulo text,
  vendedor text,
  ean text,
  criado_em timestamptz not null default now(),
  ultima_verificacao timestamptz,
  ultimo_erro text,
  unique (usuario, link)
);
create index on public.ofertas (produto_id);
create index on public.ofertas (ultima_verificacao);

create table public.precos (
  id bigint generated always as identity primary key,
  oferta_id bigint not null references public.ofertas on delete cascade,
  usuario uuid not null references auth.users on delete cascade,
  quando timestamptz not null default now(),
  preco double precision,
  preco_pix double precision,
  disponivel boolean not null
);
create index on public.precos (oferta_id, quando);

create table public.avisos (
  id bigint generated always as identity primary key,
  produto_id bigint not null references public.produtos on delete cascade,
  usuario uuid not null references auth.users on delete cascade,
  quando timestamptz not null default now(),
  titulo text not null,
  texto text not null
);

-- Celulares/computadores que pediram notificação (Web Push)
create table public.inscricoes_push (
  id bigint generated always as identity primary key,
  usuario uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint text not null unique,
  chaves jsonb not null,
  criado_em timestamptz not null default now()
);

alter table public.produtos enable row level security;
alter table public.ofertas enable row level security;
alter table public.precos enable row level security;
alter table public.avisos enable row level security;
alter table public.inscricoes_push enable row level security;

-- Produtos: a pessoa lê, cria, edita e apaga só os seus
create policy "produtos: dono" on public.produtos for all to authenticated
  using (usuario = (select auth.uid())) with check (usuario = (select auth.uid()));

-- Lojas e preços: a pessoa lê e apaga os seus; quem grava é a função da nuvem e o verificador (com chave de serviço)
create policy "ofertas: dono lê" on public.ofertas for select to authenticated using (usuario = (select auth.uid()));
create policy "ofertas: dono apaga" on public.ofertas for delete to authenticated using (usuario = (select auth.uid()));
create policy "precos: dono lê" on public.precos for select to authenticated using (usuario = (select auth.uid()));
create policy "avisos: dono lê" on public.avisos for select to authenticated using (usuario = (select auth.uid()));

-- Inscrições de notificação: cada um cuida das suas
create policy "push: dono" on public.inscricoes_push for all to authenticated
  using (usuario = (select auth.uid())) with check (usuario = (select auth.uid()));
