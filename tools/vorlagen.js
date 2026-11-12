// Erzeugt die Downloads für „Eigene Boards“ im Ordner vorlagen/ (ohne Abhängigkeiten):
//   quizabend-board-vorlage.xlsx   leere Vorlage für Excel und Google Sheets
//   quizabend-board-beispiel.xlsx  ausgefülltes Beispiel-Board
//   quizabend-board-beispiel.json  dasselbe Board als JSON
//   quizabend-board-skill.zip      Claude-Skill aus vorlagen/skill/quizabend-board
// Start: npm run vorlagen
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'vorlagen');
const VALUES = [100, 200, 300, 400, 500];

/* ---------- ZIP (Deflate, mit festem Datum, damit die Dateien bei gleichem Inhalt gleich bleiben) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) {
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 }), nm = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ---------- XLSX ---------- */
const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => String.fromCharCode(65 + i);
// Zellen: string, number oder { v, s } mit Stil-Nummer aus STYLES
function sheetXML(rows, { widths, freeze, merge } = {}) {
  const cell = (c, r, ci) => {
    if (c == null || c === '') return '';
    const v = typeof c === 'object' ? c.v : c, s = typeof c === 'object' && c.s ? ` s="${c.s}"` : '';
    const ref = colName(ci) + (r + 1);
    if (v === '' || v == null) return `<c r="${ref}"${s}/>`;
    return typeof v === 'number' ? `<c r="${ref}"${s}><v>${v}</v></c>` : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  };
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + (freeze ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>')
    + '<sheetFormatPr defaultRowHeight="18"/>'
    + (widths ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '')
    + `<sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((c, ci) => cell(c, r, ci)).join('')}</row>`).join('')}</sheetData>`
    + (merge ? `<mergeCells count="${merge.length}">${merge.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '')
    + '</worksheet>';
}
// Stile: 0 normal, 1 Kopfzeile (fett, Messing), 2 Umbruch oben, 3 Kategorie (fett, hellgrün), 4 Überschrift groß, 5 Punkte zentriert
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3B04B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCEFE6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
function xlsx(sheets) {
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>'
    + sheets.map((s, i) => `<sheet name="${x(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return zip([['[Content_Types].xml', ct], ['_rels/.rels', rels], ['xl/workbook.xml', wb], ['xl/_rels/workbook.xml.rels', wbRels], ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml])]);
}

/* Blatt „Board“: eine Zeile pro Frage. Board-Name und Kategorie reichen in der ersten Zeile, darunter gelten sie weiter. */
const HEAD = ['Board', 'Kategorie', 'Punkte', 'Frage', 'Antwort'].map(v => ({ v, s: 1 }));
function boardRows(boards) {
  const rows = [HEAD];
  for (const b of boards) b.cats.forEach((c, ci) => c.qs.forEach((q, r) => rows.push([
    ci === 0 && r === 0 ? { v: b.name, s: 3 } : '', r === 0 ? { v: c.name, s: 3 } : '', { v: VALUES[r], s: 5 }, { v: q.q, s: 2 }, { v: q.a, s: 2 }])));
  return rows;
}
const HELP = [
  [{ v: 'Quizabend: eigenes Board', s: 4 }],
  [''],
  ['So füllst du die Vorlage aus'],
  ['1. Im Blatt „Board“ steht eine Zeile pro Frage: 5 Kategorien mit je 5 Fragen, also 25 Zeilen.'],
  ['2. Den Namen des Boards und jeder Kategorie nur in die erste Zeile schreiben. Leere Zellen darunter gehören zur selben Kategorie.'],
  ['3. Punkte: 100 ist leicht, 500 ist schwer. Die Reihenfolge der Zeilen ist egal, das Spiel sortiert nach Punkten.'],
  ['4. Antworten kurz halten. Andere Schreibweisen in Klammern dahinter, zum Beispiel: Der Pazifik (Pazifischer Ozean).'],
  ['5. Mehrere Boards in einer Datei: einfach weitere 25 Zeilen darunter, mit neuem Board-Namen in der ersten Zeile.'],
  [''],
  ['So kommt das Board ins Spiel'],
  ['Im Quizabend auf der Startseite bei „Eigene Boards“ auf „Board importieren“ klicken und diese Datei wählen.'],
  ['Oder die Zeilen samt Kopfzeile markieren, kopieren und im Import-Fenster einfügen. Das geht auch aus Google Sheets.'],
  ['Google Sheets: Datei > Importieren > Hochladen und diese Datei wählen. Zum Importieren ins Spiel: Datei > Herunterladen > Microsoft Excel (.xlsx).'],
  [''],
  ['Spiel und Anleitung: https://keimjoan.github.io/quizabend/']
];
const helpSheet = { name: 'Anleitung', xml: sheetXML(HELP, { widths: [120] }) };
const boardSheet = boards => ({ name: 'Board', xml: sheetXML(boardRows(boards), { widths: [22, 24, 9, 60, 34], freeze: true }) });

/* ---------- Inhalte ---------- */
function builtin() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = html.indexOf('const RAW = '), end = html.indexOf('\n];', start);
  const raw = new Function(`return ${html.slice(start + 'const RAW = '.length, end + 2)}`)();
  return Object.fromEntries(raw.map(([id, name, qs]) => [id, { name, qs: qs.map(([q, a]) => ({ q, a })) }]));
}
const pool = builtin(), ids = Object.keys(pool);
const pickIds = ['geo', 'ges', ...ids.filter(i => !['geo', 'ges'].includes(i)).slice(0, 3)];
const example = { name: 'Beispiel: Allgemeinwissen', cats: pickIds.map(i => pool[i]) };
const empty = { name: 'Mein Board', cats: [1, 2, 3, 4, 5].map(n => ({ name: `Kategorie ${n}`, qs: VALUES.map(() => ({ q: '', a: '' })) })) };

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'quizabend-board-vorlage.xlsx'), xlsx([boardSheet([empty]), helpSheet]));
fs.writeFileSync(path.join(OUT, 'quizabend-board-beispiel.xlsx'), xlsx([boardSheet([example]), helpSheet]));
fs.writeFileSync(path.join(OUT, 'quizabend-board-beispiel.json'), JSON.stringify({ boards: [{
  name: example.name, kategorien: example.cats.map(c => ({ name: c.name, fragen: c.qs.map((q, r) => ({ punkte: VALUES[r], frage: q.q, antwort: q.a })) }))
}] }, null, 2) + '\n');
const skillDir = path.join(OUT, 'skill', 'quizabend-board');
fs.writeFileSync(path.join(OUT, 'quizabend-board-skill.zip'), zip(fs.readdirSync(skillDir).sort()
  .map(f => [`quizabend-board/${f}`, fs.readFileSync(path.join(skillDir, f))])));
console.log('Vorlagen erzeugt in', OUT, '\nBeispiel-Kategorien:', example.cats.map(c => c.name).join(', '));
