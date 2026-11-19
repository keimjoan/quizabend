// Test des Medien-Speichers im Raum-Server (Upload in Teilen, Abruf, Löschen, Grenzen).
// Vorher im Ordner server `npm run dev` starten (http://127.0.0.1:8787). Aufruf: node tests/run-media-server.js [http://127.0.0.1:8787]
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ORIGIN = 'http://localhost:8080';
const MIB = 1024 * 1024, PART = 20 * MIB;
const failures = [];
const assert = (cond, msg) => { if (cond) console.log('  ok   ', msg); else { console.log('  FAIL ', msg); failures.push(msg); } };
const rnd = () => Math.random().toString(36).slice(2, 10);
const ROOM = 'media' + rnd();
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // frische Tageszähler je Lauf

const head = (...bytes) => Buffer.from(bytes);
const PNG = n => Buffer.concat([head(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A), Buffer.alloc(Math.max(0, n - 8), 7)]);
const MP4 = n => Buffer.concat([head(0, 0, 0, 0x18), Buffer.from('ftypisom'), Buffer.alloc(Math.max(0, n - 12), 5)]);
// Kennbare Füllung, damit Teile nicht vertauscht werden
function fill(buf) { for (let i = 16; i < buf.length; i += 4099) buf[i] = (i / 4099) & 255; return buf; }

const call = (method, path, body, extra = {}) => fetch(BASE + path, {
  method, body,
  headers: { Origin: ORIGIN, 'CF-Connecting-IP': IP, ...(body && !extra.type ? { 'Content-Type': 'application/octet-stream' } : {}), ...(extra.type ? { 'Content-Type': extra.type } : {}), ...(extra.headers || {}) }
});
const json = async r => { try { return await r.json(); } catch (e) { return {}; } };

async function upload(buf, room = ROOM) {
  const r = await call('POST', `/medien/${room}?size=${buf.length}`, buf.subarray(0, Math.min(buf.length, PART)));
  const a = await json(r);
  if (!r.ok) return { status: r.status, ...a };
  if (a.done) return { status: 200, ...a };
  const parts = [{ n: 1, etag: a.etag }], count = Math.ceil(buf.length / PART);
  for (let n = 2; n <= count; n++) {
    const p = await call('PUT', `/medien/${a.id}/${n}?del=${a.del}`, buf.subarray((n - 1) * PART, Math.min(buf.length, n * PART)));
    const pj = await json(p);
    if (!p.ok) return { status: p.status, ...pj };
    parts.push({ n, etag: pj.etag });
  }
  const e = await call('POST', `/medien/${a.id}/fertig`, JSON.stringify({ del: a.del, parts }), { type: 'application/json' });
  return { status: e.status, ...a, ...(await json(e)) };
}
const get = (id, range) => call('GET', `/medien/${id}`, undefined, { headers: range ? { Range: range } : {} });
const del = list => call('POST', '/medien-loeschen', JSON.stringify(list), { type: 'text/plain' });

(async () => {
  const mine = [];
  console.log(`\n[M1] Kleine Datei (Bild), Server ${BASE}`);
  const png = fill(PNG(3000));
  let u = await upload(png); mine.push([u.id, u.del]);
  assert(u.status === 200 && u.done && u.t === 'bild' && /^[a-z0-9]{24}$/.test(u.id), 'Bild hochgeladen, Typ „bild“, ID mit 24 Zeichen');
  let r = await get(u.id);
  const body = Buffer.from(await r.arrayBuffer());
  assert(r.status === 200 && r.headers.get('content-type') === 'image/png' && body.equals(png), 'Abruf liefert dieselben Bytes als image/png');
  assert(r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy')) && r.headers.get('cache-control') === 'no-store', 'Schutzköpfe gesetzt');
  r = await get(u.id, 'bytes=10-19');
  assert(r.status === 206 && r.headers.get('content-range') === 'bytes 10-19/3000' && Buffer.from(await r.arrayBuffer()).equals(png.subarray(10, 20)), 'Bereichsanfrage liefert 206 mit dem richtigen Ausschnitt');
  r = await get(u.id, 'bytes=-5');
  assert(r.status === 206 && Buffer.from(await r.arrayBuffer()).equals(png.subarray(2995)), 'Bereichsanfrage vom Ende');
  r = await get(u.id, 'bytes=5000-');
  assert(r.status === 416, 'Bereich hinter dem Ende: 416');
  r = await call('HEAD', `/medien/${u.id}`);
  assert(r.status === 200 && r.headers.get('content-length') === '3000', 'HEAD nennt die Größe');

  console.log('\n[M2] Abgelehnte Aufrufe');
  r = await fetch(`${BASE}/medien/${ROOM}?size=3000`, { method: 'POST', body: png, headers: { 'CF-Connecting-IP': IP } });
  assert(r.status === 403, 'Ohne Origin: 403');
  r = await fetch(`${BASE}/medien/${ROOM}?size=3000`, { method: 'POST', body: png, headers: { Origin: 'https://boese.example', 'CF-Connecting-IP': IP } });
  assert(r.status === 403, 'Fremde Seite: 403');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  u = await upload(svg); assert(u.status === 415, 'SVG wird abgelehnt (415): ' + u.fehler);
  u = await upload(Buffer.from('<!doctype html><script>alert(1)</script>')); assert(u.status === 415, 'HTML wird abgelehnt (415)');
  u = await upload(Buffer.concat([head(0, 0, 0, 0x14), Buffer.from('ftypqt  '), Buffer.alloc(100)])); assert(u.status === 415, 'MOV (QuickTime) wird abgelehnt');
  u = await upload(fill(PNG(6 * MIB))); assert(u.status === 413, 'Bild über 5 MB: 413 ' + (u.fehler || ''));
  r = await call('POST', `/medien/${ROOM}?size=100`, png.subarray(0, 50));
  assert(r.status === 400, 'Falsche Größe des ersten Teils: 400');
  r = await get('aaaaaaaaaaaaaaaaaaaaaaaa'); assert(r.status === 404, 'Unbekannte ID: 404');

  console.log('\n[M3] Video in drei Teilen (45 MiB)');
  const v1 = fill(MP4(45 * MIB));
  let t0 = Date.now();
  u = await upload(v1); mine.push([u.id, u.del]);
  assert(u.status === 200 && u.done && u.t === 'video', `Video hochgeladen (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  r = await call('HEAD', `/medien/${u.id}`);
  assert(r.headers.get('content-length') === String(45 * MIB) && r.headers.get('content-type') === 'video/mp4', 'Größe und Typ stimmen');
  const mid = 20 * MIB - 100;
  r = await get(u.id, `bytes=${mid}-${mid + 199}`);
  assert(r.status === 206 && Buffer.from(await r.arrayBuffer()).equals(v1.subarray(mid, mid + 200)), 'Ausschnitt über die Teilgrenze stimmt');
  r = await get(u.id, `bytes=${45 * MIB - 10}-`);
  assert(r.status === 206 && Buffer.from(await r.arrayBuffer()).equals(v1.subarray(45 * MIB - 10)), 'Ende der Datei stimmt');
  // Falsche Teilgröße und falscher Schlüssel
  const a = await json(await call('POST', `/medien/${ROOM}?size=${45 * MIB}`, v1.subarray(0, PART)));
  mine.push([a.id, a.del]);
  r = await call('PUT', `/medien/${a.id}/2?del=${a.del}`, v1.subarray(PART, PART + 1000)); assert(r.status === 400, 'Teil mit falscher Größe: 400');
  r = await call('PUT', `/medien/${a.id}/2?del=falsch`, v1.subarray(PART, 2 * PART)); assert(r.status === 404, 'Teil mit falschem Schlüssel: 404');
  r = await call('PUT', `/medien/${a.id}/9?del=${a.del}`, v1.subarray(PART, 2 * PART)); assert(r.status === 400, 'Teilnummer außerhalb: 400');
  r = await call('POST', `/medien/${a.id}/fertig`, JSON.stringify({ del: a.del, parts: [{ n: 1, etag: a.etag }] }), { type: 'application/json' });
  assert(r.status === 400, 'Abschluss mit fehlenden Teilen: 400');
  r = await get(a.id); assert(r.status === 404, 'Halber Upload ist nicht abrufbar');
  r = await del([[a.id, a.del]]); let dj = await json(r);
  assert(dj.geloescht === 1, 'Halber Upload lässt sich abbrechen');
  r = await call('PUT', `/medien/${a.id}/2?del=${a.del}`, v1.subarray(PART, 2 * PART)); assert(r.status === 404, 'Nach dem Abbruch kein weiterer Teil');

  console.log('\n[M4] Große Datei über 100 MB (130 MiB, sieben Teile)');
  const big = fill(MP4(130 * MIB));
  t0 = Date.now();
  u = await upload(big); mine.push([u.id, u.del]);
  assert(u.status === 200 && u.done, `130 MiB hochgeladen (${((Date.now() - t0) / 1000).toFixed(1)} s) ${u.fehler || ''}`);
  r = await get(u.id, `bytes=${125 * MIB}-${125 * MIB + 99}`);
  assert(r.status === 206 && Buffer.from(await r.arrayBuffer()).equals(big.subarray(125 * MIB, 125 * MIB + 100)), 'Ausschnitt aus dem letzten Teil stimmt');
  r = await call('POST', `/medien/${ROOM}?size=${501 * MIB}`, MP4(1000));
  assert(r.status === 400, 'Video über 500 MB: abgelehnt (' + r.status + ')');

  console.log('\n[M5] Löschen');
  const target = mine[0];
  r = await del([[target[0], 'falsch']]); assert((await json(r)).geloescht === 0, 'Mit falschem Schlüssel wird nichts gelöscht');
  r = await get(target[0]); assert(r.status === 200, 'Datei ist noch da');
  r = await del(mine.map(([id, d]) => [id, d])); dj = await json(r);
  assert(dj.geloescht >= 3, 'Mit richtigem Schlüssel gelöscht: ' + dj.geloescht);
  r = await get(target[0]); assert(r.status === 404, 'Danach: 404');
  r = await fetch(`${BASE}/medien-loeschen`, { method: 'POST', body: '[]', headers: { Origin: ORIGIN } });
  assert(r.status === 200, 'Löschen ohne Kopf Content-Type (wie sendBeacon) geht');

  console.log('\n[M6] Grenze pro Raum (40 Dateien am Tag)');
  const room2 = 'limit' + rnd(), small = fill(PNG(100)), ids = [];
  let blocked = 0;
  for (let i = 0; i < 42; i++) { const x = await upload(small, room2); if (x.status === 429) blocked++; else if (x.id) ids.push([x.id, x.del]); }
  assert(ids.length === 40 && blocked === 2, `40 Dateien erlaubt, danach 429 (angenommen ${ids.length}, abgewiesen ${blocked})`);
  await del(ids);

  console.log(failures.length ? `\n${failures.length} FEHLER` : '\nALLES OK');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
