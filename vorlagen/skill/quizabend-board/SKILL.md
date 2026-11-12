---
name: quizabend-board
description: Erstellt fertige Boards für das Punkte-Quiz „Quizabend“ (https://keimjoan.github.io/quizabend/) als JSON-Datei zum Importieren. Ein Board hat 5 Kategorien mit je 5 Fragen von 100 bis 500 Punkten. Verwenden, wenn jemand Quizfragen, ein Quiz-Board, Kategorien für den Quizabend oder ein Jeopardy-artiges Board zu einem Thema haben möchte.
---

# Boards für den Quizabend erstellen

Du schreibst Boards für „Quizabend“, ein Punkte-Quiz, das Freunde im Browser spielen. Das Ergebnis ist eine JSON-Datei, die man im Spiel über „Board importieren“ einliest.

## Ablauf

1. Kläre kurz, was fehlt, aber frage nicht mehr als nötig:
   - Thema oder Themen (zum Beispiel „Unsere Clique“, „90er-Jahre“, „Fußball-WM“, „Geburtstag von Lisa“). Ohne Vorgabe: abwechslungsreiches Allgemeinwissen.
   - Wie viele Boards (Standard: 1).
   - Für wen (Kinder, Familie, Kenner). Standard: gemischte Erwachsenenrunde.
   - Bei persönlichen Themen (Freunde, Familie, Firma) brauchst du Fakten vom Nutzer. Erfinde keine Fakten über echte Privatpersonen. Bitte um Stichpunkte oder baue nur die Kategorien, für die du genug weißt.
2. Plane pro Board 5 Kategorien mit klaren, kurzen Namen (höchstens etwa 25 Zeichen, damit sie auf die Tafel passen). Die Kategorien eines Boards sollen sich nicht überschneiden.
3. Schreibe je Kategorie 5 Fragen mit steigender Schwierigkeit: 100 ist leicht, fast jeder weiß es; 500 ist schwer, nur Kenner wissen es.
4. Prüfe jede Frage (siehe Regeln), dann gib die Datei aus.

## Regeln für gute Fragen

- Alles auf Deutsch, in normaler Groß- und Kleinschreibung, ohne Emojis.
- Jede Frage hat genau eine richtige Antwort. Keine Fangfragen, keine Meinungsfragen, nichts, was sich bald ändert („Wer ist gerade …“), außer der Nutzer will das.
- Fragen kurz und vorlesbar halten (meist ein Satz, höchstens 400 Zeichen). Die Antwort steht nicht schon in der Frage.
- Antworten kurz (ein Begriff, ein Name, eine Zahl; höchstens 200 Zeichen). Gängige andere Schreibweisen oder akzeptierte Varianten in Klammern dahinter, zum Beispiel „Der Pazifik (Pazifischer Ozean)“ oder „1989 (am 9. November)“. Das hilft Spielleitung und KI-Spielleiter beim Werten.
- Nur Fakten, bei denen du dir sicher bist. Bist du unsicher, nimm eine andere Frage.
- Innerhalb eines Boards keine doppelten Fragen oder Antworten.

## Ausgabeformat

Erzeuge eine Datei `quizabend-boards.json` (wenn du Dateien erstellen kannst, sonst einen einzigen JSON-Codeblock) in genau diesem Format:

```json
{
  "boards": [
    {
      "name": "Name des Boards",
      "kategorien": [
        {
          "name": "Kategorie 1",
          "fragen": [
            { "punkte": 100, "frage": "Leichte Frage?", "antwort": "Antwort" },
            { "punkte": 200, "frage": "…", "antwort": "…" },
            { "punkte": 300, "frage": "…", "antwort": "…" },
            { "punkte": 400, "frage": "…", "antwort": "…" },
            { "punkte": 500, "frage": "Schwere Frage?", "antwort": "Antwort" }
          ]
        }
      ]
    }
  ]
}
```

- Jedes Board hat genau 5 Kategorien, jede Kategorie genau 5 Fragen mit den Punkten 100, 200, 300, 400 und 500.
- Mehrere Boards stehen nacheinander in der Liste `boards`. Im Spiel werden sie in dieser Reihenfolge gespielt.
- Gültiges JSON: doppelte Anführungszeichen, keine Kommentare, kein Komma nach dem letzten Eintrag. Anführungszeichen im Text als „…“ schreiben oder mit `\"` maskieren.

## Danach

Sag dem Nutzer in zwei, drei Sätzen, wie es weitergeht: Im Quizabend auf der Startseite bei „Eigene Boards“ auf „Board importieren“ klicken, die Datei wählen oder den JSON-Text einfügen und „Importieren“ drücken. Das Board wird dann zuerst gespielt. Biete an, einzelne Fragen auszutauschen oder leichter bzw. schwerer zu machen.
