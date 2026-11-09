# RBWR Demands

Live-Demand-Board für **Realistic Boiling Water Reactor Simulator (RBWR)** auf Roblox – als Ersatz für die nicht mehr erreichbare Seite `rbwr.waifly.com`.

Für jeden RBWR-Server zeigt die Seite:

- aktuelle Demand von **Unit 1** und **Unit 2** (plus Summe)
- die **nächste Demand** (→ Wert darunter)
- **Countdown** bis zum nächsten Demand-Wechsel (sekundengenau; der Balken zeigt die 20 Minuten einer Demand, unter 5 Minuten wird er gelb, unter 1 Minute rot)
- Sonderzustände als Leuchtmelder: `Maint` (Wartung), `LOOP` (Loss of Offsite Power), `RST`, `Evac` (Evakuierung)
- aktuelle Leistung (Output MW) pro Unit bzw. „Not generating", Spieler, privat/öffentlich, „Join"-Button
- Gesamtleistung aller Server oben in den Anzeigen (Summe der aktuellen Outputs)

Dazu: Suche nach Server-ID (z. B. `7b4f-4460` – die kurze ID aus dem Spiel – oder die volle Job-ID), Sortierung (nächster Wechsel / höchste Demand / meiste Spieler), private Server ausblenden, Server mit ☆ oben anpinnen, Klick auf die Server-ID kopiert die volle Job-ID. Links wie `/?q=7b4f-4460` öffnen direkt gefiltert.

## Woher kommen die Daten?

- **Demand, Countdown, Leistung:** öffentliche RBWR-Server-API `https://hydrogen.realisticbwr.org/api/public/servers` (Fallback: `https://realisticbwr.org/api/public/servers`). Dieselbe Quelle nutzen auch andere Community-Tools (RBWR Server Checker, RBWR Utility).
- **Spielerzahl / privat:** Roblox-API `games.roblox.com/v1/games/11765852158/servers/Public`.

Was die echten Daten zeigen (geprüft am 9. 11. 2026):

- Eine Demand gilt **20 Minuten**; Unit 1 und Unit 2 haben fast immer dieselbe Demand (meist 500–1100 MW in 10er-Schritten, `0` direkt nach Serverstart).
- Server melden sich etwa alle **30 Sekunden**; der Countdown läuft dazwischen im Browser weiter.
- Units, die nicht laufen, melden einen leicht negativen Output (Eigenverbrauch) → „Not generating".
- Server mit Besitzer sind privat („Invite only"); Server ohne Besitzer, die nicht in Roblox' öffentlicher Liste stehen, heißen „Not public".
- Negative Demand-Werte sind Sonderzustände: `-1` Maint, `-2` LOOP, `-3` RST, `-4` Evac (Kodierung aus anderen Community-Tools).

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
public/js/app.js     Laden, Sortieren, Suche, Countdown
public/js/model.js   Einlesen der API-Daten (Feldnamen, Sonderwerte, Server-ID)
public/js/demo.js    Demo-Daten im exakten API-Format
test/                Tests (node --test), inkl. echter API-Antwort als Testdaten
```

Fan-Projekt, nicht mit der RBWR Simulation Community verbunden.
