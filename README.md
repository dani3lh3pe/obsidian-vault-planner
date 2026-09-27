# Vault Planner

Ein Obsidian-Plugin: links die offenen Tasks aus den Projektdateien, rechts die Outlook-Woche.
Einen Task in eine freie Lücke ziehen, und in Outlook entsteht ein Fokus-Block.

Die Planung steht **nur in Outlook**. In die Task-Zeile schreibt das Plugin einmalig eine Block-ID
(`^t-3f9a1c`), damit der Termin seinen Task wiederfindet. Ob ein Task geplant ist, zeigt das Plugin
live aus dem Kalender an, auch nachdem du einen Block in Outlook verschoben oder gelöscht hast.

## Einrichtung

### 1. Entra-App-Registrierung (einmalig)

1. Entra Admin Center → App-Registrierungen → **Neue Registrierung** „Obsidian Vault Planner",
   *Nur Konten in diesem Organisationsverzeichnis*.
2. **Authentifizierung → Plattform hinzufügen → Mobile- und Desktopanwendungen**, dort zwei
   benutzerdefinierte Umleitungs-URIs:
   - `obsidian://vault-planner-auth`
   - `http://localhost` (Reserve)
3. „Öffentliche Clientflows zulassen" bleibt auf **Nein**.
4. **API-Berechtigungen → Microsoft Graph → Delegiert:** `Calendars.ReadWrite`. Falls
   Benutzerzustimmung gesperrt ist, die Administratorzustimmung erteilen.
5. Kein Secret, keine Anwendungsberechtigung.
6. **Anwendungs-ID (Client-ID)** und **Verzeichnis-ID (Tenant-ID)** notieren. Sie kommen in die
   Plugin-Einstellungen, nicht ins Repository.

### 2. Testvault (einmalig)

1. `release/test-vault.zip` herunterladen und **außerhalb des OneDrive** entpacken, z. B. nach
   `C:\dev\test-vault`. Danach liegt `10_Kunden` direkt in diesem Ordner.
2. In Obsidian: *Anderen Vault öffnen → Ordner als Vault öffnen*.
3. Einstellungen → Community-Plugins → einschalten, **Tasks** in derselben Version wie im
   Live-Vault installieren und dessen `data.json` aus
   `<Live-Vault>/.obsidian/plugins/obsidian-tasks-plugin/` herüberkopieren.

### 3. Plugin installieren oder aktualisieren (bei jedem neuen Build)

1. `release/vault-planner.zip` herunterladen.
2. Nach `<Vault>/.obsidian/plugins/` entpacken. Das Zip enthält den Ordner `vault-planner/` mit
   `main.js`, `manifest.json` und `styles.css`. Vorhandene Dateien überschreiben.
3. Einstellungen → Community-Plugins → **Vault Planner** aus- und wieder einschalten.
4. Die angezeigte Version (`0.1.0-dev.<Zeitstempel>`) mit der des Builds vergleichen.

### 4. Anmelden

Einstellungen → Vault Planner: **Tenant-ID** und **Client-ID** eintragen, dann **Anmelden**.

- Der Browser öffnet die Microsoft-Anmeldung und fragt am Ende, ob er Obsidian öffnen darf.
- Beim Anmelden nur **einen** Vault mit dem Plugin offen haben: Der `obsidian://`-Link geht an das
  zuletzt aktive Vault-Fenster.
- Die Anmeldung gilt auf diesem Gerät etwa 90 Tage ab der letzten Nutzung. Der Token liegt
  verschlüsselt in Obsidians Schlüsselbund, nicht im Vault.

## Bedienung

- **Öffnen:** das Kalender-Symbol in der linken Leiste oder der Befehl „Planner öffnen".
- **Liste:** Gruppiert wie in der Web-App:
  - „Wichtig & dringend": 🔺/⏫ **und** fällig innerhalb von 7 Tagen oder überfällig
  - „Wichtig": nur 🔺/⏫
  - „Dringend": nur die Fälligkeit
  - „Rest"
  - dazu „Warten auf" für `WAITING`, eingeklappt

  Suche, Kunden-Filter und „nur ungeplante" stehen darüber. Ein Klick öffnet die Aufgabe in einem
  neuen Tab.
- **Einplanen:** eine Karte in den Kalender ziehen. Die Dauer ist `[aufwand:: …]`, sonst eine
  Stunde. Die Karte zeigt „Wird gespeichert…", bis der Termin im Kalender auftaucht.
- **Verschieben oder Größe ändern:** den Block im Kalender ziehen bzw. am Rand ziehen.
- **Block löschen:** Rechtsklick auf den Block → „Block löschen…".
- **Erledigen:** die Checkbox an der Karte (über das Tasks-Plugin). Die Blöcke bleiben in Outlook
  stehen; gebuchte Zeit ist Geschichte.
- **Abgelaufen:** Ein Task, dessen Blöcke alle vorbei sind, zeigt „abgelaufen: …" und gilt wieder
  als ungeplant.

## Was das Plugin in den Vault schreibt

Genau zweierlei, und nur, wenn du es auslöst:

1. **Block-ID:** Beim ersten Einplanen hängt es `^t-xxxxxx` ans Ende der Task-Zeile. Sie wird nie
   geändert. Beim Umformulieren oder Verschieben des Tasks bleibt sie stehen; beim Kopieren oder
   Aufteilen behält nur das Original sie.
2. **Erledigen:** Das Tasks-Plugin schreibt die Zeile neu, bei `🔁` mit der Folgeaufgabe darüber.

Sonst nichts: kein `⏳`, kein Datum, keine Termin-ID, kein Schreiben im Hintergrund.

## Fehlerbilder

| Meldung | Ursache | Abhilfe |
| --- | --- | --- |
| „Die Redirect-URI passt nicht" (AADSTS50011) | `obsidian://vault-planner-auth` fehlt oder steht unter der falschen Plattform | Unter „Mobile- und Desktopanwendungen" eintragen |
| „Entra verlangt ein Client-Secret" (AADSTS7000218) | Die App wird als vertraulicher Client behandelt | „Öffentliche Clientflows zulassen" auf Ja |
| „Die App wurde nicht gefunden" (AADSTS700016) | Client-ID oder Tenant-ID falsch | Mit der Übersichtsseite der Registrierung vergleichen |
| „Die Zustimmung fehlt" (AADSTS65001) | Benutzerzustimmung gesperrt | Administratorzustimmung erteilen |
| „Conditional Access blockiert …" (AADSTS53003/53000) | Eine CA-Richtlinie greift | In den Anmeldeprotokollen die Richtlinie suchen |
| „Diese Rückmeldung gehört zu keiner laufenden Anmeldung" | Der Link ging an ein anderes Vault-Fenster, oder Obsidian wurde neu gestartet | Nur einen Vault offen lassen, erneut „Anmelden" |
| „Kalender nicht erreichbar – Planungsstatus unbekannt" | Netzwerk oder Graph gestört | „Erneut versuchen"; ziehen ist so lange gesperrt |
| „Keine offenen Aufgaben", obwohl Tasks im Vault stehen | `10_Kunden` und `20_Intern` liegen nicht direkt im Vault-Ordner, z. B. eine Ebene tiefer nach dem Entpacken | Die Ordner eine Ebene hochschieben, dann das Plugin aus- und einschalten |
| „Block-ID doppelt" an einer Karte | Eine Zeile mit `^t-…` wurde kopiert | Bei der Kopie die Block-ID entfernen |
| Block gestrichelt mit „Aufgabe nicht gefunden" | Die Task-Zeile mit dieser Block-ID gibt es nicht mehr | Block per Rechtsklick löschen oder die ID wiederherstellen |

## Grenzen

Nur Desktop, nur das Hauptfenster (kein Pop-out), nur der Standardkalender, Montag bis Freitag.
Keine Teilnehmer, keine Termine ohne Task.

## Entwicklung

Siehe `CLAUDE.md` und `docs/umsetzungsplan.md`. Kurz: `npx npm@11 install`, danach
`bash scripts/verify.sh`. Der Lauf endet mit `release/vault-planner.zip`.
