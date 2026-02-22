# Účtovníctvo s.r.o.

Webová aplikácia na nahrávanie účtovných dokladov a vedenie jednoduchého účtovníctva pre s.r.o.

## Funkcie

- **Nahrávanie dokladov** - upload PDF, JPG, PNG súborov
- **Kategorizácia** - preddefinované kategórie s prednastavenými účtami MD a D
- **Účtovný denník** - automatické aj manuálne zápisy
- **Archív denníkov** - nahrávanie PDF účtovných denníkov z minulých rokov
- **Prehľad** - výnosy, náklady, výsledok hospodárenia

## Preddefinované kategórie

Aplikácia obsahuje preddefinované účtovné kategórie pre bežné operácie s.r.o.:
- Prijaté faktúry (materiál, služby, energia, opravy, cestovné, reprezentácia)
- Vydané faktúry (tovar, služby, výrobky)
- Pokladňa (príjem, výdaj)
- Banka (príjem, výdaj dodávateľom, dane, poistné)
- Mzdy (hrubé mzdy, odvody, výplata)
- Odpisy (hmotný a nehmotný majetok)
- DPH (vstup, výstup)
- Daň z príjmov

## Spustenie

```bash
npm install
npm start
```

Aplikácia beží na `http://localhost:3000`

## Technológie

- Node.js + Express
- SQLite (better-sqlite3)
- Vanilla HTML/CSS/JS frontend
