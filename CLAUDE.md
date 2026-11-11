# Quizabend

Ein Punkte-Quiz im Browser zum Spielen mit Freunden: Boards mit 5 Kategorien × 5 Fragen (100 bis 500 Punkte). Der Nutzer spricht Deutsch. Alle Texte im Spiel sind auf Deutsch, in normaler Groß- und Kleinschreibung, ohne Emojis.

## Aufbau

- `index.html` ist das ganze Spiel: CSS, Fragenkatalog und JavaScript in einer Datei, ohne Build-Schritt und ohne Bibliotheken. Schriften kommen von Google Fonts (Big Shoulders, Atkinson Hyperlegible) mit Ersatzschriften.
- Reihenfolge in der Datei: Design-Tokens (`:root`) → CSS → Fragenkatalog (`RAW`, 25 Kategorien) → Grundlagen und Töne → Spiel an einem Bildschirm → Ansichten → Online-Spiel (Gastgeber, Spieler, Ansichten) → Eingaben → Verbindung (`initRoom`) → Start (`boot`).
- `tools/serve.js` startet einen kleinen Webserver ohne Abhängigkeiten (`npm start`, dann http://localhost:8080).
- `tests/` enthält zwei Playwright-Tests, die komplette Spiele durchspielen und die Punkte nachrechnen.

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

## Wichtig: Der Online-Modus hängt an Claude

Das Spiel läuft als Claude-Artefakt (https://claude.ai/artifact/DPszKf9UP4SnfGMY6fZUin). Der Online-Modus nutzt die Artefakt-Fähigkeit `room` über `window.claude.use('room')`. Die gibt es nur, wenn die Seite in Claude geöffnet ist. Lokal im Browser funktioniert der Modus mit Spielleitung voll, der Online-Reiter zeigt nur einen Hinweis.

So ist die Verbindung gebaut:
- Der Gastgeber hält den Spielstand (`on.og`) und verschickt eine kompakte Ansicht als Ereignis `ostate` (unter 4 KiB, siehe `oView()`).
- Spieler senden Eingaben über ihr Präsenz-Objekt (`team`, `pick`, `ans`, `claim`, `buzz`, `pass`, `vote`, `nx`). Der Gastgeber liest sie in `oProcessPeers()` und wendet sie in `oInput()` an. Jede Eingabe trägt die Fragenummer `qn`, damit alte Eingaben nie doppelt zählen.
- Benutzt werden nur diese Funktionen des Raums: `emit`, `on`, `presence`, `onPeers`, `onConnection`.

Ziel des Nutzers für später: Das Spiel soll ohne Claude laufen, damit Freunde kein Claude-Konto brauchen. Dafür einen kleinen Server bauen (z. B. Node mit WebSocket) und in `initRoom()` einen Adapter einsetzen, der dieselben fünf Funktionen bereitstellt. Dann muss die restliche Spiellogik nicht geändert werden. Die Testdatei `tests/run-online.js` enthält bereits einen nachgebauten Raum (`MOCK`), der als Vorlage für die Schnittstelle dient.

## Tests

```
npm install
npx playwright install chromium
npm test
```

- `npm run test:local`: Spiel an einem Bildschirm, eigene Fragen, sechs Teams, Handy als Spielleitung.
- `npm run test:online`: Gastgeber und zwei Spieler in getrennten Browsern, jeder für sich und in Teams.
- Bildschirmfotos landen in `shots/`. Nach jeder Änderung an Spielregeln oder Punkten beide Tests laufen lassen.

## Gestaltung

- Look einer Stadion-Anzeigetafel: emaillegrüne Tafel, cremefarbene Klappziffern (`flaps()`), Messing als Akzent, Teamfarben als Signallampen.
- Farben nur über die Tokens in `:root`. Nur dunkles Design.
- Das Spiel soll auf Fernseher und Beamer lesbar sein: große Schrift, Größen mit `clamp()` und `vmin`.
