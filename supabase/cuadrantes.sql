create extension if not exists pgcrypto with schema extensions;

-- Un cuadrante por semana ISO (KW). Lectura pública; escritura solo vía publicar_cuadrante().
create table public.cuadrantes (
  anio int not null check (anio between 2024 and 2100),
  kw int not null check (kw between 1 and 53),
  datos jsonb not null,
  publicado timestamptz not null default now(),
  primary key (anio, kw)
);
alter table public.cuadrantes enable row level security;
create policy "cuadrantes visibles para todos" on public.cuadrantes for select to anon, authenticated using (true);
revoke all on public.cuadrantes from anon, authenticated;
grant select on public.cuadrantes to anon, authenticated;

create schema if not exists privado;
revoke all on schema privado from public, anon, authenticated;

create table privado.ajustes (
  clave text primary key,
  valor text not null
);
create table privado.intentos_fallidos (
  momento timestamptz not null default now()
);

create or replace function public.publicar_cuadrante(p_pin text, p_anio int, p_kw int, p_datos jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  hash text;
begin
  -- Frena a quien pruebe PINs al azar: 10 fallos en 15 minutos bloquean la subida un rato.
  if (select count(*) from privado.intentos_fallidos where momento > now() - interval '15 minutes') >= 10 then
    return 'bloqueado';
  end if;

  select valor into hash from privado.ajustes where clave = 'pin_subida';
  if hash is null or p_pin is null or extensions.crypt(p_pin, hash) <> hash then
    insert into privado.intentos_fallidos default values;
    delete from privado.intentos_fallidos where momento < now() - interval '1 day';
    return 'pin';
  end if;

  if p_kw not between 1 and 53
     or p_anio not between 2024 and 2100
     or jsonb_typeof(p_datos -> 'filas') is distinct from 'array'
     or jsonb_array_length(p_datos -> 'filas') = 0
     or pg_column_size(p_datos) > 200000 then
    return 'datos';
  end if;

  insert into public.cuadrantes (anio, kw, datos, publicado)
  values (p_anio, p_kw, p_datos, now())
  on conflict (anio, kw) do update set datos = excluded.datos, publicado = now();

  return 'ok';
end;
$$;

revoke all on function public.publicar_cuadrante(text, int, int, jsonb) from public;
grant execute on function public.publicar_cuadrante(text, int, int, jsonb) to anon, authenticated;
