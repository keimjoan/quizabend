// Test der Monatsgrenzen des Medienspeichers (Raum-Server). Startet selbst drei kurzlebige Server (wrangler dev) mit frischem,
// leerem Speicher auf Port 8788, jeweils mit gesenkten Grenzen über --var. Aufruf: node tests/run-media-limit.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, execSync } = require('child_process');
const PORT = 8788, BASE = `http://127.0.0.1:${PORT}`, ORIGIN = 'http://localhost:8080';
const MIB = 1024 * 1024, PART = 20 * MIB;
const failures = [];
const assert = (cond, msg) => { if (cond) console.log('  ok   ', msg); else { console.log('  FAIL ', msg); failures.push(msg); } };
const rnd = () => Math.random().toString(36).slice(2, 10);
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

const MP4 = n => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(Math.max(0, n - 12), 5)]);
const PNG = n => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(Math.max(0, n - 8), 7)]);
const call = (method, p, body, ip = IP, type = 'application/octet-stream') => fetch(BASE + p, { method, body, headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Content-Type': type } });
const json = async r => { try { return await r.json(); } catch (e) { return {}; } };
// Erster Teil einer Datei mit angegebener Gesamtgröße (bis 20 MiB ist das schon die ganze Datei)
const start = async (buf, size, room, ip) => { const r = await call('POST', `/medien/${room}?size=${size}`, buf.subarray(0, Math.min(size, PART)), ip); return { status: r.status, ...(await json(r)) }; };

function startServer(vars) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quizabend-limit-'));
  const cmd = `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to "${dir}" ${vars.map(v => '--var ' + v).join(' ')}`;
  const child = spawn(cmd, { cwd: path.join(__dirname, '..', 'server'), shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const stop = () => {
    try { if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); else child.kill('SIGTERM'); } catch (e) { /* schon beendet */ }
    return new Promise(res => setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noch gesperrt */ } res(); }, 1500));
  };
  const ready = (async () => {
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(`${BASE}/medien/aaaaaaaaaaaaaaaaaaaaaaaa`); if (r.status === 404 || r.status === 503) return; } catch (e) { /* noch nicht bereit */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Server startet nicht:\n' + log.slice(-1500));
  })();
  return { ready, stop };
}

async function withServer(vars, fn) {
  const s = startServer(vars);
  try { await s.ready; await fn(); } finally { await s.stop(); }
}

(async () => {
  console.log('\n[L1] Monatsgrenze für Bytes und Dateien (gesenkt auf 25 MB und 45 Dateien)');
  await withServer(['MONTH_BYTES:25000000', 'MONTH_FILES:45'], async () => {
    const room = 'mon' + rnd(), v10 = MP4(10_000_000);
    let a = await start(v10, v10.length, room); assert(a.status === 200 && a.done, 'Erste Datei (10 MB) angenommen');
    a = await start(v10, v10.length, room); assert(a.status === 200, 'Zweite Datei (10 MB) angenommen');
    a = await start(v10, v10.length, room);
    assert(a.status === 429 && /Monatslimit/.test(a.fehler || ''), 'Dritte Datei (30 MB über 25 MB) abgewiesen mit Monatslimit: ' + (a.fehler || a.status));
    const v4 = MP4(4_000_000);
    a = await start(v4, v4.length, room); assert(a.status === 200, 'Eine kleinere Datei (4 MB) passt noch, der abgewiesene Aufruf hat nichts verbraucht');
    const v2 = MP4(2_000_000);
    a = await start(v2, v2.length, room); assert(a.status === 429 && /Monatslimit/.test(a.fehler || ''), 'Weitere 2 MB (26 MB) abgewiesen');

    // Zurückgeben: Ein am Raum-Tageslimit abgewiesener Aufruf darf im Monat nichts verbrauchen
    const small = PNG(100), roomA = 'rma' + rnd(), roomB = 'rmb' + rnd();
    let ok = 0, last;
    for (let i = 0; i < 41; i++) { last = await start(small, small.length, roomA); if (last.status === 200) ok++; }
    assert(ok === 40 && last.status === 429 && /Heute/.test(last.fehler || ''), `Raum-Tageslimit: 40 angenommen, die 41. mit Tagestext abgewiesen (${ok}, ${last.fehler || last.status})`);
    ok = 0;
    for (let i = 0; i < 4; i++) { last = await start(small, small.length, roomB); if (last.status === 200) ok++; }
    assert(ok === 2 && last.status === 429 && /Monatslimit/.test(last.fehler || ''), `Dateigrenze im Monat (45): danach noch genau 2 Dateien, dann Monatslimit (${ok})`);
  });

  console.log('\n[L2] Schreibvorgänge im Monat (gesenkt auf 9): derselbe Teil lässt sich nicht beliebig oft schicken');
  await withServer(['MONTH_WRITES:9'], async () => {
    const room = 'wr' + rnd(), size = PART + MIB, v = MP4(size);
    const a = await start(v, size, room);
    assert(a.status === 200 && a.done === false && a.id, 'Datei über 20 MiB begonnen (3 Schreibvorgänge)');
    let ok = 0, last;
    for (let i = 0; i < 12; i++) {
      last = await call('PUT', `/medien/${a.id}/2?del=${a.del}`, v.subarray(PART));
      if (last.ok) ok++; else break;
    }
    assert(ok === 6 && last.status === 429, `Teil 2 wurde 6-mal angenommen (1 + 5 Wiederholungen), danach 429 (${ok}, ${last.status})`);
    const lj = await json(last);
    assert(/Monatslimit/.test(lj.fehler || ''), 'Meldung nennt das Monatslimit');
    const e = await call('POST', `/medien/${a.id}/fertig`, JSON.stringify({ del: a.del, parts: [{ n: 1, etag: a.etag }, { n: 2, etag: 'x' }] }), IP, 'application/json');
    assert(e.status === 429, 'Auch das Abschließen zählt (429)');
    const s = await start(PNG(100), 100, room); assert(s.status === 429, 'Neue Dateien werden ebenfalls abgewiesen');
  });

  console.log('\n[L3] Die Grenze von 10 GB im Monat gilt wirklich (Standard, ein Senken oder Erhöhen per Variable ändert nichts nach oben)');
  await withServer(['MONTH_BYTES:99000000000'], async () => {
    const size = 500 * MIB, v = MP4(PART), made = [];
    let ok = 0, last;
    for (let i = 0; i < 21; i++) {
      // Jeder Aufruf mit eigener Adresse und eigenem Raum, damit nur die Monatsgrenze zählt
      last = await start(v, size, 'gb' + rnd(), `10.9.${i}.${Math.floor(Math.random() * 250)}`);
      if (last.status === 200) { ok++; made.push([last.id, last.del]); } else break;
    }
    assert(ok === 19 && last.status === 429 && /Monatslimit/.test(last.fehler || ''), `19 Videos zu 500 MiB (9,96 GB) angenommen, das 20. (über 10 GB) abgewiesen (${ok}, ${last.status})`);
    const d = await call('POST', '/medien-loeschen', JSON.stringify(made), IP, 'text/plain');
    assert((await json(d)).geloescht === made.length, 'Aufräumen: halbe Uploads abgebrochen');
  });

  console.log(failures.length ? `\n${failures.length} FEHLER` : '\nALLES OK');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
