// Online mode test: host + two players, each in its own browser context, connected by a relayed mock of the room capability.
const { chromium } = require('playwright');
const fs = require('fs');

const path = require('path');
const { startServer } = require('../tools/serve');
let BASE = '';
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

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  BASE = server.url;
  const browser = await chromium.launch();
  const metas = [];
  const relay = (fromPage, s) => {
    const m = JSON.parse(s);
    const meta = metas.find(x => x.page === fromPage); if (meta) meta.id = m.from;
    for (const x of metas) if (x.page !== fromPage && !x.page.isClosed()) x.page.evaluate(str => window.__relayIn && window.__relayIn(str), s).catch(() => {});
  };
  async function newPlayer(tag, viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(MOCK);
    await ctx.exposeBinding('__relayOut', ({ page }, s) => relay(page, s));
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`${tag} pageerror: ${e.message}`));
    const meta = { page, id: null, tag };
    metas.push(meta);
    page.on('framenavigated', f => {
      if (f !== page.mainFrame() || !meta.id) return;
      const old = meta.id; meta.id = null;
      for (const x of metas) if (x.page !== page && !x.page.isClosed()) x.page.evaluate(str => window.__relayIn && window.__relayIn(str), JSON.stringify({ kind: 'leave', from: old })).catch(() => {});
    });
    await page.goto(BASE);
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

  await browser.close();
  server.close();
  console.log('\nFehler im Browser:', errors.length ? '\n' + errors.join('\n') : 'keine');
  console.log(failures.length ? `\n${failures.length} FEHLGESCHLAGEN` : '\nALLES OK');
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
