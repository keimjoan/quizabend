// Raum-Server für den Online-Modus von Quizabend (Cloudflare Worker mit Durable Object).
// Leitet Ereignisse und Präsenz zwischen allen Geräten eines Raums weiter, sonst nichts.
// Der Spielstand liegt beim Gastgeber im Browser, hier wird nichts gespeichert.
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
    const m = url.pathname.match(ROOM);
    if (!m) return new Response('Nicht gefunden', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Nur WebSocket', { status: 426 });
    if (!ID.test(url.searchParams.get('id') || '')) return new Response('Geräte-ID fehlt', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  }
};

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
