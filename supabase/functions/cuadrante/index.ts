// Guarda y sirve los cuadrantes semanales de Carretillas L1.
// GET  -> { semanas: [...] } (más reciente primero)
// POST -> { pin, anio, kw, datos } publica o reemplaza la semana indicada.
// POST -> { pin, anio, kw, accion: "borrar" } borra la semana indicada.
// POST -> { accion: "suscribir" | "desuscribir", suscripcion } avisos push al publicar.
// POST -> { pin, accion: "comprobar" } solo comprueba la clave (para entrar en "Hacer cuadrante").
// Al publicar se puede mandar también { equipo: [...] } con la lista de carretilleros.
// POST -> { pin, accion: "codigo_guardar", codigo: { id?, faena, nombre, codigo } } guarda un código compartido.
// POST -> { pin, accion: "codigo_borrar", id } borra un código compartido.
// POST -> { pin, accion: "reserva", oficial, reserva, faena, avisar } pone una máquina de reserva.
// POST -> { pin, accion: "quitar_reserva", oficial, avisar } vuelve la máquina oficial.
// POST -> { pin, accion: "ficha_guardar", faena, descripcion, mantener: [path], nuevas: [jpeg base64] } ficha de faena.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

const BUCKET = "cuadrantes";
const ARCHIVO = "cuadrantes.json";
const MAX_SEMANAS = 12;
const SUSCRIPCIONES = "suscripciones.json";
const EQUIPO = "equipo.json";
const CODIGOS = "codigos.json";
const RESERVAS = "reservas.json";
const FICHAS = "fichas.json";
// Las fotos de las fichas van en un bucket público para que se vean sin pedir nada.
const BUCKET_FOTOS = "fichas";
const MAX_FOTOS = 6;
const MAX_CODIGOS = 3000;
const MAX_SUSCRIPCIONES = 1000;
// Quien falla la clave 10 veces en 15 minutos se queda bloqueado ese rato (por conexión).
const FALLOS = "fallos.json";
const MAX_FALLOS = 10;
const VENTANA_FALLOS = 15 * 60 * 1000;
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
type Codigo = { id: string; faena: string; nombre: string; codigo: string };
type Reserva = { oficial: string; reserva: string; faena: string; desde: string };
type Ficha = { faena: string; descripcion: string; fotos: { path: string; url: string }[]; actualizado: string };

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

async function guardarLista(archivo: string, lista: unknown) {
  // Si el bucket ya existe devuelve un error que no importa.
  await supabase.storage.createBucket(BUCKET, { public: false });
  const { error } = await supabase.storage.from(BUCKET).upload(
    archivo,
    new Blob([JSON.stringify(lista)], { type: "application/json" }),
    { upsert: true, contentType: "application/json", cacheControl: "0" },
  );
  if (error) throw error;
}

// Intentos con clave en curso, en memoria: así también se frenan las peticiones lanzadas a la vez,
// que leerían el archivo antes de que ninguna llegue a guardarlo.
const intentos = new Map<string, number[]>();

function ipDe(req: Request) {
  const reenviada = req.headers.get("x-forwarded-for")?.split(",")[0].trim();
  return reenviada || req.headers.get("cf-connecting-ip") || "desconocida";
}

const recientes = (lista: number[] | undefined, ahora: number) => (lista ?? []).filter((t) => ahora - t < VENTANA_FALLOS);

async function leerFallos(): Promise<Record<string, number[]>> {
  const { data, error } = await supabase.storage.from(BUCKET).download(FALLOS);
  if (error || !data) return {};
  try {
    const fallos = JSON.parse(await data.text());
    return fallos && typeof fallos === "object" && !Array.isArray(fallos) ? fallos : {};
  } catch {
    return {};
  }
}

async function guardarFallo(ip: string, lista: number[]) {
  const ahora = Date.now();
  const fallos = await leerFallos();
  const limpio: Record<string, number[]> = {};
  for (const [clave, valor] of Object.entries(fallos)) {
    const r = recientes(valor, ahora);
    if (r.length) limpio[clave] = r;
  }
  limpio[ip] = [...new Set([...recientes(limpio[ip], ahora), ...lista])].slice(-MAX_FALLOS * 2);
  await guardarLista(FALLOS, limpio);
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
async function avisarATodos(aviso: { title: string; body: string; url: string }, topic = "cuadrante") {
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
        topic,
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
const claveMaquina = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[^a-z0-9]/gi, "").toLowerCase();

// El código se guarda tal cual (con sus espacios); solo se admite lo que cabe en un Code 128.
function limpiarCodigo(c: any): Codigo | null {
  const codigo = String(c?.codigo ?? "").slice(0, 80);
  const faena = texto(c?.faena, 80);
  if (!faena || !codigo.trim() || !/^[\x20-\x7e]+$/.test(codigo)) return null;
  const id = /^[A-Za-z0-9_-]{6,40}$/.test(String(c?.id ?? "")) ? String(c.id) : crypto.randomUUID();
  return { id, faena, nombre: texto(c?.nombre, 80), codigo };
}

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
      const [semanas, equipo, codigos, reservas, fichas] = await Promise.all([
        leerSemanas(),
        leerLista<string>(EQUIPO),
        leerLista<Codigo>(CODIGOS),
        leerLista<Reserva>(RESERVAS),
        leerLista<Ficha>(FICHAS),
      ]);
      return responder({ semanas, equipo, codigos, reservas, fichas });
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

      // Se apunta el intento antes de cualquier espera; si la clave es buena, se quita.
      const ip = ipDe(req);
      const ahora = Date.now();
      const enMemoria = recientes(intentos.get(ip), ahora);
      if (enMemoria.length >= MAX_FALLOS) return responder({ estado: "bloqueado" }, 429);
      enMemoria.push(ahora);
      intentos.set(ip, enMemoria);
      const guardados = recientes((await leerFallos())[ip], ahora);
      if (guardados.length >= MAX_FALLOS) return responder({ estado: "bloqueado" }, 429);

      if (typeof body.pin !== "string" || (await sha256(PIN_SAL + body.pin)) !== PIN_HASH) {
        await guardarFallo(ip, [...guardados, ...enMemoria]);
        // Retraso para que probar claves al azar sea lento.
        await new Promise((r) => setTimeout(r, 1500));
        return responder({ estado: "pin" }, 403);
      }
      intentos.set(ip, enMemoria.filter((t) => t !== ahora));

      if (body.accion === "comprobar") return responder({ estado: "ok" });

      // Máquina de reserva: se guarda por máquina oficial, así sigue a la máquina aunque cambie de faena.
      if (body.accion === "reserva" || body.accion === "quitar_reserva") {
        const oficial = texto(body.oficial, 60);
        if (!oficial) return responder({ estado: "datos" }, 400);
        const reservas = await leerLista<Reserva>(RESERVAS);
        const anterior = reservas.find((r) => claveMaquina(r.oficial) === claveMaquina(oficial));
        const lista = reservas.filter((r) => r !== anterior);
        let aviso;
        if (body.accion === "reserva") {
          const reserva = texto(body.reserva, 60);
          if (!reserva) return responder({ estado: "datos" }, 400);
          const faena = texto(body.faena, 80);
          lista.push({ oficial, reserva, faena, desde: new Date().toISOString() });
          aviso = {
            title: `Máquina de reserva${faena ? ` · ${faena}` : ""}`,
            body: `La ${oficial} está fuera de servicio. Usa la reserva ${reserva}.`,
            url: "./",
          };
        } else {
          if (!anterior) return responder({ estado: "no_existe" }, 404);
          aviso = {
            title: `Vuelve la máquina oficial${anterior.faena ? ` · ${anterior.faena}` : ""}`,
            body: `Ya está de vuelta la ${anterior.oficial}. Deja de usar la reserva ${anterior.reserva}.`,
            url: "./",
          };
        }
        await guardarLista(RESERVAS, lista.slice(-50));
        let avisados = 0;
        if (body.avisar) {
          try {
            avisados = await avisarATodos(aviso, "reserva");
          } catch (err) {
            console.error("no se pudieron enviar los avisos", err);
          }
        }
        return responder({ estado: "ok", avisados, reservas: lista.slice(-50) });
      }

      // Ficha de faena: descripción y fotos (JPEG ya reducidas en el móvil).
      if (body.accion === "ficha_guardar") {
        const faena = texto(body.faena, 80);
        if (!faena) return responder({ estado: "datos" }, 400);
        const fichas = await leerLista<Ficha>(FICHAS);
        const anterior = fichas.find((f) => claveMaquina(f.faena) === claveMaquina(faena));
        const mantener = new Set((Array.isArray(body.mantener) ? body.mantener : []).map(String));
        const fotos = (anterior?.fotos ?? []).filter((f) => mantener.has(f.path));
        const nuevas = (Array.isArray(body.nuevas) ? body.nuevas : []).slice(0, Math.max(0, MAX_FOTOS - fotos.length));
        if (nuevas.length) await supabase.storage.createBucket(BUCKET_FOTOS, { public: true });
        for (const nueva of nuevas) {
          const b64 = String(nueva ?? "").replace(/^data:image\/jpeg;base64,/, "");
          if (b64.length > 2_800_000 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) continue;
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue; // solo JPEG
          const path = `${crypto.randomUUID()}.jpg`;
          const { error } = await supabase.storage.from(BUCKET_FOTOS).upload(path, bytes, {
            contentType: "image/jpeg",
            cacheControl: "31536000",
          });
          if (error) throw error;
          fotos.push({ path, url: supabase.storage.from(BUCKET_FOTOS).getPublicUrl(path).data.publicUrl });
        }
        const quitadas = (anterior?.fotos ?? []).filter((f) => !mantener.has(f.path)).map((f) => f.path);
        if (quitadas.length) await supabase.storage.from(BUCKET_FOTOS).remove(quitadas);
        const descripcion = String(body.descripcion ?? "").trim().slice(0, 4000);
        const lista = fichas.filter((f) => f !== anterior);
        if (descripcion || fotos.length) lista.push({ faena, descripcion, fotos, actualizado: new Date().toISOString() });
        await guardarLista(FICHAS, lista);
        return responder({ estado: "ok", fichas: lista });
      }

      if (body.accion === "codigo_guardar" || body.accion === "codigo_borrar") {
        const codigos = await leerLista<Codigo>(CODIGOS);
        if (body.accion === "codigo_borrar") {
          const id = String(body.id ?? "");
          await guardarLista(CODIGOS, codigos.filter((c) => c.id !== id));
          return responder({ estado: "ok" });
        }
        const codigo = limpiarCodigo(body.codigo);
        if (!codigo) return responder({ estado: "datos" }, 400);
        const lista = codigos.filter((c) => c.id !== codigo.id);
        lista.push(codigo);
        await guardarLista(CODIGOS, lista.slice(-MAX_CODIGOS));
        return responder({ estado: "ok", codigo });
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
