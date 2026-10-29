// Guarda y sirve los cuadrantes semanales de Carretillas L1.
// GET  -> { semanas: [...] } (más reciente primero)
// POST -> { pin, anio, kw, datos } publica o reemplaza la semana indicada.
// POST -> { pin, anio, kw, accion: "borrar" } borra la semana indicada.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "cuadrantes";
const ARCHIVO = "cuadrantes.json";
const MAX_SEMANAS = 12;
// PIN de subida: sha256(PIN_SAL + pin). Para cambiarlo basta con recalcular PIN_HASH.
const PIN_SAL = "<solo en la función desplegada>";
const PIN_HASH = "<solo en la función desplegada>";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function responder(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function sha256(texto: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Semana = { anio: number; kw: number; publicado: string; datos: unknown };

async function leerSemanas(): Promise<Semana[]> {
  const { data, error } = await supabase.storage.from(BUCKET).download(ARCHIVO);
  if (error || !data) return [];
  try {
    const lista = JSON.parse(await data.text());
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

async function guardarSemanas(lista: Semana[]) {
  // Si el bucket ya existe devuelve un error que no importa.
  await supabase.storage.createBucket(BUCKET, { public: false });
  const { error } = await supabase.storage.from(BUCKET).upload(
    ARCHIVO,
    new Blob([JSON.stringify(lista)], { type: "application/json" }),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (error) throw error;
}

const texto = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

// Reconstruye los datos con solo los campos esperados y longitudes acotadas.
function limpiarDatos(datos: any) {
  if (!datos || !Array.isArray(datos.filas) || !Array.isArray(datos.dias)) return null;
  const dias = datos.dias.slice(0, 7).map((d: unknown) => texto(d, 30));
  const filas = datos.filas.slice(0, 40).map((f: any) => ({
    codigo: texto(f?.codigo, 80),
    nota: texto(f?.nota, 80),
    personas: (Array.isArray(f?.personas) ? f.personas : []).slice(0, 7).map((p: unknown) => texto(p, 60)),
    tractora: texto(f?.tractora, 60),
    id: texto(f?.id, 80),
  })).filter((f: any) => f.codigo);
  if (!dias.length || !filas.length) return null;
  return { dias, filas };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    if (req.method === "GET") {
      return responder({ semanas: await leerSemanas() });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return responder({ estado: "datos" }, 400);

      if (typeof body.pin !== "string" || (await sha256(PIN_SAL + body.pin)) !== PIN_HASH) {
        // Retraso para que probar PINs al azar sea lento.
        await new Promise((r) => setTimeout(r, 1500));
        return responder({ estado: "pin" }, 403);
      }

      const anio = Number(body.anio);
      const kw = Number(body.kw);
      if (!Number.isInteger(anio) || anio < 2024 || anio > 2100 || !Number.isInteger(kw) || kw < 1 || kw > 53) {
        return responder({ estado: "datos" }, 400);
      }

      const semanas = await leerSemanas();
      const lista = semanas.filter((s) => !(s.anio === anio && s.kw === kw));

      if (body.accion === "borrar") {
        if (lista.length === semanas.length) return responder({ estado: "no_existe" }, 404);
        await guardarSemanas(lista);
        return responder({ estado: "ok" });
      }

      const datos = limpiarDatos(body.datos);
      if (!datos) return responder({ estado: "datos" }, 400);
      lista.push({ anio, kw, publicado: new Date().toISOString(), datos });
      lista.sort((a, b) => (b.anio * 100 + b.kw) - (a.anio * 100 + a.kw));
      await guardarSemanas(lista.slice(0, MAX_SEMANAS));
      return responder({ estado: "ok" });
    }

    return responder({ estado: "metodo" }, 405);
  } catch (err) {
    console.error(err);
    return responder({ estado: "error" }, 500);
  }
});
