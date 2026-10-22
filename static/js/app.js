/* Atmos weather dashboard — vanilla JS, no frontend secrets. */
"use strict";

const $ = (selector) => document.querySelector(selector);
const form = $("#searchForm");
const cityInput = $("#cityInput");
const searchButton = $("#searchButton");
const suggestionsBox = $("#suggestions");
const alertBox = $("#alertBox");
const offlineBar = $("#offlineBar");
const loading = $("#loading");
const weatherPanel = $("#weatherPanel");
const historyList = $("#historyList");
const historyMessage = $("#historyMessage");
const favList = $("#favList");
const favMessage = $("#favMessage");

const state = {
  unit: localStorage.getItem("atmos-unit") === "F" ? "F" : "C",
  data: null,
  selectedDay: 0,
  requestId: 0,
  searching: false,
  lastCity: localStorage.getItem("atmos-last-city") || "",
  historyCache: [],
  favoritesCache: [],
  suggestionIndex: -1,
};

/* ---------- small helpers (safe DOM only) ---------- */

function showError(message) {
  alertBox.textContent = message;
  alertBox.classList.remove("hidden");
}

function clearError() {
  alertBox.textContent = "";
  alertBox.classList.add("hidden");
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function isMissing(value) {
  return value === null || value === undefined || value === "" || Number.isNaN(Number(value));
}

function displayNumber(value, digits = 0) {
  return isMissing(value) ? "—" : Number(value).toFixed(digits);
}

function iconUrl(code) {
  const safe = String(code || "01d").replace(/[^a-z0-9]/gi, "").slice(0, 6) || "01d";
  return `https://openweathermap.org/img/wn/${encodeURIComponent(safe)}@2x.png`;
}

/* Temperatures from the API are always Celsius. Convert only for display. */
function toDisplayTemp(celsius) {
  if (isMissing(celsius)) return null;
  const c = Number(celsius);
  return state.unit === "F" ? (c * 9) / 5 + 32 : c;
}

function formatTemp(celsius, digits = 0) {
  const v = toDisplayTemp(celsius);
  return v === null ? "—" : v.toFixed(digits);
}

function unitSymbol() {
  return state.unit === "F" ? "°F" : "°C";
}

/* Signature micro-interaction: temperature counts to its new value
   instead of snapping. Falls back to instant set under reduced motion. */
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function animateTemperature(el, celsius) {
  const raw = toDisplayTemp(celsius);
  if (raw === null) { el.textContent = "—"; return; }
  const target = Math.round(raw * 10) / 10;
  const fromText = parseFloat(el.textContent);
  if (Number.isNaN(fromText) || reducedMotion.matches) {
    el.textContent = target.toFixed(1);
    return;
  }
  // Start from a value slightly above/below target so digits visibly roll.
  const from = Math.abs(target - fromText) < 0.5 ? fromText : fromText;
  const startTime = performance.now();
  const duration = 450;
  const ease = (t) => 1 - Math.pow(1 - t, 3); // ease-out cubic

  const step = (now) => {
    const p = Math.min((now - startTime) / duration, 1);
    el.textContent = (from + (target - from) * ease(p)).toFixed(1);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function windDirLabel(deg) {
  if (deg === null || deg === undefined || Number.isNaN(Number(deg))) return null;
  const points = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return points[Math.round(Number(deg) % 360 / 22.5) % 16];
}

function utcPlusOffset(offsetSeconds, timestampSeconds) {
  const baseMs = timestampSeconds === undefined ? Date.now() : timestampSeconds * 1000;
  return new Date(baseMs + Number(offsetSeconds || 0) * 1000);
}

function formatLocalTime(offsetSeconds, timestampSeconds, withSeconds = false) {
  if (timestampSeconds === null || timestampSeconds === undefined || timestampSeconds === "") return "—";
  const d = new Date((Number(timestampSeconds) + Number(offsetSeconds || 0)) * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });
}

function formatLocalDate(offsetSeconds, timestampSeconds) {
  let baseMs;
  if (timestampSeconds === null || timestampSeconds === undefined || timestampSeconds === "") {
    // No observation timestamp: show "now" in the location's timezone.
    baseMs = Date.now() + new Date().getTimezoneOffset() * 60000;
  } else {
    baseMs = Number(timestampSeconds) * 1000;
  }
  const d = new Date(baseMs + Number(offsetSeconds || 0) * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "UTC",
  });
}

function formatDayLabel(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("Network error. Check your connection and try again.");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) throw new Error(payload.error || "Request failed. Please try again.");
  return payload;
}

/* ---------- units + theme ---------- */

function applyUnit() {
  const isF = state.unit === "F";
  $("#unitC").classList.toggle("active", !isF);
  $("#unitF").classList.toggle("active", isF);
  $("#unitC").setAttribute("aria-pressed", String(!isF));
  $("#unitF").setAttribute("aria-pressed", String(isF));
  const sup = $("#tempUnit");
  if (sup) sup.textContent = unitSymbol();
  document.querySelectorAll(".mini-deg").forEach((el) => { el.textContent = "°"; });
  localStorage.setItem("atmos-unit", state.unit);
  if (state.data) renderWeather(state.data, { keepSelection: true });
  renderHistory(state.historyCache);
  renderFavorites(state.favoritesCache);
}

$("#unitC").addEventListener("click", () => { state.unit = "C"; applyUnit(); });
$("#unitF").addEventListener("click", () => { state.unit = "F"; applyUnit(); });

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === "light";
  $("#themeIconMoon").classList.toggle("hidden", light);
  $("#themeIconSun").classList.toggle("hidden", !light);
  localStorage.setItem("atmos-theme", theme);
}

$("#themeToggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});
applyTheme(localStorage.getItem("atmos-theme") === "light" ? "light" : "dark");

/* ---------- insights (transparent rule-based logic) ---------- */

function buildInsights(current, forecast) {
  const temp = Number(current.temperature);
  const humidity = Number(current.humidity);
  const wind = Number(current.wind_speed);
  const condition = String(current.condition || "");
  const desc = String(current.description || "");
  const maxPop = Math.max(0, ...(forecast || []).map((d) => Number(d.pop) || 0));

  const parts = [];
  if (!Number.isNaN(temp)) {
    if (temp >= 32) parts.push("very hot");
    else if (temp >= 27) parts.push("warm");
    else if (temp >= 18) parts.push("mild");
    else if (temp >= 8) parts.push("cool");
    else parts.push("cold");
  }
  if (!Number.isNaN(humidity) && humidity >= 75) parts.push("humid");
  else if (!Number.isNaN(humidity) && humidity <= 30) parts.push("dry");
  if (/rain|drizzle|thunderstorm/i.test(condition) || maxPop >= 50) parts.push("with rain likely");
  else if (/snow/i.test(condition)) parts.push("with snow");
  else if (/clear/i.test(condition)) parts.push("and clear");
  else if (/cloud/i.test(condition)) parts.push("and cloudy");
  if (!Number.isNaN(wind) && wind >= 30) parts.push("· strong wind");

  const summary = parts.length
    ? `${parts[0][0].toUpperCase()}${parts[0].slice(1)} ${parts.slice(1).join(" ")} today.`.replace(/\s+/g, " ").trim()
    : `Currently ${desc || "unavailable"}.`;

  const tips = [];
  if (!Number.isNaN(temp) && temp >= 30) tips.push("light breathable clothing, sunscreen and extra water");
  else if (!Number.isNaN(temp) && temp >= 20) tips.push("light layers and sun protection if you are out midday");
  else if (!Number.isNaN(temp) && temp >= 10) tips.push("a jacket or sweater for the cooler hours");
  else if (!Number.isNaN(temp)) tips.push("warm layers, and cover exposed skin");
  if (/rain|drizzle|thunderstorm/i.test(condition) || maxPop >= 50) tips.push("carry an umbrella or rain jacket");
  if (!Number.isNaN(wind) && wind >= 30) tips.push("secure loose items outdoors; expect gusty conditions");
  if (!Number.isNaN(humidity) && humidity >= 80) tips.push("ventilate indoor spaces where possible");
  if (!tips.length) tips.push("conditions look typical — plan normally");

  return { summary, tip: `Suggestion: ${tips.join("; ")}.` };
}

/* ---------- rendering ---------- */

function conditionKey(condition, icon) {
  const c = String(condition || "").toLowerCase();
  if (/thunderstorm/.test(c)) return "storm";
  if (/snow/.test(c)) return "snow";
  if (/rain|drizzle/.test(c)) return "rain";
  if (/mist|fog|haze|smoke|dust|sand|ash|squall|tornado/.test(c)) return "mist";
  if (/cloud/.test(c)) return "clouds";
  return "clear";
}

function renderHero(data) {
  const { location, current } = data;
  const offset = Number(location.timezone_offset || 0);

  setText("locationName", [location.name, location.state].filter(Boolean).join(", ") || "—");
  setText("locationMeta", [location.country,
    `${Number(location.lat).toFixed(2)}°`,
    `${Number(location.lon).toFixed(2)}°`].filter(Boolean).join("  ·  "));
  if (current.observed_at) {
    setText("locationTime", `${formatLocalDate(offset, current.observed_at)} · ${formatLocalTime(offset, current.observed_at)} local`);
    setText("topbarDate", `${formatLocalDate(offset, current.observed_at)} · ${formatLocalTime(offset, current.observed_at)} local`);
  } else {
    setText("locationTime", formatLocalDate(offset, undefined));
    setText("topbarDate", new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }));
  }

  animateTemperature($("#temperature"), current.temperature);
  const icon = $("#currentIcon");
  icon.src = iconUrl(current.icon);
  icon.alt = current.description || "Current weather";
  setText("condition", current.condition || "—");
  setText("description", current.description || "—");
  setText("highTemp", formatTemp(current.temp_max));
  setText("lowTemp", formatTemp(current.temp_min));
  setText("feelsLike", formatTemp(current.feels_like));
  setText("humidity", displayNumber(current.humidity));
  setText("humidityMetric", displayNumber(current.humidity));
  setText("windSpeed", isMissing(current.wind_speed) ? "—" : Number(current.wind_speed).toFixed(1));
  setText("pressure", displayNumber(current.pressure));
  setText("visibility", current.visibility == null ? "—" : (Number(current.visibility) / 1000).toFixed(1));
  setText("clouds", displayNumber(current.clouds));
  const dir = current.wind_dir || windDirLabel(current.wind_deg);
  setText("windDetail", isMissing(current.wind_speed) ? "—" : `${Number(current.wind_speed).toFixed(1)} km/h`);
  setText("windDirLabel", dir ? `from ${dir}` : "—");
  setText("sunrise", current.sunrise ? formatLocalTime(offset, current.sunrise) : "—");
  setText("sunset", current.sunset ? formatLocalTime(offset, current.sunset) : "—");

  if (current.observed_at) {
    const mins = Math.max(0, Math.round((Date.now() - current.observed_at * 1000) / 60000));
    const age = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} hr ago`;
    setText("updatedAt", `Observed ${formatLocalTime(offset, current.observed_at)} · updated ${age}`);
  } else {
    setText("updatedAt", "Live from OpenWeather");
  }

  const hero = $("#heroCard");
  hero.dataset.condition = conditionKey(current.condition, current.icon);
  hero.dataset.daynight = current.is_day === false || String(current.icon || "").endsWith("n") ? "night" : "day";

  const insights = buildInsights(current, data.forecast);
  setText("insightSummary", insights.summary);
  setText("insightTip", insights.tip);

  updateFavoriteButton();
}

function renderForecast(data) {
  const grid = $("#forecastGrid");
  grid.replaceChildren();
  const days = data.forecast || [];
  if (!days.length) {
    const empty = document.createElement("p");
    empty.className = "forecast-empty";
    empty.textContent = "Forecast unavailable for this search.";
    grid.appendChild(empty);
    return;
  }
  if (state.selectedDay >= days.length) state.selectedDay = 0;
  days.forEach((day, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `forecast-day${index === 0 ? " today" : ""}${index === state.selectedDay ? " selected" : ""}`;
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-pressed", String(index === state.selectedDay));
    card.setAttribute("aria-label", `${day.label} ${formatDayLabel(day.date)}: ${day.description || day.condition}, high ${formatTemp(day.temp_max)} degrees, low ${formatTemp(day.temp_min)} degrees`);

    const label = document.createElement("div");
    label.className = "day-label";
    label.textContent = index === 0 ? "Today" : (day.label || "—");

    const date = document.createElement("div");
    date.className = "day-date";
    date.textContent = formatDayLabel(day.date);

    const img = document.createElement("img");
    img.src = iconUrl(day.icon);
    img.alt = "";
    img.loading = "lazy";
    img.width = 54; img.height = 54;

    const cond = document.createElement("div");
    cond.className = "day-condition";
    cond.textContent = day.condition || "—";
    cond.title = day.description || day.condition || "";

    const temp = document.createElement("div");
    temp.className = "day-temp";
    temp.textContent = `${formatTemp(day.temperature)}°`;

    const range = document.createElement("div");
    range.className = "day-range";
    range.textContent = `${formatTemp(day.temp_min)}° / ${formatTemp(day.temp_max)}°`;

    const rain = document.createElement("div");
    rain.className = "rain-chance";
    rain.textContent = `Precip ${displayNumber(day.pop)}%`;

    card.append(label, date, img, cond, temp, range, rain);
    card.addEventListener("click", () => {
      state.selectedDay = index;
      renderForecast(state.data);
    });
    grid.appendChild(card);
  });
  renderHourly(data);
  drawChart(data);
}

function hourlyForSelectedDay(data) {
  const hourly = data.hourly || [];
  const days = data.forecast || [];
  const selected = days[state.selectedDay];
  if (!selected) return hourly.slice(0, 8);
  const matches = hourly.filter((h) => String(h.date || "").slice(0, 10) === selected.date);
  if (matches.length) return matches;
  // Fallback: hourly entries carry no matching date (older payloads).
  return hourly.slice(0, 8);
}

function renderHourly(data) {
  const strip = $("#hourlyStrip");
  strip.replaceChildren();
  const days = data.forecast || [];
  const selected = days[state.selectedDay];
  setText("hourlyDayLabel", selected ? `· ${selected.label} ${formatDayLabel(selected.date)}` : "");
  const items = hourlyForSelectedDay(data);
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "forecast-empty";
    empty.textContent = "Hourly data unavailable.";
    strip.appendChild(empty);
    return;
  }
  items.forEach((h, i) => {
    const cell = document.createElement("div");
    cell.className = `hour-cell${i === 0 ? " now" : ""}`;
    cell.setAttribute("role", "listitem");
    const time = document.createElement("div");
    time.className = "hour-time";
    time.textContent = i === 0 ? "Now" : (h.time || "—");
    const img = document.createElement("img");
    img.src = iconUrl(h.icon);
    img.alt = h.description || h.condition || "Hourly weather";
    img.loading = "lazy";
    img.width = 40; img.height = 40;
    const temp = document.createElement("div");
    temp.className = "hour-temp";
    temp.textContent = `${formatTemp(h.temperature)}°`;
    const pop = document.createElement("div");
    pop.className = "hour-pop";
    pop.textContent = `${displayNumber(h.pop)}%`;
    cell.append(time, img, temp, pop);
    cell.title = `${h.label || h.time || ""} · ${h.description || h.condition || ""} · precipitation ${displayNumber(h.pop)}%`;
    strip.appendChild(cell);
  });
}

function drawChart(data) {
  const canvas = $("#trendChart");
  if (!canvas || !data) return;
  const days = data.forecast || [];
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const height = 160;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const styles = getComputedStyle(document.documentElement);
  const lime = styles.getPropertyValue("--lime").trim() || "#7ee7c7";
  const muted = styles.getPropertyValue("--muted").trim() || "#9aa2c4";
  const gridColor = document.documentElement.dataset.theme === "light" ? "#e4e7f1" : "#222642";
  if (!days.length) {
    ctx.fillStyle = muted;
    ctx.font = "12px Manrope, sans-serif";
    ctx.fillText("No trend data", 12, 24);
    return;
  }
  const highs = days.map((d) => toDisplayTemp(d.temp_max));
  const lows = days.map((d) => toDisplayTemp(d.temp_min));
  const all = [...highs, ...lows].filter((v) => v !== null);
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const padL = 34, padR = 10, padT = 14, padB = 22;
  const x = (i) => padL + (i * (width - padL - padR)) / Math.max(days.length - 1, 1);
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (height - padT - padB);

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = muted;
  ctx.font = "10px 'DM Mono', monospace";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const v = min + ((max - min) * g) / 3;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(width - padR, yy);
    ctx.stroke();
    ctx.fillText(`${Math.round(v)}°`, 6, yy + 3);
  }

  // Low band fill
  ctx.beginPath();
  highs.forEach((v, i) => { const px = x(i), py = y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  [...lows].reverse().forEach((v, ri) => { ctx.lineTo(x(days.length - 1 - ri), y(v)); });
  ctx.closePath();
  ctx.fillStyle = document.documentElement.dataset.theme === "light" ? "rgba(13,143,116,.12)" : "rgba(126,231,199,.08)";
  ctx.fill();

  const line = (values, color, dashed) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash(dashed ? [4, 4] : []);
    values.forEach((v, i) => { const px = x(i), py = y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    values.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 3, 0, Math.PI * 2); ctx.fill(); });
  };
  line(highs, lime, false);
  line(lows, muted, true);

  ctx.fillStyle = muted;
  days.forEach((d, i) => {
    const label = i === state.selectedDay ? `● ${d.label}` : d.label;
    ctx.fillText(label || "", x(i) - 8, height - 6);
  });
  const note = $("#chartNote");
  if (note) note.textContent = `Daily highs & lows · ${unitSymbol()}`;
}

function renderWeather(data, options = {}) {
  if (!options.keepSelection) state.selectedDay = 0;
  renderHero(data);
  renderForecast(data);
  weatherPanel.classList.remove("hidden");
  if (data.history_warning) historyMessage.textContent = data.history_warning;
  else if (data.history_saved) historyMessage.textContent = "Search saved to MongoDB.";
}

/* ---------- search flow (stale-guard + single in-flight) ---------- */

async function searchCity(city, { fromHistory = false } = {}) {
  const cleaned = (city || "").trim();
  if (!cleaned) {
    showError("Enter a city name to search.");
    cityInput.focus();
    return;
  }
  if (state.searching) return; // prevent duplicate rapid requests
  state.searching = true;
  const myRequest = ++state.requestId;
  clearError();
  hideSuggestions();
  loading.classList.remove("hidden");
  searchButton.disabled = true;
  const label = searchButton.querySelector("span");
  const prevLabel = label ? label.textContent : "";
  if (label) label.textContent = "Searching…";
  try {
    const data = await fetchJson(`/api/weather?city=${encodeURIComponent(cleaned)}`);
    if (myRequest !== state.requestId) return; // stale response — ignore
    state.data = data;
    state.lastCity = data.location.name || cleaned;
    localStorage.setItem("atmos-last-city", state.lastCity);
    cityInput.value = state.lastCity;
    renderWeather(data);
    await loadHistory();
    await loadFavorites({ silent: true });
    if (!navigator.onLine) offlineBar.classList.remove("hidden");
  } catch (error) {
    if (myRequest !== state.requestId) return;
    showError(error.message || "Something went wrong. Please try again.");
    if (!navigator.onLine) offlineBar.classList.remove("hidden");
  } finally {
    if (myRequest === state.requestId) {
      loading.classList.add("hidden");
      searchButton.disabled = false;
      if (label) label.textContent = prevLabel || "Search weather";
      state.searching = false;
    }
  }
}

/* ---------- suggestions from MongoDB history ---------- */

function hideSuggestions() {
  suggestionsBox.replaceChildren();
  suggestionsBox.classList.add("hidden");
  cityInput.setAttribute("aria-expanded", "false");
  state.suggestionIndex = -1;
}

function showSuggestions(matches) {
  suggestionsBox.replaceChildren();
  matches.slice(0, 6).forEach((item, index) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "suggestion-item";
    opt.setAttribute("role", "option");
    opt.id = `suggestion-${index}`;
    const name = document.createElement("strong");
    name.textContent = [item.city, item.country].filter(Boolean).join(", ");
    const meta = document.createElement("small");
    meta.textContent = `${item.condition || "Recent"} · ${formatTemp(item.temperature)}°`;
    opt.append(name, meta);
    opt.addEventListener("click", () => {
      cityInput.value = item.city;
      hideSuggestions();
      searchCity(item.city);
    });
    suggestionsBox.appendChild(opt);
  });
  suggestionsBox.classList.remove("hidden");
  cityInput.setAttribute("aria-expanded", "true");
}

cityInput.addEventListener("input", () => {
  const q = cityInput.value.trim().toLowerCase();
  if (!q) { hideSuggestions(); return; }
  const matches = state.historyCache.filter((h) => String(h.city || "").toLowerCase().includes(q));
  if (!matches.length) { hideSuggestions(); return; }
  showSuggestions(matches);
});

cityInput.addEventListener("keydown", (event) => {
  const items = [...suggestionsBox.querySelectorAll(".suggestion-item")];
  if (suggestionsBox.classList.contains("hidden") || !items.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.suggestionIndex = (state.suggestionIndex + 1) % items.length;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.suggestionIndex = (state.suggestionIndex - 1 + items.length) % items.length;
  } else if (event.key === "Escape") {
    hideSuggestions();
    return;
  } else {
    return;
  }
  items.forEach((el, i) => {
    el.classList.toggle("focused", i === state.suggestionIndex);
    el.setAttribute("aria-selected", String(i === state.suggestionIndex));
  });
  if (state.suggestionIndex >= 0) cityInput.setAttribute("aria-activedescendant", `suggestion-${state.suggestionIndex}`);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-form")) hideSuggestions();
});

/* ---------- history ---------- */

function emptyHistory(message, hint) {
  historyList.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "history-empty";
  const p = document.createElement("p");
  p.textContent = message;
  const small = document.createElement("small");
  small.textContent = hint;
  empty.append(p, small);
  historyList.appendChild(empty);
}

function renderHistory(items) {
  state.historyCache = Array.isArray(items) ? items : [];
  historyList.replaceChildren();
  setText("historyCount", String(state.historyCache.length));
  if (!state.historyCache.length) {
    emptyHistory("Your searched cities will appear here.", "Search for a city to get started.");
    return;
  }
  state.historyCache.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.setAttribute("aria-label", `Search ${item.city} again`);

    const icon = document.createElement("span");
    icon.className = "history-weather-icon";
    const img = document.createElement("img");
    img.src = iconUrl(item.icon);
    img.alt = "";
    img.loading = "lazy";
    img.width = 39; img.height = 39;
    icon.appendChild(img);

    const info = document.createElement("span");
    info.className = "history-info";
    const name = document.createElement("strong");
    name.textContent = [item.city, item.state, item.country].filter(Boolean).join(", ") || item.city || "—";
    const meta = document.createElement("small");
    const when = item.searched_at
      ? new Date(item.searched_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "Recent search";
    meta.textContent = `${item.condition || "—"} · ${when}`;
    info.append(name, meta);

    const temp = document.createElement("span");
    temp.className = "history-temp";
    temp.textContent = `${formatTemp(item.temperature)}°`;

    button.append(icon, info, temp);
    button.addEventListener("click", () => searchCity(item.city, { fromHistory: true }));
    historyList.appendChild(button);
  });
}

async function loadHistory() {
  try {
    const data = await fetchJson("/api/history");
    renderHistory(data.items || []);
    if (data.available) setText("dbStatus", "MongoDB connected");
    if (!state.data) historyMessage.textContent = "";
  } catch (error) {
    renderHistory([]);
    historyMessage.textContent = error.message;
    setText("dbStatus", "History unavailable");
  }
}

/* ---------- favorites ---------- */

function isFavorite(city) {
  const name = String(city || "").toLowerCase();
  return state.favoritesCache.some((f) => String(f.city || "").toLowerCase() === name);
}

function updateFavoriteButton() {
  const btn = $("#favoriteButton");
  if (!btn || !state.data) return;
  const fav = isFavorite(state.data.location.name);
  btn.setAttribute("aria-pressed", String(fav));
  btn.classList.toggle("active", fav);
  btn.setAttribute("aria-label", fav ? "Remove city from favorites" : "Save city to favorites");
}

function renderFavorites(items) {
  state.favoritesCache = Array.isArray(items) ? items : [];
  favList.replaceChildren();
  setText("favCount", String(state.favoritesCache.length));
  if (!state.favoritesCache.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    const p = document.createElement("p");
    p.textContent = "No favorites yet.";
    const small = document.createElement("small");
    small.textContent = "Open a city and tap the bookmark icon to pin it here.";
    empty.append(p, small);
    favList.appendChild(empty);
    updateFavoriteButton();
    return;
  }
  state.favoritesCache.forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-item fav-row";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "fav-open";
    openBtn.setAttribute("aria-label", `Search ${item.city} again`);
    const icon = document.createElement("span");
    icon.className = "history-weather-icon";
    const img = document.createElement("img");
    img.src = iconUrl(item.icon);
    img.alt = "";
    img.loading = "lazy";
    img.width = 39; img.height = 39;
    icon.appendChild(img);
    const info = document.createElement("span");
    info.className = "history-info";
    const name = document.createElement("strong");
    name.textContent = [item.city, item.country].filter(Boolean).join(", ");
    const meta = document.createElement("small");
    meta.textContent = item.condition || "Favorite";
    info.append(name, meta);
    const temp = document.createElement("span");
    temp.className = "history-temp";
    temp.textContent = item.temperature === null || item.temperature === undefined ? "—" : `${formatTemp(item.temperature)}°`;
    openBtn.append(icon, info, temp);
    openBtn.addEventListener("click", () => searchCity(item.city));
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "fav-remove";
    removeBtn.setAttribute("aria-label", `Remove ${item.city} from favorites`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removeFavorite(item.city));
    row.append(openBtn, removeBtn);
    favList.appendChild(row);
  });
  updateFavoriteButton();
}

async function loadFavorites(options = {}) {
  try {
    const data = await fetchJson("/api/favorites");
    renderFavorites(data.items || []);
    if (!options.silent) favMessage.textContent = "";
  } catch (error) {
    if (!options.silent) {
      renderFavorites([]);
      favMessage.textContent = error.message;
    }
  }
}

async function toggleFavorite() {
  if (!state.data) return;
  const city = state.data.location.name;
  try {
    if (isFavorite(city)) {
      await fetchJson(`/api/favorites?city=${encodeURIComponent(city)}`, { method: "DELETE" });
      favMessage.textContent = `${city} removed from favorites.`;
    } else {
      await fetchJson("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city }),
      });
      favMessage.textContent = `${city} saved to favorites.`;
    }
    await loadFavorites({ silent: true });
  } catch (error) {
    favMessage.textContent = error.message;
  }
}

async function removeFavorite(city) {
  try {
    await fetchJson(`/api/favorites?city=${encodeURIComponent(city)}`, { method: "DELETE" });
    favMessage.textContent = `${city} removed from favorites.`;
    await loadFavorites({ silent: true });
  } catch (error) {
    favMessage.textContent = error.message;
  }
}

$("#favoriteButton").addEventListener("click", toggleFavorite);

/* ---------- events ---------- */

form.addEventListener("submit", (event) => {
  event.preventDefault();
  searchCity(cityInput.value);
});

document.querySelectorAll("[data-city]").forEach((button) => {
  button.addEventListener("click", () => {
    cityInput.value = button.dataset.city;
    searchCity(button.dataset.city);
  });
});

$("#clearHistory").addEventListener("click", async () => {
  clearError();
  if (!window.confirm("Clear all saved search history from MongoDB? This cannot be undone.")) return;
  try {
    await fetchJson("/api/history", { method: "DELETE" });
    await loadHistory();
    historyMessage.textContent = "Search history cleared.";
  } catch (error) {
    historyMessage.textContent = error.message;
  }
});

$("#refreshButton").addEventListener("click", () => {
  const city = state.data ? state.data.location.name : (cityInput.value || state.lastCity);
  if (!city) {
    showError("Search for a city first, then refresh.");
    return;
  }
  searchCity(city);
});

window.addEventListener("online", () => offlineBar.classList.add("hidden"));
window.addEventListener("offline", () => offlineBar.classList.remove("hidden"));
if (!navigator.onLine) offlineBar.classList.remove("hidden");

window.addEventListener("resize", () => {
  if (state.data) drawChart(state.data);
});

async function checkHealth() {
  try {
    const data = await fetchJson("/api/health");
    const dot = $("#apiDot");
    if (data.weather_api_configured) {
      setText("apiStatus", "Weather service ready");
      dot.className = "status-dot ok";
    } else {
      setText("apiStatus", "API key required");
      dot.className = "status-dot bad";
      showError("Weather API key is missing. Add OPENWEATHER_API_KEY to your .env file.");
    }
    setText("dbStatus", data.database === "connected" ? "MongoDB connected"
      : data.database === "not_configured" ? "MongoDB not configured" : "MongoDB unavailable");
  } catch {
    setText("apiStatus", "Service status unknown");
    $("#apiDot").className = "status-dot bad";
  }
}

/* ---------- init ---------- */

applyUnit();
setText("topbarDate", new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }));
checkHealth();
loadHistory();
loadFavorites();
if (state.lastCity) {
  cityInput.value = state.lastCity;
  searchCity(state.lastCity);
}
