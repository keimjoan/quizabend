// Raum-Server für den Online-Modus von Quizabend (Cloudflare Worker mit Durable Object).
// Leitet Ereignisse und Präsenz zwischen allen Geräten eines Raums weiter, sonst nichts.
// Der Spielstand liegt beim Gastgeber im Browser, hier wird nichts gespeichert.
// Einzige Ausnahme: Mediendateien (Bild, Audio, Video) der laufenden Runde, siehe unten. Sie werden am Rundenende gelöscht.
//
// Verbindung: wss://<server>/raum/<raum-code>?id=<geräte-id>
// Gerät → Server: {"t":"emit","topic","data"}  {"t":"presence","p":{…}}  {"t":"ping"}
// Server → Gerät: {"t":"hi","id","peers":[{id,p,at}]}  {"t":"emit","topic","data","from"}
//                 {"t":"peer","id","p","at"}  {"t":"leave","id"}  {"t":"pong"}
import { DurableObject } from 'cloudflare:workers';

const ROOM = /^\/raum\/([a-z0-9]{4,16})$/;
const ID = /^[a-z0-9]{8,24}$/;
const MAX_MSG = 16 * 1024;
const MAX_PEERS = 40;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('Quizabend-Raum-Server läuft.\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (url.pathname.startsWith('/medien')) return handleMedia(req, env, url);
    const m = url.pathname.match(ROOM);
    if (!m) return new Response('Nicht gefunden', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Nur WebSocket', { status: 426 });
    if (!ID.test(url.searchParams.get('id') || '')) return new Response('Geräte-ID fehlt', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  }
};

/* ---------- Medien (Bild, Audio, Video) nur für die laufende Runde ----------
   Der Gastgeber lädt die Dateien seiner Runde in Teilen hoch (ein Aufruf an einen Worker darf höchstens 100 MB groß sein),
   alle Spieler laden sie über /medien/<id> ab. Am Rundenende löscht der Gastgeber sie wieder, ein Löschregel im Bucket
   räumt nach einem Tag ab, falls sein Browser abgestürzt ist.
   POST /medien/<raum>?size=N        Start mit dem ersten Teil (bis 20 MiB). Bis 20 MiB ist das schon die ganze Datei.
   PUT  /medien/<id>/<n>?del=…       weitere Teile (n ab 2), jeder genau 20 MiB, der letzte der Rest
   POST /medien/<id>/fertig          {"del":…,"parts":[{"n":1,"etag":…},…]} schließt ab
   POST /medien-loeschen             Text-JSON [[id, del], …] löscht Dateien oder bricht halbe Uploads ab
   GET|HEAD /medien/<id>             Abruf mit Bereichsanfragen */
const MEDIA_NEW = /^\/medien\/([a-z0-9]{4,16})$/;
const MEDIA_ONE = /^\/medien\/([a-z0-9]{24})$/;
const MEDIA_PART = /^\/medien\/([a-z0-9]{24})\/(\d{1,3})$/;
const MEDIA_END = /^\/medien\/([a-z0-9]{24})\/fertig$/;
const MIB = 1024 * 1024;
const PART = 20 * MIB;
const MAX_SIZE = { bild: 5 * MIB, audio: 50 * MIB, video: 500 * MIB };
const MAX_NAMES = { bild: 'Bilder 5 MB', audio: 'Audiodateien 50 MB', video: 'Videos 500 MB' };
const DAY = { ip: { b: 3072 * MIB, f: 100 }, room: { b: 2048 * MIB, f: 40 }, all: { b: 20480 * MIB, f: 1000 } };
const ORIGIN = /^(https:\/\/keimjoan\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?|null)$/;
const MP4_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'mmp4'];

/* Dateityp am Anfang der Datei erkennen. Dem Typ aus dem Browser wird nicht geglaubt. SVG und HTML gibt es hier nicht. */
function sniff(b) {
  if (b.length < 12) return null;
  const s = (i, t) => [...t].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && s(1, 'PNG')) return { t: 'bild', ct: 'image/png' };
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { t: 'bild', ct: 'image/jpeg' };
  if (s(0, 'GIF87a') || s(0, 'GIF89a')) return { t: 'bild', ct: 'image/gif' };
  if (s(0, 'RIFF') && s(8, 'WEBP')) return { t: 'bild', ct: 'image/webp' };
  if (s(0, 'RIFF') && s(8, 'WAVE')) return { t: 'audio', ct: 'audio/wav' };
  if (s(0, 'OggS')) return { t: 'audio', ct: 'audio/ogg' };
  if (s(0, 'ID3') || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0)) return { t: 'audio', ct: 'audio/mpeg' };
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { t: 'video', ct: 'video/webm' };
  if (s(4, 'ftyp')) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === 'M4A ' || brand === 'M4B ') return { t: 'audio', ct: 'audio/mp4' };
    if (MP4_BRANDS.includes(brand)) return { t: 'video', ct: 'video/mp4' };
  }
  return null;
}

function rid() {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789', r = crypto.getRandomValues(new Uint8Array(24));
  return [...r].map(x => a[x % 36]).join('');
}

function corsHeaders(req) {
  const o = req.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  if (o && ORIGIN.test(o)) { h['Access-Control-Allow-Origin'] = o; h['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, PUT, OPTIONS'; h['Access-Control-Allow-Headers'] = 'content-type'; h['Access-Control-Max-Age'] = '86400'; }
  return h;
}
function reply(req, obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(req) } });
}
const fail = (req, status, fehler) => reply(req, { fehler }, status);

async function quota(env, name, add, lim) {
  const r = await env.LIMITS.get(env.LIMITS.idFromName(name)).fetch(`https://quota/?b=${add.b}&f=${add.f}&mb=${lim.b}&mf=${lim.f}`);
  return r.ok;
}

async function readUpload(env, id) {
  const o = await env.MEDIA.get('u/' + id);
  if (!o) return null;
  try { return await o.json(); } catch (e) { return null; }
}

async function readBody(req, want) {
  if (Number(req.headers.get('content-length')) !== want) return null;
  const buf = await req.arrayBuffer();
  return buf.byteLength === want ? buf : null;
}

async function handleMedia(req, env, url) {
  const path = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (!env.MEDIA) return fail(req, 503, 'Der Medienspeicher ist auf dem Server noch nicht eingerichtet.');
  let m;
  if (req.method === 'GET' || req.method === 'HEAD') {
    if ((m = path.match(MEDIA_ONE))) return mediaGet(req, env, m[1]);
    return new Response('Nicht gefunden', { status: 404 });
  }
  // Schreiben darf nur die Seite selbst (oder lokal beim Entwickeln), nicht jede beliebige Seite
  if (!ORIGIN.test(req.headers.get('Origin') || '')) return fail(req, 403, 'Von dieser Adresse aus darf nicht hochgeladen werden.');
  if (req.method === 'POST' && path === '/medien-loeschen') return mediaDelete(req, env);
  if (req.method === 'POST' && (m = path.match(MEDIA_NEW))) return mediaStart(req, env, m[1], url);
  if (req.method === 'PUT' && (m = path.match(MEDIA_PART))) return mediaPart(req, env, m[1], Number(m[2]), url);
  if (req.method === 'POST' && (m = path.match(MEDIA_END))) return mediaEnd(req, env, m[1]);
  return fail(req, 404, 'Nicht gefunden');
}

async function mediaStart(req, env, room, url) {
  const size = Number(url.searchParams.get('size'));
  if (!Number.isInteger(size) || size < 12 || size > MAX_SIZE.video) return fail(req, 400, 'Die Dateigröße stimmt nicht.');
  const first = Math.min(size, PART);
  const buf = await readBody(req, first);
  if (!buf) return fail(req, 400, 'Der erste Teil hat nicht die erwartete Größe.');
  const kind = sniff(new Uint8Array(buf, 0, 16));
  if (!kind) return fail(req, 415, 'Dieses Dateiformat ist nicht erlaubt. Erlaubt sind Bilder (PNG, JPEG, WebP, GIF), Audio (MP3, OGG, WAV, M4A) und Videos (MP4, WebM).');
  if (size > MAX_SIZE[kind.t]) return fail(req, 413, `Die Datei ist zu groß. Erlaubt sind ${MAX_NAMES[kind.t]}.`);
  const ip = req.headers.get('CF-Connecting-IP') || 'lokal', add = { b: size, f: 1 };
  if (!(await quota(env, 'ip:' + ip, add, DAY.ip)) || !(await quota(env, 'room:' + room, add, DAY.room)) || !(await quota(env, 'all', add, DAY.all))) {
    return fail(req, 429, 'Heute wurden schon zu viele Dateien hochgeladen. Starte ohne Medien oder versuche es morgen noch einmal.');
  }
  const id = rid(), del = rid();
  const opts = { httpMetadata: { contentType: kind.ct }, customMetadata: { t: kind.t, del, size: String(size) } };
  if (size <= PART) {
    await env.MEDIA.put('m/' + id, buf, opts);
    return reply(req, { id, del, t: kind.t, done: true });
  }
  const mp = await env.MEDIA.createMultipartUpload('m/' + id, opts);
  const p1 = await mp.uploadPart(1, buf);
  await env.MEDIA.put('u/' + id, JSON.stringify({ del, up: mp.uploadId, size, t: kind.t }));
  return reply(req, { id, del, t: kind.t, etag: p1.etag, done: false });
}

async function mediaPart(req, env, id, n, url) {
  const u = await readUpload(env, id);
  if (!u || u.del !== url.searchParams.get('del')) return fail(req, 404, 'Upload nicht gefunden.');
  const count = Math.ceil(u.size / PART);
  if (n < 2 || n > count) return fail(req, 400, 'Falsche Teilnummer.');
  const want = n < count ? PART : u.size - (count - 1) * PART;
  const buf = await readBody(req, want);
  if (!buf) return fail(req, 400, 'Der Teil hat nicht die erwartete Größe.');
  const p = await env.MEDIA.resumeMultipartUpload('m/' + id, u.up).uploadPart(n, buf);
  return reply(req, { n, etag: p.etag });
}

async function mediaEnd(req, env, id) {
  let b;
  try { b = await req.json(); } catch (e) { return fail(req, 400, 'Kein gültiges JSON.'); }
  const u = b && await readUpload(env, id);
  if (!u || u.del !== b.del) return fail(req, 404, 'Upload nicht gefunden.');
  const count = Math.ceil(u.size / PART), parts = Array.isArray(b.parts) ? b.parts : [];
  const ok = parts.length === count && parts.every(p => p && Number.isInteger(p.n) && p.n >= 1 && p.n <= count && typeof p.etag === 'string' && p.etag.length < 200) && new Set(parts.map(p => p.n)).size === count;
  if (!ok) return fail(req, 400, 'Die Liste der Teile stimmt nicht.');
  let obj;
  try { obj = await env.MEDIA.resumeMultipartUpload('m/' + id, u.up).complete(parts.map(p => ({ partNumber: p.n, etag: p.etag }))); }
  catch (e) { return fail(req, 400, 'Die Teile passen nicht zusammen.'); }
  if (obj.size !== u.size) { await env.MEDIA.delete('m/' + id); await env.MEDIA.delete('u/' + id); return fail(req, 400, 'Die Datei ist nicht vollständig angekommen.'); }
  await env.MEDIA.delete('u/' + id);
  return reply(req, { done: true, t: u.t });
}

async function mediaDelete(req, env) {
  let list;
  try { list = JSON.parse(await req.text()); } catch (e) { return fail(req, 400, 'Kein gültiges JSON.'); }
  if (!Array.isArray(list) || list.length > 100) return fail(req, 400, 'Die Liste ist zu lang.');
  let n = 0;
  for (const e of list) {
    if (!Array.isArray(e) || !/^[a-z0-9]{24}$/.test(e[0]) || typeof e[1] !== 'string') continue;
    const [id, del] = e, head = await env.MEDIA.head('m/' + id);
    if (head && head.customMetadata && head.customMetadata.del === del) { await env.MEDIA.delete('m/' + id); n++; continue; }
    const u = await readUpload(env, id);
    if (u && u.del === del) {
      try { await env.MEDIA.resumeMultipartUpload('m/' + id, u.up).abort(); } catch (err) { /* schon fertig oder weg */ }
      await env.MEDIA.delete('u/' + id); n++;
    }
  }
  return reply(req, { geloescht: n });
}

async function mediaGet(req, env, id) {
  const key = 'm/' + id, head = await env.MEDIA.head(key);
  if (!head) return new Response('Nicht gefunden', { status: 404, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
  const size = head.size;
  const h = {
    'content-type': (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream',
    'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'",
    'cache-control': 'no-store', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin'
  };
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.get('Range');
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === '' && m[2] === '')) return new Response(null, { status: 416, headers: { ...h, 'content-range': `bytes */${size}` } });
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...h, 'content-range': `bytes */${size}` } });
    status = 206; h['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  h['content-length'] = String(end - start + 1);
  if (req.method === 'HEAD') return new Response(null, { status, headers: h });
  const obj = await env.MEDIA.get(key, status === 206 ? { range: { offset: start, length: end - start + 1 } } : undefined);
  if (!obj) return new Response('Nicht gefunden', { status: 404 });
  return new Response(obj.body, { status, headers: h });
}

/* Zähler pro Tag (je Adresse, Raum und für den ganzen Server), damit der Dateispeicher nicht missbraucht wird */
export class Quota extends DurableObject {
  async fetch(req) {
    const q = new URL(req.url).searchParams, b = Number(q.get('b')) || 0, f = Number(q.get('f')) || 0;
    const day = new Date().toISOString().slice(0, 10);
    let s = await this.ctx.storage.get('s');
    if (!s || s.day !== day) s = { day, b: 0, f: 0 };
    if (s.b + b > Number(q.get('mb')) || s.f + f > Number(q.get('mf'))) return new Response('voll', { status: 429 });
    s.b += b; s.f += f;
    await this.ctx.storage.put('s', s);
    return new Response('ok');
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Lebenszeichen beantwortet Cloudflare selbst, ohne den Raum aufzuwecken
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    this.big = new Map(); // Präsenz, die nicht in den Anhang passt (über 2 KiB)
  }

  info(ws) {
    try { const a = ws.deserializeAttachment(); if (a) return { ...a, p: a.p || this.big.get(a.id) || {} }; } catch (e) { /* geschlossen */ }
    return null;
  }

  store(ws, a) {
    try { ws.serializeAttachment(a); this.big.delete(a.id); }
    catch (e) { this.big.set(a.id, a.p); ws.serializeAttachment({ id: a.id, at: a.at }); }
  }

  async fetch(req) {
    const id = new URL(req.url).searchParams.get('id');
    const all = this.ctx.getWebSockets();
    // Gleiches Gerät verbindet sich neu: alte Verbindung ersetzen und ihre Präsenz übernehmen
    let p = {};
    for (const old of all) {
      const a = this.info(old);
      if (a && a.id === id) { p = a.p; try { old.close(4000, 'ersetzt'); } catch (e) { /* schon zu */ } }
    }
    if (all.length >= MAX_PEERS) return new Response('Raum ist voll', { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const at = Date.now();
    this.store(server, { id, p, at });
    const peers = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws === server ? null : this.info(ws);
      if (a && a.id !== id) peers.push(a);
    }
    server.send(JSON.stringify({ t: 'hi', id, peers }));
    this.send(server, { t: 'peer', id, p, at });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const me = this.info(ws);
    if (!me || !m || typeof m !== 'object') return;
    if (m.t === 'emit' && typeof m.topic === 'string' && m.topic.length <= 64) {
      this.send(ws, { t: 'emit', topic: m.topic, data: m.data, from: me.id });
    } else if (m.t === 'presence' && m.p && typeof m.p === 'object' && !Array.isArray(m.p)) {
      const a = { id: me.id, p: m.p, at: Date.now() };
      this.store(ws, a);
      this.send(ws, { t: 'peer', ...a });
    }
  }

  webSocketClose(ws) { this.leave(ws); try { ws.close(1000, 'tschüss'); } catch (e) { /* schon zu */ } }
  webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const me = this.info(ws);
    if (!me) return;
    // Ersetzt durch eine neue Verbindung desselben Geräts: kein Abschied
    if (this.ctx.getWebSockets().some(o => o !== ws && (this.info(o) || {}).id === me.id)) return;
    this.big.delete(me.id);
    this.send(ws, { t: 'leave', id: me.id });
  }

  send(from, msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) if (ws !== from) { try { ws.send(s); } catch (e) { /* geschlossen */ } }
  }
}
