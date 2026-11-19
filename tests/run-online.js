// Online mode test: host + two players, each in its own browser context, connected by a relayed mock of the room capability.
const { chromium } = require('playwright');
const fs = require('fs');

const path = require('path');
const { startServer } = require('../tools/serve');
let BASE = '';
// Mit --server ws://127.0.0.1:8787 laufen alle Browser über den echten Raum-Server (npm run dev im Ordner server)
// statt über den nachgebauten Raum. Alle treten demselben Raum bei, der Code steht hinten im Link.
const argi = process.argv.indexOf('--server');
const ROOM_URL = argi > 0 ? process.argv[argi + 1] : '';
const ROOM = 'test' + Math.random().toString(36).slice(2, 8);
// Misst im echten Modus die Größe von Spielstand und Präsenz, wie es der nachgebaute Raum tut
const MEASURE = url => {
  window.QUIZ_ROOM_URL = url;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (s) {
    try {
      const m = JSON.parse(s), n = x => new TextEncoder().encode(JSON.stringify(x)).length;
      if (m.t === 'emit') { window.__maxEmit = Math.max(window.__maxEmit || 0, n(m.data)); (window.__emits = window.__emits || []).push(JSON.stringify(m.data)); }
      if (m.t === 'presence') window.__maxPresence = Math.max(window.__maxPresence || 0, n(m.p));
    } catch (e) { /* kein JSON */ }
    return send.call(this, s);
  };
};
const SHOTS = path.join(__dirname, '..', 'shots');
const VALUES = [100, 200, 300, 400, 500];
const failures = [], errors = [];
const assert = (cond, msg) => { if (cond) console.log('  ok   ', msg); else { console.log('  FAIL ', msg); failures.push(msg); } };

const MOCK = `(() => {
  const me = 'p' + Math.random().toString(36).slice(2, 10);
  const handlers = {}, peerHandlers = [];
  const peersMap = new Map([[me, { presence: Object.freeze({}), updatedAt: Date.now() }]]);
  const snap = () => [...peersMap.entries()].map(([peer, v]) => Object.freeze({ peer, by: null, isMe: peer === me, sameTab: peer === me, kind: 'viewer', guest: false, presence: v.presence, updatedAt: v.updatedAt }));
  const notify = (joined, left, updated) => setTimeout(() => { const ps = snap(); const pick = ids => ps.filter(p => ids.includes(p.peer)); peerHandlers.forEach(fn => fn({ peers: ps, joined: pick(joined), left: left.map(id => ({ peer: id, presence: {} })), updated: pick(updated) })); }, 0);
  const out = m => { try { window.__relayOut(JSON.stringify(m)); } catch (e) {} };
  const bytes = s => new TextEncoder().encode(s).length;
  window.__relayIn = s => {
    const m = JSON.parse(s);
    if (m.kind === 'emit') (handlers[m.topic] || []).forEach(fn => fn({ topic: m.topic, data: m.data, peer: m.from, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false }));
    else if (m.kind === 'presence') {
      const had = peersMap.has(m.from);
      peersMap.set(m.from, { presence: Object.freeze(m.presence), updatedAt: Date.now() });
      notify(had ? [] : [m.from], [], had ? [m.from] : []);
      if (!had) out({ kind: 'presence', from: me, presence: peersMap.get(me).presence });
    } else if (m.kind === 'leave') { if (peersMap.delete(m.from)) notify([], [m.from], []); }
    else if (m.kind === 'hello') out({ kind: 'presence', from: me, presence: peersMap.get(me).presence });
  };
  const room = {
    emit(topic, data) {
      const s = JSON.stringify(data);
      if (bytes(s) > 4096) return Promise.reject({ code: 'invalid_argument', message: 'too big ' + bytes(s) });
      window.__maxEmit = Math.max(window.__maxEmit || 0, bytes(s));
      (window.__emits = window.__emits || []).push(s);
      setTimeout(() => (handlers[topic] || []).forEach(fn => fn({ topic, data: JSON.parse(s), peer: me, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false })), 0);
      out({ kind: 'emit', topic, data: JSON.parse(s), from: me });
      return Promise.resolve();
    },
    on(topic, fn) { (handlers[topic] = handlers[topic] || []).push(fn); return () => {}; },
    presence(patch) {
      const cur = Object.assign({}, peersMap.get(me).presence);
      for (const k in patch) { if (patch[k] === null) delete cur[k]; else cur[k] = patch[k]; }
      if (bytes(JSON.stringify(cur)) > 4096) return Promise.reject({ code: 'invalid_argument' });
      window.__maxPresence = Math.max(window.__maxPresence || 0, bytes(JSON.stringify(cur)));
      peersMap.set(me, { presence: Object.freeze(cur), updatedAt: Date.now() });
      out({ kind: 'presence', from: me, presence: cur });
      notify([], [], [me]);
      return Promise.resolve();
    },
    peers() { return snap(); },
    onPeers(fn) { peerHandlers.push(fn); setTimeout(() => fn({ peers: snap(), joined: snap(), left: [], updated: [] }), 0); return () => {}; },
    connected() { return true; },
    onConnection(fn) { setTimeout(() => fn(true), 0); return () => {}; },
    join() { return Promise.reject({ code: 'not_permitted' }); }
  };
  window.claude = { use: async name => { await new Promise(r => setTimeout(r, 50)); return name === 'room' ? room : null; } };
  setTimeout(() => { out({ kind: 'hello', from: me }); out({ kind: 'presence', from: me, presence: peersMap.get(me).presence }); }, 30);
  window.__peerId = me;
})();`;

// Nachgestellter Medien-Speicher (nur beim nachgebauten Raum). Mit --server läuft alles gegen den echten Raum-Server.
const mediaStore = new Map(); // id → { del, t, ct, size, parts: Map, buf }
const MEDIA_PART = 20 * 1048576;
const MEDIA_HOST = ROOM_URL ? ROOM_URL.replace(/^ws/, 'http') : 'http://media.test';
const rid24 = () => Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
function sniffKind(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { t: 'bild', ct: 'image/png' };
  if (b.slice(0, 4).toString() === 'RIFF') return { t: 'audio', ct: 'audio/wav' };
  if (b.slice(4, 8).toString() === 'ftyp') return { t: 'video', ct: 'video/mp4' };
  return null;
}
const mediaRoute = async route => {
  const req = route.request(), u = new URL(req.url()), m = req.method();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS' };
  const json = (o, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(o) });
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  let x;
  if (m === 'POST' && u.pathname === '/medien-loeschen') {
    let n = 0;
    for (const [id, del] of JSON.parse(req.postData() || '[]')) { const e = mediaStore.get(id); if (e && e.del === del) { mediaStore.delete(id); n++; } }
    return json({ geloescht: n });
  }
  if (m === 'POST' && (x = u.pathname.match(/^\/medien\/([a-z0-9]{4,16})$/))) {
    const buf = req.postDataBuffer(), size = Number(u.searchParams.get('size')), kind = sniffKind(buf);
    if (!kind || buf.length !== Math.min(size, MEDIA_PART)) return json({ fehler: 'abgelehnt' }, 415);
    const id = rid24(), e = { del: rid24(), t: kind.t, ct: kind.ct, size, parts: new Map([[1, buf]]), buf: null };
    mediaStore.set(id, e);
    if (size <= MEDIA_PART) { e.buf = buf; return json({ id, del: e.del, t: kind.t, done: true }); }
    return json({ id, del: e.del, t: kind.t, etag: 'e1', done: false });
  }
  if (m === 'PUT' && (x = u.pathname.match(/^\/medien\/([a-z0-9]{24})\/(\d+)$/))) {
    const e = mediaStore.get(x[1]);
    if (!e || e.del !== u.searchParams.get('del')) return json({ fehler: 'unbekannt' }, 404);
    e.parts.set(Number(x[2]), req.postDataBuffer());
    return json({ n: Number(x[2]), etag: 'e' + x[2] });
  }
  if (m === 'POST' && (x = u.pathname.match(/^\/medien\/([a-z0-9]{24})\/fertig$/))) {
    const e = mediaStore.get(x[1]), b = JSON.parse(req.postData() || '{}');
    if (!e || e.del !== b.del || b.parts.length !== Math.ceil(e.size / MEDIA_PART)) return json({ fehler: 'unvollständig' }, 400);
    e.buf = Buffer.concat([...e.parts.entries()].sort((a, c) => a[0] - c[0]).map(p => p[1]));
    if (e.buf.length !== e.size) return json({ fehler: 'Größe' }, 400);
    return json({ done: true, t: e.t });
  }
  if ((m === 'GET' || m === 'HEAD') && (x = u.pathname.match(/^\/medien\/([a-z0-9]{24})$/))) {
    const e = mediaStore.get(x[1]);
    if (!e || !e.buf) return route.fulfill({ status: 404, headers: cors, body: 'Nicht gefunden' });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': e.ct, 'accept-ranges': 'bytes' }, body: e.buf });
  }
  return route.fulfill({ status: 404, headers: cors, body: 'Nicht gefunden' });
};
const mediaGone = async id => ROOM_URL ? (await fetch(`${MEDIA_HOST}/medien/${id}`)).status === 404 : !mediaStore.has(id);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  BASE = server.url;
  console.log(ROOM_URL ? `Echter Raum-Server: ${ROOM_URL}, Raum ${ROOM}` : 'Nachgebauter Raum');
  // Testkamera statt echter Kamera, Freigabe ohne Nachfrage
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const metas = [];
  const relay = (fromPage, s) => {
    const m = JSON.parse(s);
    const meta = metas.find(x => x.page === fromPage); if (meta) meta.id = m.from;
    for (const x of metas) if (x.page !== fromPage && !x.page.isClosed()) x.page.evaluate(str => window.__relayIn && window.__relayIn(str), s).catch(() => {});
  };
  async function newPlayer(tag, viewport) {
    const ctx = await browser.newContext({ viewport });
    if (ROOM_URL) await ctx.addInitScript(MEASURE, ROOM_URL);
    else {
      await ctx.addInitScript(MOCK);
      await ctx.exposeBinding('__relayOut', ({ page }, s) => relay(page, s));
    }
    await ctx.addInitScript(() => { window.QUIZ_ICE = []; }); // keine STUN-Server im Test, die Browser finden sich lokal
    if (!ROOM_URL) { await ctx.addInitScript(() => { window.QUIZ_MEDIA_URL = 'http://media.test'; }); await ctx.route('http://media.test/**', mediaRoute); }
    const page = await ctx.newPage();
    // Im KI-Test scheitern Anfragen an die nachgestellte API mit Absicht (falscher Schlüssel, Ausfall)
    page.on('console', m => { if (m.type() === 'error' && !(tag.startsWith('ki-') && /Failed to load resource/.test(m.text()))) errors.push(`${tag} console: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`${tag} pageerror: ${e.message}`));
    const meta = { page, id: null, tag };
    metas.push(meta);
    page.on('framenavigated', f => {
      if (f !== page.mainFrame() || !meta.id) return;
      const old = meta.id; meta.id = null;
      for (const x of metas) if (x.page !== page && !x.page.isClosed()) x.page.evaluate(str => window.__relayIn && window.__relayIn(str), JSON.stringify({ kind: 'leave', from: old })).catch(() => {});
    });
    await page.goto(ROOM_URL ? BASE + '#' + ROOM : BASE);
    return page;
  }
  const hostState = () => host.evaluate(() => JSON.parse(localStorage.getItem('quizabend.online.v1')));

  console.log('\n[5] Online: Gastgeber und zwei Spieler, jeder für sich');
  const host = await newPlayer('host', { width: 1440, height: 900 });
  await host.waitForSelector('#me-name');
  await host.fill('#me-name', 'Joan');
  await host.click('#o-create');
  await host.waitForSelector('.lobby');
  let g;
  const lea = await newPlayer('lea', { width: 1280, height: 800 });
  await lea.waitForSelector('#me-name');
  await lea.fill('#me-name', 'Lea');
  await lea.waitForSelector('[data-act="o-join"]');
  await lea.screenshot({ path: `${SHOTS}/30-online-start.png`, fullPage: true });
  await lea.click('[data-act="o-join"]');
  const max = await newPlayer('max', { width: 1280, height: 800 });
  await max.waitForSelector('#me-name');
  await max.fill('#me-name', 'Max');
  await max.waitForSelector('[data-act="o-join"]');
  await max.click('[data-act="o-join"]');
  await host.waitForFunction(() => document.querySelectorAll('.pchip').length === 3, null, { timeout: 5000 });
  await lea.waitForFunction(() => document.querySelectorAll('.pchip').length === 3, null, { timeout: 5000 });
  g = await hostState();
  assert(g.pl.map(p => p.n).join(',') === 'Joan,Lea,Max', 'Drei Spieler in der Lobby: ' + g.pl.map(p => p.n).join(', '));
  await host.click('#ob-minus').catch(() => {});
  g = await hostState();
  if (g.set.boards > 2) { while ((await hostState()).set.boards > 2) await host.click('#ob-minus'); }
  if ((await hostState()).set.boards < 2) await host.click('#ob-plus');
  assert(await host.isVisible('#od-1'), 'Online-Lobby: Schalter für doppelte Punkte sichtbar');
  await host.click('#od-1');
  await lea.waitForSelector('.summary-list:has-text("doppelt")', { timeout: 5000 });
  assert((await hostState()).set.dbl === true, 'Doppelte Punkte eingestellt, Mitspieler sehen es');
  await host.screenshot({ path: `${SHOTS}/31-online-lobby-host.png`, fullPage: true });
  await lea.screenshot({ path: `${SHOTS}/32-online-lobby-player.png`, fullPage: true });
  await host.click('#o-start');
  for (const p of [host, lea, max]) await p.waitForSelector('.board', { timeout: 5000 });
  g = await hostState();
  assert(g.ph === 'board' && g.boards.length === 2 && g.teams.length === 3 && g.turn === 0, 'Spiel gestartet: 2 Boards, 3 Einzelspieler, Joan beginnt');
  assert(await lea.$('button.tile') === null, 'Lea kann nicht wählen, wenn Joan dran ist');
  await lea.screenshot({ path: `${SHOTS}/33-online-board-player.png` });

  // Frage 1: Joan antwortet, sieht allein die Lösung, wertet selbst „falsch“ (−200). Lea buzzert, sagt „richtig“, 1:1 Stimmen zählt (+400)
  await host.click('#tile-0-3');
  await host.waitForSelector('#o-ans-in');
  await lea.waitForSelector('.qcard');
  await host.fill('#o-ans-in', 'Juno');
  await host.screenshot({ path: `${SHOTS}/34-online-answer.png` });
  await host.press('#o-ans-in', 'Enter');
  await host.waitForSelector('#o-claim-no');
  await lea.waitForSelector('text=vergleicht die Antwort');
  assert(!(await lea.isVisible('.answer')) && !(await max.isVisible('.answer')), 'Nur der Fragewähler sieht die Musterlösung');
  assert(!(await lea.isVisible('#o-buzz')), 'Vor der Selbstbewertung kann niemand buzzern');
  await host.screenshot({ path: `${SHOTS}/35-online-judge.png` });
  await host.click('#o-claim-no');
  await lea.waitForSelector('#o-buzz'); await max.waitForSelector('#o-buzz');
  assert(!(await host.isVisible('#o-buzz')), 'Der Fragewähler darf nicht buzzern');
  assert(!(await lea.isVisible('.answer')), 'Beim Buzzern ist die Lösung noch verdeckt');
  await max.screenshot({ path: `${SHOTS}/36-online-buzz.png` });
  await lea.click('#o-buzz');
  await lea.waitForSelector('#o-ans-in');
  await max.waitForSelector('text=hat gebuzzert und tippt');
  await lea.fill('#o-ans-in', 'Venus'); await lea.press('#o-ans-in', 'Enter');
  await lea.waitForSelector('#o-claim-yes'); await lea.click('#o-claim-yes');
  await host.waitForSelector('#o-yes'); await max.waitForSelector('#o-yes');
  assert(!(await lea.isVisible('#o-yes')), 'Lea stimmt nicht über die eigene Antwort ab');
  await max.screenshot({ path: `${SHOTS}/37-online-vote.png` });
  await host.click('#o-yes'); await max.click('#o-no');
  await host.waitForSelector('#o-next');
  g = await hostState();
  assert(JSON.stringify(g.sc) === '[-200,400,0]', 'Frage 1: Joan −200 (selbst falsch), Lea +400 (1:1 zählt): ' + g.sc);
  assert(g.cur.win === 1 && g.cur.ans[1].y === 1 && g.cur.ans[1].n === 1, 'Abstimmung korrekt gezählt');
  await max.waitForSelector('#o-next');
  await max.waitForTimeout(500);
  await max.screenshot({ path: `${SHOTS}/38-online-resolved.png` });
  await max.click('#o-next');
  await lea.waitForSelector('button.tile');
  g = await hostState();
  assert(g.turn === 1 && g.res[0][0][3] === 1, 'Weiter: Lea ist dran, Feld gehört Lea');

  // Frage 2: Lea behauptet „richtig“, beide lehnen ab → volle 100 Punkte Abzug, kein Buzzern mehr
  await lea.click('#tile-1-0');
  await lea.waitForSelector('#o-ans-in'); await lea.fill('#o-ans-in', 'Gemogelt'); await lea.press('#o-ans-in', 'Enter');
  await lea.waitForSelector('#o-claim-yes'); await lea.click('#o-claim-yes');
  await host.waitForSelector('#o-no'); await host.click('#o-no');
  await max.waitForSelector('#o-no'); await max.click('#o-no');
  await lea.waitForSelector('#o-next');
  g = await hostState();
  assert(JSON.stringify(g.sc) === '[-200,300,0]' && g.cur.win === -1 && g.cur.ans.length === 1, 'Frage 2: abgelehnt, Lea −100 (volle Punkte), keine Buzzer-Runde: ' + g.sc);
  await lea.click('#o-next');

  // Frage 3: Max weiß es nicht (−100), Joan buzzert und wertet selbst falsch (−100), Joan darf nicht nochmal, Lea passt
  await max.waitForSelector('button.tile');
  await max.click('#tile-2-1');
  await max.waitForSelector('#o-skip'); await max.click('#o-skip');
  await host.waitForSelector('#o-buzz'); await host.click('#o-buzz');
  await host.waitForSelector('#o-ans-in'); await host.fill('#o-ans-in', 'Erste Idee'); await host.press('#o-ans-in', 'Enter');
  await host.waitForSelector('#o-claim-no'); await host.click('#o-claim-no');
  await lea.waitForSelector('#o-buzz');
  await host.waitForSelector('text=schon gebuzzert');
  assert(!(await host.isVisible('#o-buzz')) && !(await max.isVisible('#o-buzz')), 'Joan darf nur einmal buzzern, Max als Fragewähler gar nicht');
  await lea.click('#o-pass');
  await host.waitForSelector('#o-next');
  g = await hostState();
  assert(JSON.stringify(g.sc) === '[-300,300,-100]' && g.cur.win === -1, 'Frage 3: keine Antwort, eine falsche Buzzer-Antwort: ' + g.sc);
  await host.screenshot({ path: `${SHOTS}/39-online-resolved-nobody.png` });
  await host.click('#o-next');

  // Lea lädt neu und steigt wieder ein
  await host.waitForSelector('button.tile');
  await lea.reload();
  await lea.waitForSelector('[data-act="o-join"]');
  assert((await lea.textContent('[data-act="o-join"]')).includes('Wieder einsteigen'), 'Nach dem Neuladen: „Wieder einsteigen“');
  await lea.click('[data-act="o-join"]');
  await lea.waitForSelector('.board');
  assert((await lea.textContent('.scores')).includes('300'), 'Lea sieht nach dem Wiedereinstieg den Spielstand');

  // Rest von Board 1 schnell durchspielen: immer richtig
  const pages = [host, lea, max];
  const exp = [-300, 300, -100];
  let turn = 0;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    g = await hostState();
    if (g.res[0][c][r] !== null) continue;
    const tp = pages[turn], others = pages.filter((_, i) => i !== turn);
    await tp.waitForSelector(`button#tile-${c}-${r}`); await tp.click(`#tile-${c}-${r}`);
    await tp.waitForSelector('#o-ans-in'); await tp.fill('#o-ans-in', 'Antwort'); await tp.press('#o-ans-in', 'Enter');
    await tp.waitForSelector('#o-claim-yes'); await tp.click('#o-claim-yes');
    for (const p of others) { await p.waitForSelector('#o-yes'); await p.click('#o-yes'); }
    await tp.waitForSelector('#o-next'); await tp.click('#o-next');
    exp[turn] += VALUES[r]; turn = (turn + 1) % 3;
  }
  await host.waitForSelector('.interlude');
  g = await hostState();
  assert(g.ph === 'boardEnd' && JSON.stringify(g.sc) === JSON.stringify(exp), `Board 1 fertig, Punkte ${g.sc} (erwartet ${exp})`);
  await max.screenshot({ path: `${SHOTS}/40-online-board-end.png` });
  await max.click('#o-next');
  for (const p of pages) await p.waitForSelector('.board');
  g = await hostState();
  assert(g.ph === 'board' && g.bi === 1, 'Board 2 beginnt');
  // Doppelte Punkte: Board 2 zählt doppelt (400er Frage = 800)
  {
    const who = g.turn, tp2 = pages[who], oth2 = pages.filter((_, i) => i !== who);
    await tp2.waitForSelector('#tile-0-3');
    assert((await tp2.textContent('#tile-0-0')) === '200' && (await tp2.textContent('#tile-4-4')) === '1000', 'Online: Board 2 zeigt 200 bis 1000 Punkte');
    await tp2.click('#tile-0-3');
    await tp2.waitForSelector('#o-ans-in'); await tp2.fill('#o-ans-in', 'Antwort'); await tp2.press('#o-ans-in', 'Enter');
    await tp2.waitForSelector('#o-claim-yes'); await tp2.click('#o-claim-yes');
    for (const p of oth2) { await p.waitForSelector('#o-yes'); await p.click('#o-yes'); }
    await tp2.waitForSelector('#o-next');
    g = await hostState();
    exp[who] += 800;
    assert(g.cur.v === 800 && JSON.stringify(g.sc) === JSON.stringify(exp), 'Online: Frage zählt 800, Punkte ' + g.sc + ' (erwartet ' + exp + ')');
    await tp2.click('#o-next');
    await host.waitForSelector('.board');
  }
  await host.click('#t-menu'); await host.click('[data-act="o-end"]'); await host.click('[data-act="modal-ok"]');
  for (const p of pages) await p.waitForSelector('.finale');
  await lea.waitForTimeout(500);
  await lea.screenshot({ path: `${SHOTS}/41-online-end-player.png` });
  const head = await lea.textContent('.finale .bigline');
  const best = Math.max(...exp), names = ['Joan', 'Lea', 'Max'];
  assert(head.includes(names[exp.indexOf(best)]), 'Sieger stimmt: ' + head);

  console.log('\n[6] Online in Teams');
  await host.click('#o-lobby');
  await lea.waitForSelector('.lobby');
  if (await host.isVisible('#od-0')) await host.click('#od-0');
  await host.click('#om-teams');
  await lea.waitForSelector('#ot-join-0');
  await host.click('#ot-join-0');
  await lea.click('#ot-join-0');
  await max.waitForSelector('#ot-join-1');
  await max.click('#ot-join-1');
  await host.fill('#otn-0', 'Die Füchse');
  await host.waitForTimeout(800);
  await lea.waitForSelector('text=Die Füchse');
  await host.screenshot({ path: `${SHOTS}/41-online-lobby-teams.png`, fullPage: true });
  await host.click('#o-start');
  for (const p of pages) await p.waitForSelector('.board');
  g = await hostState();
  assert(g.teams.length === 2 && g.teams[0].n === 'Die Füchse' && g.pl.map(p => p.t).join('') === '001', 'Teams: Joan und Lea gegen Max');
  assert(g.qn > 20, 'Fragenzähler läuft über die Revanche weiter (keine alten Eingaben)');
  // Lea antwortet fürs Team, wertet selbst falsch (−150). Max buzzert, sagt richtig, Joan und Lea stimmen zu (+300)
  await lea.waitForSelector('button.tile');
  await lea.click('#tile-3-2');
  await host.waitForSelector('#o-ans-in');
  await lea.waitForSelector('#o-ans-in'); await lea.fill('#o-ans-in', 'Teamantwort'); await lea.press('#o-ans-in', 'Enter');
  await host.waitForSelector('#o-claim-no');
  assert(!(await max.isVisible('.answer')), 'Gegner sieht die Lösung nicht, das eigene Team schon');
  await host.click('#o-claim-no');
  await max.waitForSelector('#o-buzz');
  assert(!(await host.isVisible('#o-buzz')) && !(await lea.isVisible('#o-buzz')), 'Das Team am Zug kann nicht buzzern');
  await max.click('#o-buzz');
  await max.waitForSelector('#o-ans-in'); await max.fill('#o-ans-in', 'Konter'); await max.press('#o-ans-in', 'Enter');
  await max.waitForSelector('#o-claim-yes'); await max.click('#o-claim-yes');
  await host.waitForSelector('#o-yes'); await lea.waitForSelector('#o-yes');
  await host.click('#o-yes'); await lea.click('#o-yes');
  await host.waitForSelector('#o-next');
  g = await hostState();
  assert(JSON.stringify(g.sc) === '[-150,300]', 'Teams: −150 für Die Füchse, +300 für Max: ' + g.sc);
  await host.screenshot({ path: `${SHOTS}/42-online-team-resolved.png` });

  const maxEmit = await host.evaluate(() => window.__maxEmit || 0);
  const maxPres = await lea.evaluate(() => window.__maxPresence || 0);
  assert(maxEmit < 4096 && maxPres < 4096, `Nachrichten unter 4 KiB (Spielstand ${maxEmit} Bytes, Präsenz ${maxPres} Bytes)`);

  // ---------- [7] KI-Spielleiter: Anthropic wird nachgestellt, der Gastgeber bringt seinen eigenen Schlüssel mit ----------
  console.log('\n[7] Online mit KI-Spielleiter (nachgestellte Claude-API)');
  for (const p of [host, lea, max]) await p.close();
  const TEST_KEY = 'sk-ant-test-' + 'q'.repeat(40);
  const kiCalls = [], kiFrom = new Set();
  let kiMode = 'ok';
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  const json = (route, status, body) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
  const kiRoute = tag => async route => {
    const req = route.request(), h = req.headers();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    kiFrom.add(tag);
    if (h['x-api-key'] !== TEST_KEY) return json(route, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const mm = /\/v1\/models\/([a-z0-9-]+)$/.exec(req.url());
    if (mm) return json(route, 200, { type: 'model', id: mm[1], display_name: mm[1] });
    const body = JSON.parse(req.postData());
    kiCalls.push({ headers: h, body, url: req.url() });
    if (kiMode === 'down') return json(route, 500, { type: 'error', error: { type: 'api_error', message: 'kaputt' } });
    const text = body.messages[0].content;
    const sol = /<musterloesung>([\s\S]*?)<\/musterloesung>/.exec(text)[1], said = /<antwort_des_spielers>([\s\S]*?)<\/antwort_des_spielers>/.exec(text)[1];
    const richtig = said.trim().toLowerCase() === sol.trim().toLowerCase();
    return json(route, 200, { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify({ richtig, kommentar: richtig ? 'Genau richtig.' : `Leider nein, gesucht war ${sol}.` }) }] });
  };
  const kiPlayer = async (tag, name) => {
    const p = await newPlayer(tag, { width: 1280, height: 800 });
    await p.context().route('https://api.anthropic.com/**', kiRoute(tag));
    await p.waitForSelector('#me-name'); await p.fill('#me-name', name);
    return p;
  };
  const kh = await kiPlayer('ki-host', 'Joan');
  await kh.click('#o-create'); await kh.waitForSelector('.lobby');
  const kl = await kiPlayer('ki-lea', 'Lea');
  await kl.waitForSelector('[data-act="o-join"]'); await kl.click('[data-act="o-join"]');
  await kh.waitForFunction(() => document.querySelectorAll('.pchip').length === 2, null, { timeout: 5000 });
  while ((await kh.evaluate(() => JSON.parse(localStorage.getItem('quizabend.online.v1')).set.boards)) > 1) await kh.click('#ob-minus');

  // Einschalten, Start ohne Schlüssel, falsche Schlüssel, richtiger Schlüssel
  await kh.click('#oki-1');
  await kh.waitForSelector('#ki-key');
  await kl.waitForSelector('text=Wertung der Antworten: KI-Spielleiter (Claude Opus 5.5)');
  await kh.click('#okm-haiku');
  await kl.waitForSelector('text=Wertung der Antworten: KI-Spielleiter (Claude Haiku 5.5)');
  assert((await kh.textContent('.kibox')).includes('Claude Haiku 5.5'), 'Modellauswahl: Mitspieler und Kostenhinweis folgen der Wahl');
  await kh.click('#okm-opus');
  await kl.waitForSelector('text=Wertung der Antworten: KI-Spielleiter (Claude Opus 5.5)');
  await kh.click('#o-start'); await kh.waitForTimeout(300);
  assert(await kh.isVisible('.lobby') && (await kh.textContent('#toast')).includes('API-Schlüssel'), 'Ohne Schlüssel startet das Spiel mit KI nicht');
  await kh.fill('#ki-key', 'abc'); await kh.click('#ki-check');
  assert((await kh.textContent('#ki-err')).includes('sk-ant-'), 'Unsinn im Schlüsselfeld wird gleich abgelehnt');
  await kh.fill('#ki-key', 'sk-ant-falsch-' + 'x'.repeat(30)); await kh.click('#ki-check');
  await kh.waitForFunction(() => /lehnt diesen Schlüssel ab/.test(document.querySelector('#ki-err').textContent), null, { timeout: 5000 });
  assert(!(await kh.isVisible('#ki-ok')), 'Ein Schlüssel, den Anthropic ablehnt, wird nicht übernommen');
  await kh.fill('#ki-key', TEST_KEY); await kh.click('#ki-check');
  await kh.waitForSelector('#ki-ok', { timeout: 5000 });
  await kh.screenshot({ path: `${SHOTS}/50-ki-lobby.png`, fullPage: true });
  const kept = await kh.evaluate(() => [sessionStorage.getItem('quizabend.ki.v1'), localStorage.getItem('quizabend.ki.v1')]);
  assert(kept[0] === TEST_KEY && kept[1] === null, 'Schlüssel liegt nur für diesen Tab im Browser des Gastgebers');
  assert(!(await kh.textContent('.kibox')).includes(TEST_KEY.slice(0, -4)), 'Der Schlüssel wird nicht im Klartext angezeigt');

  const kState = () => kh.evaluate(() => JSON.parse(localStorage.getItem('quizabend.online.v1')));
  const kSol = async (c, r) => (await kState()).boards[0].cats[c].qs[r].a;
  const kAnswer = async (p, text) => { await p.waitForSelector('#o-ans-in'); await p.fill('#o-ans-in', text); await p.press('#o-ans-in', 'Enter'); };
  await kh.click('#o-start');
  for (const p of [kh, kl]) await p.waitForSelector('.board', { timeout: 5000 });

  // Frage 1: Joan antwortet richtig. Die KI wertet, es gibt weder Selbstbewertung noch Abstimmung.
  await kh.click('#tile-0-0');
  await kh.waitForSelector('text=Danach prüft der KI-Spielleiter die Antwort.');
  await kAnswer(kh, (await kSol(0, 0)).toUpperCase());
  await kh.waitForSelector('#o-next', { timeout: 8000 });
  g = await kState();
  assert(JSON.stringify(g.sc) === '[100,0]' && g.cur.win === 0 && g.cur.ans[0].ki === 1, 'KI wertet richtig: Joan +100, ohne Abstimmung: ' + g.sc);
  await kl.waitForSelector('.kinote');
  assert((await kl.textContent('.kinote')).includes('Genau richtig.') && (await kl.textContent('.verdict .res')) === 'richtig', 'Alle sehen Urteil und Kommentar der KI');
  await kl.screenshot({ path: `${SHOTS}/51-ki-resolved.png` });
  const call = kiCalls[0];
  assert(call.url.endsWith('/v1/messages') && call.headers['anthropic-version'] === '2026-10-21' && call.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'Anfrage geht mit den richtigen Köpfen an die Messages-API');
  assert(call.body.model === 'claude-opus-5-5' && call.body.output_config.format.type === 'json_schema' && call.body.output_config.effort === 'low' && /Spielleiter/.test(call.body.system), 'Anfrage: Modell, festes JSON-Format und Spielleiter-Anweisung');
  await kl.click('#o-next');

  // Frage 2: Lea liegt falsch (−100), Joan buzzert und liegt richtig (+200). Der Kommentar erscheint erst nach der Auflösung.
  await kl.waitForSelector('button.tile'); await kl.click('#tile-0-1');
  await kAnswer(kl, 'Quatsch <b>mit</b> Soße');
  await kh.waitForSelector('#o-buzz', { timeout: 8000 });
  assert((await kh.$$('.kinote')).length === 0 && !(await kh.isVisible('.answer')), 'Beim Buzzern sind Kommentar und Lösung noch verdeckt');
  assert(!/[<>]/.test(/<antwort_des_spielers>([\s\S]*?)<\/antwort_des_spielers>/.exec(kiCalls[kiCalls.length - 1].body.messages[0].content)[1]), 'Spitze Klammern in der Antwort kommen nicht bei der KI an');
  await kh.click('#o-buzz');
  await kAnswer(kh, await kSol(0, 1));
  await kh.waitForSelector('#o-next', { timeout: 8000 });
  g = await kState();
  assert(JSON.stringify(g.sc) === '[300,-100]' && g.cur.win === 0, 'KI wertet falsch und richtig: Lea −100, Joan +200: ' + g.sc);
  assert((await kh.$$('.kinote')).length === 2 && (await kh.textContent('.kinote')).includes('Leider nein'), 'Nach der Auflösung stehen beide Kommentare da');
  await kh.click('#o-next');

  // Frage 3: Anthropic fällt aus. Die Antwort wird wie ohne KI bewertet (selbst und per Abstimmung).
  kiMode = 'down';
  await kh.waitForSelector('button.tile'); await kh.click('#tile-0-2');
  await kAnswer(kh, 'Irgendwas');
  await kl.waitForSelector('#o-ki-wait');
  await kh.waitForSelector('#o-claim-yes', { timeout: 12000 });
  assert(await kh.isVisible('#o-ki-off'), 'KI nicht erreichbar: Hinweis und Selbstbewertung wie bisher');
  await kh.click('#o-claim-yes');
  await kl.waitForSelector('#o-yes'); await kl.click('#o-yes');
  await kh.waitForSelector('#o-next');
  g = await kState();
  assert(JSON.stringify(g.sc) === '[600,-100]' && !g.cur.ans[0].ki, 'Rückfall zählt wie eine normale Abstimmung: ' + g.sc);
  kiMode = 'ok';
  await kh.click('#o-next');

  // Gastgeber lädt neu: Der Schlüssel ist noch da, die KI wertet weiter.
  await kl.waitForSelector('button.tile');
  await kh.reload();
  await kh.waitForSelector('#o-resume'); await kh.click('#o-resume');
  await kh.waitForSelector('.board');
  await kl.waitForSelector('button.tile', { timeout: 15000 }); await kl.click('#tile-0-3');
  await kAnswer(kl, await kSol(0, 3));
  await kl.waitForSelector('#o-next', { timeout: 15000 });
  g = await kState();
  assert(JSON.stringify(g.sc) === '[600,300]', 'Nach dem Neuladen des Gastgebers wertet die KI weiter: ' + g.sc);

  // Mit Claude Haiku 5.5: anderes Modell, ohne Ersatzmodell (das bietet Anthropic für Haiku 5.5 nicht an)
  await kh.click('#t-menu'); await kh.click('[data-act="o-lobby-ask"]'); await kh.click('[data-act="modal-ok"]');
  await kh.waitForSelector('#okm-haiku'); await kh.click('#okm-haiku');
  await kh.click('#o-start');
  for (const p of [kh, kl]) await p.waitForSelector('.board', { timeout: 5000 });
  const before = kiCalls.length;
  await kh.click('#tile-0-0');
  await kAnswer(kh, await kSol(0, 0));
  await kh.waitForSelector('#o-next', { timeout: 8000 });
  const hc = kiCalls[kiCalls.length - 1];
  assert(kiCalls.length === before + 1 && hc.body.model === 'claude-haiku-5-5' && !('fallbacks' in hc.body) && !hc.headers['anthropic-beta'], 'Haiku: richtiges Modell, ohne Ersatzmodell und ohne Beta-Kopf');
  assert(kiCalls.filter(c => c.body.model === 'claude-opus-5-5').every(c => c.body.fallbacks === 'default' && c.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01'), 'Opus: mit Ersatzmodell und Beta-Kopf');
  g = await kState();
  assert(JSON.stringify(g.sc) === '[100,0]', 'Haiku wertet richtig: ' + g.sc);

  // Der Schlüssel verlässt den Browser des Gastgebers nur in Richtung Anthropic
  const leak = await kh.evaluate(k => Object.keys(localStorage).filter(n => (localStorage.getItem(n) || '').includes(k)), TEST_KEY);
  const seen = await kl.evaluate(k => document.documentElement.outerHTML.includes(k) || Object.keys(localStorage).some(n => (localStorage.getItem(n) || '').includes(k)) || Object.keys(sessionStorage).some(n => (sessionStorage.getItem(n) || '').includes(k)), TEST_KEY);
  assert(leak.length === 0 && !seen, 'Der Schlüssel steht weder im Spielstand noch bei den Mitspielern');
  assert(kiFrom.has('ki-host') && !kiFrom.has('ki-lea') && kiCalls.length >= 5, `Nur der Gastgeber ruft Anthropic auf (${kiCalls.length} Bewertungen)`);
  const kEmit = await kh.evaluate(() => window.__maxEmit || 0);
  assert(kEmit > 0 && kEmit < 4096, `Spielstand mit KI-Kommentaren bleibt unter 4 KiB (${kEmit} Bytes)`);

  // ---------- [8] Der Gastgeber moderiert: sieht die Lösung, entscheidet per Klick, spielt nicht mit ----------
  console.log('\n[8] Online, der Gastgeber moderiert');
  for (const p of [kh, kl]) await p.close();
  const mh = await newPlayer('mod-host', { width: 1280, height: 800 });
  await mh.waitForSelector('#me-name'); await mh.fill('#me-name', 'Joan');
  await mh.click('#o-create'); await mh.waitForSelector('.lobby');
  const mPlayer = async (tag, name) => {
    const p = await newPlayer(tag, { width: 1280, height: 800 });
    await p.waitForSelector('#me-name'); await p.fill('#me-name', name);
    await p.waitForSelector('[data-act="o-join"]'); await p.click('[data-act="o-join"]');
    return p;
  };
  const ml = await mPlayer('mod-lea', 'Lea'), mm = await mPlayer('mod-max', 'Max');
  await mh.waitForFunction(() => document.querySelectorAll('.pchip').length === 3, null, { timeout: 5000 });
  const mState = () => mh.evaluate(() => JSON.parse(localStorage.getItem('quizabend.online.v1')));
  while ((await mState()).set.boards > 1) await mh.click('#ob-minus');
  await mh.click('#omod');
  await mh.waitForSelector('#omod-note');
  await ml.waitForSelector('text=der Gastgeber moderiert und spielt nicht mit');
  assert((await mh.textContent('.plist')).includes('Spielleitung'), 'Lobby: Einstellung „Ich moderiere“, Mitspieler sehen sie');
  await mh.click('#o-start');
  for (const p of [mh, ml, mm]) await p.waitForSelector('.board', { timeout: 5000 });
  g = await mState();
  assert(g.teams.map(t => t.n).join(',') === 'Lea,Max' && g.pl.find(p => p.n === 'Joan').t === null, 'Wer moderiert, spielt nicht mit: ' + g.teams.map(t => t.n).join(', '));
  assert((await mh.textContent('.mechip')).includes('Du moderierst') && (await mh.$('button.tile')) === null, 'Spielleitung kann keine Frage wählen');

  // Lea antwortet falsch (−50, halbe Punkte der 100er-Frage), Max buzzert und liegt richtig (+100)
  await ml.click('#tile-0-0');
  await mh.waitForSelector('#o-mod-sol');
  const mSol = (await mState()).boards[0].cats[0].qs[0].a;
  assert((await mh.textContent('#o-mod-sol .val')) === mSol, 'Spielleitung sieht die Lösung schon beim Antworten');
  await ml.waitForSelector('#o-ans-in');
  assert(await ml.isVisible('text=Danach entscheidet die Spielleitung'), 'Hinweis für den Antwortenden passt');
  await ml.fill('#o-ans-in', 'Irgendwas'); await ml.press('#o-ans-in', 'Enter');
  await mh.waitForSelector('#o-mod-yes');
  await mm.waitForSelector('#o-mod-wait');
  assert(!(await ml.isVisible('.answer')) && !(await mm.isVisible('.answer')) && !(await ml.isVisible('#o-claim-yes')), 'Spieler sehen die Lösung nicht und bewerten nicht selbst');
  await mh.screenshot({ path: `${SHOTS}/60-mod-judge.png` });
  await mh.click('#o-mod-no');
  await mm.waitForSelector('#o-buzz');
  assert(!(await mh.isVisible('#o-buzz')) && await mh.isVisible('#o-mod-sol'), 'Spielleitung buzzert nicht und sieht weiter die Lösung');
  await mm.click('#o-buzz');
  await mm.waitForSelector('#o-ans-in'); await mm.fill('#o-ans-in', mSol); await mm.press('#o-ans-in', 'Enter');
  await mh.waitForSelector('#o-mod-yes'); await mh.click('#o-mod-yes');
  await ml.waitForSelector('#o-next');
  g = await mState();
  assert(JSON.stringify(g.sc) === '[-50,100]' && g.cur.win === 1, 'Moderiert: Lea −50 (halbe Punkte), Max +100: ' + g.sc);
  const mRes = await ml.$$eval('.verdict .res', els => els.map(e => e.textContent).join(','));
  assert(mRes === 'falsch,richtig', 'Auflösung zeigt das Urteil der Spielleitung: ' + mRes);
  await ml.screenshot({ path: `${SHOTS}/61-mod-resolved.png` });
  await ml.click('#o-next');
  await mm.waitForSelector('button.tile');
  g = await mState();
  assert(g.turn === 1, 'Danach ist Max dran');

  // ---------- [9] Eigenes Board in der Lobby: Gastgeber importiert, alle spielen es zuerst ----------
  console.log('\n[9] Online mit eigenem Board');
  for (const p of [mh, ml, mm]) await p.close();
  const bh = await newPlayer('own-host', { width: 1280, height: 800 });
  await bh.waitForSelector('#me-name'); await bh.fill('#me-name', 'Joan');
  await bh.click('#o-create'); await bh.waitForSelector('.lobby');
  const bl = await mPlayer('own-lea', 'Lea');
  await bh.waitForFunction(() => document.querySelectorAll('.pchip').length === 2, null, { timeout: 5000 });
  const bState = () => bh.evaluate(() => JSON.parse(localStorage.getItem('quizabend.online.v1')));
  while ((await bState()).set.boards > 1) await bh.click('#ob-minus');
  const ownJSON = { boards: [{ name: 'Lobby-Board', kategorien: [1, 2, 3, 4, 5].map(k => ({ name: `Eigen ${k}`, fragen: VALUES.map(p => ({ punkte: p, frage: `Frage ${k}/${p}`, antwort: `L${k}${p}` })) })) }] };
  await bh.click('#ownb-import');
  await bh.fill('#bimp-text', JSON.stringify(ownJSON));
  await bh.click('#bimp-run');
  await bh.waitForSelector('.obrow');
  await bl.waitForSelector('text=ein eigenes kommt zuerst', { timeout: 5000 });
  assert(await bl.$('#ownb-import') === null, 'Nur der Gastgeber importiert Boards, Mitspieler sehen es in den Einstellungen');
  await bh.click('#o-start');
  for (const p of [bh, bl]) await p.waitForSelector('.board', { timeout: 5000 });
  g = await bState();
  assert(g.boards.length === 1 && g.boards[0].cats.map(c => c.name).join(',') === 'Eigen 1,Eigen 2,Eigen 3,Eigen 4,Eigen 5', 'Online wird das eigene Board gespielt');
  assert((await bl.textContent('.board')).includes('Eigen 3'), 'Mitspieler sehen die eigenen Kategorien');
  await bh.screenshot({ path: `${SHOTS}/70-own-board-online.png` });

  // ---------- [9b] Medien: Der Gastgeber lädt hoch, alle sehen Bild, Ton und Video, am Ende wird gelöscht ----------
  console.log('\n[9b] Online mit Medien (Bild, Audio, Video)');
  for (const p of [bh, bl]) await p.close();
  const uh = await newPlayer('med-host', { width: 1280, height: 800 });
  await uh.waitForSelector('#me-name'); await uh.fill('#me-name', 'Joan');
  await uh.click('#o-create'); await uh.waitForSelector('.lobby');
  const ul = await newPlayer('med-lea', { width: 1280, height: 800 });
  await ul.waitForSelector('#me-name'); await ul.fill('#me-name', 'Lea');
  await ul.waitForSelector('[data-act="o-join"]'); await ul.click('[data-act="o-join"]');
  await uh.waitForFunction(() => document.querySelectorAll('.pchip').length === 2, null, { timeout: 5000 });
  const uState = () => uh.evaluate(() => JSON.parse(localStorage.getItem('quizabend.online.v1')));
  while ((await uState()).set.boards > 1) await uh.click('#ob-minus');
  const mPng = Buffer.from(await uh.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const x = c.getContext('2d'); x.fillStyle = '#39c'; x.fillRect(0, 0, 64, 48);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
  const mWav = (() => { const d = Buffer.alloc(8000, 128), h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40); return Buffer.concat([h, d]); })();
  const mMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(21 * 1048576, 9)]); // über 20 MiB: zwei Teile
  const mediaJSON = { boards: [{ name: 'Medien-Runde', kategorien: [1, 2, 3, 4, 5].map(k => ({ name: `Ton ${k}`, fragen: VALUES.map(p => ({ punkte: p, frage: `Was ist das ${k}/${p}?`, antwort: `M${k}${p}`, medium: k === 1 && p === 100 ? 'bild.png' : k === 2 && p === 300 ? 'ton.wav' : k === 3 && p === 500 ? 'film.mp4' : undefined })) })) }] };
  await uh.click('#ownb-import');
  await uh.fill('#bimp-text', JSON.stringify(mediaJSON));
  await uh.setInputFiles('#bimp-media', [{ name: 'bild.png', mimeType: 'image/png', buffer: mPng }, { name: 'ton.wav', mimeType: 'audio/wav', buffer: mWav }, { name: 'film.mp4', mimeType: 'video/mp4', buffer: mMp4 }]);
  await uh.click('#bimp-run');
  await uh.waitForSelector('.obrow', { timeout: 15000 });
  await uh.waitForFunction(() => /Alle Medien sind hochgeladen/.test((document.querySelector('#mu-note') || {}).textContent || ''), null, { timeout: 60000 });
  let ug = await uState();
  const mIds = Object.values(ug.media || {});
  assert(mIds.length === 3 && mIds.every(x => /^[a-z0-9]{24}$/.test(x[0]) && x[1]), 'Alle drei Dateien liegen auf dem Server: ' + mIds.map(x => x[2]).join(','));
  assert(mIds.map(x => x[2]).sort().join(',') === 'audio,bild,video', 'Typen vom Server erkannt');
  assert(!(await uh.isDisabled('#o-start')), 'Start ist frei, sobald alles hochgeladen ist');
  await uh.screenshot({ path: `${SHOTS}/75-medien-lobby.png`, fullPage: true });
  await uh.click('#o-start');
  for (const p of [uh, ul]) await p.waitForSelector('.board', { timeout: 5000 });
  const seenB = (await uh.evaluate(() => window.__emits || [])).join('');
  assert(seenB.length > 100 && !seenB.includes('/medien/') && !mIds.some(x => seenB.includes(x[0])), 'Vor der Frage steht keine Datei-ID in den gesendeten Spielständen');
  // Frage 1 (Bild): Joan wählt, Lea sieht das Bild vom Server
  await uh.click('#tile-0-0');
  await uh.waitForSelector('#o-ans-in'); await ul.waitForSelector('#media-slot img', { timeout: 5000 });
  await ul.waitForFunction(() => { const i = document.querySelector('#media-slot img'); return i && i.complete && i.naturalWidth === 64; }, null, { timeout: 10000 });
  assert((await ul.getAttribute('#media-slot img', 'src')).startsWith(MEDIA_HOST + '/medien/'), 'Lea lädt das Bild vom Server');
  const seenQ = (await uh.evaluate(() => window.__emits || [])).join('');
  assert(mIds.some(x => seenQ.includes(x[0])) && !mIds.some(x => seenQ.includes(x[1])), 'Erst bei der Frage steht die ID im Spielstand, der Löschschlüssel nie');
  await uh.waitForFunction(() => { const i = document.querySelector('#media-slot img'); return i && i.complete && i.naturalWidth === 64; }, null, { timeout: 10000 });
  await ul.screenshot({ path: `${SHOTS}/76-medien-online-bild.png` });
  await uh.fill('#o-ans-in', 'Antwort'); await uh.press('#o-ans-in', 'Enter');
  await uh.waitForSelector('#o-claim-yes'); await uh.click('#o-claim-yes');
  await ul.waitForSelector('#o-yes'); await ul.click('#o-yes');
  await uh.waitForSelector('#o-next'); await uh.click('#o-next');
  // Frage 2 (Audio): Lea ist dran, beide sehen und laden den Ton
  await ul.waitForSelector('button.tile'); await ul.click('#tile-1-2');
  await ul.waitForSelector('#o-ans-in'); await uh.waitForSelector('#media-slot audio', { timeout: 5000 });
  await uh.waitForFunction(() => document.querySelector('#media-slot audio').duration > 0.5, null, { timeout: 10000 });
  assert(true, 'Der Gastgeber lädt den Ton (Dauer erkannt)');
  await ul.waitForFunction(() => document.querySelector('#media-slot audio').duration > 0.5, null, { timeout: 10000 });
  await ul.fill('#o-ans-in', 'Ton'); await ul.press('#o-ans-in', 'Enter');
  await ul.waitForSelector('#o-claim-yes'); await ul.click('#o-claim-yes');
  await uh.waitForSelector('#o-yes'); await uh.click('#o-yes');
  await ul.waitForSelector('#o-next'); await ul.click('#o-next');
  // Frage 3 (Video)
  await uh.waitForSelector('button.tile'); await uh.click('#tile-2-4');
  await uh.waitForSelector('#o-ans-in'); await ul.waitForSelector('#media-slot video', { timeout: 5000 });
  assert((await ul.getAttribute('#media-slot video', 'src')).startsWith(MEDIA_HOST + '/medien/'), 'Lea bekommt das Video vom Server');
  await uh.fill('#o-ans-in', 'Film'); await uh.press('#o-ans-in', 'Enter');
  await uh.waitForSelector('#o-claim-yes'); await uh.click('#o-claim-yes');
  await ul.waitForSelector('#o-yes'); await ul.click('#o-yes');
  await uh.waitForSelector('#o-next'); await uh.click('#o-next'); await ul.waitForSelector('button.tile');
  // Ende: alles wird gelöscht
  await uh.click('#t-menu'); await uh.click('[data-act="o-end"]'); await uh.click('[data-act="modal-ok"]');
  for (const p of [uh, ul]) await p.waitForSelector('.finale');
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { gone = (await Promise.all(mIds.map(x => mediaGone(x[0])))).every(Boolean); if (!gone) await uh.waitForTimeout(200); }
  assert(gone, 'Nach dem Spielende sind alle Dateien vom Server gelöscht');
  assert(Object.keys((await uState()).media || {}).length === 0, 'Der Gastgeber hat die Schlüssel verworfen');
  for (const p of [uh, ul]) await p.close();

  // ---------- [10] Kameras: Bilder gehen per WebRTC direkt von Browser zu Browser (Chromium mit Testkamera) ----------
  console.log('\n[10] Online mit Kameras');
  for (const p of [bh, bl]) await p.close();
  const cPlayer = async (tag, name, join) => {
    const p = await newPlayer(tag, { width: 1280, height: 800 });
    await p.waitForSelector('#me-name'); await p.fill('#me-name', name);
    if (join) { await p.waitForSelector('[data-act="o-join"]'); await p.click('[data-act="o-join"]'); }
    return p;
  };
  const ch = await cPlayer('cam-host', 'Joan', false);
  await ch.click('#o-create'); await ch.waitForSelector('.lobby');
  const cl = await cPlayer('cam-lea', 'Lea', true), cm = await cPlayer('cam-max', 'Max', true);
  await ch.waitForFunction(() => document.querySelectorAll('.pchip').length === 3, null, { timeout: 5000 });
  // Laufen alle n Bilder (Testkamera liefert echte Einzelbilder)?
  const camsLive = (p, n) => p.waitForFunction(k => {
    const vs = [...document.querySelectorAll('#cam-slot .cam video')];
    return vs.length === k && vs.every(v => v.videoWidth > 0 && !v.paused);
  }, n, { timeout: 15000 });
  const camNames = p => p.$$eval('#cam-slot .cam .nm', els => els.map(e => e.textContent).join(','));

  await ch.click('#o-cam');
  await camsLive(ch, 1);
  assert((await camNames(ch)) === 'Joan (du)', 'Gastgeber sieht sein eigenes Bild');
  await cl.click('#o-cam');
  await camsLive(cm, 2);
  assert((await camNames(cm)) === 'Joan,Lea', 'Max ohne Kamera sieht Joan und Lea: ' + await camNames(cm));
  await camsLive(ch, 2); await camsLive(cl, 2);
  assert((await camNames(cl)) === 'Joan,Lea (du)', 'Lea sieht Joan und sich selbst');
  assert((await cm.textContent('#o-cam')).includes('Kamera einschalten'), 'Bei Max bleibt die Kamera aus, bis er sie einschaltet');
  await ch.screenshot({ path: `${SHOTS}/72-kamera-lobby.png` });

  // Spielstart: Die Bilder laufen auf der Tafel weiter, auch wenn sie neu gezeichnet wird
  while ((await ch.evaluate(() => JSON.parse(localStorage.getItem('quizabend.online.v1')).set.boards)) > 1) await ch.click('#ob-minus');
  await ch.click('#o-start');
  for (const p of [ch, cl, cm]) await p.waitForSelector('.board', { timeout: 5000 });
  await camsLive(cm, 2);
  const t0 = await cm.evaluate(() => [...document.querySelectorAll('#cam-slot video')].map(v => v.currentTime));
  await cm.waitForTimeout(1200);
  const t1 = await cm.evaluate(() => [...document.querySelectorAll('#cam-slot video')].map(v => v.currentTime));
  assert(t1.every((t, i) => t > t0[i]), 'Auf der Tafel laufen die Bilder weiter');
  const camW = await cm.evaluate(() => [...document.querySelectorAll('#cam-slot video')].map(v => v.videoWidth));
  assert(camW.every(w => w > 0 && w <= 400), `Verschickt werden kleine Bilder, auch wenn die Kamera größer filmt (${camW})`);
  assert(await cm.isVisible('#t-cam') && await cm.isVisible('.board'), 'Kamera-Knopf in der Kopfzeile, Tafel bleibt sichtbar');
  await cm.screenshot({ path: `${SHOTS}/73-kamera-tafel.png` });

  // Max schaltet seine Kamera auch ein, Lea schaltet ihre aus
  await cm.click('#t-cam');
  await camsLive(ch, 3); await camsLive(cl, 3);
  assert((await camNames(ch)) === 'Joan (du),Lea,Max', 'Alle drei Bilder beim Gastgeber: ' + await camNames(ch));
  await cl.click('#t-cam');
  await camsLive(ch, 2); await camsLive(cm, 2);
  assert(!(await camNames(cm)).includes('Lea'), 'Leas Bild verschwindet bei den anderen');
  assert(await cl.evaluate(() => !document.querySelector('.cam.me')), 'Lea sieht ihr eigenes Bild nicht mehr');
  await camsLive(cl, 2);
  // Max verlässt das Spiel: Kamera aus, sein Bild verschwindet
  await cm.click("#t-menu"); await cm.click("[data-act=\"o-leave-ask\"]");
  await cm.waitForSelector(".setup", { timeout: 5000 });
  await camsLive(ch, 1);
  assert(await cm.evaluate(() => !document.querySelector('.cam')), 'Nach dem Verlassen ist Max ohne Kamera');
  const cEmit = Math.max(...await Promise.all([ch, cl].map(p => p.evaluate(() => window.__maxEmit || 0))));
  assert(cEmit > 0 && cEmit < 4096, `Verbindungsdaten bleiben unter 4 KiB pro Nachricht (${cEmit} Bytes)`);

  await browser.close();
  server.close();
  console.log('\nFehler im Browser:', errors.length ? '\n' + errors.join('\n') : 'keine');
  console.log(failures.length ? `\n${failures.length} FEHLGESCHLAGEN` : '\nALLES OK');
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
