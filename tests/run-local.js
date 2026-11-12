// End-to-end test for Quizabend: plays complete games and checks the scoring.
const { chromium } = require('playwright');
const fs = require('fs');

const path = require('path');
const { startServer } = require('../tools/serve');
let BASE = '';
const SHOTS = path.join(__dirname, '..', 'shots');
const failures = [];
const errors = [];
const assert = (cond, msg) => { if (cond) console.log('  ok   ', msg); else { console.log('  FAIL ', msg); failures.push(msg); } };
const VALUES = [100, 200, 300, 400, 500];

function watch(page, tag) {
  page.on('console', m => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${tag} pageerror: ${e.message}`));
}
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('quizabend.game.v1')));

// Mock of the artifact "room" capability: relays between pages of one browser context.
const MOCK_ROOM = `(() => {
  const bc = new BroadcastChannel('mock-room');
  const me = 'p' + Math.random().toString(36).slice(2, 8);
  const handlers = {}, peerHandlers = [];
  const peersMap = new Map([[me, { presence: {}, updatedAt: Date.now() }]]);
  const snap = () => [...peersMap.entries()].map(([peer, v]) => Object.freeze({ peer, by: null, isMe: peer === me, sameTab: peer === me, kind: 'viewer', guest: false, presence: v.presence, updatedAt: v.updatedAt }));
  const notify = (joined, left, updated) => { const ps = snap(); const pick = ids => ps.filter(p => ids.includes(p.peer)); peerHandlers.forEach(fn => fn({ peers: ps, joined: pick(joined), left: left.map(id => ({ peer: id, presence: {} })), updated: pick(updated) })); };
  bc.onmessage = ev => {
    const m = ev.data;
    if (m.kind === 'emit') (handlers[m.topic] || []).forEach(fn => fn({ topic: m.topic, data: m.data, peer: m.from, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false }));
    else if (m.kind === 'presence') {
      const had = peersMap.has(m.from);
      peersMap.set(m.from, { presence: m.presence, updatedAt: Date.now() });
      notify(had ? [] : [m.from], [], had ? [m.from] : []);
      if (!had) bc.postMessage({ kind: 'presence', from: me, presence: peersMap.get(me).presence });
    } else if (m.kind === 'leave') { peersMap.delete(m.from); notify([], [m.from], []); }
  };
  addEventListener('beforeunload', () => bc.postMessage({ kind: 'leave', from: me }));
  const room = {
    emit(topic, data) {
      const s = JSON.stringify(data); if (s.length > 4096) return Promise.reject({ code: 'invalid_argument', message: 'too big ' + s.length });
      window.__maxEmit = Math.max(window.__maxEmit || 0, s.length);
      setTimeout(() => (handlers[topic] || []).forEach(fn => fn({ topic, data: JSON.parse(s), peer: me, by: null, isMe: true, sameTab: true, kind: 'viewer', guest: false })), 0);
      bc.postMessage({ kind: 'emit', topic, data: JSON.parse(s), from: me }); return Promise.resolve();
    },
    on(topic, fn) { (handlers[topic] = handlers[topic] || []).push(fn); return () => {}; },
    presence(patch) {
      const cur = Object.assign({}, peersMap.get(me).presence);
      for (const k in patch) { if (patch[k] === null) delete cur[k]; else cur[k] = patch[k]; }
      peersMap.set(me, { presence: cur, updatedAt: Date.now() });
      bc.postMessage({ kind: 'presence', from: me, presence: cur }); notify([], [], [me]); return Promise.resolve();
    },
    peers() { return snap(); },
    onPeers(fn) { peerHandlers.push(fn); setTimeout(() => fn({ peers: snap(), joined: snap(), left: [], updated: [] }), 0); return () => {}; },
    connected() { return true; },
    onConnection(fn) { setTimeout(() => fn(true), 0); return () => {}; },
    join() { return Promise.reject({ code: 'not_permitted' }); }
  };
  window.claude = { use: async name => { await new Promise(r => setTimeout(r, 60)); return name === 'room' ? room : null; } };
  setTimeout(() => bc.postMessage({ kind: 'presence', from: me, presence: peersMap.get(me).presence }), 20);
})();`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  BASE = server.url;
  const browser = await chromium.launch();

  /* ---------------- 1. Full game, three teams, two boards ---------------- */
  console.log('\n[1] Volles Spiel mit 3 Teams und 2 Boards');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { window.QUIZ_ROOM_URL = ''; });
  const page = await ctx.newPage(); watch(page, 'main');
  await page.goto(BASE);
  await page.waitForTimeout(1700);
  await page.click('#tab-local');
  await page.screenshot({ path: `${SHOTS}/01-setup.png`, fullPage: true });

  await page.fill('#tn-0', 'Die Füchse');
  await page.click('#team-add');
  await page.click('#tm-30');
  await page.click('#start');
  await page.waitForTimeout(300);
  let s = await state(page);
  assert(s.boards.length === 2, 'zwei Boards erzeugt');
  assert(s.teams.map(t => t.name).join('|') === 'Die Füchse|Team Blau|Team Gelb', 'Teamnamen: ' + s.teams.map(t => t.name).join(', '));
  assert(s.teams.map(t => t.key).join('') === 'alq', 'Buzzer-Tasten a, l, q');
  const game1Cats = s.boards.flatMap(b => b.cats.map(c => c.name));
  assert(new Set(game1Cats).size === 10, '10 verschiedene Kategorien');
  assert(s.boards.every(b => b.cats.every(c => c.qs.length === 5)), 'je 5 Fragen pro Kategorie');
  await page.screenshot({ path: `${SHOTS}/02-board.png` });

  // Q1: Team 0 wählt 400er, falsch (−200), Team 1 buzzert per Taste und hat recht (+400)
  await page.click('#tile-0-3');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/03-question.png` });
  await page.click('#q-wrong');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/04-buzz.png` });
  await page.keyboard.press('a'); // Team 0 hat schon geantwortet: darf nicht buzzern
  s = await state(page);
  assert(s.dyn.cur.st === 'buzz', 'Team am Zug kann nach falscher Antwort nicht buzzern');
  await page.keyboard.press('l');
  s = await state(page);
  assert(s.dyn.cur.st === 'buzzAnswer' && s.dyn.cur.ans === 1, 'Team Blau buzzert mit Taste L');
  await page.click('#q-right');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/05-resolved.png` });
  s = await state(page);
  assert(JSON.stringify(s.dyn.scores) === '[-200,400,0]', 'Punkte nach Frage 1: ' + s.dyn.scores);
  await page.click('#q-next');
  s = await state(page);
  assert(s.dyn.turn === 1 && s.dyn.phase === 'board' && s.dyn.res[0][0][3] === 1, 'Zug geht an Team 2, Feld gehört Team Blau');

  // Q2: alle falsch → niemand bekommt Punkte, jeder verliert die Hälfte
  await page.click('#tile-1-0'); await page.click('#q-wrong');
  await page.keyboard.press('q'); await page.click('#q-wrong');
  await page.click('#bz-0'); await page.click('#q-wrong');
  s = await state(page);
  assert(s.dyn.cur.st === 'resolved' && s.dyn.cur.win === -1, 'alle falsch: aufgelöst ohne Gewinner');
  assert(JSON.stringify(s.dyn.scores) === '[-250,350,-50]', 'Punkte nach Frage 2: ' + s.dyn.scores);
  await page.click('#q-next');

  // Q3: Zurück zum Board und Rückgängig
  await page.click('#tile-2-0'); await page.click('#q-back');
  s = await state(page);
  assert(s.dyn.phase === 'board' && s.dyn.turn === 2 && s.dyn.res[0][2][0] === null, 'Zurück zum Board: Feld bleibt offen, gleiches Team');
  await page.click('#tile-2-0'); await page.click('#q-right');
  s = await state(page); assert(s.dyn.scores[2] === 50, 'Team Gelb +100');
  await page.keyboard.press('Control+z');
  s = await state(page); assert(s.dyn.scores[2] === -50 && s.dyn.cur.st === 'answer', 'Strg+Z macht die Wertung rückgängig');
  await page.click('#q-right'); await page.click('#q-next');

  // Rest von Board 1: immer richtig
  const exp = [-250, 350, 50];
  let turn = 0;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    s = await state(page);
    if (s.dyn.res[0][c][r] !== null) continue;
    await page.click(`#tile-${c}-${r}`); await page.click('#q-right'); await page.click('#q-next');
    exp[turn] += VALUES[r]; turn = (turn + 1) % 3;
  }
  s = await state(page);
  assert(s.dyn.phase === 'boardEnd', 'Board 1 leer → Zwischenstand');
  assert(JSON.stringify(s.dyn.scores) === JSON.stringify(exp), `Punkte nach Board 1: ${s.dyn.scores} (erwartet ${exp})`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/06-board-end.png` });
  await page.click('#nb');
  s = await state(page);
  assert(s.dyn.bi === 1 && s.dyn.phase === 'board' && s.dyn.turn === turn, 'Board 2 beginnt, Zugreihenfolge läuft weiter');

  // Board 2: abwechselnd richtig / falsch ohne Buzzer
  let k = 0;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    await page.click(`#tile-${c}-${r}`);
    if (k++ % 2 === 0) { await page.click('#q-right'); exp[turn] += VALUES[r]; }
    else { await page.click('#q-wrong'); await page.click('#q-nobody'); exp[turn] -= VALUES[r] / 2; }
    if (k === 24) { await page.waitForTimeout(200); await page.screenshot({ path: `${SHOTS}/07-board2-late.png` }); }
    await page.click('#q-next');
    turn = (turn + 1) % 3;
  }
  s = await state(page);
  assert(s.dyn.phase === 'gameEnd', 'Nach dem letzten Board: Endstand');
  assert(JSON.stringify(s.dyn.scores) === JSON.stringify(exp), `Endstand ${s.dyn.scores} (erwartet ${exp})`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/08-game-end.png` });
  const winnerText = await page.textContent('.finale .bigline');
  const best = Math.max(...exp), wi = exp.indexOf(best);
  assert(winnerText.includes(s.teams[wi].name), 'Sieger-Anzeige: ' + winnerText);

  // Revanche: neue Kategorien, keine Wiederholung
  await page.click('#rematch');
  s = await state(page);
  const game2Cats = s.boards.flatMap(b => b.cats.map(c => c.name));
  assert(game2Cats.every(n => !game1Cats.includes(n)), 'Revanche zieht nur neue Kategorien');
  assert(JSON.stringify(s.dyn.scores) === '[0,0,0]', 'Revanche startet bei 0');

  // Menü → Neues Spiel einrichten
  await page.click('#t-menu'); await page.click('[data-act="new-setup-ask"]'); await page.click('[data-act="modal-ok"]');
  assert(await page.isVisible('#start'), 'Zurück in der Einrichtung');

  /* ---------------- 2. Eigene Fragen ---------------- */
  console.log('\n[2] Eigene Fragen');
  await page.click('#open-editor');
  await page.click('#ed-new');
  await page.fill('#ed-name', 'Unsere Clique');
  for (let r = 0; r < 5; r++) { await page.fill(`#ed-q-${r}`, `Testfrage für ${VALUES[r]}?`); await page.fill(`#ed-a-${r}`, `Antwort ${r + 1}`); }
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/09-editor.png`, fullPage: true });
  await page.click('#ed-import');
  await page.fill('#imp-text', JSON.stringify({ kategorien: [{ name: 'Importiert', fragen: [5, 1, 3, 2, 4].map(p => ({ punkte: p * 100, frage: `F${p}`, antwort: `A${p}` })) }] }));
  await page.click('[data-act="imp-run"]');
  const custom = await page.evaluate(() => JSON.parse(localStorage.getItem('quizabend.custom.v1')));
  assert(custom.length === 2 && custom[1].name === 'Importiert' && custom[1].qs.map(x => x.q).join(',') === 'F1,F2,F3,F4,F5', 'Import sortiert nach Punkten');
  await page.click('#ed-import'); await page.fill('#imp-text', '{kaputt'); await page.click('[data-act="imp-run"]');
  assert((await page.textContent('#imp-err')).includes('kein gültiges JSON'), 'Fehlermeldung bei kaputtem JSON');
  await page.click('[data-act="modal-close"]');
  await page.click('#ed-export');
  const exported = await page.inputValue('#exp-text');
  assert(JSON.parse(exported).kategorien.length === 2, 'Export enthält beide Kategorien');
  await page.click('[data-act="modal-close"]');
  await page.click('#ed-close');
  assert(await page.isVisible('#cat-' + custom[0].id), 'Eigene Kategorie erscheint in der Auswahl');
  await page.click('#cats-none');
  assert(await page.isDisabled('#start'), 'Ohne Kategorien kein Start');
  await page.click('#cats-all');

  /* ---------------- 2b. Eigene Boards: Vorlagen, Import, Reihenfolge ---------------- */
  console.log('\n[2b] Eigene Boards');
  const VORL = path.join(__dirname, '..', 'vorlagen');
  const ownB = () => page.evaluate(() => JSON.parse(localStorage.getItem('quizabend.boards.v1') || '[]'));
  const bImport = async (files, text) => {
    await page.click('#ownb-import');
    if (files) { await page.setInputFiles('#bimp-file', files); await page.waitForFunction(() => document.querySelector('#bimp-text').value || document.querySelector('#bimp-err').textContent); }
    if (text != null) await page.fill('#bimp-text', text);
    await page.click('#bimp-run');
    await page.waitForTimeout(150);
    const err = await page.isVisible('#bimp-err') ? await page.textContent('#bimp-err') : '';
    if (err) await page.click('[data-act="modal-close"]');
    return err;
  };
  assert(await page.getAttribute('#link-boards', 'href') === 'boards.html', 'Startseite verlinkt die Seite mit Vorlagen und Anleitung');
  let bErr = await bImport(path.join(VORL, 'quizabend-board-vorlage.xlsx'));
  assert(bErr.includes('Kategorie „Kategorie 1“, 100 Punkte: Die Frage fehlt'), 'Leere Excel-Vorlage: Fehlermeldung nennt die Stelle: ' + bErr);
  bErr = await bImport(path.join(VORL, 'quizabend-board-beispiel.xlsx'));
  let ob = await ownB();
  assert(!bErr && ob.length === 1 && ob[0].name === 'Beispiel: Allgemeinwissen' && ob[0].cats.map(c => c.name).join(',') === 'Geografie,Geschichte,Naturwissenschaft,Weltraum,Sport', 'Beispiel-Board aus Excel importiert ' + bErr);
  // Eingefügte Zellen wie aus Google Sheets: zwei Boards, Namen nur in der ersten Zeile, Zeilen ungeordnet, Zelle mit Zeilenumbruch
  const rowsTSV = [['Board', 'Kategorie', 'Punkte', 'Frage', 'Antwort']];
  ['Party A', 'Party B'].forEach(bn => [1, 2, 3, 4, 5].forEach(k => [500, 100, 300, 200, 400].forEach((p, j) =>
    rowsTSV.push([k === 1 && j === 0 ? bn : '', j === 0 ? `${bn} K${k}` : '', String(p), p === 300 && k === 1 ? '"Zwei\nZeilen"' : `${bn} K${k} F${p}`, `A${p}`]))));
  bErr = await bImport(null, rowsTSV.map(r => r.join('\t')).join('\n'));
  ob = await ownB();
  assert(!bErr && ob.length === 3 && ob[1].name === 'Party A' && ob[2].name === 'Party B', 'Zwei Boards aus eingefügten Zellen ' + bErr);
  assert(ob[1].cats[0].qs.map(x => x.a).join(',') === 'A100,A200,A300,A400,A500' && ob[1].cats[0].qs[2].q === 'Zwei\nZeilen', 'Fragen nach Punkten sortiert, Zeilenumbruch in der Zelle bleibt');
  // CSV mit Semikolon (deutsches Excel), ohne Board-Spalte: Name kommt aus dem Dateinamen
  const csv = ['Kategorie;Punkte;Frage;Antwort', ...[1, 2, 3, 4, 5].flatMap(k => VALUES.map((p, j) => `${j ? '' : 'CSV ' + k};${p};Frage ${k}/${p};Antwort ${p}`))].join('\r\n');
  bErr = await bImport({ name: 'mein-csv-board.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + csv) });
  ob = await ownB();
  assert(!bErr && ob.length === 4 && ob[3].name === 'mein csv board', 'CSV mit Semikolon importiert, Name aus dem Dateinamen ' + bErr);
  bErr = await bImport(null, rowsTSV.slice(0, 21).map(r => r.join('\t')).join('\n'));
  assert(bErr.includes('hat 4 Kategorien'), 'Board mit zu wenigen Kategorien wird abgelehnt: ' + bErr);
  bErr = await bImport(null, '{"boards": [{"name": "Halb", "kategorien": []}]}');
  assert(bErr.includes('genau fünf'), 'JSON-Board ohne Kategorien wird abgelehnt');
  bErr = await bImport(path.join(VORL, 'quizabend-board-beispiel.json'));
  ob = await ownB();
  assert(!bErr && ob.length === 5, 'Beispiel-Board als JSON importiert');
  // Auswahl: CSV-Board und JSON-Board abwählen, Excel-Beispiel löschen. Bleiben Party A und Party B.
  await page.click(`#ownb-${ob[3].id}`); await page.click(`#ownb-${ob[4].id}`);
  await page.click(`#ownb-del-${ob[0].id}`); await page.click('[data-act="modal-ok"]');
  ob = await ownB();
  assert(ob.length === 4 && ob.filter(b => b.on).map(b => b.name).join(',') === 'Party A,Party B', 'Abwählen und Löschen');
  await page.click('#cats-none');
  assert(!(await page.isDisabled('#start')) && (await page.textContent('.startbar .hint')).includes('Deine 2 eigenen Boards kommen zuerst'), 'Nur eigene Boards, ohne Kategorien: Start geht');
  assert(await page.isDisabled('#b-plus') && await page.isDisabled('#b-minus'), 'Ohne Kategorien genau so viele Boards wie eigene');
  await page.screenshot({ path: `${SHOTS}/09b-own-boards.png`, fullPage: true });
  await page.click('#cats-all');

  await page.click('#b-plus');
  await page.click('#start');
  await page.waitForSelector('.board');
  s = await state(page);
  assert(s.boards.length === 3 && s.boards[0].cats[0].name === 'Party A K1' && s.boards[1].cats[4].name === 'Party B K5' && !s.boards[2].cats[0].name.startsWith('Party'), 'Eigene Boards zuerst und in Reihenfolge, danach ein zufälliges');
  assert(s.boards[0].cats[0].qs[0].a === 'A100', 'Board spielt die eigenen Fragen');
  await page.click('#t-menu'); await page.click('[data-act="new-setup-ask"]'); await page.click('[data-act="modal-ok"]');
  // Seite mit Vorlagen: alle Downloads sind da
  const help = await ctx.newPage(); watch(help, 'boards');
  await help.goto(BASE.replace(/index\.html$/, 'boards.html'));
  const links = await help.$$eval('a[download]', els => els.map(a => a.href));
  const codes = await Promise.all(links.map(u => help.request.get(u).then(r => r.status())));
  assert(links.length >= 5 && codes.every(c => c === 200), `Anleitungsseite: ${links.length} Downloads erreichbar`);
  await help.screenshot({ path: `${SHOTS}/09c-boards-page.png`, fullPage: true });
  await help.close();
  await ctx.close();

  /* ---------------- 3. Sechs Teams auf Laptop-Bildschirm ---------------- */
  console.log('\n[3] Sechs Teams, 1366×768');
  const ctx3 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx3.addInitScript(() => { window.QUIZ_ROOM_URL = ''; });
  const p3 = await ctx3.newPage(); watch(p3, 'six');
  await p3.goto(BASE);
  await p3.click('#tab-local');
  for (let i = 0; i < 4; i++) await p3.click('#team-add');
  await p3.fill('#tn-3', 'Die mit dem extrem langen Teamnamen');
  await p3.click('#b-plus'); await p3.click('#b-plus'); await p3.click('#b-plus');
  await p3.click('#start');
  s = await state(p3);
  assert(s.teams.length === 6 && s.boards.length === 5, '6 Teams, 5 Boards (alle 25 Kategorien)');
  await p3.click('#tile-4-4'); await p3.click('#q-right'); await p3.click('#q-next');
  await p3.click('#tile-0-1'); await p3.click('#q-wrong');
  await p3.waitForTimeout(300);
  await p3.screenshot({ path: `${SHOTS}/10-six-buzz.png` });
  await p3.click('#q-nobody'); await p3.click('#q-next');
  await p3.screenshot({ path: `${SHOTS}/11-six-board.png` });
  // Neu laden: Weiterspielen
  await p3.reload(); await p3.waitForTimeout(400);
  if (await p3.isVisible('#tab-local')) await p3.click('#tab-local');
  assert(await p3.isVisible('#resume'), 'Nach dem Neuladen: Weiterspielen angeboten');
  await p3.click('#resume');
  s = await state(p3);
  assert(s.dyn.turn === 2 && s.dyn.scores[0] === 500 && s.dyn.scores[1] === -100, 'Spielstand nach dem Neuladen erhalten');
  await ctx3.close();

  /* ---------------- 4. Handy als Spielleitung ---------------- */
  console.log('\n[4] Spielleitung am Handy (simulierter Raum)');
  const ctx4 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx4.addInitScript(() => { window.QUIZ_ROOM_URL = ''; });
  await ctx4.addInitScript(MOCK_ROOM);
  const tv = await ctx4.newPage(); watch(tv, 'tv');
  await tv.goto(BASE); await tv.waitForTimeout(300);
  await tv.click('#tab-local');
  await tv.click('#start'); await tv.waitForTimeout(300);
  // Ein echtes Handy hat eigene Einstellungen und startet im Online-Reiter. Der Knopf muss auch dort zu sehen sein.
  await tv.evaluate(() => { const p = JSON.parse(localStorage.getItem('quizabend.prefs.v1')); p.tab = 'online'; localStorage.setItem('quizabend.prefs.v1', JSON.stringify(p)); });
  const phone = await ctx4.newPage(); watch(phone, 'phone');
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(BASE);
  await phone.waitForSelector('[data-act="remote-join"]', { timeout: 5000 });
  await phone.screenshot({ path: `${SHOTS}/12-phone-join.png` });
  await phone.click('[data-act="remote-join"]');
  await phone.waitForSelector('.r-board', { timeout: 5000 });
  await phone.screenshot({ path: `${SHOTS}/13-phone-board.png`, fullPage: true });
  await tv.waitForTimeout(300);
  assert(await tv.isVisible('#t-phone .dot.on'), 'Fernseher zeigt: Handy verbunden');
  await phone.click('.r-board button.t[data-c="2"][data-r="1"]');
  await tv.waitForSelector('.qcard', { timeout: 3000 });
  s = await state(tv);
  assert(s.dyn.phase === 'question' && s.dyn.cur.c === 2 && s.dyn.cur.r === 1, 'Frage vom Handy aus gewählt');
  await phone.waitForSelector('.r-ans', { timeout: 3000 });
  const ansPhone = await phone.textContent('.r-ans .val');
  assert(ansPhone === s.boards[0].cats[2].qs[1].a, 'Handy zeigt die richtige Lösung');
  assert(!(await tv.isVisible('.answer')), 'Fernseher zeigt die Lösung noch nicht');
  await phone.screenshot({ path: `${SHOTS}/14-phone-question.png`, fullPage: true });
  await phone.click('[data-act="judge"][data-ok="0"]');
  await phone.waitForSelector('[data-act="buzz"][data-t="1"]', { timeout: 3000 });
  await phone.screenshot({ path: `${SHOTS}/15-phone-buzz.png`, fullPage: true });
  await phone.click('[data-act="buzz"][data-t="1"]');
  await phone.waitForSelector('[data-act="judge"][data-ok="1"]:not([disabled])', { timeout: 3000 });
  await phone.click('[data-act="judge"][data-ok="1"]');
  await phone.waitForSelector('[data-act="next"]:not([disabled])', { timeout: 3000 });
  s = await state(tv);
  assert(JSON.stringify(s.dyn.scores) === '[-100,200]' && s.dyn.cur.st === 'resolved', 'Wertung vom Handy: ' + s.dyn.scores);
  assert(await tv.isVisible('.answer'), 'Nach dem Auflösen zeigt der Fernseher die Lösung');
  await phone.click('[data-act="next"]');
  await phone.waitForSelector('.r-board', { timeout: 3000 });
  await phone.click('[data-act="undo"]');
  await phone.waitForSelector('[data-act="next"]:not([disabled])', { timeout: 3000 });
  s = await state(tv);
  assert(s.dyn.phase === 'question' && s.dyn.cur.st === 'resolved', 'Rückgängig vom Handy');
  const maxEmit = await tv.evaluate(() => window.__maxEmit || 0);
  assert(maxEmit > 0 && maxEmit < 4096, 'Nachrichten bleiben unter 4 KiB: ' + maxEmit + ' Bytes');
  await tv.screenshot({ path: `${SHOTS}/16-tv-resolved.png` });
  await ctx4.close();

  await browser.close();
  server.close();
  console.log('\nFehler im Browser:', errors.length ? '\n' + errors.join('\n') : 'keine');
  console.log(failures.length ? `\n${failures.length} FEHLGESCHLAGEN` : '\nALLES OK');
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
