# CLAUDE.md

Kanonische Projektregeln. Jede Regel steht an genau einer Stelle; wo ein anderes Artefakt das
Detail besitzt, zeigt diese Datei darauf.

## Projekt

Ein Obsidian-Plugin für **einen** Nutzer: links die offenen Tasks aus den Projektdateien des
Vaults, rechts der eigene Outlook-Kalender. Zieht man einen Task in eine Lücke, entsteht in Outlook
ein Fokus-Block.

> **Das Ziel in einem Satz:** Morgens in unter zwei Minuten die offenen Aufgaben sichten, die für
> heute relevanten in freie Kalenderlücken ziehen, fertig. Was diesen Ablauf nicht beschleunigt,
> kommt nicht rein.

## Wichtige Dokumente

- `docs/umsetzungsplan.md` — Meilensteine M0–M5, Stolperfallen mit Gegenmaßnahme, manuelle
  Verifikation je Meilenstein, belegte Fakten mit Quelle. Vor jedem Meilenstein den Abschnitt lesen.
- `.claude/skills/graph-calendar/` — Graph-Regeln (UTC lesen, Wandzeit schreiben, Immutable IDs,
  Extended Property). **Vor jeder Änderung an einem Graph-Aufruf lesen.**
- `.claude/skills/verify/` — das Gate und die Übergabe eines Builds.
- `.claude/skills/retro/` — Abschluss-Durchgang einer Sitzung: jedes Learning an seinen einen Ort.
- `.claude/agents/invariant-reviewer.md` — prüft Token, HTTP und beide Schreibpfade gegen die
  Invarianten, ändert nichts. Pflicht vor M5.
- `README.md` — Einrichtung (Entra-App, Einstellungen), Bedienung, Fehlerbilder.
- Vorbild ist die Web-App **daily-planner** (`../daily-planner`): Bei „wie wurde das dort
  gelöst" dort nachsehen, statt neu zu erfinden.

**Obsidian, Tasks, FullCalendar 6.1.21 und Graph nie aus dem Gedächtnis.** Die Trainingsdaten
kennen andere Versionen und veraltete Muster. Belegen (installierter Quelltext, `obsidian.d.ts`,
Primärdoku) oder als offen markieren.

## Entwicklung hier, Ausführung auf Windows

Gebaut und getestet wird auf diesem Linux-Host. Obsidian und der Vault laufen auf dem
Windows-Notebook. Jeder verify-Lauf erzeugt `release/vault-planner.zip` mit einer Build-Kennung
(`0.1.0-dev.<Zeitstempel>`) im Manifest. Daniel entpackt das Zip in
`<Testvault>/.obsidian/plugins/` und schaltet das Plugin aus und wieder ein. `release/test-vault.zip`
enthält den Testvault und wird einmal übertragen.

**Nie gegen den Live-Vault entwickeln.** Er liegt im OneDrive, und Claude bearbeitet ihn parallel.
Der Live-Vault kommt erst in M5 dran.

## Befehle

```bash
npx npm@11 install     # Distro-npm 9.2.0 ist auf diesem Host mit Node 22 kaputt
bash scripts/verify.sh # das Gate: tsc, Tests (TZ=UTC), Build, Paket — auch der Stop-Hook
npm test               # nur die Tests
npm run dev            # esbuild im Watch-Modus nach build/main.js
```

## Invarianten

1. **Der Kalender ist die Wahrheit für den Planungsstatus.** Weder im Vault noch in `data.json`
   steht je ein Planungsdatum oder eine Event-ID. Kein `⏳`-Schreibpfad, auch nicht „nur als
   Hinweis". Ob ein Task geplant ist, leitet `lib/schedule.ts` bei jedem Rendern aus dem geladenen
   Kalender ab.
2. **In den Vault schreibt das Plugin genau zweierlei, beides nur auf eine Handlung des Nutzers
   hin:** eine Block-ID ans Ende der Task-Zeile (einmal, nie geändert), und beim Erledigen ersetzt
   es genau die Zielzeile durch die Ausgabe der Tasks-API (eine oder zwei Zeilen). Nie im
   Hintergrund, nie eine andere Zeile, nie eine Datei anlegen, löschen oder umbenennen.
3. **Jeder Schreibvorgang läuft über `app.vault.process()`**, nachdem offene Editoren der Datei
   gespeichert wurden. Die Zielzeile wird im aktuellen Inhalt per Block-ID oder eindeutigem
   Rohtext gefunden, nie per Zeilennummer; Zeilenenden bleiben byte-genau. Nicht gefunden oder
   mehrdeutig heißt: abbrechen und melden.
4. **Graph folgt dem graph-calendar-Skill.** Nie `attendees`.
5. **Alle HTTP-Aufrufe über `requestUrl`, nie `fetch`**, und nur zu `login.microsoftonline.com`
   und `graph.microsoft.com`. Keine Telemetrie.
6. **Tokens nie in `data.json`** — sie liegt im Vault und damit im OneDrive. Der Refresh-Token liegt
   in `app.secretStorage`. Nur der Anmelde-Knopf öffnet den Browser, nie ein Timer.

Die Verknüpfung Task ↔ Termin ist die Extended Property mit dem Wert `<vaultName>|<blockId>`.
Ihre GUID in `src/config.ts` wird **nie** geändert.

## Tasks-Plugin

- Der Parser (`lib/parseTask.ts`) liest wie Tasks: Felder vom Zeilenende her, hinter den Feldern
  nur Block-Link und Tags. Ein Link hinter `📅` macht das Datum unsichtbar — in Tasks wie hier.
- Quelldateien sind nur `<Ordner>/<Ordner>.md` unter `10_Kunden/` und `20_Intern/`.
- Ein globaler Filter der Tasks-Einstellungen gehört nach `TASKS_GLOBAL_FILTER` in `src/config.ts`.
- Erledigen nur über `apiV1.executeToggleTaskDoneCommand` — sie gibt Text zurück und schreibt
  nichts; ein eigenes Abhaken würde bei `🔁` die Folgeaufgabe verlieren.

## Nebenläufigkeit

`lib/readGate.ts` besitzt die Regeln: nur die Antwort des zuletzt gestarteten Lesevorgangs zählt,
während einer Geste (Ziehen, Größe ändern, PATCH) wird nichts angewendet, und „Wird gespeichert…"
endet erst nach dem ersten Lesevorgang, der nach dem POST gestartet wurde. `droppable` sperrt
externe Drops in FullCalendar 6.1.21 **nicht** — das Tor ist `eventAllow`. `eventDragMinDistance`
bleibt 0: Mit Schwelle öffnet die Geste zu spät, und ein Lesevorgang dazwischen erzeugt einen
Geister-Block.

## Code-Standards

- Die kleinste Lösung, die das Problem löst. Keine Abstraktionen für Einmalcode, keine
  Konfigurierbarkeit auf Vorrat.
- TypeScript strict, kein `any` — `unknown` plus Einengung an den Rändern. `import type` für
  reine Typ-Importe (`verbatimModuleSyntax`).
- Reine Logik gehört nach `src/lib/` und hat Tests; `src/lib/` importiert nie `obsidian`.
- Kein `console.log`, kein `alert()`, kein `confirm()`. Rückmeldung über `Notice`, Bestätigung
  über ein `Modal`, das die Sache beim Namen nennt.
- FullCalendar bleibt exakt auf 6.1.21 (v7 hat andere Pakete und kein automatisches CSS).
- **Bezeichner, Kommentare, Skills, Commit-Nachrichten: Englisch. Oberflächentexte, diese Datei,
  `README.md`, `docs/` und Antworten an den Nutzer: Deutsch.** Jede Datei bleibt beim Bearbeiten in
  ihrer Sprache; nie nebenbei übersetzen.
- Jeder Commit ist potenziell lesbar: keine echten Kundennamen, keine Tenant- oder Client-IDs,
  keine Zugangsdaten. Der Testvault nutzt neutrale Namen.

## UX-Regeln

1. **Ladezustände sind Pflicht.** Graph braucht 2–10 s: Ladehinweis, nie eine leere Fläche.
2. **Fehler in Klartext** mit einer Handlung (`lib/errors.ts`), nie rohes Graph- oder AADSTS-JSON.
3. **Zerstörende Aktionen brauchen einen echten Dialog** mit dem Namen der Sache.
4. **Kalender nicht bereit → Status unbekannt:** keine Statuszeilen, kein Drop, Banner.

## Commit-Stil und Reviews

Conventional Commits. Vor einem mehrdateiigen Commit `/ponytail-review`, jeden Fund mit Daniel
entscheiden, dann `/code-review`. Keiner ersetzt den anderen: ponytail-review sucht keine Fehler.
Die Stufe richtet sich danach, was ein Fehler kostet, nicht nach der Größe des Diffs:

- **high** — alles, was schreibt: Outlook-Termine, die zwei Vault-Schreibvorgänge, Anmeldung
- **medium** — Graph-Lesepfad, Task-Index
- **low** — reine UI

Berührt ein Diff mehrere Stufen, gilt die höchste. `/code-review` entfällt nur bei Doku- oder
Tippfehler-Diffs.

Nach einer für den Nutzer sichtbaren Änderung: die manuellen Checks aus der Tabelle des
Meilensteins nennen, die diese Änderung braucht, und was jeder beweist, also nur, was
Automatisierung nicht beweist. Deckt das Gate die Änderung ganz ab (Umbenennung, reiner Refactor),
das in einer Zeile sagen, statt Schritte zu erfinden.

## Learning Loop

Zeigt eine Sitzung, dass eine Behauptung hier, im Plan oder im Skill falsch war, wird sie in
derselben Sitzung korrigiert — am kanonischen Ort. Neue Graph-Erkenntnisse gehören in den
graph-calendar-Skill, mit ihrem Beleg („live geprüft", „dokumentiert", „abgeleitet"). Wohin alles
andere gehört, regelt der `retro`-Skill. Ein falsches Dokument ist schlimmer als keines.
