# RBWR Demands

Live-Demand-Board für **Realistic Boiling Water Reactor Simulator (RBWR)** auf Roblox – als Ersatz für die nicht mehr erreichbare Seite `rbwrwaifly.com`.

Für jeden RBWR-Server zeigt die Seite:

- aktuelle Demand von **Unit 1** und **Unit 2** (plus Summe)
- die **nächste Demand** (→ Wert darunter)
- **Countdown** bis zum nächsten Demand-Wechsel (sekundengenau, mit Balken für die letzten 10 Minuten; unter 5 Minuten wird er gelb, unter 1 Minute rot)
- Sonderzustände als Leuchtmelder: `Maint` (Wartung), `LOOP` (Loss of Offsite Power), `RST`, `Evac` (Evakuierung)
- aktuelle Leistung (Output MW) pro Unit, Spieler, privat/öffentlich, „Join"-Button
- Gesamtleistung aller Server oben in den Anzeigen

Dazu: Suche nach Server-ID (z. B. `7b4f-4460` – die kurze ID aus dem Spiel – oder die volle Job-ID), Sortierung (nächster Wechsel / höchste Demand / meiste Spieler), private Server ausblenden, Server mit ☆ oben anpinnen, Klick auf die Server-ID kopiert die volle Job-ID. Links wie `/?q=7b4f-4460` öffnen direkt gefiltert.

## Woher kommen die Daten?

- **Demand, Countdown, Leistung:** öffentliche RBWR-Server-API `https://hydrogen.realisticbwr.org/api/public/servers` (Fallback: `https://realisticbwr.org/api/public/servers`). Dieselbe Quelle nutzen auch andere Community-Tools (RBWR Server Checker, RBWR Utility).
- **Spielerzahl / privat:** Roblox-API `games.roblox.com/v1/games/11765852158/servers/Public`.

Negative Demand-Werte sind Sonderzustände: `-1` Maint, `-2` LOOP, `-3` RST, `-4` Evac.

Der kleine Node-Server fragt die API höchstens alle 15 Sekunden ab (egal wie viele Leute die Seite offen haben) und reicht die Daten an den Browser weiter – direkt aus dem Browser lässt sich die API wegen CORS normalerweise nicht abfragen.

## Starten

Voraussetzung: **Node.js 18 oder neuer**. Keine weiteren Pakete nötig (`npm install` ist nicht erforderlich).

```bash
npm start          # echte Daten, http://localhost:3000
npm run demo       # Fake-Daten zum Ausprobieren, ohne Internet
npm test           # Tests für das Einlesen der API-Daten
```

Ohne Server ausprobieren geht auch: `index.html?demo` öffnet die Seite mit Demo-Daten (muss trotzdem über einen Webserver laufen, nicht per `file://`).

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

**Nur statisch (GitHub Pages o. ä.):** Der Ordner `public/` funktioniert auch ohne `server.js`. Dann fragt der Browser die RBWR-API direkt ab – das klappt aber nur, wenn die API CORS erlaubt, und Spielerzahlen fehlen. Mit `server.js` ist man auf der sicheren Seite.

## Aufbau

```
server.js            Webserver + API-Proxy mit Cache (keine Abhängigkeiten)
public/index.html    Seite
public/css/style.css Kontrollraum-Design (hell + dunkel)
public/js/app.js     Laden, Sortieren, Suche, Countdown
public/js/model.js   Einlesen der API-Daten (Feldnamen, Sonderwerte, Server-ID)
public/js/demo.js    Demo-Daten im exakten API-Format
test/                Tests (node --test)
```

Fan-Projekt, nicht mit der RBWR Simulation Community verbunden.
