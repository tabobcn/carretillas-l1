// Guarda y sirve los cuadrantes semanales de Carretillas L1.
// GET  -> { semanas: [...] } (más reciente primero)
// POST -> { pin, anio, kw, datos } publica o reemplaza la semana indicada.
// POST -> { pin, anio, kw, accion: "borrar" } borra la semana indicada.
// POST -> { accion: "suscribir" | "desuscribir", suscripcion } avisos push al publicar.
// POST -> { pin, accion: "comprobar" } solo comprueba la clave (para entrar en "Hacer cuadrante").
// Al publicar se puede mandar también { equipo: [...] } con la lista de carretilleros.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const BUCKET = "cuadrantes";
const ARCHIVO = "cuadrantes.json";
const MAX_SEMANAS = 12;
const SUSCRIPCIONES = "suscripciones.json";
const EQUIPO = "equipo.json";
const MAX_SUSCRIPCIONES = 1000;
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
// Claves VAPID de los avisos (la pública también está en index.html).
const VAPID = { publicKey: "<solo en la función desplegada>", privateKey: "<solo en la función desplegada>" };
const CONTACTO = "https://carretillasl1.netlify.app";
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
type Suscripcion = { endpoint: string; keys: { p256dh: string; auth: string } };

async function leerLista<T>(archivo: string): Promise<T[]> {
  const { data, error } = await supabase.storage.from(BUCKET).download(archivo);
  if (error || !data) return [];
  try {
    const lista = JSON.parse(await data.text());
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

async function guardarLista(archivo: string, lista: unknown[]) {
  // Si el bucket ya existe devuelve un error que no importa.
  await supabase.storage.createBucket(BUCKET, { public: false });
  const { error } = await supabase.storage.from(BUCKET).upload(
    archivo,
    new Blob([JSON.stringify(lista)], { type: "application/json" }),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (error) throw error;
}

const leerSemanas = () => leerLista<Semana>(ARCHIVO);
const guardarSemanas = (lista: Semana[]) => guardarLista(ARCHIVO, lista);

// Solo se aceptan suscripciones de los servicios de avisos de los navegadores.
const SERVICIOS_PUSH = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];

function limpiarSuscripcion(s: any): Suscripcion | null {
  const endpoint = String(s?.endpoint ?? "");
  const p256dh = String(s?.keys?.p256dh ?? "");
  const auth = String(s?.keys?.auth ?? "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || endpoint.length > 1000 || !SERVICIOS_PUSH.some((h) => h.test(url.hostname))) return null;
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function lunesDeSemana(anio: number, kw: number) {
  const d = new Date(Date.UTC(anio, 0, 4));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1) + (kw - 1) * 7);
  return d;
}
const fechaCorta = (d: Date) => `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;

// Envía el aviso a todos los suscritos y quita las suscripciones que ya no existen.
async function avisarATodos(aviso: { title: string; body: string; url: string }) {
  const suscripciones = await leerLista<Suscripcion>(SUSCRIPCIONES);
  if (!suscripciones.length) return 0;
  const vapidKeys = await webpush.importVapidKeys(VAPID as unknown as webpush.ExportedVapidKeys);
  const servidor = await webpush.ApplicationServer.new({ contactInformation: CONTACTO, vapidKeys });
  const caducadas = new Set<string>();
  let enviados = 0;
  await Promise.all(suscripciones.map(async (s) => {
    try {
      await servidor.subscribe(s).pushTextMessage(JSON.stringify(aviso), {
        urgency: webpush.Urgency.High,
        ttl: 172800,
        topic: "cuadrante",
      });
      enviados++;
    } catch (err) {
      const estado = (err as webpush.PushMessageError)?.response?.status;
      if (estado === 404 || estado === 410) caducadas.add(s.endpoint);
      console.error("aviso fallido", estado ?? String(err));
    }
  }));
  if (caducadas.size) {
    const actuales = await leerLista<Suscripcion>(SUSCRIPCIONES);
    await guardarLista(SUSCRIPCIONES, actuales.filter((s) => !caducadas.has(s.endpoint)));
  }
  console.log(`avisos: ${enviados} enviados de ${suscripciones.length}`);
  return enviados;
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
      const [semanas, equipo] = await Promise.all([leerSemanas(), leerLista<string>(EQUIPO)]);
      return responder({ semanas, equipo });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return responder({ estado: "datos" }, 400);

      if (body.accion === "suscribir" || body.accion === "desuscribir") {
        const suscripcion = limpiarSuscripcion(body.suscripcion);
        if (!suscripcion) return responder({ estado: "datos" }, 400);
        const lista = (await leerLista<Suscripcion>(SUSCRIPCIONES)).filter((s) => s.endpoint !== suscripcion.endpoint);
        if (body.accion === "suscribir") lista.push(suscripcion);
        await guardarLista(SUSCRIPCIONES, lista.slice(-MAX_SUSCRIPCIONES));
        return responder({ estado: "ok" });
      }

      if (typeof body.pin !== "string" || (await sha256(PIN_SAL + body.pin)) !== PIN_HASH) {
        // Retraso para que probar PINs al azar sea lento.
        await new Promise((r) => setTimeout(r, 1500));
        return responder({ estado: "pin" }, 403);
      }

      if (body.accion === "comprobar") return responder({ estado: "ok" });

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
      const yaExistia = lista.length < semanas.length;
      lista.push({ anio, kw, publicado: new Date().toISOString(), datos });
      lista.sort((a, b) => (b.anio * 100 + b.kw) - (a.anio * 100 + a.kw));
      await guardarSemanas(lista.slice(0, MAX_SEMANAS));
      if (Array.isArray(body.equipo)) {
        const equipo = [...new Set(body.equipo.slice(0, 100).map((n: unknown) => texto(n, 60)).filter(Boolean))];
        await guardarLista(EQUIPO, equipo);
      }

      const lunes = lunesDeSemana(anio, kw);
      const viernes = new Date(lunes.getTime() + 4 * 86400000);
      let avisados = 0;
      try {
        avisados = await avisarATodos({
          title: yaExistia ? `Cuadrante KW ${kw} actualizado` : `Nuevo cuadrante: KW ${kw}`,
          body: `Del ${fechaCorta(lunes)} al ${fechaCorta(viernes)}. Toca para ver qué te toca.`,
          url: "./#cuadrante",
        });
      } catch (err) {
        console.error("no se pudieron enviar los avisos", err);
      }
      return responder({ estado: "ok", avisados });
    }

    return responder({ estado: "metodo" }, 405);
  } catch (err) {
    console.error(err);
    return responder({ estado: "error" }, 500);
  }
});
