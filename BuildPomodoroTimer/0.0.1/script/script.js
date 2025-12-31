(() => {
  'use strict';

  /* ---------- CONFIG & STATE ---------- */
  const STORAGE_KEY = 'pomodoroSettings_v1';
  const defaults = { total: 4, work: 25, short: 5, longEvery: 4, long: 15 };

  // DOM (verifica elementi)
  const btnOpen = document.getElementById('btn-set-timer');
  const dropdown = document.getElementById('timer-dropdown');
  const form = document.getElementById('timer-dropdown-form');
  const btnSave = document.getElementById('td-save');
  const btnCancel = document.getElementById('td-cancel');

  const display = document.getElementById('main-display-time');
  const btnStart = document.getElementById('btn-start');
  const btnStop  = document.getElementById('btn-stop');
  const btnReset = document.getElementById('btn-reset');
  const sessionNumberEl = document.getElementById('session-number');
  const phaseStatusEl = document.getElementById('phase-status');

  // state
  let settings = loadSettings();
  let currentPomodoro = 1;          // 1-based index
  let isWork = true;                // true = work / false = break
  let remainingSeconds = settings.work * 60;
  let running = false;
  let rafId = null;
  let targetEnd = null;             // timestamp ms when current phase should end
  let lastPaint = 0;                // used to throttle DOM updates
  let endTimeoutId = null;          // fallback setTimeout id

  /* ---------- AUDIO: file mp3 + WebAudio fallback ---------- */
  // METTI IL TUO FILE MP3 QUI (percorso relativo alla pagina)
  const DEFAULT_AUDIO_SRC = './sound/alarm.mp3';

  const audioFile = new Audio();
  audioFile.preload = 'auto';
  audioFile.volume = 0.9;
  audioFile.src = DEFAULT_AUDIO_SRC;

  const audioCtx = (window.AudioContext || window.webkitAudioContext) ? new (window.AudioContext || window.webkitAudioContext)() : null;

  function playTone(freq, dur, when) {
    if(!audioCtx) return;
    const startWhen = (typeof when === 'number') ? when : audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(startWhen);
    g.gain.exponentialRampToValueAtTime(0.12, startWhen + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, startWhen + dur);
    o.stop(startWhen + dur + 0.02);
  }

  function playBeepPattern(){
    // try file first
    if(audioFile && audioFile.src){
      try{
        audioFile.currentTime = 0;
        const p = audioFile.play();
        if(p && typeof p.catch === 'function'){
          p.catch(() => {
            // fallback to WebAudio
            if(audioCtx){
              try {
                if(audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
                const now = audioCtx.currentTime;
                playTone(880, 0.10, now);
                playTone(660, 0.10, now + 0.18);
              } catch(e){ /* silent */ }
            }
          });
        }
        return;
      } catch(e){
        // continue to fallback
      }
    }
    // fallback
    if(audioCtx){
      try {
        if(audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
        const now = audioCtx.currentTime;
        playTone(880, 0.10, now);
        playTone(660, 0.10, now + 0.18);
      } catch(e){ /* silent */ }
    }
  }

  /* ---------- STORAGE ---------- */
  function loadSettings(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return Object.assign({}, defaults, raw ? JSON.parse(raw) : {});
    } catch (e) {
      return { ...defaults };
    }
  }
  function saveSettings(s){
    settings = Object.assign({}, s);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  /* ---------- NOTIFICATIONS & BACKGROUND ---------- */
  function requestNotificationPermissionIfNeeded(){
    if(!('Notification' in window)) return;
    if(Notification.permission === 'default'){
      Notification.requestPermission().then(permission => {
        // noop, permission stored by browser
      }).catch(()=>{});
    }
  }

  function showNotification(title, body){
    try {
      if('Notification' in window && Notification.permission === 'granted'){
        // If service worker registration available, prefer reg.showNotification for background reliability
        if(navigator.serviceWorker && navigator.serviceWorker.getRegistration){
          navigator.serviceWorker.getRegistration().then(reg => {
            if(reg && reg.showNotification){
              reg.showNotification(title, { body, tag: 'pomodoro', renotify: true });
            } else {
              new Notification(title, { body });
            }
          }).catch(()=> {
            new Notification(title, { body });
          });
        } else {
          new Notification(title, { body });
        }
      }
    } catch(e){ /* silent */ }
  }

  /* ---------- TIMING (precise) ---------- */
  function nowMs(){ return Date.now(); }

  function updateRemainingFromTarget(){
    if(!targetEnd) return;
    const msLeft = Math.max(0, targetEnd - nowMs());
    remainingSeconds = Math.ceil(msLeft / 1000);
  }

  function scheduleEndTimeout(){
    clearEndTimeout();
    if(!targetEnd) return;
    const ms = targetEnd - nowMs();
    if(ms <= 0){
      // target already passed -> call on next tick
      setTimeout(()=> {
        try { onPhaseEnd(); } catch(e){/*silent*/ }
      }, 0);
      return;
    }
    // clamp to safe setTimeout value if necessary
    const maxTimeout = 2147483647; // ~24.8 days
    const useMs = Math.min(ms, maxTimeout);
    endTimeoutId = setTimeout(()=> {
      // re-evaluate actual time left (in case of clamping)
      updateRemainingFromTarget();
      if(remainingSeconds <= 0){
        try { onPhaseEnd(); } catch(e){/*silent*/ }
      } else {
        // if still time left, reschedule
        // compute new target (shouldn't usually happen) and reschedule
        scheduleEndTimeout();
      }
    }, useMs);
  }

  function clearEndTimeout(){
    if(endTimeoutId){ clearTimeout(endTimeoutId); endTimeoutId = null; }
  }

  function startPhaseTimer(){
    // set targetEnd based on remainingSeconds (use ms)
    targetEnd = nowMs() + remainingSeconds * 1000;
    running = true;
    lastPaint = 0;
    scheduleTick();
    scheduleEndTimeout();
  }

  function scheduleTick(){
    if(rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function tick(ts){
    // throttle DOM updates to ~180-200ms to reduce repaints
    if(!lastPaint || (ts - lastPaint) > 180){
      updateRemainingFromTarget();
      repaint();
      lastPaint = ts;
    }
    if(running){
      if(remainingSeconds <= 0){
        // phase finished
        running = false;
        targetEnd = null;
        if(rafId) cancelAnimationFrame(rafId);
        rafId = null;
        clearEndTimeout();
        onPhaseEnd();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }
  }

  function repaint(){
  const formatted = formatTime(remainingSeconds);
  display.textContent = formatted;

  // Aggiorna il titolo della scheda
  const phase = isWork ? '💻' : '☕';
  document.title = `${phase} ${formatted} | Build`;
}


  function formatTime(sec){
    const mm = Math.floor(sec / 60).toString().padStart(2,'0');
    const ss = (sec % 60).toString().padStart(2,'0');
    return `${mm}:${ss}`;
  }

  /* ---------- PHASE MANAGEMENT ---------- */
  function updateLabels(){
    if(sessionNumberEl) sessionNumberEl.textContent = `Session: ${currentPomodoro}`;
    if(phaseStatusEl) phaseStatusEl.textContent = isWork ? 'Deep work' : 'Rest time';
  }

  function onPhaseEnd(){
    // notify + sound
    try { 
      // show notification if permitted
      const title = isWork ? 'Pomodoro finito' : 'Pausa finita';
      const body  = isWork ? `Session ${currentPomodoro} completata` : `Pausa terminata`;
      showNotification(title, body);
      playBeepPattern();
    } catch(e){ /* silent */ }

    // proceed to next phase
    if(isWork){
      // finished a work session -> go to break
      if(currentPomodoro % settings.longEvery === 0){
        remainingSeconds = settings.long * 60;
      } else {
        remainingSeconds = settings.short * 60;
      }
      isWork = false;
      updateLabels();
      // start new phase
      startPhaseTimer();
      dispatchPhaseEvent('break-start');
    } else {
      // finished a break -> next work session
      currentPomodoro++;
      if(currentPomodoro > settings.total){
        dispatchPhaseEvent('all-done');
        // keep final notification (already sent), then reset
        resetAll();
        return;
      }
      remainingSeconds = settings.work * 60;
      isWork = true;
      updateLabels();
      startPhaseTimer();
      dispatchPhaseEvent('work-start');
    }
  }

  function dispatchPhaseEvent(name){
    window.dispatchEvent(new CustomEvent('pomodoroPhase', { detail: { name, currentPomodoro, isWork, settings } }));
  }

  /* ---------- CONTROL APIs ---------- */
  function start(){
    // ensure audio context can play after a user gesture
    if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
    // request notification permission at first start attempt
    requestNotificationPermissionIfNeeded();

    if(running) return;
    // if targetEnd exists (resuming), compute remaining; else start new phase timer
    if(!targetEnd){
      // when starting fresh ensure remainingSeconds is set
      if(typeof remainingSeconds !== 'number' || remainingSeconds <= 0){
        remainingSeconds = isWork ? settings.work * 60 : (isWork ? settings.work * 60 : settings.short * 60);
      }
      startPhaseTimer();
    } else {
      // resume from previously set target
      running = true;
      scheduleTick();
      scheduleEndTimeout();
    }
    dispatchPhaseEvent('started');
  }

  function pause(){
    if(!running) return;
    updateRemainingFromTarget();
    running = false;
    if(rafId) { cancelAnimationFrame(rafId); rafId = null; }
    // clear scheduled timeout because we'll resume later
    clearEndTimeout();
    // clear targetEnd so state is consistent (remainingSeconds is authoritative)
    targetEnd = null;
    dispatchPhaseEvent('paused');
    repaint();
  }

  function resetAll(){
    if(rafId) { cancelAnimationFrame(rafId); rafId = null; }
    running = false;
    targetEnd = null;
    clearEndTimeout();
    currentPomodoro = 1;
    isWork = true;
    remainingSeconds = settings.work * 60;
    updateLabels();
    repaint();
    dispatchPhaseEvent('reset');
  }

  /* ---------- DROPDOWN UI ---------- */
  function openDropdown(){
    if(!dropdown || !form) return;
    dropdown.classList.add('open');
    dropdown.setAttribute('aria-hidden','false');
    btnOpen.setAttribute('aria-expanded','true');
    // populate
    form.elements['total'].value = settings.total;
    form.elements['work'].value = settings.work;
    form.elements['short'].value = settings.short;
    form.elements['longEvery'].value = settings.longEvery;
    form.elements['long'].value = settings.long;
    setTimeout(()=> form.elements['total'].focus(), 10);
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
  }

  function closeDropdown(){
    if(!dropdown) return;
    dropdown.classList.remove('open');
    dropdown.setAttribute('aria-hidden','true');
    btnOpen.setAttribute('aria-expanded','false');
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
    btnOpen.focus();
  }

  function onDocClick(e){
    if(!dropdown) return;
    if(dropdown.contains(e.target) || btnOpen.contains(e.target)) return;
    closeDropdown();
  }
  function onDocKey(e){
    if(e.key === 'Escape') closeDropdown();
    // focus trap (basic)
    if(e.key === 'Tab' && dropdown && dropdown.classList.contains('open')){
      const focusables = Array.from(dropdown.querySelectorAll('input,button')).filter(el => !el.disabled);
      if(!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
  }

  /* ---------- EVENTS ---------- */
  if(btnOpen) btnOpen.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if(dropdown && dropdown.classList.contains('open')) closeDropdown(); else openDropdown();
  });

  if(btnCancel) btnCancel.addEventListener('click', (e) => { e.preventDefault(); closeDropdown(); });

  if(btnSave) btnSave.addEventListener('click', (e) => {
    e.preventDefault();
    if(!form) return;
    const newSettings = {
      total: Math.max(1, parseInt(form.elements['total'].value) || defaults.total),
      work: Math.max(1, parseInt(form.elements['work'].value) || defaults.work),
      short: Math.max(1, parseInt(form.elements['short'].value) || defaults.short),
      longEvery: Math.max(2, parseInt(form.elements['longEvery'].value) || defaults.longEvery),
      long: Math.max(1, parseInt(form.elements['long'].value) || defaults.long)
    };
    saveSettings(newSettings);

    // clamp currentPomodoro
    if(currentPomodoro > settings.total) currentPomodoro = settings.total;

    // update remaining seconds if not running and current is work
    if(!running && isWork){
      remainingSeconds = settings.work * 60;
      repaint();
    }
    updateLabels();
    closeDropdown();
    window.dispatchEvent(new CustomEvent('pomodoroSettingsChanged', { detail: settings }));
  });

  if(btnStart) btnStart.addEventListener('click', () => start());
  if(btnStop) btnStop.addEventListener('click', () => pause());
  if(btnReset) btnReset.addEventListener('click', () => resetAll());

  // expose a small API
  window.pomodoro = Object.assign(window.pomodoro || {}, {
    start, pause, reset: resetAll, getSettings: () => settings, saveSettings,
    // audio helpers
    setAudioSrc: (src) => { if(src) audioFile.src = src; audioFile.load(); },
    playSoundNow: () => playBeepPattern()
  });

  /* ---------- VISIBILITY: repaint/resync on visibilitychange ---------- */
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible'){
      // recalc remaining & repaint immediately
      updateRemainingFromTarget();
      if(remainingSeconds <= 0){
        // if missed due to throttling, run end handler
        try { onPhaseEnd(); } catch(e){/*silent*/ }
      } else {
        repaint();
      }
    }
  });

  /* ---------- INIT ---------- */
  function init(){
    settings = loadSettings();
    remainingSeconds = settings.work * 60;
    updateLabels();
    repaint();

    // resume audio ctx on first user interaction if possible
    const resumeAudioOnUserGesture = () => {
      if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
      document.body.removeEventListener('pointerdown', resumeAudioOnUserGesture);
      document.body.removeEventListener('keydown', resumeAudioOnUserGesture);
    };
    document.body.addEventListener('pointerdown', resumeAudioOnUserGesture, { once: true });
    document.body.addEventListener('keydown', resumeAudioOnUserGesture, { once: true });
  }

  init();

})();






/***************************LOFI*****************************/
/*
(() => {
  const LOFI_SRC = './sound/lofi.mp3'; // tuo file mp3 lofi

  const lofiAudio = new Audio(LOFI_SRC);
  lofiAudio.loop = true;
  lofiAudio.volume = 0.5;

  const btn = document.getElementById('lofi-toggle');
  const icon = document.getElementById('lofi-icon');
  const vol = document.getElementById('lofi-volume');

  let isPlaying = false;

  btn.addEventListener('click', () => {
    if (!isPlaying) {
      lofiAudio.play();
      icon.src = './img/pause.svg'; // cambia con l'icona pausa
      icon.alt = 'Pause icon';
      isPlaying = true;
    } else {
      lofiAudio.pause();
      icon.src = './img/play.svg'; // torna a play
      icon.alt = 'Play icon';
      isPlaying = false;
    }
  });

  vol.addEventListener('input', () => {
    lofiAudio.volume = parseFloat(vol.value);
  });
})();
*/
(() => {
  const LOFI_SRC = './sound/lofi.mp3';
  const lofiAudio = new Audio(LOFI_SRC);
  lofiAudio.loop = true;
  lofiAudio.volume = 0.5;

  const btn = document.getElementById('lofi-toggle');
  const icon = document.getElementById('lofi-icon');
  const vol = document.getElementById('lofi-volume');

  if(!btn || !vol || !icon){
    console.warn('lofi: missing elements', {btn, vol, icon});
    return;
  }

  let isPlaying = false;

  btn.addEventListener('click', async () => {
    try {
      if (!isPlaying) {
        await lofiAudio.play();
        icon.src = './img/pause.svg';
        icon.alt = 'Pause icon';
        isPlaying = true;
      } else {
        lofiAudio.pause();
        icon.src = './img/play.svg';

        icon.alt = 'Play icon';
        isPlaying = false;
      }
    } catch (err) {
      console.warn('lofi play blocked', err);
    }
  });

  // handler che effettua l'aggiornamento effettivo del volume
  const setVolume = v => {
    const value = Math.max(0, Math.min(1, parseFloat(v) || 0));
    lofiAudio.volume = value;
    console.log('lofi volume set to', value);
  };

  // eventi: input è il principale, ma aggiungiamo fallback
  vol.addEventListener('input', e => setVolume(e.target.value));
  vol.addEventListener('change', e => setVolume(e.target.value));
  vol.addEventListener('pointermove', e => { if (e.pressure !== 0) setVolume(e.target.value); });
  // touchmove fallback per alcuni browser
  vol.addEventListener('touchmove', e => { setVolume(e.target.value); }, { passive: true });

  // debug helper: abilita la classe outline se vuoi vedere l'area touch
  // document.getElementById('lofi-volume').classList.add('debug-outline');
})();





document.getElementById("scroll-lofi").addEventListener("click", () => {
  document.getElementById("lofi").scrollIntoView({
    behavior: "smooth"  // scroll fluido
  });
});

document.getElementById("scroll-report").addEventListener("click", () => {
  document.getElementById("contatti").scrollIntoView({
    behavior: "smooth"  // scroll fluido
  });
});


/*************dinamyc custom button******************** */

// Mappa dei temi e relative immagini da sostituire
const themes = {
  grey: {
    spheres: ["./img/s1.svg", "./img/s2.svg", "./img/s4.svg", "./img/s5.svg"],
    pc: "./img/pc.svg",
    note: "./img/note.svg",
    calendar: "./img/calendar.svg",
    clock: "./img/clock.svg",
    mail:"./img/mail.svg",
    insta:"./img/insta.svg",
    update:"./img/update.svg",
    //play:"./img/play.svg"

  },
  purple: {
    spheres: [
      "./img/viola/s1.svg",
      "./img/viola/s1.svg",
      "./img/viola/s1.svg",
      "./img/viola/s1.svg"
    ],
    pc: "./img/viola/pc.svg",
    note: "./img/viola/note.svg",
    calendar: "./img/viola/calendar.svg",
    clock: "./img/viola/clock.svg",
    mail:"./img/viola/mail.svg",
    insta:"./img/viola/insta.svg",
    update:"./img/viola/update.svg",
    //play:"./img/viola/play.svg"

  },
  gold: {
    spheres: [
      "./img/gold/s1.svg",
      "./img/gold/s1.svg",
      "./img/gold/s1.svg",
      "./img/gold/s1.svg"
    ],
    pc: "./img/gold/pc.svg",
    note: "./img/gold/note.svg",
    calendar: "./img/gold/calendar.svg",
    clock: "./img/gold/clock.svg",
    mail:"./img/gold/mail.svg",
    insta:"./img/gold/insta.svg",
    update:"./img/gold/update.svg",
    //play:"./img/gold/play.svg"

  }
};

// --- Funzione per applicare un tema ---
function applyTheme(theme) {
  const t = themes[theme];
  if (!t) return console.warn("Tema non trovato:", theme);

  // Aggiorna le sfere
  const spheres = document.querySelectorAll(".bg-sphere");
  spheres.forEach((sphere, i) => {
    if (t.spheres[i]) sphere.src = t.spheres[i];
  });

  // Funzione helper per aggiornare immagini desktop + mobile
  const updateIcons = (classBase, newSrc) => {
    document.querySelectorAll(`.${classBase}, .${classBase}-mob`).forEach(el => {
      el.src = newSrc;
    });
  };

  // Aggiorna tutte le icone desktop + mobile
  updateIcons("icon-pc", t.pc);
  updateIcons("icon-note", t.note);
  updateIcons("icon-calendar", t.calendar);
  updateIcons("icon-clock", t.clock);
  updateIcons("icon-mail", t.mail);
  updateIcons("icon-insta", t.insta);
  updateIcons("icon-update", t.update);
  //updateIcons("icon-play", t.play);


}

// --- Gestione del dropdown ---
const customBtn = document.querySelector("button:has(img[src*='custom'])") || 
                  document.querySelector("button:has(img[alt*='custom'])");

let dropdownMenu;

if (customBtn) {
  customBtn.addEventListener("click", () => {
    // Se il menu è già aperto, chiudilo
    if (dropdownMenu) {
      dropdownMenu.remove();
      dropdownMenu = null;
      return;
    }

    // Crea il menu
    dropdownMenu = document.createElement("div");
    dropdownMenu.className = "custom-dropdown";
    dropdownMenu.innerHTML = `
      <ul>
        <li data-color="grey" class="grey">Grey</li>
        <li data-color="purple" class="purple">Purple</li>
        <li data-color="gold" class="gold">Gold</li>
      </ul>
      <button id="custom-save">Save</button>
    `;

    customBtn.insertAdjacentElement("afterend", dropdownMenu);

    let selectedColor = null;
    dropdownMenu.querySelectorAll("li").forEach(li => {
      li.addEventListener("click", () => {
        dropdownMenu.querySelectorAll("li").forEach(l => l.classList.remove("selected"));
        li.classList.add("selected");
        selectedColor = li.dataset.color;
      });
    });

    dropdownMenu.querySelector("#custom-save").addEventListener("click", () => {
      if (selectedColor) {
        applyTheme(selectedColor);
        dropdownMenu.remove();
        dropdownMenu = null;
      }
    });
  });
}