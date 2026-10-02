# Turtle Media Discord Recorder

Deze losse serverdienst koppelt Discord-calls aan de Podcast Studio. De Windows-app bevat nooit de geheime bottoken.

## Werking

1. De gebruiker voegt de bot toe vanuit Turtle Media.
2. De app maakt een tijdelijke sessiecode.
3. Een gebruiker in de voicecall voert `/podcast start code:CODE` uit.
4. Iedere deelnemer geeft zelf toestemming met `/podcast consent`.
5. De bot bewaart iedere toestemmende spreker als een apart, synchroon 48 kHz WAV-spoor.
6. Na `/podcast stop` haalt de app de sporen op.

Discord levert voice-audio als Opus. Losse sporen voorkomen kwaliteitsverlies door een vooraf gemixte call en maken volume- en montagecorrecties per persoon mogelijk. Voor de allerbeste presentatorstem blijft de lokale microfoonopname in de app aanbevolen.

## Configuratie

- Node.js 22.12 of nieuwer.
- Maak een Discord-applicatie met bot aan en activeer geen extra privileged intents.
- Geef de bot alleen `View Channels`, `Connect`, `Use Voice Activity` en `Use Application Commands`.
- Vul de omgevingsvariabelen uit `.env.example` in via de procesmanager of hostingomgeving.
- Zet HTTPS-reverse-proxying voor `PUBLIC_BASE_URL` voor de API.
- Vul daarna `discordRecorder.clientId` en `discordRecorder.apiBaseUrl` in de `publisher-config.json` van de app-build in.

Kopieer `.env.example` naar `.env`, installeer met `npm install` en start met `npm start`.
Op Linux kan deze dienst als een afzonderlijk systemd- of Docker-proces draaien.

## Privacy

De bot neemt nooit automatisch iedereen op: alleen stemmen van gebruikers die tijdens de actieve sessie zelf `/podcast consent` uitvoeren worden opgeslagen. De startmelding benoemt dit zichtbaar in het kanaal. Opnames blijven op de eigen recorderhost en dienen volgens het beleid van het mediabedrijf te worden verwijderd wanneer ze niet meer nodig zijn.

> Let op: ontvangen van voice-audio wordt door `@discordjs/voice` ondersteund, maar Discord documenteert het ontvangen van audio niet als officiële stabiele bot-API. De recorder moet daarom na Discord- of library-updates opnieuw worden getest.
