# Quizabend

Ein Punkte-Quiz im Browser zum Spielen mit Freunden: Boards mit 5 Kategorien × 5 Fragen (100 bis 500 Punkte). Der Nutzer spricht Deutsch. Alle Texte im Spiel sind auf Deutsch, in normaler Groß- und Kleinschreibung, ohne Emojis.

## Aufbau

- `index.html` ist das ganze Spiel: CSS, Fragenkatalog und JavaScript in einer Datei, ohne Build-Schritt und ohne Bibliotheken. Schriften kommen von Google Fonts (Big Shoulders, Atkinson Hyperlegible) mit Ersatzschriften.
- Reihenfolge in der Datei: Design-Tokens (`:root`) → CSS → Fragenkatalog (`RAW`, 25 Kategorien) → Grundlagen und Töne → Spiel an einem Bildschirm → Ansichten → Online-Spiel (Gastgeber, Spieler, Ansichten) → Eingaben → Verbindung (`initRoom`) → Start (`boot`).
- `tools/serve.js` startet einen kleinen Webserver ohne Abhängigkeiten (`npm start`, dann http://localhost:8080).
- Webapp-Dateien: `manifest.webmanifest`, `icon.svg` und die PNG-Icons daraus (`npm run icons`, Skript `tools/icons.js`), `sw.js` als Offline-Speicher (erst Netz, sonst Speicher). `sw.js` wird nur über https und außerhalb von Claude registriert.
- `server/` ist der Raum-Server für den Online-Modus (Cloudflare Worker mit Durable Object, eigene `package.json` mit Wrangler).
- `tests/` enthält zwei Playwright-Tests, die komplette Spiele durchspielen und die Punkte nachrechnen.

## Veröffentlichung

- Seite: GitHub Pages aus dem Repo `keimjoan/quizabend`, Zweig `main`, Ordner `/` (mit `.nojekyll`). Adresse: https://keimjoan.github.io/quizabend/. Jeder Push auf `main` geht nach etwa einer Minute online.
- Raum-Server: Cloudflare-Konto des Nutzers, Worker `quizabend-raum`, Adresse `wss://quizabend-raum.quizabend-raum.workers.dev` (steht als `ROOM_SERVER` in `index.html`). Neu bereitstellen: im Ordner `server` `npm install`, dann `npx wrangler login` (einmalig, der Nutzer klickt im Browser auf „Allow“) und `npm run deploy`. Kostenloser Tarif reicht.

## Spielregeln

### Ein Bildschirm mit Spielleitung (Reiter „Ein Bildschirm mit Spielleitung“)
- 2 bis 6 Teams mit Name, Farbe und Buzzer-Taste (Standard A, L, Q, P, G, B). 1 bis 5 Boards.
- Das Team am Zug wählt Kategorie und Punkte. Richtig: volle Punkte. Falsch: halbe Punkte Abzug, dann dürfen die anderen Teams buzzern, jedes einmal. Falsche Buzzer-Antwort kostet auch die Hälfte (abschaltbar).
- Der Zug geht strikt reihum. Ist ein Board leer, kommt das nächste.
- Die Spielleitung bewertet per Klick. Die Lösung sieht sie über „Lösung spicken“ oder auf dem Handy („Als Spielleitung verbinden“).
- Rückgängig (Strg+Z), Punkte von Hand anpassen, optionale Antwortzeit, Spielstand übersteht Neuladen.

### Online, jeder am eigenen PC (Reiter „Online, jeder am eigenen PC“)
- Ein Gastgeber eröffnet eine Lobby und spielt mit, alle anderen melden sich mit ihrem Namen an (bis 12). Beim Start einstellbar: jeder für sich oder Teams (2 bis 6).
- Ablauf pro Frage, so vom Nutzer festgelegt:
  1. Wer am Zug ist, wählt ein Feld und tippt die Antwort ein (30, 60 oder 90 Sekunden). „Weiß ich nicht“ oder Zeitablauf zählt als falsch.
  2. Nur der Fragewähler (bei Teams sein Team) sieht danach die Musterlösung und wertet sich selbst (30 Sekunden, sonst falsch).
  3. Sagt er „richtig“: Alle anderen sehen Antwort und Lösung und stimmen ab. Mindestens 50 Prozent dafür ergibt die Punkte, sonst werden die vollen Punkte abgezogen. Danach ist die Frage vorbei. Stimmt niemand ab, zählt die Antwort.
  4. Sagt er „falsch“: halbe Punkte Abzug. Dann dürfen die anderen buzzern (20 Sekunden), jedes Team nur einmal pro Frage, der Fragewähler gar nicht. Wer zuerst buzzert, antwortet und wertet sich genauso selbst.
- KI-Spielleiter (Einstellung „Wertung der Antworten“ in der Lobby, Standard ist aus): Statt Schritt 2 bis 4 prüft Claude die getippte Antwort gegen die Musterlösung. Richtig: volle Punkte, die Frage ist vorbei, ohne Abstimmung. Falsch: halbe Punkte Abzug, dann buzzern die anderen wie in Schritt 4, und auch die Buzzer-Antwort prüft die KI. Den Kommentar der KI sehen alle erst nach der Auflösung. Antwortet die KI nicht (Ausfall, abgelehnter Schlüssel, 25 Sekunden), läuft diese eine Antwort nach den normalen Regeln.

## Verbindung: Raum von Claude oder eigener Raum-Server

Online-Modus und „Handy als Spielleitung“ brauchen einen Raum. `initRoom()` wählt ihn:
- In Claude (Artefakt https://claude.ai/artifact/DPszKf9UP4SnfGMY6fZUin) die Fähigkeit `room` über `window.claude.use('room')`.
- Sonst (GitHub Pages, `npm start`, Doppelklick) den eigenen Raum-Server über `webRoom()`. Freunde brauchen kein Konto.
- Ohne beides (`HAS_ROOM` falsch, z. B. `window.QUIZ_ROOM_URL = ''` in den Tests) öffnet die Seite den Reiter „Ein Bildschirm mit Spielleitung“, der Online-Reiter zeigt einen Hinweis.

Raum-Code: Mit eigenem Server steht hinten im Link ein Code (`…/quizabend/#k3x9p2`, `roomCode()`). Wer den Link hat, ist im selben Raum. So sehen Fremde auf der öffentlichen Seite keine fremden Spiele und können keinen fremden Bildschirm steuern. Ohne Code nimmt die Seite den zuletzt benutzten (`quizabend.room.v1`) oder würfelt einen neuen. Gastgeber-Lobby und Handy-Hinweis zeigen den Link mit „Link kopieren“.

So ist die Verbindung gebaut:
- Der Gastgeber hält den Spielstand (`on.og`) und verschickt eine kompakte Ansicht als Ereignis `ostate` (unter 4 KiB, siehe `oView()`).
- Spieler senden Eingaben über ihr Präsenz-Objekt (`team`, `pick`, `ans`, `claim`, `buzz`, `pass`, `vote`, `nx`). Der Gastgeber liest sie in `oProcessPeers()` und wendet sie in `oInput()` an. Jede Eingabe trägt die Fragenummer `qn`, damit alte Eingaben nie doppelt zählen.
- Benutzt werden nur diese Funktionen des Raums: `emit`, `on`, `presence`, `onPeers`, `onConnection`. `webRoom()` bildet genau diese nach, die Spiellogik weiß nicht, welcher Raum dahinter steckt.
- Der Raum-Server (`server/worker.js`) speichert nichts. Er leitet Ereignisse und Präsenz an alle anderen im Raum weiter, ein Durable Object pro Raum-Code. Jedes Gerät hat eine feste ID pro Seitenaufruf, bei Neuverbindung bleibt seine Präsenz erhalten. Lebenszeichen alle 25 Sekunden, nach einer Minute Stille verbindet `webRoom()` neu.

## KI-Spielleiter

- Vom Nutzer so entschieden: Jeder darf einen Raum eröffnen, aber wer die KI nutzt, zahlt sie selbst. Der Gastgeber trägt in der Lobby seinen eigenen Claude-API-Schlüssel ein. Im Code, im Repo und auf dem Raum-Server liegt kein Schlüssel.
- Der Schlüssel bleibt im Browser des Gastgebers (`kiKey`): in `sessionStorage`, mit „Auf diesem Gerät merken“ zusätzlich in `localStorage` (`quizabend.ki.v1`). Er darf nie in `on.og`, in die Präsenz oder in ein Ereignis geraten. Der Test prüft das.
- Der Aufruf geht per `fetch` direkt aus dem Browser an `https://api.anthropic.com/v1/messages` (keine Bibliothek, siehe `kiAsk()`): Köpfe `x-api-key`, `anthropic-version: 2026-10-21` und `anthropic-dangerous-direct-browser-access: true`, Modell `claude-opus-5-5` (`KI_MODEL`), `output_config` mit `effort: "low"` und festem JSON-Format `{richtig, kommentar}`, dazu `fallbacks: "default"` mit Beta-Kopf (bei Fehler 400 noch einmal ohne). Die Schlüsselprüfung in der Lobby fragt `GET /v1/models/claude-opus-5-5` ab.
- Im Spielstand gibt es dafür den Zustand `ki` (`cur.st`) zwischen `answer` und `resolved` bzw. `buzz`. `kiStart()` läuft auch aus `oTick()`, damit die Prüfung ein Neuladen des Gastgebers übersteht. `kiFallback()` stellt auf `judge` um und setzt `cur.kf` für den Hinweis.
- Die Antwort des Spielers ist für die KI Spielmaterial, keine Anweisung (steht in `KI_SYSTEM`), spitze Klammern werden entfernt.
- Test [7] in `tests/run-online.js` stellt Anthropic mit `context.route` nach. Ein echter Aufruf mit gültigem Schlüssel kostet Geld und ist nicht automatisch getestet.

## Tests

```
npm install
npx playwright install chromium
npm test
```

- `npm run test:local`: Spiel an einem Bildschirm, eigene Fragen, sechs Teams, Handy als Spielleitung.
- `npm run test:online`: Gastgeber und zwei Spieler in getrennten Browsern, jeder für sich und in Teams, über den nachgebauten Raum (`MOCK`). Danach ein Spiel mit KI-Spielleiter gegen eine nachgestellte Claude-API.
- `npm run test:server`: derselbe Online-Test über den echten Raum-Server. Vorher im Ordner `server` `npm run dev` starten (http://127.0.0.1:8787). Nach Änderungen an `webRoom()` oder `server/` laufen lassen.
- Bildschirmfotos landen in `shots/`. Nach jeder Änderung an Spielregeln oder Punkten beide Tests laufen lassen.

## Gestaltung

- Look einer Stadion-Anzeigetafel: emaillegrüne Tafel, cremefarbene Klappziffern (`flaps()`), Messing als Akzent, Teamfarben als Signallampen.
- Farben nur über die Tokens in `:root`. Nur dunkles Design.
- Das Spiel soll auf Fernseher und Beamer lesbar sein: große Schrift, Größen mit `clamp()` und `vmin`.
