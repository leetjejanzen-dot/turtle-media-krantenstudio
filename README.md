# Turtle Media Krantenstudio

Een Windows-app waarmee Turtle Media professionele krantenpagina's voor een FiveM-server kan maken. De krantnaam, het logo en de kleuren blijven aanpasbaar voor hergebruik.

## Functies

- Eigen krantnaam, slogan, logo en kleuren
- Meerdere pagina's toevoegen, dupliceren, verwijderen en ordenen
- Kop, intro, artikel, auteur, locatie, foto en bijschrift
- Klassieke, moderne en tabloidvormgeving
- Projecten opslaan en opnieuw openen
- Automatisch lokaal herstel van de laatste versie
- Geselecteerde pagina exporteren naar hoge-resolutie PNG
- Alle pagina's bundelen in één printklare A4-PDF
- Veilige updates via GitHub Releases met SHA-256-controle
- Fourthwall-knop voor de officiële product- en downloadpagina
- Podcast Studio met losse sporen, waveform, volume, dempen, markers en 48 kHz WAV-export
- Ongecomprimeerde lokale 48 kHz-microfoonopname met expliciete toestemmingscontrole
- Optionele Discord Recorder voor afzonderlijke, gesynchroniseerde sprekersporen
- Kranten, afbeeldingen en lokale podcastopnames worden niet geüpload

## Ontwikkelen

```powershell
npm install
npm start
```

## Windows-versies bouwen

```powershell
npm run dist
```

De installer verschijnt in `release`. Maak daarna met `tools/prepare-release.ps1` een
bijbehorend `.sha256`-bestand en upload beide bestanden naar dezelfde GitHub Release.

Vul voor het bouwen `publisher-config.json` met de GitHub-repository (`eigenaar/repo`)
en de openbare Fourthwall-product-URL.

De Discord Recorder is bewust een losse serverdienst, zodat de geheime bottoken nooit
in de Windows-app terechtkomt. Zie `discord-recorder-service/README.md` voor installatie,
privacy en configuratie.
