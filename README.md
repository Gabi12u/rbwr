# RBWR Demands

Live-Demand-Board für **Realistic Boiling Water Reactor Simulator (RBWR)** auf Roblox – als Ersatz für die nicht mehr erreichbare Seite `rbwr.waifly.com`.

Gestaltet wie der Kontrollraum im Spiel: beige Pulte, schwarze Schilder, Rundinstrumente mit mintgrünem Zifferblatt, rote 7-Segment-Anzeigen, Leuchtmelder-Tableau, Leuchtdrucktasten und Drehschalter.

Jeder Server bekommt ein eigenes Pult mit:

- ganz oben, groß: **Demand jetzt ▶ nächste Demand** (rote und gelbe LED; eine Zeile, wenn beide Units dieselbe Demand haben, sonst je eine Zeile für U1 und U2)
- direkt darunter: **„Changes in"** – Countdown bis zum Wechsel als LED + Zeigerinstrument über die 20 Minuten einer Demand (gelbe Zone unter 5 min, rote unter 1 min)
- **zwei Rundinstrumente** (Unit 1 / Unit 2): Zeiger = aktueller Output, rote Marke + grünes Band = Demand
- **Lampen**: grün = Server meldet sich, gelb = Wechsel in < 5 min, rot = Wechsel in < 1 min (Countdown blinkt)
- **Störmelde-Tableau**: Reactor Scram, Turbine Trip, Offsite Power Lost, Rupture Disk, Fire Alarm, Turbine Damage (mit % und Unit), dazu der letzte Scram- und Trip-Grund und ob der Notstromdiesel läuft
- Sonderzustände `Maint`, `LOOP`, `RST`, `Evac` als Leuchtmelder statt Zahl
- Spieler, privat/öffentlich, grüner **Join**-Knopf bzw. rotes „Private"-Schild
- Knöpfe **„Unit 1 panel" / „Unit 2 panel"**: öffnen das Pult der Unit mit allem, was das Spiel meldet – APRM/RTP, Stabstellung, Xenon, Jod, Reaktordruck, -temperatur und -füllstand, Recirc- und Speisewasserpumpen, Hotwell/Deaerator, Turbinendrehzahl und -zustand, Generator, Bus A/B, Anfahrtrafo, Offsite Power, Notstromdiesel, Ereignis-Logger und Standortdaten. Unit 1 im hellgrauen Look des Unit-1-Kontrollraums, Unit 2 beige. Jedes Pult hat einen eigenen Link (`#unit/<job id>/u1`), die Zurück-Taste schließt es.

Oben: **Alarm-Panel** über alle Server (API-Verbindung, Demand-Wechsel < 5 / < 1 min, angepinnter Server < 1 min, Scram, Turbine Trip, Offsite Power, Rupture Disk, Feuer, Maint, Evac). Neue Meldungen blinken, bis man **ACK** drückt. Daneben LED-Anzeigen für Server, Spieler und die Gesamtleistung beider Units.

Bedienung: Suche nach Server-ID (z. B. `7b4f-4460` – die kurze ID aus dem Spiel – oder die volle Job-ID), Sortier-Tasten (nächster Wechsel / Demand / Spieler), Drehschalter „All / Public", Server mit **Pin** oben festhalten, Klick auf die Server-ID kopiert die volle Job-ID. Links wie `/?q=7b4f-4460` öffnen direkt gefiltert. Im Dark Mode werden die Pulte dunkel („Nachtschicht"), die Instrumente leuchten weiter.

## Woher kommen die Daten?

- **Demand, Countdown, Leistung:** öffentliche RBWR-Server-API `https://hydrogen.realisticbwr.org/api/public/servers` (Fallback: `https://realisticbwr.org/api/public/servers`). Dieselbe Quelle nutzen auch andere Community-Tools (RBWR Server Checker, RBWR Utility).
- **Spielerzahl / privat:** Roblox-API `games.roblox.com/v1/games/11765852158/servers/Public`.

Was die echten Daten zeigen (geprüft am 9. 11. 2026):

- Eine Demand gilt **20 Minuten**; Unit 1 und Unit 2 haben fast immer dieselbe Demand (meist 500–1100 MW in 10er-Schritten, `0` direkt nach Serverstart).
- Die Daten der API sind meist **30–90 Sekunden** alt; der Countdown läuft dazwischen im Browser weiter. Ist er abgelaufen, bevor der Server sich neu meldet, zeigt die Seite schon die neue Demand (vorher „Next") und zählt die nächsten 20 Minuten – markiert mit „New demand, report pending".
- Units, die nicht laufen, melden einen leicht negativen Output (Eigenverbrauch) → „Not generating".
- Server mit Besitzer sind privat („Invite only"); Server ohne Besitzer, die nicht in Roblox' öffentlicher Liste stehen, heißen „Not public".
- Negative Demand-Werte sind Sonderzustände: `-1` Maint, `-2` LOOP, `-3` RST, `-4` Evac (Kodierung aus anderen Community-Tools; `-1` taucht in echten Daten auf).
- **Spielersuche** („in welchem Server ist Spieler X?") geht mit öffentlichen Daten nicht: Roblox liefert in der Serverliste keine Spieler mehr (die `playerTokens` sind leer), die RBWR-API hat keine Spielernamen (die Spielerliste der offiziellen Seite ist nur für Admins), und Roblox' Presence-API verrät den Server nur eingeloggten Freunden. Suche stattdessen nach der Server-ID aus dem Spiel.
- **Störungen:** Die API liefert pro Unit `Reactor Scram State`, `TurbineTrip`, `Offsite Power`, `Disk Ruptured` (nur U2), `TurbineHealth` (nur U2), `DieselRPM` sowie `SCRAMreason`/`TRIPreason` (bleiben nach dem Reset stehen → „Last scram") und pro Server `FSS Smoke Detected`. Zufällige Geräte-Malfunctions (z. B. Feedwater- oder Druck-Malfs) stehen **nicht** in der API.

Die API sendet **keine CORS-Header**, der Browser darf sie also nicht direkt abfragen. Deshalb gibt es die **RBWR-Demands-App** (Rust): Sie holt die Daten (höchstens alle 15 Sekunden, egal wie viele Tabs offen sind) und liefert sie zusammen mit der Seite aus. Für GitHub Pages schreibt sie stattdessen einen Schnappschuss.

## Auf dem PC starten

**Download:** https://github.com/Gabi12u/rbwr/releases/latest

- **Windows:** `RBWR-Demands-Setup.exe` herunterladen und starten. Der Installer braucht keine Admin-Rechte, legt einen Startmenü-Eintrag und ein Desktop-Symbol „RBWR Demands" an und startet die App am Ende. Deinstallieren über *Einstellungen → Apps*. Ohne Installation geht auch `rbwr-demands-windows-x64.exe` direkt per Doppelklick.
- **macOS:** `rbwr-demands-macos-apple-silicon` (M1/M2/…) oder `rbwr-demands-macos-intel`; **Linux:** `rbwr-demands-linux-x64`. Vorher `chmod +x` ausführen, macOS beim ersten Mal per Rechtsklick → *Öffnen*.

Beim Start öffnet sich ein kleines Fenster mit der Adresse, und der Browser zeigt `http://localhost:3000/` mit Live-Daten. Zum Beenden das Fenster schließen. Ein zweiter Klick auf das Symbol öffnet nur den Browser, wenn die App schon läuft.

Windows warnt beim ersten Start evtl. („Der Computer wurde durch Windows geschützt"), weil die Dateien nicht signiert sind: *Weitere Informationen → Trotzdem ausführen*. Passiert gar nichts, hat meist der Virenschutz die Datei blockiert: *Windows-Sicherheit → Viren- & Bedrohungsschutz → Schutzverlauf*, dort den Eintrag zu RBWR Demands öffnen und *Zulassen* wählen.

Die Dateien baut der Workflow **„Build app"** automatisch, sobald sich die App in `main` ändert (oder per *Actions → Build app → Run workflow*).

Optionen (z. B. über eine Verknüpfung oder im Terminal):

| Option | Bedeutung |
| --- | --- |
| `--lan` | Auch im Heimnetz erreichbar (Handy, Tablet); die Adresse steht im Fenster |
| `--port 8080` | Anderer Port (sonst 3000 oder der nächste freie) |
| `--no-browser` | Browser nicht automatisch öffnen |
| `--demo` | Mit Demo-Daten öffnen |
| `--export ORDNER` | Seite + Daten-Schnappschuss in einen Ordner schreiben (für GitHub Pages) |

Umgebungsvariablen: `PORT`/`SERVER_PORT`, `HOST`, `CACHE_SECONDS` (Standard 15), `UPSTREAM_URLS` (kommagetrennt). Ist `SERVER_PORT` gesetzt (z. B. bei Waifly/Pterodactyl), lauscht die App auf `0.0.0.0` und öffnet keinen Browser – so läuft sie auch auf einem Server.

### Selbst bauen

[Rust installieren](https://rustup.rs), dann im Projektordner:

```bash
cargo run --release              # startet die App
cargo build --release            # Programm liegt dann in target/release/
cargo test                       # Rust-Tests
npm test                         # Tests für das Einlesen der API-Daten (Node.js 18+)
```

Die Seite aus `public/` wird beim Bauen ins Programm eingebettet – nach Änderungen an HTML/CSS/JS neu bauen.

## Website auf GitHub Pages

Der Workflow **„GitHub Pages"** baut die App, lässt sie mit `--export` die Seite samt Daten-Schnappschuss schreiben und veröffentlicht das alle 10 Minuten unter `https://gabi12u.github.io/rbwr/`. Countdowns bleiben trotzdem sekundengenau (sie werden aus Meldezeitpunkt + Restzeit berechnet), und ist eine Demand seit dem Schnappschuss gewechselt, zeigt die Seite schon die neue an. Live (15 s) ist nur die App auf dem PC.

Einschalten:

1. **Repo öffentlich machen** (*Settings → General → Danger Zone → Change visibility*). Für private Repos braucht GitHub Pages einen bezahlten Plan, und der 10-Minuten-Takt würde das Freikontingent an Actions-Minuten aufbrauchen; bei öffentlichen Repos ist beides kostenlos.
2. *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
3. *Settings → Secrets and variables → Actions → Variables →* **New repository variable**: Name `PAGES_LIVE`, Wert `true`.
4. Diese Änderungen in `main` mergen (geplante Workflows laufen nur auf dem Standard-Branch), dann *Actions → GitHub Pages → Run workflow*.

Solange `PAGES_LIVE` nicht gesetzt ist, wird jeder Lauf übersprungen und kostet nichts. GitHub startet geplante Läufe manchmal verspätet; dann ist der Schnappschuss etwas älter.

## Aufbau

```
src/main.rs          App: Webserver, API-Proxy mit Cache, Browser-Start, Export für GitHub Pages
build.rs, assets/    Programm-Icon und Versionsinfo für Windows
installer/           Windows-Installer (Inno Setup)
public/index.html    Seite (wird ins Programm eingebettet)
public/css/style.css Kontrollraum-Design (hell + dunkel)
public/fonts/        DSEG7 (7-Segment) und Barlow, selbst gehostet (SIL Open Font License)
public/js/app.js     Laden, Sortieren, Suche, Countdown, Alarm-Panel
public/js/model.js   Einlesen der API-Daten (Feldnamen, Sonderwerte, Störungen, Server-ID)
public/js/demo.js    Demo-Daten im exakten API-Format
test/                JavaScript-Tests, inkl. echter API-Antwort als Testdaten
.github/workflows/   CI (Tests), Build app (Windows-Installer, macOS, Linux → GitHub Release), GitHub Pages
```

Fan-Projekt, nicht mit der RBWR Simulation Community verbunden.
