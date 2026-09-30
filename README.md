# Vault Planner

Ein Obsidian-Plugin: links die offenen Tasks aus den Projektdateien, rechts die Outlook-Woche.
Einen Task in eine freie Lücke ziehen, und in Outlook entsteht ein Fokus-Block.

Die Planung steht **nur in Outlook**. In die Task-Zeile schreibt das Plugin einmalig eine Block-ID
(`^t-3f9a1c`), damit der Termin seinen Task wiederfindet. Ob ein Task geplant ist, zeigt das Plugin
live aus dem Kalender an, auch nachdem du einen Block in Outlook verschoben oder gelöscht hast.

## Einrichtung

### 1. Entra-App-Registrierung (einmalig)

1. Entra Admin Center → App-Registrierungen → **Neue Registrierung** „Obsidian Vault Planner",
   *Nur Konten in diesem Organisationsverzeichnis*. Für To Do mit dem privaten Konto wird das später
   umgestellt (Einrichtung 5).
2. **Authentifizierung → Plattform hinzufügen → Mobile- und Desktopanwendungen**, dort zwei
   benutzerdefinierte Umleitungs-URIs:
   - `obsidian://vault-planner-auth`
   - `http://localhost` (Reserve)
3. „Öffentliche Clientflows zulassen" bleibt auf **Nein**.
4. **API-Berechtigungen → Microsoft Graph → Delegiert:** `Calendars.ReadWrite` und
   `MailboxSettings.Read` (nur für die Farben der Outlook-Kategorien), für Planner-Aufgaben oder To Do
   zusätzlich `Tasks.ReadWrite`. Falls Benutzerzustimmung gesperrt ist, die Administratorzustimmung
   erteilen.
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
Der Schalter **Planner-Aufgaben** holt die dir zugewiesenen Planner-Aufgaben dazu. Fehlt dafür die
Zustimmung, meldet sich das Plugin nach dem Einschalten ab; **Anmelden** holt sie ein. Wer nicht
zustimmen kann, schaltet den Schalter wieder aus und meldet sich neu an. Ausschalten
fordert `Tasks.ReadWrite` nicht mehr an, nimmt die einmal erteilte Zustimmung aber nicht zurück.
Das geht nur in Entra bzw. unter myapps.microsoft.com.

Seit M7 fragt das Plugin zusätzlich `MailboxSettings.Read` an. Nach dem ersten Update darauf meldet
es sich deshalb einmal ab; **Anmelden** holt die Zustimmung ein.

- Der Browser öffnet die Microsoft-Anmeldung und fragt am Ende, ob er Obsidian öffnen darf.
- Beim Anmelden nur **einen** Vault mit dem Plugin offen haben: Der `obsidian://`-Link geht an das
  zuletzt aktive Vault-Fenster.
- Die Anmeldung gilt auf diesem Gerät etwa 90 Tage ab der letzten Nutzung. Der Token liegt
  verschlüsselt in Obsidians Schlüsselbund, nicht im Vault.

### 5. Privates Konto für Microsoft To Do (optional, in Arbeit: M9)

Dieselbe App-Registrierung wie für das Arbeitskonto, für private Konten geöffnet:

1. **Authentifizierung → Unterstützte Kontotypen:** „Konten in allen Organisationsverzeichnissen und
   persönliche Microsoft-Konten". Die App ist damit für jeden Entra-Tenant offen; an deine Daten
   kommt dadurch niemand, andere Tenants sehen sie als „nicht verifiziert". Lehnt Entra das
   Umstellen ab, zuerst die Eigenschaft ändern, die die Fehlermeldung nennt; laut Doku kann das
   nötig sein.
2. **API-Berechtigungen → Microsoft Graph → Delegiert:** `Tasks.ReadWrite` und `Calendars.ReadWrite`
   müssen in der Liste stehen, auch ohne Planner.
3. Im Plugin „To Do (privat)" einschalten, beim privaten Konto **Anmelden** und mit dem privaten
   Konto zustimmen. Die Client-ID ist dieselbe.

Ein Problem mit dem privaten Konto meldet das Arbeitskonto nie ab. Ausschalten blendet To Do und
den privaten Kalender aus, meldet das private Konto aber nicht ab.

## Bedienung

- **Öffnen:** das Kalender-Symbol in der linken Leiste oder der Befehl „Planner öffnen".
- **Liste:** Gruppiert nach Datum:
  - „Überfällig": das älteste Datum oben
  - „Heute"
  - „Nächste 7 Tage"
  - „Später"
  - „Ohne Datum"
  - dazu „Warten auf" für `WAITING`, eingeklappt

  Das Datum ist `📅`, fehlt es, dann `⏳`. Die Karte zeigt, welches: „bis Di., 22.09." oder
  „⏳ Mi., 08.07.". Ein eingeplanter Task rückt vor auf den Tag seines nächsten Blocks: heute
  eingeplant steht unter „Heute". Nach hinten schiebt ein Block nie, eine überfällige Aufgabe
  bleibt überfällig. Bei gleichem Datum kommt die höhere Priorität zuerst, ihr Symbol steht vor dem
  Titel.

  Suche, Kunden-Filter und „nur ungeplante" stehen darüber. Ein Klick öffnet die Aufgabe in einem
  neuen Tab.
- **Farben:** Karte und Block einer Vault-Aufgabe haben die Akzentfarbe, bei Planner-Aufgaben sind
  sie grün. Eigene Blöcke sind gefüllt. Fremde Termine sind hell getönt in der Farbe ihrer ersten
  Outlook-Kategorie, ohne Kategorie blau, und schraffiert, wenn sie „mit Vorbehalt" sind.
- **Ansicht:** Die Knöpfe rechts über dem Kalender schalten zwischen 1, 2, 3 oder 4 Arbeitstagen,
  der Arbeitswoche und der ganzen Woche mit Wochenende um. In der Tagesansicht blättern die Pfeile
  um so viele Arbeitstage, wie zu sehen sind. Die Wahl bleibt auf diesem Gerät gespeichert.
- **Einplanen:** eine Karte in den Kalender ziehen. Ein Block ist eine Stunde lang; am Rand ziehen
  ändert die Länge. Die Karte zeigt „Wird gespeichert…", bis der Termin im Kalender auftaucht.
- **Verschieben oder Größe ändern:** den Block im Kalender ziehen bzw. am Rand ziehen.
- **Block löschen:** Rechtsklick auf den Block → „Block löschen…".
- **Erledigen:** die Checkbox an der Karte (über das Tasks-Plugin). Die Blöcke bleiben in Outlook
  stehen; gebuchte Zeit ist Geschichte.
- **Abgelaufen:** Ein Task, dessen Blöcke alle vorbei sind, zeigt „abgelaufen: …" und gilt wieder
  als ungeplant.
- **Planner-Aufgaben** stehen unter dem Kunden „Planner", mit Plan und Bucket. „Dringend" und
  „Wichtig" aus Planner zählen als wichtig. Ein Klick öffnet die Aufgabe in Planner, ein Rechtsklick
  wechselt den Bucket, die Checkbox schließt sie in Planner ab. Ist sie auch anderen zugewiesen,
  fragt vorher ein Dialog, denn abgeschlossen ist sie dann für alle. Planner wird jede Minute und
  bei der Rückkehr in die Ansicht (höchstens alle 30 s) neu gelesen.
- **To-Do-Aufgaben** (privates Konto, Schalter „To Do (privat)") stehen türkis unter dem Kunden „To
  Do", mit der Liste als Projekt. Gekennzeichnete E-Mails fehlen, „Warten auf" und „Zurückgestellt"
  stehen unter „Warten auf". Ein Klick öffnet die Aufgabe in To Do, die Checkbox schließt sie dort
  ab. In einer geteilten Liste fragt vorher ein Dialog. Wiederkehrende Aufgaben haben vorerst keine
  Checkbox, sie werden in To Do abgehakt. Einplanen in den privaten Kalender kommt mit M9.1b.

## Was das Plugin in den Vault schreibt

Genau zweierlei, und nur, wenn du es auslöst:

1. **Block-ID:** Beim ersten Einplanen hängt es `^t-xxxxxx` ans Ende der Task-Zeile. Sie wird nie
   geändert. Beim Umformulieren oder Verschieben des Tasks bleibt sie stehen; beim Kopieren oder
   Aufteilen behält nur das Original sie.
2. **Erledigen:** Das Tasks-Plugin schreibt die Zeile neu, bei `🔁` mit der Folgeaufgabe darüber.

Sonst nichts: kein `⏳`, kein Datum, keine Termin-ID, kein Schreiben im Hintergrund. Eine
Planner-Aufgabe einzuplanen schreibt nichts in den Vault.

## Was das Plugin in To Do schreibt

Genau eines, und nur, wenn du es auslöst: eine Aufgabe abschließen. Keinen anderen Wert, keine
neue Aufgabe, keinen Listenwechsel.

## Was das Plugin in Planner schreibt

Genau zweierlei, und nur, wenn du es auslöst: abschließen und den Bucket wechseln. Hat jemand die
Aufgabe inzwischen in Planner geändert, bricht das Plugin ab und liest neu, statt die Änderung zu
überschreiben.

## Fehlerbilder

| Meldung | Ursache | Abhilfe |
| --- | --- | --- |
| „Die Redirect-URI passt nicht" (AADSTS50011) | `obsidian://vault-planner-auth` fehlt oder steht unter der falschen Plattform | Unter „Mobile- und Desktopanwendungen" eintragen |
| „Entra verlangt ein Client-Secret" (AADSTS7000218) | Die App wird als vertraulicher Client behandelt | „Öffentliche Clientflows zulassen" auf Ja |
| „Die App wurde nicht gefunden" (AADSTS700016) | Client-ID oder Tenant-ID falsch | Mit der Übersichtsseite der Registrierung vergleichen |
| „Privates Konto: Die App-Registrierung ist nicht für private Microsoft-Konten geöffnet" | Kontotyp der Registrierung steht noch auf „Nur Konten in diesem Organisationsverzeichnis" | Einrichtung 5, Schritt 1 |
| „Die Zustimmung fehlt" (AADSTS65001) | Benutzerzustimmung gesperrt | Administratorzustimmung erteilen |
| „Conditional Access blockiert …" (AADSTS53003/53000) | Eine CA-Richtlinie greift | In den Anmeldeprotokollen die Richtlinie suchen |
| „Diese Rückmeldung gehört zu keiner laufenden Anmeldung" | Der Link ging an ein anderes Vault-Fenster, oder Obsidian wurde neu gestartet | Nur einen Vault offen lassen, erneut „Anmelden" |
| „Kalender nicht erreichbar – Planungsstatus unbekannt" | Netzwerk oder Graph gestört | „Erneut versuchen"; ziehen ist so lange gesperrt |
| „Keine offenen Aufgaben", obwohl Tasks im Vault stehen | `10_Kunden` und `20_Intern` liegen nicht direkt im Vault-Ordner, z. B. eine Ebene tiefer nach dem Entpacken | Die Ordner eine Ebene hochschieben, dann das Plugin aus- und einschalten |
| „Privates Konto: Kein Zugriff auf To Do" | `Tasks.ReadWrite` fehlt in der App-Registrierung oder ist für das private Konto nicht zugestimmt | Berechtigung ergänzen, beim privaten Konto abmelden und neu anmelden |
| „Kein Zugriff auf Planner" | `Tasks.ReadWrite` fehlt in der App-Registrierung oder ist nicht zugestimmt | Berechtigung ergänzen, abmelden, neu anmelden |
| „… zwischenzeitlich in Planner geändert" | Die Aufgabe wurde in Planner geändert, seit das Plugin sie gelesen hat | Nach dem Neuladen erneut versuchen |
| Alle fremden Termine blau, obwohl sie in Outlook Kategorien haben | Die Kategorieliste war nicht lesbar (`MailboxSettings.Read` fehlt oder ist nicht zugestimmt), oder die Kategorie ist neu | Berechtigung ergänzen, abmelden, neu anmelden; eine neue Kategorie erscheint, sobald die Ansicht neu geöffnet wird |
| „Block-ID doppelt" an einer Karte | Eine Zeile mit `^t-…` wurde kopiert | Bei der Kopie die Block-ID entfernen |
| Block gestrichelt mit „Aufgabe nicht gefunden" | Die Task-Zeile mit dieser Block-ID gibt es nicht mehr | Block per Rechtsklick löschen oder die ID wiederherstellen |

## Grenzen

Nur Desktop, nur das Hauptfenster (kein Pop-out), nur der Standardkalender. Das Wochenende nur in
der Ansicht „Woche".
Keine Teilnehmer, keine Termine ohne Task. Aus Planner nur Basic-Pläne: Premium-Pläne liefert die
API nicht.

## Entwicklung

Siehe `CLAUDE.md` und `docs/umsetzungsplan.md`. Kurz: `npx npm@11 install`, danach
`bash scripts/verify.sh`. Der Lauf endet mit `release/vault-planner.zip`.
