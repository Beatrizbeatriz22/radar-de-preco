-- Lojas que bloqueiam a nuvem: a oferta fica marcada e quem lê é o computador da pessoa (ponte).
alter table public.ofertas add column so_computador boolean not null default false;
