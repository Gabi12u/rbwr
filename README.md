# RBWR Demands

Live-Demand-Board für **Realistic Boiling Water Reactor Simulator (RBWR)** auf Roblox – als Ersatz für die nicht mehr erreichbare Seite `rbwr.waifly.com`.

Gestaltet wie der Kontrollraum im Spiel: beige Pulte, schwarze Schilder, Rundinstrumente mit mintgrünem Zifferblatt, rote 7-Segment-Anzeigen, Leuchtmelder-Tableau, Leuchtdrucktasten und Drehschalter.

Jeder Server bekommt ein eigenes Pult mit:

- **zwei Rundinstrumenten** (Unit 1 / Unit 2): Zeiger = aktueller Output, rote Marke + grünes Band = Demand
- **Demand** als rote LED-Anzeige, **nächste Demand** als gelbe LED
- **Countdown** bis zum Wechsel als LED + Zeigerinstrument über die 20 Minuten einer Demand (gelbe Zone unter 5 min, rote unter 1 min)
- **Lampen**: grün = Server meldet sich, gelb = Wechsel in < 5 min, rot = Wechsel in < 1 min (Countdown blinkt)
- **Störmelde-Tableau**: Reactor Scram, Turbine Trip, Offsite Power Lost, Rupture Disk, Fire Alarm, Turbine Damage (mit % und Unit), dazu der letzte Scram- und Trip-Grund und ob der Notstromdiesel läuft
- Sonderzustände `Maint`, `LOOP`, `RST`, `Evac` als Leuchtmelder statt Zahl
- Spieler, privat/öffentlich, grüner **Join**-Knopf bzw. rotes „Private"-Schild

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
- **Störungen:** Die API liefert pro Unit `Reactor Scram State`, `TurbineTrip`, `Offsite Power`, `Disk Ruptured` (nur U2), `TurbineHealth` (nur U2), `DieselRPM` sowie `SCRAMreason`/`TRIPreason` (bleiben nach dem Reset stehen → „Last scram") und pro Server `FSS Smoke Detected`. Zufällige Geräte-Malfunctions (z. B. Feedwater- oder Druck-Malfs) stehen **nicht** in der API.

Die API sendet **keine CORS-Header**, der Browser darf sie also nicht direkt abfragen. Deshalb holt `server.js` die Daten (höchstens alle 15 Sekunden, egal wie viele Leute die Seite offen haben) und gibt sie unter `/api/servers` an die Seite weiter.

## Starten

Voraussetzung: **Node.js 18 oder neuer**. Keine weiteren Pakete nötig (`npm install` ist nicht erforderlich).

```bash
npm start          # echte Daten, http://localhost:3000
npm run demo       # Fake-Daten zum Ausprobieren, ohne Internet
npm test           # Tests für das Einlesen der API-Daten
```

`?demo` hinter der Adresse (z. B. `http://localhost:3000/?demo`) zeigt Demo-Daten auch bei laufendem Live-Server.

### Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` / `SERVER_PORT` | `3000` | Port des Webservers (`SERVER_PORT` setzt Pterodactyl/Waifly automatisch) |
| `HOST` | `0.0.0.0` | Adresse, an die gebunden wird |
| `CACHE_SECONDS` | `15` | Wie lange eine API-Antwort wiederverwendet wird |
| `UPSTREAM_URLS` | beide realisticbwr.org-URLs | Kommagetrennte Liste von API-URLs |
| `DEMO` | – | `1` = Demo-Daten statt echter API |

## Hosten

**Waifly / Pterodactyl (Node.js-Egg):** Alle Dateien hochladen, als Startdatei `server.js` eintragen (bzw. Startbefehl `node server.js`). Der Port wird über `SERVER_PORT` automatisch übernommen.

**Eigener Server / VPS:** `node server.js` hinter einem Reverse-Proxy (nginx, Caddy) laufen lassen, z. B. mit `pm2` oder einem systemd-Service.

**Nicht geeignet:** reines Static Hosting wie GitHub Pages – ohne `server.js` kommen wegen der fehlenden CORS-Header keine Daten an.

## Aufbau

```
server.js            Webserver + API-Proxy mit Cache (keine Abhängigkeiten)
public/index.html    Seite
public/css/style.css Kontrollraum-Design (hell + dunkel)
public/fonts/        DSEG7 (7-Segment) und Barlow, selbst gehostet (SIL Open Font License)
public/js/app.js     Laden, Sortieren, Suche, Countdown
public/js/model.js   Einlesen der API-Daten (Feldnamen, Sonderwerte, Server-ID)
public/js/demo.js    Demo-Daten im exakten API-Format
test/                Tests (node --test), inkl. echter API-Antwort als Testdaten
```

Fan-Projekt, nicht mit der RBWR Simulation Community verbunden.
