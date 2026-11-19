# Quizabend

Punkte-Quiz für Freunde: Teams oder jeder für sich, 5 Kategorien × 5 Fragen pro Board.

## Spielen
- Im Netz: https://keimjoan.github.io/quizabend/ – auf Handy, Tablet oder PC über „Zum Startbildschirm hinzufügen“ bzw. „App installieren“ als App speichern. Nach dem ersten Öffnen startet sie auch ohne Internet.
- Wertung der Antworten im Online-Spiel (Einstellung in der Lobby): selbst bewerten und abstimmen, der Gastgeber moderiert (sieht die Lösungen, entscheidet per Klick und spielt nicht mit) oder ein KI-Spielleiter.
- Kameras im Online-Spiel: Jeder kann in der Lobby oder über das Kamerasymbol oben seine Kamera einschalten. Die Bilder gehen direkt von Browser zu Browser, kostenlos und ohne Ton. In manchen Netzen (Mobilfunk, Firmen-WLAN) kommt kein Bild an. Am besten klappt es mit bis zu etwa 8 Kameras.
- KI-Spielleiter (optional): Der Gastgeber kann in der Lobby unter „Wertung der Antworten“ Claude die Antworten prüfen lassen. Dafür trägt er seinen eigenen Claude-API-Schlüssel von platform.claude.com ein und zahlt die Runde selbst. Der Schlüssel bleibt in seinem Browser.
- Doppelte Punkte: Bei mehr als einem Board lässt sich einstellen, dass ab dem zweiten Board jede Frage doppelt zählt (200 bis 1000 Punkte).
- Bild, Lied oder Video zu einer Frage: In der Spalte „Medium“ des eigenen Boards steht der Dateiname, die Dateien wählt man beim Import aus. Ein Bildschirm spielt sie direkt vom Gerät. Online lädt der Gastgeber sie nur für die laufende Runde auf den Raum-Server hoch (Video bis 500 MB) und löscht sie am Ende wieder. Der Raum-Server nimmt im Monat insgesamt höchstens 10 GB an, damit der Speicher im Gratistarif von Cloudflare bleibt.
- Eigene Boards: Auf https://keimjoan.github.io/quizabend/boards.html gibt es eine Excel-Vorlage, eine Google-Sheets-Vorlage zum Kopieren, ein Beispiel-Board und einen Claude-Skill, der Boards zu jedem Thema schreibt. Im Spiel unter „Eigene Boards“ auf „Board importieren“ klicken.
- Doppelklick auf `index.html` öffnet das Spiel im Browser. Der Modus mit Spielleitung funktioniert so direkt.
- Oder mit Node.js: `npm start`, dann http://localhost:8080 öffnen.
- Online, jeder am eigenen PC: Wer das Spiel eröffnet, schickt den Raum-Link aus der Lobby an die Freunde (zum Beispiel `https://keimjoan.github.io/quizabend/#k3x9p2`). Ein Konto braucht niemand. Die Verbindung läuft über einen kleinen Raum-Server bei Cloudflare (Ordner `server/`).

## Neue Version ins Netz stellen
Änderungen committen und `git push`. GitHub Pages veröffentlicht den Stand von `main` nach etwa einer Minute.
Den Raum-Server nur neu hochladen, wenn sich `server/` geändert hat: im Ordner `server` `npm install`, dann `npm run deploy`.
Für die Medien braucht der Raum-Server einmalig einen R2-Speicher: in Cloudflare R2 einschalten, dann im Ordner `server` `npx wrangler r2 bucket create quizabend-medien` und `npx wrangler r2 bucket lifecycle add quizabend-medien nach-einem-tag --expire-days 1 --abort-multipart-days 1`, danach `npm run deploy`.

## Mit Claude Code weiterbauen
1. Claude Code installieren. In Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`
2. Neues Terminal öffnen, in diesen Ordner wechseln und `claude` starten.
3. Claude Code liest `CLAUDE.md` und kennt damit Regeln, Aufbau und Tests.

## Tests
`npm install`, dann `npx playwright install chromium`, dann `npm test`.
