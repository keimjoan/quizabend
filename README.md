# Quizabend

Punkte-Quiz für Freunde: Teams oder jeder für sich, 5 Kategorien × 5 Fragen pro Board.

## Spielen
- Im Netz: https://keimjoan.github.io/quizabend/ – auf Handy, Tablet oder PC über „Zum Startbildschirm hinzufügen“ bzw. „App installieren“ als App speichern. Nach dem ersten Öffnen startet sie auch ohne Internet.
- Wertung der Antworten im Online-Spiel (Einstellung in der Lobby): selbst bewerten und abstimmen, der Gastgeber moderiert (sieht die Lösungen, entscheidet per Klick und spielt nicht mit) oder ein KI-Spielleiter.
- KI-Spielleiter (optional): Der Gastgeber kann in der Lobby unter „Wertung der Antworten“ Claude die Antworten prüfen lassen. Dafür trägt er seinen eigenen Claude-API-Schlüssel von platform.claude.com ein und zahlt die Runde selbst. Der Schlüssel bleibt in seinem Browser.
- Doppelklick auf `index.html` öffnet das Spiel im Browser. Der Modus mit Spielleitung funktioniert so direkt.
- Oder mit Node.js: `npm start`, dann http://localhost:8080 öffnen.
- Online, jeder am eigenen PC: Wer das Spiel eröffnet, schickt den Raum-Link aus der Lobby an die Freunde (zum Beispiel `https://keimjoan.github.io/quizabend/#k3x9p2`). Ein Konto braucht niemand. Die Verbindung läuft über einen kleinen Raum-Server bei Cloudflare (Ordner `server/`).

## Neue Version ins Netz stellen
Änderungen committen und `git push`. GitHub Pages veröffentlicht den Stand von `main` nach etwa einer Minute.
Den Raum-Server nur neu hochladen, wenn sich `server/` geändert hat: im Ordner `server` `npm install`, dann `npm run deploy`.

## Mit Claude Code weiterbauen
1. Claude Code installieren. In Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`
2. Neues Terminal öffnen, in diesen Ordner wechseln und `claude` starten.
3. Claude Code liest `CLAUDE.md` und kennt damit Regeln, Aufbau und Tests.

## Tests
`npm install`, dann `npx playwright install chromium`, dann `npm test`.
