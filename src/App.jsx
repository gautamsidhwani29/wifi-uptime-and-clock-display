import { useCallback, useEffect, useRef, useState } from "react";
import { BatteryCharging, Settings, Wifi } from "lucide-react";
import "./App.css";

const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const CONNECTIVITY_REFRESH_MS = 30 * 1000;
const UPTIME_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UPTIME_STORAGE_KEY = "ambient-dashboard-uptime-history";
const UPTIME_VIEW_STORAGE_KEY = "ambient-dashboard-uptime-view";
const CLOCK_FORMAT_STORAGE_KEY = "ambient-dashboard-clock-format";
const PING_TARGET_STORAGE_KEY = "ambient-dashboard-ping-target";
const DEFAULT_PING_TARGET = "https://www.gstatic.com/generate_204";
const WEATHER_RETRY_DELAYS_MS = [1000, 3000, 7000];
const SELF_HEAL_AFTER_MS = 45 * 60 * 1000;
const SELF_HEAL_CHECK_MS = 5 * 60 * 1000;
const FULL_REFRESH_MS = 6 * 60 * 60 * 1000;
const TEMPERATURE_DETAIL_MS = 5000;
const CLOCK_HOLD_MS = 800;
const MAX_OUTAGE_EVENTS = 5;

const UPTIME_VIEWS = {
  day:   { label: "24 hours", windowMs: 24 * 60 * 60 * 1000,      columns: 48, colLabel: (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) },
  week:  { label: "7 days",   windowMs: 7  * 24 * 60 * 60 * 1000, columns: 56, colLabel: (ts) => new Date(ts).toLocaleDateString([], { weekday: "short", hour: "numeric" }) },
  month: { label: "30 days",  windowMs: 30 * 24 * 60 * 60 * 1000, columns: 60, colLabel: (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" }) },
};
const UPTIME_VIEW_ORDER = ["day", "week", "month"];

// ── helpers ──────────────────────────────────────────────────────────────────

function readingState() {
  return { status: "loading", value: null };
}

function initialLocationReading() {
  return "geolocation" in navigator ? readingState() : { status: "unavailable", value: null };
}

function aqiColor(aqi) {
  if (aqi <= 50) return "good";
  if (aqi <= 100) return "moderate";
  if (aqi <= 150) return "unhealthy-sensitive";
  return "unhealthy";
}

function aqiLabel(aqi) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  return "Unhealthy";
}

function displayReading(reading, formatter) {
  if (reading.status === "available") return formatter(reading.value);
  return reading.status === "loading" ? "Loading…" : "Unavailable";
}

function loadUptimeHistory() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UPTIME_STORAGE_KEY) ?? "[]");
    const cutoff = Date.now() - UPTIME_RETENTION_MS;
    return Array.isArray(parsed)
      ? parsed.filter(
          (p) => Number.isFinite(p?.timestamp) && p.timestamp >= cutoff && ["online", "offline"].includes(p.status),
        )
      : [];
  } catch {
    return [];
  }
}

function loadUptimeView() {
  try {
    const saved = window.localStorage.getItem(UPTIME_VIEW_STORAGE_KEY);
    return UPTIME_VIEW_ORDER.includes(saved) ? saved : "day";
  } catch {
    return "day";
  }
}

function loadPingTarget() {
  try {
    return window.localStorage.getItem(PING_TARGET_STORAGE_KEY) || DEFAULT_PING_TARGET;
  } catch {
    return DEFAULT_PING_TARGET;
  }
}

function uptimeSummary(history) {
  if (!history.length) return null;
  return Math.round((history.filter((p) => p.status === "online").length / history.length) * 100);
}

/** Derive outage events (consecutive offline runs) from raw history. */
function deriveOutageEvents(history) {
  const events = [];
  let outageStart = null;

  for (const point of history) {
    if (point.status === "offline" && outageStart === null) {
      outageStart = point.timestamp;
    } else if (point.status === "online" && outageStart !== null) {
      events.push({ start: outageStart, end: point.timestamp, durationMs: point.timestamp - outageStart });
      outageStart = null;
    }
  }
  // Still offline
  if (outageStart !== null) {
    events.push({ start: outageStart, end: null, durationMs: Date.now() - outageStart });
  }

  return events.slice(-MAX_OUTAGE_EVENTS).reverse();
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function loadClockFormat() {
  try {
    return window.localStorage.getItem(CLOCK_FORMAT_STORAGE_KEY) === "24";
  } catch {
    return false;
  }
}

function wait(delay) {
  return new Promise((resolve) => window.setTimeout(resolve, delay));
}

async function fetchWithRetry(url, source, readValue) {
  for (let attempt = 0; attempt <= WEATHER_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await readValue(await response.json());
      console.info(`[dashboard] ${source} fetch succeeded`, new Date().toISOString());
      return value;
    } catch (error) {
      if (attempt === WEATHER_RETRY_DELAYS_MS.length) {
        console.error(`[dashboard] ${source} unavailable after retries`, error);
        throw error;
      }
      const delay = WEATHER_RETRY_DELAYS_MS[attempt];
      console.warn(`[dashboard] ${source} fetch failed; retrying in ${delay}ms`, error);
      await wait(delay);
    }
  }
}

// ── component ─────────────────────────────────────────────────────────────────

function App() {
  const [time, setTime] = useState(new Date());
  const [use24HourClock, setUse24HourClock] = useState(loadClockFormat);
  const [connectivity, setConnectivity] = useState("checking");
  const [offlineSince, setOfflineSince] = useState(null); // timestamp when we went offline
  const [battery, setBattery] = useState(null);
  const [isCharging, setIsCharging] = useState(false);
  const [temperature, setTemperature] = useState(initialLocationReading);
  const [weatherDetails, setWeatherDetails] = useState(readingState);
  const [aqi, setAqi] = useState(initialLocationReading);
  const [uptimeHistory, setUptimeHistory] = useState(loadUptimeHistory);
  const [uptimeView, setUptimeView] = useState(loadUptimeView);
  const [showTemperatureDetails, setShowTemperatureDetails] = useState(false);
  const [mode, setMode] = useState("ambient");
  const [pomodoroPhase, setPomodoroPhase] = useState("work");
  const [workMinutes, setWorkMinutes] = useState(25);
  const [breakMinutes, setBreakMinutes] = useState(5);
  const [pomodoroSeconds, setPomodoroSeconds] = useState(25 * 60);
  const [pomodoroRunning, setPomodoroRunning] = useState(false);
  const [pingTarget, setPingTarget] = useState(loadPingTarget);
  const [showPingSettings, setShowPingSettings] = useState(false);
  const [pingInput, setPingInput] = useState(loadPingTarget);

  const refreshReadingsRef = useRef(null);
  const connectivityRef = useRef("checking");
  const pingTargetRef = useRef(pingTarget);
  const lastSuccessfulUpdateRef = useRef(null);
  const temperatureDetailTimerRef = useRef(null);
  const clockHoldTimerRef = useRef(null);

  // Keep ref in sync so the connectivity loop always uses latest target
  useEffect(() => { pingTargetRef.current = pingTarget; }, [pingTarget]);

  const markSuccessfulUpdate = useCallback((source) => {
    lastSuccessfulUpdateRef.current = Date.now();
    console.info(`[dashboard] ${source} updated`, new Date().toISOString());
  }, []);

  const reloadWhenSafe = useCallback((reason) => {
    console.info(`[dashboard] ${reason}; refreshing data in place`);
    refreshReadingsRef.current?.();
  }, []);

  // Clock tick
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => { lastSuccessfulUpdateRef.current = Date.now(); }, []);

  // Wake lock
  useEffect(() => {
    if (!("wakeLock" in navigator)) return undefined;

    let wakeLock = null;
    let requestInProgress = false;
    let unmounted = false;

    const releaseWakeLock = async () => {
      if (!wakeLock) return;
      const activeLock = wakeLock;
      wakeLock = null;
      activeLock.removeEventListener("release", handleRelease);
      try { await activeLock.release(); } catch { /* already released */ }
    };

    const requestWakeLock = async () => {
      if (unmounted || document.visibilityState !== "visible" || wakeLock || requestInProgress) return;
      requestInProgress = true;
      try {
        const newLock = await navigator.wakeLock.request("screen");
        if (unmounted || document.visibilityState !== "visible") { await newLock.release(); return; }
        wakeLock = newLock;
        wakeLock.addEventListener("release", handleRelease);
        console.info("[dashboard] screen wake lock acquired");
      } catch (error) {
        console.warn("[dashboard] screen wake lock request failed", error);
      } finally {
        requestInProgress = false;
      }
    };

    const handleRelease = () => {
      wakeLock = null;
      console.warn("[dashboard] screen wake lock released");
      if (!unmounted && document.visibilityState === "visible") requestWakeLock();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") requestWakeLock(); else releaseWakeLock();
    };

    requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      unmounted = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseWakeLock();
    };
  }, []);

  // Connectivity checker
  useEffect(() => {
    let activeController;

    const recordConnectivity = (status) => {
      const timestamp = Date.now();
      const previousStatus = connectivityRef.current;
      connectivityRef.current = status;
      setConnectivity(status);

      if (status === "offline") {
        if (previousStatus !== "offline") setOfflineSince(timestamp);
        console.warn("[dashboard] connectivity check failed", new Date(timestamp).toISOString());
      } else {
        setOfflineSince(null);
        markSuccessfulUpdate("wifi");
        if (previousStatus !== "online") {
          console.info("[dashboard] connectivity restored; refreshing live data");
          refreshReadingsRef.current?.();
        }
      }

      setUptimeHistory((history) => {
        const nextHistory = [
          ...history.filter((p) => p.timestamp >= timestamp - UPTIME_RETENTION_MS),
          { timestamp, status },
        ];
        try { window.localStorage.setItem(UPTIME_STORAGE_KEY, JSON.stringify(nextHistory)); } catch { /* ignore */ }
        return nextHistory;
      });
    };

    const checkConnectivity = async () => {
      if (!navigator.onLine) { recordConnectivity("offline"); return; }

      activeController?.abort();
      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController.abort(), 5000);

      try {
        await fetch(pingTargetRef.current, { cache: "no-store", mode: "no-cors", signal: activeController.signal });
        recordConnectivity("online");
      } catch {
        recordConnectivity("offline");
      } finally {
        window.clearTimeout(timeout);
      }
    };

    checkConnectivity();
    const timer = window.setInterval(checkConnectivity, CONNECTIVITY_REFRESH_MS);
    window.addEventListener("online", checkConnectivity);
    window.addEventListener("offline", () => recordConnectivity("offline"));

    return () => {
      activeController?.abort();
      window.clearInterval(timer);
      window.removeEventListener("online", checkConnectivity);
      window.removeEventListener("offline", () => recordConnectivity("offline"));
    };
  }, [markSuccessfulUpdate]);

  // Weather + AQI + sunrise/sunset
  useEffect(() => {
    if (!("geolocation" in navigator)) return undefined;

    let timer;
    let cancelled = false;

    const loadReadings = async (position) => {
      const { latitude, longitude } = position.coords;
      setTemperature(readingState());
      setWeatherDetails(readingState());
      setAqi(readingState());

      const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
      weatherUrl.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "temperature_2m,apparent_temperature,relative_humidity_2m",
        temperature_unit: "celsius",
        timezone: "auto",
      });

      const airQualityUrl = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
      airQualityUrl.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "us_aqi",
      });

      const [weatherResult, aqiResult] = await Promise.allSettled([
        fetchWithRetry(weatherUrl, "weather", (data) => {
          const current = data.current;
          if (
            !Number.isFinite(current?.temperature_2m) ||
            !Number.isFinite(current?.apparent_temperature) ||
            !Number.isFinite(current?.relative_humidity_2m)
          ) throw new Error("Weather value unavailable");
          return {
            temperature: Math.round(current.temperature_2m),
            apparentTemperature: Math.round(current.apparent_temperature),
            humidity: Math.round(current.relative_humidity_2m),
          };
        }),
        fetchWithRetry(airQualityUrl, "AQI", (data) => {
          const value = data.current?.us_aqi;
          if (!Number.isFinite(value)) throw new Error("AQI value unavailable");
          return Math.round(value);
        }),
      ]);

      if (cancelled) return;

      setTemperature(
        weatherResult.status === "fulfilled"
          ? { status: "available", value: weatherResult.value.temperature }
          : { status: "unavailable", value: null },
      );
      setWeatherDetails(
        weatherResult.status === "fulfilled"
          ? { status: "available", value: weatherResult.value }
          : { status: "unavailable", value: null },
      );
      setAqi(
        aqiResult.status === "fulfilled"
          ? { status: "available", value: aqiResult.value }
          : { status: "unavailable", value: null },
      );

      if (weatherResult.status === "fulfilled") markSuccessfulUpdate("weather");
      if (aqiResult.status === "fulfilled") markSuccessfulUpdate("AQI");
    };

    const requestLocation = () => {
      navigator.geolocation.getCurrentPosition(
        (position) => loadReadings(position),
        () => {
          if (!cancelled) {
            setTemperature({ status: "unavailable", value: null });
            setWeatherDetails({ status: "unavailable", value: null });
            setAqi({ status: "unavailable", value: null });
            console.error("[dashboard] location request failed; weather and AQI unavailable");
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      );
    };

    requestLocation();
    refreshReadingsRef.current = requestLocation;
    timer = window.setInterval(requestLocation, WEATHER_REFRESH_MS);

    return () => {
      cancelled = true;
      refreshReadingsRef.current = null;
      window.clearInterval(timer);
    };
  }, [markSuccessfulUpdate]);

  // Battery
  useEffect(() => {
    if (!("getBattery" in navigator)) return undefined;
    let batteryManager;
    let updateBattery;

    const setupBattery = async () => {
      try {
        batteryManager = await navigator.getBattery();
        updateBattery = () => {
          setBattery(Math.round(batteryManager.level * 100));
          setIsCharging(batteryManager.charging);
        };
        updateBattery();
        batteryManager.addEventListener("levelchange", updateBattery);
        batteryManager.addEventListener("chargingchange", updateBattery);
      } catch { /* optional API */ }
    };

    setupBattery();
    return () => {
      if (batteryManager && updateBattery) {
        batteryManager.removeEventListener("levelchange", updateBattery);
        batteryManager.removeEventListener("chargingchange", updateBattery);
      }
    };
  }, []);

  // Self-heal
  useEffect(() => {
    const checkHealth = () => {
      if (lastSuccessfulUpdateRef.current === null) return;
      const idleFor = Date.now() - lastSuccessfulUpdateRef.current;
      if (document.visibilityState === "visible" && idleFor >= SELF_HEAL_AFTER_MS) {
        console.warn("[dashboard] no successful live update", { idleFor });
        reloadWhenSafe("self-healing reload");
      }
    };
    const timer = window.setInterval(checkHealth, SELF_HEAL_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [reloadWhenSafe]);

  // Scheduled refresh
  useEffect(() => {
    const timer = window.setTimeout(() => reloadWhenSafe("scheduled full refresh"), FULL_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [reloadWhenSafe]);

  // Cleanup timers
  useEffect(() => {
    return () => {
      window.clearTimeout(temperatureDetailTimerRef.current);
      window.clearTimeout(clockHoldTimerRef.current);
    };
  }, []);

  // Pomodoro tick
  useEffect(() => {
    if (mode !== "pomodoro" || !pomodoroRunning) return undefined;
    const timer = window.setTimeout(() => {
      if (pomodoroSeconds <= 1) {
        const nextPhase = pomodoroPhase === "work" ? "break" : "work";
        const nextDuration = nextPhase === "work" ? workMinutes : breakMinutes;
        setPomodoroPhase(nextPhase);
        setPomodoroSeconds(nextDuration * 60);
        console.info(`[dashboard] Pomodoro switched to ${nextPhase}`);
      } else {
        setPomodoroSeconds((s) => s - 1);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [breakMinutes, mode, pomodoroPhase, pomodoroRunning, pomodoroSeconds, workMinutes]);

  // ── event handlers ──────────────────────────────────────────────────────────

  const toggleClockFormat = () => {
    setUse24HourClock((current) => {
      const next = !current;
      try { window.localStorage.setItem(CLOCK_FORMAT_STORAGE_KEY, next ? "24" : "12"); } catch { /* ignore */ }
      return next;
    });
  };

  const revealTemperatureDetails = () => {
    if (weatherDetails.status !== "available") return;
    setShowTemperatureDetails(true);
    window.clearTimeout(temperatureDetailTimerRef.current);
    temperatureDetailTimerRef.current = window.setTimeout(() => setShowTemperatureDetails(false), TEMPERATURE_DETAIL_MS);
  };

  const startClockHold = () => {
    window.clearTimeout(clockHoldTimerRef.current);
    clockHoldTimerRef.current = window.setTimeout(() => {
      setMode("pomodoro");
      console.info("[dashboard] entered Pomodoro mode");
    }, CLOCK_HOLD_MS);
  };

  const cancelClockHold = () => window.clearTimeout(clockHoldTimerRef.current);

  const resetPomodoro = () => {
    setPomodoroRunning(false);
    setPomodoroPhase("work");
    setPomodoroSeconds(workMinutes * 60);
  };

  const updatePomodoroDuration = (type, rawValue) => {
    const minutes = Math.min(120, Math.max(1, Number.parseInt(rawValue, 10) || 1));
    if (type === "work") {
      setWorkMinutes(minutes);
      if (pomodoroPhase === "work") setPomodoroSeconds(minutes * 60);
    } else {
      setBreakMinutes(minutes);
      if (pomodoroPhase === "break") setPomodoroSeconds(minutes * 60);
    }
    setPomodoroRunning(false);
  };

  const savePingTarget = () => {
    const trimmed = pingInput.trim();
    if (!trimmed) return;
    setPingTarget(trimmed);
    try { window.localStorage.setItem(PING_TARGET_STORAGE_KEY, trimmed); } catch { /* ignore */ }
    setShowPingSettings(false);
    console.info("[dashboard] ping target updated", trimmed);
  };

  const cycleUptimeView = () => {
    setUptimeView((current) => {
      const next = UPTIME_VIEW_ORDER[(UPTIME_VIEW_ORDER.indexOf(current) + 1) % UPTIME_VIEW_ORDER.length];
      try { window.localStorage.setItem(UPTIME_VIEW_STORAGE_KEY, next); } catch { /* ignore */ }
      return next;
    });
  };

  // ── derived values ──────────────────────────────────────────────────────────

  const formattedTime = time
    .toLocaleTimeString([], { hour: use24HourClock ? "2-digit" : "numeric", minute: "2-digit", hour12: !use24HourClock })
    .replace(/\b([ap])\.?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`);

  const formattedDate = time.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  const connectionLabel =
    connectivity === "online" ? "Internet connected"
    : connectivity === "offline" ? "Internet unavailable"
    : "Checking internet connection";

  const offlineDuration = connectivity === "offline" && offlineSince !== null
    ? formatDuration(time.getTime() - offlineSince)
    : null;

  const currentView = UPTIME_VIEWS[uptimeView];
  const graphStep = currentView.windowMs / currentView.columns;
  const graphStart = Math.floor((time.getTime() - currentView.windowMs) / graphStep) * graphStep;
  const viewHistory = uptimeHistory.filter((p) => p.timestamp >= graphStart);
  const viewUptime = uptimeSummary(viewHistory);
  const uptimeColumns = Array.from({ length: currentView.columns }, (_, index) => {
    const start = graphStart + index * graphStep;
    const end = start + graphStep;
    const samples = uptimeHistory.filter((p) => p.timestamp >= start && p.timestamp < end);
    if (!samples.length) return { start, status: "unknown" };
    const onlineCount = samples.filter((p) => p.status === "online").length;
    return { start, status: onlineCount >= samples.length / 2 ? "online" : "offline" };
  });

  const outageEvents = deriveOutageEvents(uptimeHistory);

  const pomodoroTime = `${String(Math.floor(pomodoroSeconds / 60)).padStart(2, "0")}:${String(pomodoroSeconds % 60).padStart(2, "0")}`;

  // ── render ──────────────────────────────────────────────────────────────────

  if (mode === "pomodoro") {
    return (
      <main className={`pomodoro-screen ${pomodoroPhase}`}>
        <header className="pomodoro-topbar">
          <div className={`connection-status ${connectivity}`} title={connectionLabel}>
            <Wifi size={30} strokeWidth={2} />
            <span>{connectionLabel}</span>
          </div>
          <time className="pomodoro-current-time">{formattedTime}</time>
        </header>
        <button className="pomodoro-exit" type="button" onClick={() => { setPomodoroRunning(false); setMode("ambient"); }}>
          Back to dashboard
        </button>
        <section className="pomodoro-panel" aria-live="polite">
          <p className="pomodoro-phase">{pomodoroPhase === "work" ? "Focus" : "Break"}</p>
          <p className="pomodoro-time">{pomodoroTime}</p>
          <div className="pomodoro-controls">
            <button type="button" onClick={() => setPomodoroRunning((r) => !r)}>
              {pomodoroRunning ? "Pause" : "Start"}
            </button>
            <button type="button" onClick={resetPomodoro}>Reset</button>
          </div>
          <div className="pomodoro-settings">
            <label>
              Focus
              <input type="number" min="1" max="120" value={workMinutes} onChange={(e) => updatePomodoroDuration("work", e.target.value)} />
            </label>
            <label>
              Break
              <input type="number" min="1" max="120" value={breakMinutes} onChange={(e) => updatePomodoroDuration("break", e.target.value)} />
            </label>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className={`connection-status ${connectivity}`} title={connectionLabel} aria-label={connectionLabel}>
          <Wifi size={52} strokeWidth={1.8} />
          <span>
            {connectionLabel}
            {offlineDuration && <span className="offline-duration"> · {offlineDuration}</span>}
          </span>
        </div>

        {battery !== null && (
          <div className={`battery-status ${isCharging ? "charging" : ""}`} title={`Battery ${battery}%`}>
            <BatteryCharging size={52} strokeWidth={1.8} />
            <span>{battery}%</span>
          </div>
        )}
      </header>

      <section
        className="clock"
        onDoubleClick={toggleClockFormat}
        onPointerDown={startClockHold}
        onPointerUp={cancelClockHold}
        onPointerCancel={cancelClockHold}
        onPointerLeave={cancelClockHold}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleClockFormat(); } }}
        role="button"
        tabIndex="0"
        aria-label="Clock. Double tap to switch between 12-hour and 24-hour time. Hold to open Pomodoro mode."
      >
        <h1>{formattedTime}</h1>
        <p>{formattedDate}</p>
      </section>

      <section className="metrics" aria-live="polite">
        <article
          className="metric-card temperature-card"
          onClick={revealTemperatureDetails}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); revealTemperatureDetails(); } }}
          role="button"
          tabIndex="0"
          aria-label="Outdoor temperature. Tap for feels-like temperature and humidity."
        >
          <p className="metric-label">Outdoor temperature</p>
          <div className="metric-value temperature-value">
            {displayReading(temperature, (v) => `${v}°`)}
          </div>
          {showTemperatureDetails && weatherDetails.status === "available" && (
            <div className="temperature-detail-overlay">
              <span>Feels like {weatherDetails.value.apparentTemperature}°</span>
              <span>Humidity {weatherDetails.value.humidity}%</span>
            </div>
          )}
        </article>

        <article className="metric-card aqi-card">
          <div className="metric-heading">
            <span className={`aqi-dot ${aqi.status === "available" ? aqiColor(aqi.value) : "unavailable"}`} />
            <p className="metric-label">Air quality index</p>
          </div>
          <div className="metric-value">{displayReading(aqi, (v) => v)}</div>
          <p className="metric-detail">
            {aqi.status === "available" ? aqiLabel(aqi.value) : "Live AQI unavailable"}
          </p>
        </article>
      </section>

      <section className="uptime-card" aria-label="Connection uptime history">
        <div className="uptime-heading">
          <div>
            <p className="metric-label">Connection history</p>
            <p className="uptime-period">Last {currentView.label} of live checks</p>
          </div>
          <div className="uptime-heading-right">
            <p className="uptime-summary">
              {viewUptime === null ? "Collecting data" : `${viewUptime}% uptime`}
            </p>
            <button
              className="uptime-view-toggle"
              type="button"
              onClick={cycleUptimeView}
              aria-label={`Switch uptime view. Currently showing ${currentView.label}.`}
            >
              {UPTIME_VIEW_ORDER.map((v) => (
                <span key={v} className={v === uptimeView ? "active" : ""}>{UPTIME_VIEWS[v].label}</span>
              ))}
            </button>
          </div>
        </div>

        <div
          className="uptime-graph"
          style={{ gridTemplateColumns: `repeat(${currentView.columns}, minmax(0, 1fr))` }}
          role="img"
          aria-label={`Live connectivity checks over the last ${currentView.label}`}
        >
          {uptimeColumns.map((column) => (
            <span
              className={`uptime-bar ${column.status}`}
              key={column.start}
              title={
                column.status === "unknown"
                  ? "No live connectivity check recorded"
                  : `${currentView.colLabel(column.start)}: ${column.status}`
              }
            />
          ))}
        </div>

        <div className="uptime-legend" aria-hidden="true">
          <span><i className="online" />Online</span>
          <span><i className="offline" />Offline</span>
          <span><i className="unknown" />Not observed</span>
        </div>

        {outageEvents.length > 0 && (
          <div className="outage-log" aria-label="Recent outage events">
            <p className="outage-log-title">Recent outages</p>
            <ul className="outage-list">
              {outageEvents.map((event) => (
                <li key={event.start} className={event.end === null ? "outage-item active" : "outage-item"}>
                  <span className="outage-time">
                    {new Date(event.start).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {event.end !== null && ` – ${new Date(event.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                  </span>
                  <span className="outage-duration">
                    {event.end === null ? `ongoing · ${formatDuration(event.durationMs)}` : formatDuration(event.durationMs)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ping-settings-row">
          <button
            className="ping-settings-toggle"
            type="button"
            onClick={() => { setShowPingSettings((v) => !v); setPingInput(pingTarget); }}
            aria-label="Configure ping target"
          >
            <Settings size={14} strokeWidth={2} />
            <span>Ping target</span>
          </button>
          {pingTarget !== DEFAULT_PING_TARGET && (
            <span className="ping-target-label">{pingTarget}</span>
          )}
        </div>
        {showPingSettings && (
          <div className="ping-settings-panel">
            <input
              className="ping-input"
              type="url"
              value={pingInput}
              onChange={(e) => setPingInput(e.target.value)}
              placeholder={DEFAULT_PING_TARGET}
              aria-label="Custom ping target URL"
              onKeyDown={(e) => { if (e.key === "Enter") savePingTarget(); if (e.key === "Escape") setShowPingSettings(false); }}
            />
            <button className="ping-save" type="button" onClick={savePingTarget}>Save</button>
            <button className="ping-reset" type="button" onClick={() => { setPingInput(DEFAULT_PING_TARGET); setPingTarget(DEFAULT_PING_TARGET); try { window.localStorage.removeItem(PING_TARGET_STORAGE_KEY); } catch { /* ignore */ } setShowPingSettings(false); }}>Reset</button>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
