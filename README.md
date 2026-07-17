# Free Salon Website Builder

Ein bewusst kleiner, statischer Website-Builder für Coiffeur-Salons. Er dient als kostenloser Einstieg in das spätere Buchungs-SaaS von Gasserwerk Solutions.

## Produktgrenze der Gratisversion

Enthalten:

- Salonprofil und Kontaktdaten
- direkt bearbeitbare Website-Texte
- gemeinsamer Service- und Preiskatalog
- Dauer, Preisart und Buchbarkeit pro Leistung
- Öffnungszeiten
- vier kuratierte Designrichtungen
- optional bis zu drei manuelle Kundenstimmen
- lokales Autosave
- responsive Live-Vorschau
- Export als einzelne HTML-Datei

Bewusst nicht enthalten:

- externe Bewertungs-APIs
- Google-Review-Synchronisierung
- API-Schlüssel im Browser
- allgemeine Branchen und technische DSL-Oberflächen
- Hosting, Domainverwaltung und SaaS-Tenant-Synchronisierung

Die Plattformversion kann später automatische Bewertungen, Veröffentlichung, Teamkalender, Ressourcen, Buchungsregeln und laufende Inhaltsverwaltung ergänzen.

## Lokal starten

Es gibt keinen Build-Schritt und keine Abhängigkeiten.

```bash
python3 -m http.server 8080
```

Danach `http://localhost:8080` öffnen.

## Datenmodell

`services` ist die gemeinsame Quelle für Website, Preisliste und spätere Buchungsintegration:

```json
{
  "id": "balayage",
  "category": "Farbe",
  "name": "Balayage",
  "description": "Individuelle Freihandtechnik inklusive Glossing",
  "durationMinutes": 180,
  "price": 220,
  "priceType": "from",
  "bookable": true
}
```

Bei einem hinterlegten Buchungslink ergänzt der Export `?service=<service-id>`.
