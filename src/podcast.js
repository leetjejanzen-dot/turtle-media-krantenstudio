(() => {
  const get = id => document.getElementById(id);
  const tracks = [], markers = [];
  let context, activeSources = [], playing = false, position = 0, startedAt = 0, animationFrame = 0;
  let microphoneStream, microphoneSource, microphoneProcessor, microphoneSink, micChunks = [], micStartedAt = 0, micClock;
  let recorderConfig = { configured: false, clientId: '', apiBaseUrl: '' }, discordSession = null;

  const notify = message => {
    const element = get('toast'); if (!element) return;
    element.textContent = message; element.classList.add('show'); clearTimeout(notify.timer);
    notify.timer = setTimeout(() => element.classList.remove('show'), 3000);
  };
  const formatTime = (seconds, milliseconds = false) => {
    const safe = Math.max(0, Number(seconds) || 0), minutes = Math.floor(safe / 60), rest = safe - minutes * 60;
    return milliseconds ? `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}` : `${String(minutes).padStart(2, '0')}:${String(Math.floor(rest)).padStart(2, '0')}`;
  };
  const audibleDuration = track => Math.max(.001, track.buffer.duration - track.trimStart - track.trimEnd);
  const trackEnd = track => track.offset + audibleDuration(track);
  const projectDuration = () => tracks.reduce((max, track) => Math.max(max, trackEnd(track)), 0);
  const ensureContext = () => context || (context = new AudioContext({ sampleRate: 48000 }));
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

  function clampTrack(track) {
    const maxTrim = Math.max(0, track.buffer.duration - .01);
    track.offset = Math.max(0, Number(track.offset) || 0);
    track.trimStart = Math.min(maxTrim, Math.max(0, Number(track.trimStart) || 0));
    track.trimEnd = Math.min(maxTrim - track.trimStart, Math.max(0, Number(track.trimEnd) || 0));
    const duration = audibleDuration(track);
    track.fadeIn = Math.min(duration, Math.max(0, Number(track.fadeIn) || 0));
    track.fadeOut = Math.min(duration, Math.max(0, Number(track.fadeOut) || 0));
  }
  async function decodeAudio(blob) { return ensureContext().decodeAudioData((await blob.arrayBuffer()).slice(0)); }
  function drawWaveform(canvas, track) {
    const ratio = Math.max(1, devicePixelRatio || 1), width = Math.max(1, Math.floor(canvas.clientWidth * ratio)), height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    canvas.width = width; canvas.height = height;
    const graphics = canvas.getContext('2d'), channel = track.buffer.getChannelData(0);
    const startSample = Math.floor(track.trimStart * track.buffer.sampleRate), endSample = Math.min(channel.length, Math.ceil((track.buffer.duration - track.trimEnd) * track.buffer.sampleRate));
    const step = Math.max(1, Math.floor((endSample - startSample) / width)), gradient = graphics.createLinearGradient(0, 0, width, 0);
    const colors = track.kind === 'sfx' ? ['#f0a36c', '#ed6e9c'] : ['#56d2c5', '#8c7ee7'];
    gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]); graphics.strokeStyle = gradient; graphics.lineWidth = ratio; graphics.beginPath();
    for (let x = 0; x < width; x++) {
      const start = startSample + x * step, end = Math.min(endSample, start + step); let min = 1, max = -1;
      for (let index = start; index < end; index++) { min = Math.min(min, channel[index]); max = Math.max(max, channel[index]); }
      graphics.moveTo(x, (1 + min) * height / 2); graphics.lineTo(x, (1 + max) * height / 2);
    }
    graphics.stroke();
  }
  function updatePlayheads() {
    const duration = projectDuration(), left = duration ? Math.min(100, position / duration * 100) : 0;
    document.querySelectorAll('.track-playhead').forEach(element => { element.style.left = `${left}%`; });
  }
  function renderRuler() {
    const host = get('timelineRuler'), duration = projectDuration(); host.innerHTML = ''; if (!duration) return;
    const steps = Math.min(10, Math.max(4, Math.ceil(duration / 15)));
    for (let index = 0; index <= steps; index++) { const tick = document.createElement('span'); tick.style.left = `${index / steps * 100}%`; tick.textContent = formatTime(duration * index / steps); host.appendChild(tick); }
  }
  function renderMarkers() {
    const host = get('podcastMarkers'), duration = projectDuration(); host.innerHTML = ''; if (!duration) return;
    markers.forEach((marker, index) => { const element = document.createElement('span'); element.className = 'podcast-marker'; element.style.left = `${marker.time / duration * 100}%`; element.dataset.label = `Marker ${index + 1} · ${formatTime(marker.time)}`; host.appendChild(element); });
  }
  function sliceBuffer(buffer, startSeconds, endSeconds) {
    const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate)), end = Math.min(buffer.length, Math.ceil(endSeconds * buffer.sampleRate));
    const result = ensureContext().createBuffer(buffer.numberOfChannels, Math.max(1, end - start), buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) result.copyToChannel(buffer.getChannelData(channel).subarray(start, end), channel);
    return result;
  }
  function splitTrack(track) {
    if (position <= track.offset + .01 || position >= trackEnd(track) - .01) return notify('Zet de afspeelkop binnen deze clip om te splitsen');
    stopPlayback(false);
    const at = track.trimStart + position - track.offset, base = { source: track.source, kind: track.kind, volume: track.volume, muted: track.muted, liveGain: null, trimStart: 0, trimEnd: 0 };
    const left = sliceBuffer(track.buffer, track.trimStart, at), right = sliceBuffer(track.buffer, at, track.buffer.duration - track.trimEnd), index = tracks.indexOf(track);
    tracks.splice(index, 1,
      { ...base, id: crypto.randomUUID(), name: `${track.name} A`, buffer: left, offset: track.offset, fadeIn: track.fadeIn, fadeOut: 0 },
      { ...base, id: crypto.randomUUID(), name: `${track.name} B`, buffer: right, offset: position, fadeIn: 0, fadeOut: track.fadeOut });
    renderTracks(); updateTimeline(); notify(`Clip gesplitst op ${formatTime(position, true)}`);
  }
  function bindNumber(row, selector, track, property) {
    row.querySelector(selector).addEventListener('change', event => { stopPlayback(false); track[property] = Number(event.target.value); clampTrack(track); position = Math.min(position, projectDuration()); renderTracks(); updateTimeline(); });
  }
  function enableDragging(clip, lane, track) {
    clip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return; event.preventDefault(); stopPlayback(false);
      const duration = Math.max(.001, projectDuration()), originX = event.clientX, origin = track.offset; clip.classList.add('dragging');
      const move = moveEvent => { track.offset = Math.max(0, origin + (moveEvent.clientX - originX) / Math.max(1, lane.clientWidth) * duration); clip.style.left = `${track.offset / Math.max(duration, trackEnd(track)) * 100}%`; updateTimeline(); };
      const end = () => { clip.classList.remove('dragging'); window.removeEventListener('pointermove', move); renderTracks(); updateTimeline(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', end, { once: true });
    });
  }
  function renderTracks() {
    const host = get('podcastTracks'), duration = Math.max(.001, projectDuration()); host.innerHTML = ''; get('podcastEmpty').hidden = tracks.length > 0;
    tracks.forEach(track => {
      clampTrack(track); const row = document.createElement('article'); row.className = `podcast-track kind-${track.kind}`;
      const left = Math.min(100, track.offset / duration * 100), width = Math.max(1.5, audibleDuration(track) / duration * 100);
      row.innerHTML = `<div class="track-controls">
        <div class="track-title-row"><span class="track-kind">${escapeHtml(track.kind.toUpperCase())}</span><strong title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</strong></div>
        <small>${escapeHtml(track.source)} · ${formatTime(audibleDuration(track))}</small>
        <div class="track-buttons"><button class="track-mute${track.muted ? ' active' : ''}" type="button">${track.muted ? 'Gedempt' : 'Dempen'}</button><button class="track-split" type="button">Splitsen</button><button class="track-delete" type="button">Verwijder</button></div>
        <label class="track-slider">Volume <b>${Math.round(track.volume * 100)}%</b><input class="track-volume" type="range" min="0" max="1.5" step="0.01" value="${track.volume}"></label>
        <div class="track-fields"><label>Start<input class="track-offset" type="number" min="0" step="0.1" value="${track.offset.toFixed(2)}"></label><label>Trim in<input class="track-trim-start" type="number" min="0" step="0.1" value="${track.trimStart.toFixed(2)}"></label><label>Trim uit<input class="track-trim-end" type="number" min="0" step="0.1" value="${track.trimEnd.toFixed(2)}"></label><label>Fade in<input class="track-fade-in" type="number" min="0" step="0.1" value="${track.fadeIn.toFixed(2)}"></label><label>Fade uit<input class="track-fade-out" type="number" min="0" step="0.1" value="${track.fadeOut.toFixed(2)}"></label></div>
      </div><div class="track-lane"><div class="track-clip" style="left:${left}%;width:${Math.min(100 - left, width)}%"><canvas class="waveform"></canvas><span class="clip-name">${escapeHtml(track.name)}</span><span class="fade-shade fade-in" style="width:${Math.min(50, track.fadeIn / audibleDuration(track) * 100)}%"></span><span class="fade-shade fade-out" style="width:${Math.min(50, track.fadeOut / audibleDuration(track) * 100)}%"></span></div><span class="track-playhead"></span></div>`;
      row.querySelector('.track-mute').onclick = () => { track.muted = !track.muted; stopPlayback(true); renderTracks(); };
      row.querySelector('.track-split').onclick = () => splitTrack(track);
      row.querySelector('.track-delete').onclick = () => { stopPlayback(false); tracks.splice(tracks.indexOf(track), 1); position = Math.min(position, projectDuration()); renderTracks(); updateTimeline(); };
      row.querySelector('.track-volume').oninput = event => { track.volume = Number(event.target.value); row.querySelector('.track-slider b').textContent = `${Math.round(track.volume * 100)}%`; if (track.liveGain) track.liveGain.gain.value = track.muted ? 0 : track.volume; };
      bindNumber(row, '.track-offset', track, 'offset'); bindNumber(row, '.track-trim-start', track, 'trimStart'); bindNumber(row, '.track-trim-end', track, 'trimEnd'); bindNumber(row, '.track-fade-in', track, 'fadeIn'); bindNumber(row, '.track-fade-out', track, 'fadeOut');
      const lane = row.querySelector('.track-lane'); lane.ondblclick = event => { const box = lane.getBoundingClientRect(); position = Math.max(0, Math.min(projectDuration(), (event.clientX - box.left) / box.width * projectDuration())); updateTimeline(); };
      enableDragging(row.querySelector('.track-clip'), lane, track); host.appendChild(row); requestAnimationFrame(() => drawWaveform(row.querySelector('.waveform'), track));
    });
    updatePlayheads(); renderMarkers(); renderRuler();
  }
  function updateTimeline() {
    const duration = projectDuration(), seek = get('podcastSeek'); seek.max = String(Math.max(duration, .001)); seek.value = String(Math.min(position, duration));
    get('podcastCurrentTime').textContent = formatTime(position, true); get('podcastDuration').textContent = formatTime(duration, true); updatePlayheads(); renderMarkers(); renderRuler();
  }
  function addBuffer(buffer, name, source = 'Import', options = {}) {
    const track = { id: crypto.randomUUID(), name, source, kind: options.kind || 'voice', buffer, offset: Math.max(0, Number(options.offset) || 0), trimStart: 0, trimEnd: 0, fadeIn: Number(options.fadeIn) || 0, fadeOut: Number(options.fadeOut) || 0, volume: Number(options.volume ?? 1), muted: false, liveGain: null, remoteId: options.remoteId };
    clampTrack(track); tracks.push(track); renderTracks(); updateTimeline(); notify(`${name} toegevoegd op ${formatTime(track.offset, true)}`); return track;
  }
  async function addAudio(blob, name, source = 'Import', options = {}) { try { return addBuffer(await decodeAudio(blob), name, source, options); } catch (error) { console.error(error); notify(`${name} kon niet als audio worden geopend`); return null; } }
  async function importFiles(files, source, options) { for (const file of files) await addAudio(file, file.name.replace(/\.[^.]+$/, ''), source, options); }

  function gainFactorAt(track, time) {
    const local = time - track.offset, duration = audibleDuration(track); let factor = 1;
    if (track.fadeIn > 0) factor = Math.min(factor, Math.max(0, local / track.fadeIn));
    if (track.fadeOut > 0) factor = Math.min(factor, Math.max(0, (duration - local) / track.fadeOut)); return Math.max(0, Math.min(1, factor));
  }
  function automateGain(gain, track, playPosition, when, volume) {
    const end = trackEnd(track); gain.gain.setValueAtTime(volume * gainFactorAt(track, playPosition), when);
    const fadeInEnd = track.offset + track.fadeIn; if (track.fadeIn > 0 && fadeInEnd > playPosition) gain.gain.linearRampToValueAtTime(volume, when + fadeInEnd - playPosition);
    const fadeOutStart = end - track.fadeOut; if (track.fadeOut > 0 && end > playPosition) { if (fadeOutStart > playPosition) gain.gain.setValueAtTime(volume, when + fadeOutStart - playPosition); gain.gain.linearRampToValueAtTime(0, when + end - playPosition); }
  }
  function frame() { if (!playing) return; position = Math.min(projectDuration(), ensureContext().currentTime - startedAt); updateTimeline(); if (position >= projectDuration()) stopPlayback(false); else animationFrame = requestAnimationFrame(frame); }
  async function startPlayback() {
    if (!tracks.length || position >= projectDuration()) position = 0; const audio = ensureContext(); await audio.resume(); activeSources = [];
    for (const track of tracks) {
      if (position >= trackEnd(track)) continue; const playPosition = Math.max(position, track.offset), when = audio.currentTime + playPosition - position;
      const source = audio.createBufferSource(), gain = audio.createGain(); source.buffer = track.buffer; automateGain(gain, track, playPosition, when, track.muted ? 0 : track.volume); source.connect(gain).connect(audio.destination);
      source.start(when, track.trimStart + playPosition - track.offset, trackEnd(track) - playPosition); track.liveGain = gain; activeSources.push(source);
    }
    playing = true; startedAt = audio.currentTime - position; get('podcastPlay').textContent = 'Ⅱ'; cancelAnimationFrame(animationFrame); animationFrame = requestAnimationFrame(frame);
  }
  function stopPlayback(keep = true) { if (playing && keep) position = Math.min(projectDuration(), ensureContext().currentTime - startedAt); activeSources.forEach(source => { try { source.stop(); } catch {} }); activeSources = []; tracks.forEach(track => { track.liveGain = null; }); playing = false; cancelAnimationFrame(animationFrame); get('podcastPlay').textContent = '▶'; updateTimeline(); }

  function encodeWav(buffer) {
    const channels = Math.min(2, buffer.numberOfChannels), length = buffer.length, bytes = new ArrayBuffer(44 + length * channels * 2), view = new DataView(bytes), sampleRate = buffer.sampleRate;
    const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, 36 + length * channels * 2, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, length * channels * 2, true);
    const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel)); let offset = 44;
    for (let sample = 0; sample < length; sample++) for (let channel = 0; channel < channels; channel++) { const value = Math.max(-1, Math.min(1, data[channel][sample])); view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2; }
    return new Uint8Array(bytes);
  }
  async function exportMix() {
    if (!tracks.length) return notify('Voeg eerst minimaal één audioclip toe'); stopPlayback(true); const sampleRate = 48000, duration = projectDuration(), offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
    tracks.forEach(track => { if (track.muted) return; const source = offline.createBufferSource(), gain = offline.createGain(); source.buffer = track.buffer; automateGain(gain, track, track.offset, track.offset, track.volume); source.connect(gain).connect(offline.destination); source.start(track.offset, track.trimStart, audibleDuration(track)); });
    get('podcastExport').disabled = true; get('podcastExport').textContent = 'Mix wordt opgebouwd…';
    try { const mix = await offline.startRendering(), result = await window.desktop.savePodcastAudio({ name: get('discordSessionName').value || 'turtle-media-podcast', bytes: encodeWav(mix) }); if (!result.canceled) notify('Volledige podcastmix als 48 kHz WAV opgeslagen'); }
    catch (error) { console.error(error); notify('De podcastmix kon niet worden geëxporteerd'); } finally { get('podcastExport').disabled = false; get('podcastExport').textContent = 'Mix exporteren'; }
  }
  function generateBeep() {
    const audio = ensureContext(), duration = .45, buffer = audio.createBuffer(1, Math.ceil(duration * audio.sampleRate), audio.sampleRate), channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index++) { const time = index / audio.sampleRate, envelope = Math.min(1, time / .012, (duration - time) / .025); channel[index] = Math.sin(2 * Math.PI * 1000 * time) * .32 * Math.max(0, envelope); }
    addBuffer(buffer, 'Censor-piep', 'Ingebouwd effect', { kind: 'sfx', offset: position, fadeIn: .01, fadeOut: .02 });
  }

  async function toggleMicrophone() {
    if (microphoneProcessor) {
      clearInterval(micClock); microphoneProcessor.disconnect(); microphoneSource.disconnect(); microphoneSink.disconnect(); microphoneStream?.getTracks().forEach(track => track.stop());
      const sampleRate = ensureContext().sampleRate, frames = micChunks.reduce((sum, chunk) => sum + chunk.length, 0), buffer = ensureContext().createBuffer(1, frames, sampleRate), channel = buffer.getChannelData(0); let offset = 0;
      micChunks.forEach(chunk => { channel.set(chunk, offset); offset += chunk.length; }); microphoneProcessor = microphoneSource = microphoneSink = null; get('toggleMicRecording').classList.remove('recording'); get('toggleMicRecording').querySelector('span').textContent = 'Opname starten'; addBuffer(buffer, `Microfoon ${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`, 'Lokale 48 kHz PCM-opname', { kind: 'voice' }); return;
    }
    if (!get('recordingConsent').checked) return notify('Bevestig eerst dat alle deelnemers van de opname weten');
    try { microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); const audio = ensureContext(); await audio.resume(); microphoneSource = audio.createMediaStreamSource(microphoneStream); microphoneProcessor = audio.createScriptProcessor(4096, 1, 1); microphoneSink = audio.createGain(); microphoneSink.gain.value = 0; micChunks = []; microphoneProcessor.onaudioprocess = event => micChunks.push(event.inputBuffer.getChannelData(0).slice()); microphoneSource.connect(microphoneProcessor); microphoneProcessor.connect(microphoneSink).connect(audio.destination); micStartedAt = Date.now(); get('toggleMicRecording').classList.add('recording'); get('toggleMicRecording').querySelector('span').textContent = 'Opname stoppen'; micClock = setInterval(() => { get('micRecordingTime').textContent = formatTime((Date.now() - micStartedAt) / 1000); }, 250); }
    catch (error) { console.error(error); notify('Microfoontoegang is nodig om lokaal op te nemen'); }
  }

  const apiUrl = path => `${recorderConfig.apiBaseUrl}${path}`;
  async function fetchJson(path, options = {}) { const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000); try { const response = await fetch(apiUrl(path), { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); if (!response.ok) throw new Error(`Recorder antwoordde met ${response.status}`); return response.json(); } finally { clearTimeout(timeout); } }
  function setDiscordStatus(kind, message) { const status = get('discordRecorderStatus'); status.className = `recorder-status${kind ? ` ${kind}` : ''}`; status.querySelector('span').textContent = message; }
  async function initializeRecorder() { try { recorderConfig = await window.desktop.getRecorderConfig(); get('installDiscordBot').disabled = !recorderConfig.clientId; get('createDiscordSession').disabled = !recorderConfig.apiBaseUrl; if (!recorderConfig.configured) return setDiscordStatus('', 'Recorder-bot wordt voorbereid'); const health = await fetchJson('/v1/health'); if (!health.ok) throw new Error(); setDiscordStatus('ready', 'Turtle Media Recorder is online'); } catch (error) { console.error(error); setDiscordStatus('error', 'Recorder tijdelijk niet bereikbaar'); } }
  async function createDiscordSession() { try { setDiscordStatus('', 'Opnamesessie aanmaken…'); discordSession = await fetchJson('/v1/sessions', { method: 'POST', body: JSON.stringify({ title: get('discordSessionName').value.trim() || 'Turtle Media Podcast' }) }); get('discordJoinCode').textContent = discordSession.joinCode; get('discordSessionInfo').hidden = false; get('syncDiscordTracks').disabled = false; setDiscordStatus('ready', 'Sessie klaar — start de bot in je call'); } catch (error) { console.error(error); setDiscordStatus('error', 'Sessie kon niet worden aangemaakt'); } }
  async function syncDiscordTracks() { if (!discordSession) return; try { const payload = await fetchJson(`/v1/sessions/${encodeURIComponent(discordSession.id)}/tracks`); let imported = 0; for (const remote of payload.tracks || []) { if (tracks.some(track => track.remoteId === remote.id)) continue; const response = await fetch(new URL(remote.downloadUrl, `${recorderConfig.apiBaseUrl}/`).toString()); if (!response.ok) throw new Error(); const added = await addAudio(await response.blob(), remote.displayName || remote.fileName || 'Discord-spreker', 'Discord-call', { kind: 'voice', remoteId: remote.id }); if (added) imported++; } notify(imported ? `${imported} nieuw(e) Discord-spoor/sporen geïmporteerd` : 'Alle Discord-sporen zijn al bijgewerkt'); } catch (error) { console.error(error); notify('Discord-sporen konden niet worden opgehaald'); } }

  ['podcastImport', 'podcastImportTop', 'podcastEmptyImport'].forEach(id => get(id).onclick = () => get('podcastFileInput').click());
  get('podcastFileInput').onchange = async event => { await importFiles([...event.target.files], 'Import', { kind: 'voice' }); event.target.value = ''; };
  get('podcastAddIntro').onclick = () => get('podcastIntroInput').click(); get('podcastIntroInput').onchange = async event => { if (event.target.files[0]) await importFiles([event.target.files[0]], 'Intro', { kind: 'intro', offset: 0, fadeIn: .35, fadeOut: .5 }); event.target.value = ''; };
  get('podcastAddOutro').onclick = () => get('podcastOutroInput').click(); get('podcastOutroInput').onchange = async event => { if (event.target.files[0]) await importFiles([event.target.files[0]], 'Outro', { kind: 'outro', offset: projectDuration(), fadeIn: .5, fadeOut: .8 }); event.target.value = ''; };
  get('podcastAddSfx').onclick = () => get('podcastSfxInput').click(); get('podcastSfxInput').onchange = async event => { await importFiles([...event.target.files], 'Soundeffect', { kind: 'sfx', offset: position, fadeIn: .02, fadeOut: .08 }); event.target.value = ''; };
  get('podcastAddBeep').onclick = generateBeep; get('podcastPlay').onclick = () => playing ? stopPlayback(true) : startPlayback(); get('podcastRewind').onclick = () => { stopPlayback(false); position = 0; updateTimeline(); };
  get('podcastSeek').oninput = event => { const resume = playing; stopPlayback(false); position = Number(event.target.value); updateTimeline(); if (resume) startPlayback(); };
  get('podcastAddMarker').onclick = () => { if (!tracks.length) return notify('Voeg eerst audio toe'); markers.push({ time: position }); renderMarkers(); notify(`Marker toegevoegd op ${formatTime(position, true)}`); };
  get('podcastDeleteMarker').onclick = () => { if (!markers.length) return notify('Er zijn nog geen markers'); markers.pop(); renderMarkers(); notify('Laatste marker verwijderd'); };
  get('podcastExport').onclick = exportMix; get('toggleMicRecording').onclick = toggleMicrophone; get('installDiscordBot').onclick = async () => { try { await window.desktop.openDiscordBotInvite(); } catch { notify('De Discord-bot is nog niet gepubliceerd'); } }; get('createDiscordSession').onclick = createDiscordSession; get('syncDiscordTracks').onclick = syncDiscordTracks;
  window.onresize = () => document.querySelectorAll('.podcast-track').forEach((row, index) => drawWaveform(row.querySelector('.waveform'), tracks[index]));

  if (new URLSearchParams(location.search).has('smoke-test')) window.__podcastSmoke = async () => {
    const rate = 48000, buffer = ensureContext().createBuffer(1, rate / 2, rate), channel = buffer.getChannelData(0); for (let index = 0; index < channel.length; index++) channel[index] = Math.sin(2 * Math.PI * 220 * index / rate) * .2;
    const track = addBuffer(buffer, 'Stemtest', 'Automatische test', { kind: 'voice', offset: .25, fadeIn: .05, fadeOut: .05 }); position = .1; generateBeep(); const wav = encodeWav(buffer); await startPlayback(); await new Promise(resolve => setTimeout(resolve, 80)); stopPlayback(true);
    return { trackCount: tracks.length, duration: projectDuration(), playbackAdvanced: position > .12, wavBytes: wav.byteLength, wavHeader: String.fromCharCode(...wav.slice(0, 4)), editing: track.offset === .25 && tracks.some(item => item.kind === 'sfx') };
  };
  updateTimeline(); initializeRecorder();
})();
