(() => {
  const get = id => document.getElementById(id);
  const tracks = [];
  const markers = [];
  let context;
  let activeSources = [];
  let playing = false;
  let position = 0;
  let startedAt = 0;
  let animationFrame = 0;
  let microphoneStream;
  let microphoneSource;
  let microphoneProcessor;
  let microphoneSink;
  let micChunks = [];
  let micStartedAt = 0;
  let micClock;
  let recorderConfig = { configured: false, clientId: '', apiBaseUrl: '' };
  let discordSession = null;

  const notify = message => {
    const element = get('toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => element.classList.remove('show'), 3000);
  };

  const formatTime = (seconds, milliseconds = false) => {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    return milliseconds
      ? `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder)).padStart(2, '0')}`;
  };

  const projectDuration = () => tracks.reduce((maximum, track) => Math.max(maximum, track.buffer.duration), 0);

  const ensureContext = () => {
    if (!context) context = new AudioContext({ sampleRate: 48000 });
    return context;
  };

  async function decodeAudio(blob) {
    const bytes = await blob.arrayBuffer();
    return ensureContext().decodeAudioData(bytes.slice(0));
  }

  function drawWaveform(canvas, buffer) {
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    canvas.width = width;
    canvas.height = height;
    const graphics = canvas.getContext('2d');
    graphics.clearRect(0, 0, width, height);
    const gradient = graphics.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#56d2c5');
    gradient.addColorStop(1, '#8c7ee7');
    graphics.strokeStyle = gradient;
    graphics.lineWidth = Math.max(1, ratio);
    const channel = buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
    graphics.beginPath();
    for (let x = 0; x < width; x += 1) {
      const start = x * samplesPerPixel;
      const end = Math.min(channel.length, start + samplesPerPixel);
      let minimum = 1;
      let maximum = -1;
      for (let index = start; index < end; index += 1) {
        const value = channel[index];
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
      graphics.moveTo(x, (1 + minimum) * height / 2);
      graphics.lineTo(x, (1 + maximum) * height / 2);
    }
    graphics.stroke();
  }

  function updatePlayheads() {
    const duration = projectDuration();
    const percentage = duration ? Math.min(100, position / duration * 100) : 0;
    document.querySelectorAll('.track-playhead').forEach(element => { element.style.left = `${percentage}%`; });
  }

  function renderMarkers() {
    const host = get('podcastMarkers');
    host.innerHTML = '';
    const duration = projectDuration();
    if (!duration) return;
    markers.forEach((marker, index) => {
      const element = document.createElement('span');
      element.className = 'podcast-marker';
      element.style.left = `${marker.time / duration * 100}%`;
      element.dataset.label = `Marker ${index + 1} · ${formatTime(marker.time)}`;
      host.appendChild(element);
    });
  }

  function renderTracks() {
    const host = get('podcastTracks');
    host.innerHTML = '';
    get('podcastEmpty').hidden = tracks.length > 0;
    tracks.forEach(track => {
      const row = document.createElement('article');
      row.className = 'podcast-track';
      row.innerHTML = `
        <div class="track-controls">
          <strong title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</strong>
          <small>${escapeHtml(track.source)} · ${formatTime(track.buffer.duration)}</small>
          <div class="track-buttons"><button class="track-mute${track.muted ? ' active' : ''}" type="button">${track.muted ? 'Gedempt' : 'Dempen'}</button><button class="track-delete" type="button">Verwijder</button></div>
          <input class="track-volume" aria-label="Volume" type="range" min="0" max="1.5" step="0.01" value="${track.volume}">
        </div>
        <div class="waveform-wrap"><canvas class="waveform"></canvas><span class="track-playhead"></span></div>`;
      row.querySelector('.track-mute').addEventListener('click', () => {
        track.muted = !track.muted;
        stopPlayback(true);
        renderTracks();
      });
      row.querySelector('.track-delete').addEventListener('click', () => {
        stopPlayback(false);
        tracks.splice(tracks.indexOf(track), 1);
        position = Math.min(position, projectDuration());
        renderTracks();
        updateTimeline();
      });
      row.querySelector('.track-volume').addEventListener('input', event => {
        track.volume = Number(event.target.value);
        if (track.liveGain) track.liveGain.gain.value = track.muted ? 0 : track.volume;
      });
      host.appendChild(row);
      requestAnimationFrame(() => drawWaveform(row.querySelector('.waveform'), track.buffer));
    });
    updatePlayheads();
    renderMarkers();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  function updateTimeline() {
    const duration = projectDuration();
    const seek = get('podcastSeek');
    seek.max = String(Math.max(duration, 0.001));
    seek.value = String(Math.min(position, duration));
    get('podcastCurrentTime').textContent = formatTime(position, true);
    get('podcastDuration').textContent = formatTime(duration, true);
    updatePlayheads();
  }

  function addBuffer(buffer, name, source = 'Import') {
    tracks.push({ id: crypto.randomUUID(), name, source, buffer, volume: 1, muted: false, liveGain: null });
    renderTracks();
    updateTimeline();
    notify(`${name} toegevoegd als apart spoor`);
  }

  async function addAudio(blob, name, source = 'Import') {
    try {
      const buffer = await decodeAudio(blob);
      addBuffer(buffer, name, source);
    } catch (error) {
      console.error(error);
      notify(`${name} kon niet als audio worden geopend`);
    }
  }

  async function importFiles(files) {
    for (const file of files) await addAudio(file, file.name.replace(/\.[^.]+$/, ''), 'Import');
    get('podcastFileInput').value = '';
  }

  function frame() {
    if (!playing) return;
    position = Math.min(projectDuration(), ensureContext().currentTime - startedAt);
    updateTimeline();
    if (position >= projectDuration()) stopPlayback(false);
    else animationFrame = requestAnimationFrame(frame);
  }

  async function startPlayback() {
    if (!tracks.length || position >= projectDuration()) position = 0;
    const audio = ensureContext();
    await audio.resume();
    activeSources = [];
    for (const track of tracks) {
      if (position >= track.buffer.duration) continue;
      const source = audio.createBufferSource();
      const gain = audio.createGain();
      source.buffer = track.buffer;
      gain.gain.value = track.muted ? 0 : track.volume;
      source.connect(gain).connect(audio.destination);
      source.start(0, position);
      track.liveGain = gain;
      activeSources.push(source);
    }
    playing = true;
    startedAt = audio.currentTime - position;
    get('podcastPlay').textContent = 'Ⅱ';
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(frame);
  }

  function stopPlayback(keepPosition = true) {
    if (playing && keepPosition) position = Math.min(projectDuration(), ensureContext().currentTime - startedAt);
    activeSources.forEach(source => { try { source.stop(); } catch {} });
    activeSources = [];
    tracks.forEach(track => { track.liveGain = null; });
    playing = false;
    cancelAnimationFrame(animationFrame);
    get('podcastPlay').textContent = '▶';
    updateTimeline();
  }

  function encodeWav(buffer) {
    const channels = Math.min(2, buffer.numberOfChannels);
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const bytes = new ArrayBuffer(44 + length * channels * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + length * channels * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, length * channels * 2, true);
    const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
    let offset = 44;
    for (let sample = 0; sample < length; sample += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const value = Math.max(-1, Math.min(1, data[channel][sample]));
        view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
        offset += 2;
      }
    }
    return new Uint8Array(bytes);
  }

  async function exportMix() {
    if (!tracks.length) return notify('Voeg eerst minimaal één audiospoor toe');
    stopPlayback(true);
    const sampleRate = 48000;
    const duration = projectDuration();
    const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
    tracks.forEach(track => {
      if (track.muted) return;
      const source = offline.createBufferSource();
      const gain = offline.createGain();
      source.buffer = track.buffer;
      gain.gain.value = track.volume;
      source.connect(gain).connect(offline.destination);
      source.start(0);
    });
    get('podcastExport').disabled = true;
    get('podcastExport').textContent = 'Mix wordt opgebouwd…';
    try {
      const mix = await offline.startRendering();
      const result = await window.desktop.savePodcastAudio({ name: get('discordSessionName').value || 'turtle-media-podcast', bytes: encodeWav(mix) });
      if (!result.canceled) notify('Podcastmix als 48 kHz WAV opgeslagen');
    } catch (error) {
      console.error(error);
      notify('De podcastmix kon niet worden geëxporteerd');
    } finally {
      get('podcastExport').disabled = false;
      get('podcastExport').textContent = 'Mix exporteren';
    }
  }

  async function toggleMicrophone() {
    if (microphoneProcessor) {
      clearInterval(micClock);
      microphoneProcessor.disconnect();
      microphoneSource.disconnect();
      microphoneSink.disconnect();
      microphoneStream?.getTracks().forEach(track => track.stop());
      const sampleRate = ensureContext().sampleRate;
      const frameCount = micChunks.reduce((total, chunk) => total + chunk.length, 0);
      const buffer = ensureContext().createBuffer(1, frameCount, sampleRate);
      const channel = buffer.getChannelData(0);
      let offset = 0;
      micChunks.forEach(chunk => { channel.set(chunk, offset); offset += chunk.length; });
      microphoneProcessor = null;
      microphoneSource = null;
      microphoneSink = null;
      get('toggleMicRecording').classList.remove('recording');
      get('toggleMicRecording').querySelector('span').textContent = 'Opname starten';
      addBuffer(buffer, `Microfoon ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`, 'Lokale 48 kHz PCM-opname');
      return;
    }
    if (!get('recordingConsent').checked) return notify('Bevestig eerst dat alle deelnemers van de opname weten');
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const audio = ensureContext();
      await audio.resume();
      microphoneSource = audio.createMediaStreamSource(microphoneStream);
      microphoneProcessor = audio.createScriptProcessor(4096, 1, 1);
      microphoneSink = audio.createGain();
      microphoneSink.gain.value = 0;
      micChunks = [];
      microphoneProcessor.onaudioprocess = event => micChunks.push(event.inputBuffer.getChannelData(0).slice());
      microphoneSource.connect(microphoneProcessor);
      microphoneProcessor.connect(microphoneSink).connect(audio.destination);
      micStartedAt = Date.now();
      get('toggleMicRecording').classList.add('recording');
      get('toggleMicRecording').querySelector('span').textContent = 'Opname stoppen';
      micClock = setInterval(() => { get('micRecordingTime').textContent = formatTime((Date.now() - micStartedAt) / 1000); }, 250);
    } catch (error) {
      console.error(error);
      notify('Microfoontoegang is nodig om lokaal op te nemen');
    }
  }

  const apiUrl = path => `${recorderConfig.apiBaseUrl}${path}`;

  async function fetchJson(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(apiUrl(path), { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
      if (!response.ok) throw new Error(`Recorder antwoordde met ${response.status}`);
      return response.json();
    } finally { clearTimeout(timeout); }
  }

  function setDiscordStatus(kind, message) {
    const status = get('discordRecorderStatus');
    status.className = `recorder-status${kind ? ` ${kind}` : ''}`;
    status.querySelector('span').textContent = message;
  }

  async function initializeRecorder() {
    try {
      recorderConfig = await window.desktop.getRecorderConfig();
      get('installDiscordBot').disabled = !recorderConfig.clientId;
      get('createDiscordSession').disabled = !recorderConfig.apiBaseUrl;
      if (!recorderConfig.configured) {
        setDiscordStatus('', 'Recorder-bot wordt voorbereid');
        return;
      }
      const health = await fetchJson('/v1/health');
      if (!health.ok) throw new Error('Recorder niet gereed');
      setDiscordStatus('ready', 'Turtle Media Recorder is online');
    } catch (error) {
      console.error(error);
      setDiscordStatus('error', 'Recorder tijdelijk niet bereikbaar');
    }
  }

  async function createDiscordSession() {
    try {
      setDiscordStatus('', 'Opnamesessie aanmaken…');
      discordSession = await fetchJson('/v1/sessions', { method: 'POST', body: JSON.stringify({ title: get('discordSessionName').value.trim() || 'Turtle Media Podcast' }) });
      get('discordJoinCode').textContent = discordSession.joinCode;
      get('discordSessionInfo').hidden = false;
      get('syncDiscordTracks').disabled = false;
      setDiscordStatus('ready', 'Sessie klaar — start de bot in je call');
    } catch (error) {
      console.error(error);
      setDiscordStatus('error', 'Sessie kon niet worden aangemaakt');
    }
  }

  async function syncDiscordTracks() {
    if (!discordSession) return;
    try {
      const payload = await fetchJson(`/v1/sessions/${encodeURIComponent(discordSession.id)}/tracks`);
      let imported = 0;
      for (const remote of payload.tracks || []) {
        if (tracks.some(track => track.remoteId === remote.id)) continue;
        const url = new URL(remote.downloadUrl, `${recorderConfig.apiBaseUrl}/`).toString();
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Spoor downloaden mislukt (${response.status})`);
        const blob = await response.blob();
        const before = tracks.length;
        await addAudio(blob, remote.displayName || remote.fileName || 'Discord-spreker', 'Discord-call');
        if (tracks.length > before) {
          tracks[tracks.length - 1].remoteId = remote.id;
          imported += 1;
        }
      }
      notify(imported ? `${imported} nieuw(e) Discord-spoor/sporen geïmporteerd` : 'Alle Discord-sporen zijn al bijgewerkt');
    } catch (error) {
      console.error(error);
      notify('Discord-sporen konden niet worden opgehaald');
    }
  }

  ['podcastImport', 'podcastImportTop', 'podcastEmptyImport'].forEach(id => get(id).addEventListener('click', () => get('podcastFileInput').click()));
  get('podcastFileInput').addEventListener('change', event => importFiles([...event.target.files]));
  get('podcastPlay').addEventListener('click', () => playing ? stopPlayback(true) : startPlayback());
  get('podcastRewind').addEventListener('click', () => { stopPlayback(false); position = 0; updateTimeline(); });
  get('podcastSeek').addEventListener('input', event => {
    const wasPlaying = playing;
    stopPlayback(false);
    position = Number(event.target.value);
    updateTimeline();
    if (wasPlaying) startPlayback();
  });
  get('podcastAddMarker').addEventListener('click', () => {
    if (!tracks.length) return notify('Voeg eerst audio toe');
    markers.push({ time: position });
    renderMarkers();
    notify(`Marker toegevoegd op ${formatTime(position, true)}`);
  });
  get('podcastExport').addEventListener('click', exportMix);
  get('toggleMicRecording').addEventListener('click', toggleMicrophone);
  get('installDiscordBot').addEventListener('click', async () => {
    try { await window.desktop.openDiscordBotInvite(); } catch { notify('De Discord-bot is nog niet gepubliceerd'); }
  });
  get('createDiscordSession').addEventListener('click', createDiscordSession);
  get('syncDiscordTracks').addEventListener('click', syncDiscordTracks);
  window.addEventListener('resize', () => document.querySelectorAll('.podcast-track').forEach((row, index) => drawWaveform(row.querySelector('.waveform'), tracks[index].buffer)));

  if (new URLSearchParams(location.search).has('smoke-test')) {
    window.__podcastSmoke = async () => {
      const sampleRate = 48000;
      const buffer = ensureContext().createBuffer(1, sampleRate / 4, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < channel.length; index += 1) channel[index] = Math.sin(2 * Math.PI * 440 * index / sampleRate) * .2;
      addBuffer(buffer, 'Testtoon', 'Automatische test');
      const wav = encodeWav(buffer);
      await startPlayback();
      await new Promise(resolve => setTimeout(resolve, 80));
      stopPlayback(true);
      return {
        trackCount: tracks.length,
        duration: projectDuration(),
        playbackAdvanced: position > 0.02,
        wavBytes: wav.byteLength,
        wavHeader: String.fromCharCode(...wav.slice(0, 4))
      };
    };
  }

  updateTimeline();
  initializeRecorder();
})();
