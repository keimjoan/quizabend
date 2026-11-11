# Quizabend

Punkte-Quiz für Freunde: Teams oder jeder für sich, 5 Kategorien × 5 Fragen pro Board.

## Spielen
- Doppelklick auf `index.html` öffnet das Spiel im Browser. Der Modus mit Spielleitung funktioniert so direkt.
- Oder mit Node.js: `npm start`, dann http://localhost:8080 öffnen.
- Der Online-Modus (jeder am eigenen PC) funktioniert vorerst nur über den Claude-Link des Artefakts.

## Mit Claude Code weiterbauen
1. Claude Code installieren. In Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`
2. Neues Terminal öffnen, in diesen Ordner wechseln und `claude` starten.
3. Claude Code liest `CLAUDE.md` und kennt damit Regeln, Aufbau und Tests.

## Tests
`npm install`, dann `npx playwright install chromium`, dann `npm test`.
