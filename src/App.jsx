import { useEffect, useState } from "react";
import { BatteryCharging, Wifi } from "lucide-react";
import "./App.css";

const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const CONNECTIVITY_REFRESH_MS = 30 * 1000;
const UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPTIME_STORAGE_KEY = "ambient-dashboard-uptime-history";
const UPTIME_COLUMNS = 48;
const CLOCK_FORMAT_STORAGE_KEY = "ambient-dashboard-clock-format";

function readingState() {
  return { status: "loading", value: null };
}

function initialLocationReading() {
  return "geolocation" in navigator
    ? readingState()
    : { status: "unavailable", value: null };
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
    const cutoff = Date.now() - UPTIME_WINDOW_MS;
    return Array.isArray(parsed)
      ? parsed.filter(
          (point) =>
            Number.isFinite(point?.timestamp) &&
            point.timestamp >= cutoff &&
            ["online", "offline"].includes(point.status),
        )
      : [];
  } catch {
    return [];
  }
}

function uptimeSummary(history) {
  if (!history.length) return null;
  const onlineChecks = history.filter((point) => point.status === "online").length;
  return Math.round((onlineChecks / history.length) * 100);
}

function loadClockFormat() {
  try {
    return window.localStorage.getItem(CLOCK_FORMAT_STORAGE_KEY) === "24";
  } catch {
    return false;
  }
}

function App() {
  const [time, setTime] = useState(new Date());
  const [use24HourClock, setUse24HourClock] = useState(loadClockFormat);
  const [connectivity, setConnectivity] = useState("checking");
  const [battery, setBattery] = useState(null);
  const [isCharging, setIsCharging] = useState(false);
  const [temperature, setTemperature] = useState(initialLocationReading);
  const [aqi, setAqi] = useState(initialLocationReading);
  const [uptimeHistory, setUptimeHistory] = useState(loadUptimeHistory);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

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

      try {
        await activeLock.release();
      } catch {
        // A lock can already have been released by the browser or Android.
      }
    };

    const requestWakeLock = async () => {
      if (
        unmounted ||
        document.visibilityState !== "visible" ||
        wakeLock ||
        requestInProgress
      ) {
        return;
      }

      requestInProgress = true;

      try {
        const newLock = await navigator.wakeLock.request("screen");

        if (unmounted || document.visibilityState !== "visible") {
          await newLock.release();
          return;
        }

        wakeLock = newLock;
        wakeLock.addEventListener("release", handleRelease);
      } catch {
        // Unsupported policies, low battery, and denied requests fail silently.
      } finally {
        requestInProgress = false;
      }
    };

    const handleRelease = () => {
      wakeLock = null;

      if (!unmounted && document.visibilityState === "visible") {
        requestWakeLock();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    };

    requestWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unmounted = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseWakeLock();
    };
  }, []);

  // A real request catches captive portals and lost internet connections that
  // navigator.onLine alone cannot reliably detect.
  useEffect(() => {
    let activeController;

    const recordConnectivity = (status) => {
      const timestamp = Date.now();
      setConnectivity(status);
      setUptimeHistory((history) => {
        const nextHistory = [
          ...history.filter((point) => point.timestamp >= timestamp - UPTIME_WINDOW_MS),
          { timestamp, status },
        ];
        try {
          window.localStorage.setItem(UPTIME_STORAGE_KEY, JSON.stringify(nextHistory));
        } catch {
          // The tracker remains live for this session if storage is unavailable.
        }
        return nextHistory;
      });
    };

    const checkConnectivity = async () => {
      if (!navigator.onLine) {
        recordConnectivity("offline");
        return;
      }

      activeController?.abort();
      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController.abort(), 5000);

      try {
        await fetch("https://www.gstatic.com/generate_204", {
          cache: "no-store",
          mode: "no-cors",
          signal: activeController.signal,
        });
        recordConnectivity("online");
      } catch {
        recordConnectivity("offline");
      } finally {
        window.clearTimeout(timeout);
      }
    };

    const handleOnline = () => checkConnectivity();
    const handleOffline = () => recordConnectivity("offline");

    checkConnectivity();
    const timer = window.setInterval(checkConnectivity, CONNECTIVITY_REFRESH_MS);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      activeController?.abort();
      window.clearInterval(timer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!("geolocation" in navigator)) {
      return undefined;
    }

    let timer;
    let cancelled = false;

    const loadReadings = async (position) => {
      const { latitude, longitude } = position.coords;
      setTemperature(readingState());
      setAqi(readingState());

      const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
      weatherUrl.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "temperature_2m",
        temperature_unit: "celsius",
      });

      const airQualityUrl = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
      airQualityUrl.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: "us_aqi",
      });

      const [weatherResult, aqiResult] = await Promise.allSettled([
        fetch(weatherUrl, { cache: "no-store" }).then(async (response) => {
          if (!response.ok) throw new Error("Weather request failed");
          const data = await response.json();
          const value = data.current?.temperature_2m;
          if (!Number.isFinite(value)) throw new Error("Weather value unavailable");
          return Math.round(value);
        }),
        fetch(airQualityUrl, { cache: "no-store" }).then(async (response) => {
          if (!response.ok) throw new Error("Air-quality request failed");
          const data = await response.json();
          const value = data.current?.us_aqi;
          if (!Number.isFinite(value)) throw new Error("AQI value unavailable");
          return Math.round(value);
        }),
      ]);

      if (cancelled) return;

      setTemperature(
        weatherResult.status === "fulfilled"
          ? { status: "available", value: weatherResult.value }
          : { status: "unavailable", value: null },
      );
      setAqi(
        aqiResult.status === "fulfilled"
          ? { status: "available", value: aqiResult.value }
          : { status: "unavailable", value: null },
      );
    };

    const requestLocation = () => {
      navigator.geolocation.getCurrentPosition(
        (position) => loadReadings(position),
        () => {
          if (!cancelled) {
            setTemperature({ status: "unavailable", value: null });
            setAqi({ status: "unavailable", value: null });
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
      );
    };

    requestLocation();
    timer = window.setInterval(requestLocation, WEATHER_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
      } catch {
        // The Battery Status API is optional; omit it when unavailable.
      }
    };

    setupBattery();

    return () => {
      if (batteryManager && updateBattery) {
        batteryManager.removeEventListener("levelchange", updateBattery);
        batteryManager.removeEventListener("chargingchange", updateBattery);
      }
    };
  }, []);

  const toggleClockFormat = () => {
    setUse24HourClock((currentFormat) => {
      const nextFormat = !currentFormat;
      try {
        window.localStorage.setItem(CLOCK_FORMAT_STORAGE_KEY, nextFormat ? "24" : "12");
      } catch {
        // The format still changes for this session if storage is unavailable.
      }
      return nextFormat;
    });
  };

  const formattedTime = time.toLocaleTimeString([], {
    hour: use24HourClock ? "2-digit" : "numeric",
    minute: "2-digit",
    hour12: !use24HourClock,
  });
  const formattedDate = time.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const connectionLabel =
    connectivity === "online"
      ? "Internet connected"
      : connectivity === "offline"
        ? "Internet unavailable"
        : "Checking internet connection";
  const uptime = uptimeSummary(uptimeHistory);
  const graphStart = time.getTime() - UPTIME_WINDOW_MS;
  const graphStep = UPTIME_WINDOW_MS / UPTIME_COLUMNS;
  const uptimeColumns = Array.from({ length: UPTIME_COLUMNS }, (_, index) => {
    const start = graphStart + index * graphStep;
    const end = start + graphStep;
    const samples = uptimeHistory.filter(
      (point) => point.timestamp >= start && point.timestamp < end,
    );
    const latestSample = samples.at(-1);
    return { start, status: latestSample?.status ?? "unknown" };
  });

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className={`connection-status ${connectivity}`} title={connectionLabel} aria-label={connectionLabel}>
          <Wifi size={38} strokeWidth={2} />
          <span>{connectionLabel}</span>
        </div>

        {battery !== null && (
          <div className={`battery-status ${isCharging ? "charging" : ""}`} title={`Battery ${battery}%`}>
            <BatteryCharging size={38} strokeWidth={2} />
            <span>{battery}%</span>
          </div>
        )}
      </header>

      <section
        className="clock"
        onDoubleClick={toggleClockFormat}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleClockFormat();
          }
        }}
        role="button"
        tabIndex="0"
        aria-label="Clock. Double tap to switch between 12-hour and 24-hour time."
      >
        <h1>{formattedTime}</h1>
        <p>{formattedDate}</p>
      </section>

      <section className="metrics" aria-live="polite">
        <article className="metric-card temperature-card">
          <p className="metric-label">Outdoor temperature</p>
          <div className="metric-value temperature-value">
            {displayReading(temperature, (value) => `${value}°`)}
          </div>
        </article>

        <article className="metric-card aqi-card">
          <div className="metric-heading">
            <span className={`aqi-dot ${aqi.status === "available" ? aqiColor(aqi.value) : "unavailable"}`} />
            <p className="metric-label">Air quality index</p>
          </div>
          <div className="metric-value">{displayReading(aqi, (value) => value)}</div>
          <p className="metric-detail">
            {aqi.status === "available" ? aqiLabel(aqi.value) : "Live AQI unavailable"}
          </p>
        </article>
      </section>

      <section className="uptime-card" aria-label="Connection uptime history">
        <div className="uptime-heading">
          <div>
            <p className="metric-label">Connection history</p>
            <p className="uptime-period">Last 24 hours of live checks</p>
          </div>
          <p className="uptime-summary">
            {uptime === null ? "Collecting data" : `${uptime}% observed uptime`}
          </p>
        </div>
        <div className="uptime-graph" role="img" aria-label="Live connectivity checks over the last 24 hours">
          {uptimeColumns.map((column) => (
            <span
              className={`uptime-bar ${column.status}`}
              key={column.start}
              title={
                column.status === "unknown"
                  ? "No live connectivity check recorded"
                  : `${new Date(column.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: ${column.status}`
              }
            />
          ))}
        </div>
        <div className="uptime-legend" aria-hidden="true">
          <span><i className="online" />Online</span>
          <span><i className="offline" />Offline</span>
          <span><i className="unknown" />Not observed</span>
        </div>
      </section>
    </main>
  );
}

export default App;
