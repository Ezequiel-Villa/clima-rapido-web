// ===== Utilidad: timeout para fetch con AbortController =====
function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const merged = { ...options, signal: controller.signal };
  return fetch(url, merged).finally(() => clearTimeout(id));
}

// ===== Una sola "sesión" de petición en curso para evitar carreras =====
let inFlight = { weather: null, forecast: null };

/* ==================== RELOJES ==================== */
// Timers globales (evita múltiples intervalos)
let localClockTimer = null;
let cityClockTimer = null;

/**
 * Inserta, si hace falta, un contenedor para el reloj local en el header
 * y retorna el elemento #clock-local. No rompe si ya existe.
 */
function ensureLocalClockMount() {
  // Busca el header de tu layout
  const header = document.querySelector('.header');
  if (!header) return null;

  // Crea contenedor derecho si no existe
  let right = header.querySelector('.header-right');
  if (!right) {
    right = document.createElement('div');
    right.className = 'header-right';
    // Empuja a la derecha manteniendo flex; tu CSS puede ya manejar esto
    right.style.marginLeft = 'auto';
    header.appendChild(right);
  }

  // Crea el chip del reloj local si no existe
  let clock = document.getElementById('clock-local');
  if (!clock) {
    clock = document.createElement('div');
    clock.id = 'clock-local';
    clock.className = 'clock';
    clock.title = 'Hora local';
    clock.textContent = '--:--:--';
    right.appendChild(clock);
  }
  return clock;
}

/** Inicia el reloj local (hora del navegador) */
function startLocalClock() {
  const el = document.getElementById('clock-local');
  if (!el) return;
  if (localClockTimer) return; // ya corriendo

  const tick = () => {
    el.textContent = new Date().toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };
  tick();
  localClockTimer = setInterval(tick, 1000);
}

/**
 * Inicia el reloj de la ciudad destino
 * tzOffsetSeconds: segundos de desplazamiento vs UTC (OpenWeather: campo "timezone")
 * Truco: sumamos el offset y renderizamos con timeZone='UTC' para no depender de tz IANA
 */
function startCityClock(tzOffsetSeconds) {
  const el = document.getElementById('clock-city');
  if (!el || !Number.isFinite(tzOffsetSeconds)) return;

  if (cityClockTimer) clearInterval(cityClockTimer);

  const tick = () => {
    const cityMs = Date.now() + tzOffsetSeconds * 1000;
    const d = new Date(cityMs);
    el.textContent = d.toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC'
    });
  };
  tick();
  cityClockTimer = setInterval(tick, 1000);
}
/* ================================================= */

/* ==================== CRUD Local (Historial) ==================== */
// Clave de localStorage
const LS_KEY = 'weather:history';

// Escapar nombres al renderizar (seguridad XSS)
function esc(s=''){
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// Carga y migra: si eran strings, conviértelo a objetos {name, pinned, ts}
function getHistory(){
  try{
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    let arr = Array.isArray(raw) ? raw : [];
    if (arr.length && typeof arr[0] === 'string'){
      const now = Date.now();
      arr = arr.map((name, i) => ({ name, pinned:false, ts: now - i }));
    } else {
      arr = arr.map(o => ({
        name: String(o?.name || '').trim(),
        pinned: Boolean(o?.pinned),
        ts: Number.isFinite(o?.ts) ? o.ts : Date.now()
      })).filter(o => o.name);
    }
    return arr;
  }catch{
    return [];
  }
}
function setHistory(arr){
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
}

// Insertar/actualizar (Create/Update): sube al tope y mantiene únicidad (case-insensitive)
function upsertCity(name){
  const normalized = name.trim();
  let arr = getHistory();
  const i = arr.findIndex(x => x.name.toLowerCase() === normalized.toLowerCase());
  const ts = Date.now();
  if (i >= 0){
    arr[i].name = normalized;    // por si cambió mayúsculas/minúsculas
    arr[i].ts = ts;              // recencia
  } else {
    arr.unshift({ name: normalized, pinned:false, ts });
  }
  // Orden: anclados primero por ts; luego no anclados por ts
  arr.sort((a,b) => (b.pinned - a.pinned) || (b.ts - a.ts));
  // Límite: guarda hasta 8
  arr = arr.slice(0, 8);
  setHistory(arr);
  return arr;
}

// Delete uno
function deleteCity(name){
  const arr = getHistory().filter(x => x.name.toLowerCase() !== name.toLowerCase());
  setHistory(arr);
  return arr;
}

// Clear todo
function clearHistoryAll(){
  setHistory([]);
  return [];
}

// Toggle pin (anclar/desanclar)
function togglePin(name){
  const arr = getHistory();
  const i = arr.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
  if (i >= 0){
    arr[i].pinned = !arr[i].pinned;
    arr[i].ts = Date.now();
    arr.sort((a,b) => (b.pinned - a.pinned) || (b.ts - a.ts));
    setHistory(arr);
  }
  return arr;
}

// Rename (con validación; recibe helpers de normalización/patrón)
function renameCity(oldName, normalizeFn, regex){
  const current = getHistory();
  const i = current.findIndex(x => x.name.toLowerCase() === oldName.toLowerCase());
  if (i < 0) return current;

  let nn = prompt('Nuevo nombre para la ciudad:', oldName);
  if (nn == null) return current;      // cancelado
  nn = normalizeFn(String(nn));
  if (!nn){
    alert('El nombre no puede estar vacío.'); return current;
  }
  if (nn.length > 80){
    alert('Máximo 80 caracteres.'); return current;
  }
  if (!regex.test(nn)){
    alert('Formato inválido. Ej.: "Tijuana" o "Tijuana, MX".');
    return current;
  }

  // Si ya existe con ese nombre (dup), fusiona: mantiene "pinned" si alguno lo estaba
  const j = current.findIndex(x => x.name.toLowerCase() === nn.toLowerCase());
  if (j >= 0 && j !== i){
    current[j].pinned = current[j].pinned || current[i].pinned;
    current[j].ts = Date.now();
    current.splice(i,1);
  } else {
    current[i].name = nn;
    current[i].ts = Date.now();
  }
  current.sort((a,b) => (b.pinned - a.pinned) || (b.ts - a.ts));
  setHistory(current);
  return current;
}
/* ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // Referencias a elementos del DOM
  const form = document.getElementById('form-weather');
  const city = document.getElementById('city');
  const units = document.getElementById('units');
  const lang = document.getElementById('lang');
  const resultEl = document.getElementById('result');
  const forecastEl = document.getElementById('forecast');
  const historyRoot = document.getElementById('history-root');
  const submitBtn = form?.querySelector('button[type="submit"]');
  const cityError = document.getElementById('city-error');

  if (!form || !city || !units || !lang || !resultEl || !forecastEl) return;

  // Monta e inicia el reloj local (en el header)
  ensureLocalClockMount();
  startLocalClock();

  // ======== Validación de inputs (cliente) ========

  const allowedUnits = new Set(['metric', 'imperial']);
  const allowedLangs = new Set(['es', 'en']);

  // Patrón permisivo para ciudades (con acentos, números, etc.) + opcional ", CC"
  const cityRegex = /^[\p{L}\p{M}0-9\s,'\.\-]{1,80}(,\s?[A-Za-z]{2})?$/u;

  function normalizeCity(value) {
    // Limpia espacios extra y normaliza coma + country code en mayúsculas
    let v = value.trim().replace(/\s+/g, ' ');
    v = v.replace(/,\s*([A-Za-z]{2})$/, (_, cc) => `, ${cc.toUpperCase()}`);
    return v;
  }

  function validateCityField() {
    const v = normalizeCity(city.value);
    city.value = v; // deja el valor normalizado
    let msg = '';
    if (!v) msg = 'Ingresa una ciudad.';
    else if (v.length > 80) msg = 'Máximo 80 caracteres.';
    else if (!cityRegex.test(v)) msg = 'Formato inválido. Ej.: "Tijuana" o "Tijuana, MX".';

    if (msg) {
      city.classList.add('invalid');
      city.setAttribute('aria-invalid', 'true');
      cityError.textContent = msg;
      cityError.style.display = 'block';
      return false;
    } else {
      city.classList.remove('invalid');
      city.removeAttribute('aria-invalid');
      cityError.textContent = '';
      cityError.style.display = 'none';
      return true;
    }
  }

  // Valida selects por si alguien manipula el DOM (seguridad mínima del lado cliente)
  function sanitizeSelects() {
    if (!allowedUnits.has(units.value)) units.value = 'metric';
    if (!allowedLangs.has(lang.value)) lang.value = 'es';
  }

  city.addEventListener('input', validateCityField);
  units.addEventListener('change', sanitizeSelects);
  lang.addEventListener('change', sanitizeSelects);

  // ======== Render de estados ========

  function renderLoading() {
    resultEl.innerHTML = `
      <div class="pop-in" style="display:flex; align-items:center; gap:10px;">
        <div class="spinner" aria-hidden="true"></div>
        <div class="muted">Consultando clima...</div>
      </div>
      <div class="skeleton skel-line tall" style="margin-top:12px;"></div>
      <div class="skeleton skel-line"></div>
      <div class="skeleton skel-line" style="width:70%;"></div>
    `;
    // Placeholder para el pronóstico
    forecastEl.innerHTML = `
      <div class="skeleton skel-line tall" style="margin-top:12px;"></div>
      <div class="skeleton skel-line"></div>
    `;
  }

  const unitLabel = u => (u === 'metric' ? 'C' : 'F');
  const windUnit = u => (u === 'metric' ? 'm/s' : 'mph');
  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s || '');

  /**
   * Pinta el resultado del clima actual.
   * Si el backend nos pasó tz_offset, agrega también la pildorita con la hora de la ciudad.
   */
  function renderResult(payload) {
    const r = payload.result;
    const unit = unitLabel(r.units);
    const wunit = windUnit(r.units);

    resultEl.innerHTML = `
      <div class="pop-in">
        <h2 style="margin:0 0 4px 0;">${r.city}</h2>
        <p style="margin:6px 0; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          ${r.icon ? `<img alt="icono clima" src="https://openweathermap.org/img/wn/${r.icon}@2x.png">` : ''}
          <strong style="font-size:1.35rem;">${r.temp}°${unit}</strong>
          <span class="kpi">${cap(r.desc)}</span>
          ${payload.from_cache ? `<span class="badge" style="margin-left:6px;">cache</span>` : ""}
          ${
            Number.isFinite(r.tz_offset)
              ? `<span class="kpi clock-pill" title="Hora en destino"><span class="dot">🕒</span> <span id="clock-city">--:--:--</span></span>`
              : ''
          }
        </p>
        <p class="muted">
          Sensación: <b>${r.feels_like}°${unit}</b> ·
          Humedad: <b>${r.humidity}%</b> ·
          Presión: <b>${r.pressure} hPa</b> ·
          Viento: <b>${r.wind_speed} ${wunit}</b>
        </p>
      </div>
    `;

    // Accesibilidad: enfoca el resultado al actualizar
    resultEl.focus?.();

    // Si tenemos offset horario, arranca el reloj de la ciudad
    if (Number.isFinite(r.tz_offset)) {
      startCityClock(r.tz_offset);
    }
  }

  function renderForecast(dataF) {
    const days = dataF.forecast5 || [];
    if (!days.length) {
      forecastEl.innerHTML = `<div class="muted">No hay pronóstico disponible.</div>`;
      return;
    }
    forecastEl.innerHTML = `
      <div class="forecast-grid">
        ${days.map(d => `
          <article class="forecast-card pop-in" tabindex="0" role="button" aria-label="Pronóstico para ${d.day}">
            <div class="day">${d.day}</div>
            ${d.icon ? `<img src="https://openweathermap.org/img/wn/${d.icon}@2x.png" alt="icono">` : ""}
            <div class="temps"><b>${d.temp_max}°</b> / ${d.temp_min}°</div>
            <div class="desc">${cap(d.desc)}</div>
            <div class="muted">Lluvia: ${Math.round((d.pop || 0) * 100)}%</div>
          </article>
        `).join('')}
      </div>
    `;
  }

  function renderError(message) {
    resultEl.innerHTML = `<div class="pop-in"><strong>Error:</strong> ${cap(message)}</div>`;
    forecastEl.innerHTML = '';
  }

  /* ==================== HISTORIAL: CRUD ==================== */

  // Create/Update al buscar
  function saveHistory(name){
    upsertCity(name);
    renderHistory();
  }

  // Read + acciones (Update/Delete/Clear)
  function renderHistory(){
    const list = getHistory();
    if (!historyRoot) return;

    if (!list.length){
      historyRoot.innerHTML = '';
      return;
    }

    historyRoot.innerHTML = `
      <div class="card pop-in history-card">
        <div class="history-top">
          <div class="muted">Búsquedas recientes</div>
          <button type="button" class="kpi clear-history-btn" title="Borrar historial">Borrar</button>
        </div>

        <div class="chip-list">
          ${list.map(o => `
            <span class="kpi hist-btn" role="button" tabindex="0" data-city="${esc(o.name)}">
              <span class="chip-name">${esc(o.name)}</span>
              <span class="chip-actions">
                <button type="button" class="chip-pin ${o.pinned ? 'pinned' : ''}" data-city="${esc(o.name)}" title="${o.pinned ? 'Desanclar' : 'Anclar'}">${o.pinned ? '★' : '☆'}</button>
                <button type="button" class="chip-edit" data-city="${esc(o.name)}" title="Renombrar">✎</button>
                <button type="button" class="chip-x" data-city="${esc(o.name)}" title="Eliminar">×</button>
              </span>
            </span>
          `).join('')}
        </div>
      </div>
    `;

    // Click en chip = buscar
    historyRoot.querySelectorAll('.hist-btn').forEach(chip => {
      chip.addEventListener('click', () => {
        city.value = chip.dataset.city || '';
        form.dispatchEvent(new Event('submit', { cancelable:true, bubbles:true }));
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          chip.click();
        }
      });
    });

    // Botón borrar uno
    historyRoot.querySelectorAll('.chip-x').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // evita disparar la búsqueda
        const name = btn.dataset.city || '';
        deleteCity(name);
        renderHistory();
      });
    });

    // Botón anclar / desanclar
    historyRoot.querySelectorAll('.chip-pin').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.city || '';
        togglePin(name);
        renderHistory();
      });
    });

    // Botón renombrar
    historyRoot.querySelectorAll('.chip-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const name = btn.dataset.city || '';
        renameCity(name, normalizeCity, cityRegex);
        renderHistory();
      });
    });

    // Borrar todo
    historyRoot.querySelector('.clear-history-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('¿Borrar todo el historial?')){
        clearHistoryAll();
        renderHistory();
      }
    });
  }

  // Pintar historial al cargar
  renderHistory();

  // ======== Submit AJAX (sin recarga) ========
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); // Evita recarga
    sanitizeSelects();

    // Valida campo ciudad antes de llamar al backend
    if (!validateCityField()) return;

    const q = city.value.trim();
    const payload = { city: q, units: units.value, lang: lang.value };

    // Deshabilita botón mientras consulta
    submitBtn.disabled = true;
    const original = submitBtn.querySelector('.btn-label').textContent;
    submitBtn.querySelector('.btn-label').textContent = 'Consultando...';

    renderLoading();

    try {
      // Si había una petición en curso, la cancelamos por cortesía (AbortController por timeout ya se usa)
      inFlight.weather?.abort?.();

      // Llamada a /api/weather (clima actual)
      const weatherController = new AbortController();
      inFlight.weather = weatherController;

      const resp = await fetchWithTimeout('/api/weather', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: weatherController.signal
      }, 10000);

      const data = await resp.json();
      if (!resp.ok || data.error) {
        renderError(data.error || 'No se pudo consultar el clima.');
        return;
      }
      renderResult(data);
      saveHistory(q); // <-- Create/Update

      // Llamada a /api/forecast (pronóstico 5 días)
      inFlight.forecast?.abort?.();
      const forecastController = new AbortController();
      inFlight.forecast = forecastController;

      const respF = await fetchWithTimeout('/api/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: forecastController.signal
      }, 10000);

      const dataF = await respF.json();
      if (!respF.ok || dataF.error) {
        // Si falla el pronóstico, al menos deja el clima actual
        forecastEl.innerHTML = `<div class="muted">No se pudo cargar el pronóstico.</div>`;
        return;
      }
      renderForecast(dataF);

    } catch (err) {
      // Manejo de abort/timeout y otros errores de red
      const msg = (err && err.name === 'AbortError') ? 'La solicitud se canceló o demoró demasiado.'
                : (err && err.message) || 'Error de red.';
      renderError(msg);
    } finally {
      submitBtn.disabled = false;
      submitBtn.querySelector('.btn-label').textContent = original;
    }
  });

  // ===== Accesibilidad: Enter en inputs dispara submit con validación =====
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (form && ['city', 'units', 'lang'].includes(document.activeElement?.id)) {
        e.preventDefault();
        form.requestSubmit?.();
      }
    }
  });
});


