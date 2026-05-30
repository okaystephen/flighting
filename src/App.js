import { useState, useRef, useEffect, useCallback } from "react";
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

// Lightweight CSV parser (handles quoted fields)
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (values[idx] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function splitCSVLine(line) {
  const fields = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

if (!document.getElementById("ibm-plex-mono-font")) {
  const link = document.createElement("link");
  link.id = "ibm-plex-mono-font";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap";
  document.head.appendChild(link);
}

if (!document.getElementById("flightlog-css")) {
  const style = document.createElement("style");
  style.id = "flightlog-css";
  style.textContent = `
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes slideInRight { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }
    @keyframes dashMove { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -18; } }
    @keyframes pulse { 0%,100% { opacity: 0.2; } 50% { opacity: 0.6; } }
    .fl-tab-content { animation: fadeIn 0.22s ease; }
    .fl-detail-panel { animation: slideInRight 0.2s ease; }
    .fl-stat-card { transition: transform 0.15s ease, box-shadow 0.15s ease; }
    .fl-stat-card:hover { transform: translateY(-2px); }
    .fl-flight-row { transition: background 0.12s ease, border-color 0.12s ease, transform 0.1s ease; }
    .fl-flight-row:hover { transform: translateX(2px); }
    .fl-flight-row:active { transform: scale(0.99); }
    .fl-airline-card { transition: transform 0.15s ease, border-color 0.15s ease; }
    .fl-airline-card:hover { transform: translateY(-2px); border-color: #2a4060 !important; }
    .fl-btn { transition: background 0.12s ease, border-color 0.12s ease, transform 0.1s ease, color 0.12s ease; }
    .fl-btn:hover { opacity: 0.85; }
    .fl-btn:active { transform: scale(0.97); }
    .fl-tab-btn { transition: background 0.15s ease, color 0.15s ease; }
    .fl-country { transition: fill 0.2s ease; }
    .fl-country:hover { fill: #162538 !important; }
    .fl-arc { animation: none; }
    .fl-selected-arc { animation: dashMove 0.8s linear infinite; }
    .fl-loading-dot { animation: pulse 1.4s ease-in-out infinite; }
    .fl-loading-dot:nth-child(2) { animation-delay: 0.2s; }
    .fl-loading-dot:nth-child(3) { animation-delay: 0.4s; }
  `;
  document.head.appendChild(style);
}

const FONT = "'IBM Plex Mono', monospace";

const AIRPORT_COORDS = {
  MNL: { lat: 14.5086, lng: 121.0197, city: "Manila", country: "Philippines" },
  HKG: { lat: 22.308, lng: 113.9185, city: "Hong Kong", country: "China" },
  ICN: { lat: 37.4602, lng: 126.4407, city: "Seoul", country: "South Korea" },
  SGN: { lat: 10.8188, lng: 106.6519, city: "Ho Chi Minh City", country: "Vietnam" },
  KLO: { lat: 11.6795, lng: 122.4759, city: "Kalibo", country: "Philippines" },
  MPH: { lat: 11.9215, lng: 122.0252, city: "Caticlan", country: "Philippines" },
  TPE: { lat: 25.0777, lng: 121.2322, city: "Taipei", country: "Taiwan" },
  CEB: { lat: 10.3075, lng: 123.9794, city: "Cebu", country: "Philippines" },
  SIN: { lat: 1.3644, lng: 103.9915, city: "Singapore", country: "Singapore" },
  BKK: { lat: 13.6811, lng: 100.7471, city: "Bangkok", country: "Thailand" },
  DXB: { lat: 25.2532, lng: 55.3657, city: "Dubai", country: "UAE" },
};

const AIRLINE_NAMES = { CEB: "Cebu Pacific", HVN: "Vietnam Airlines", AAR: "Asiana Airlines", APG: "Air Philippines", CPA: "Cathay Pacific", TGW: "Scoot", UAE: "Emirates" };
const AIRLINE_COLORS = { CEB: "#FFD700", HVN: "#4FC3F7", AAR: "#EF5350", APG: "#66BB6A", CPA: "#CE93D8", TGW: "#FF7043", UAE: "#29B6F6" };

// ── Mercator projection ───────────────────────────────────────────────────────
const W = 900, H = 440;
const BASE_SCALE = 130, BASE_TX = W / 2, BASE_TY = H / 2 + 60;

// Project [lng, lat] → {x, y} at given scale/translate
function mercProject(lng, lat, scale = BASE_SCALE, tx = BASE_TX, ty = BASE_TY) {
  const x = (lng / 180) * Math.PI;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  // clamp to avoid ±Infinity at poles
  const clamped = Math.max(-0.9999, Math.min(0.9999, sinLat));
  const y = Math.log((1 + clamped) / (1 - clamped)) / 2;
  return { x: x * scale + tx, y: -y * scale + ty };
}

// Cut a ring at the antimeridian — split into segments that don't cross 180°
function cutRing(ring) {
  const segments = [];
  let seg = [];
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i];
    if (seg.length > 0) {
      const prev = seg[seg.length - 1];
      const dLng = cur[0] - prev[0];
      if (Math.abs(dLng) > 180) {
        // crossing antimeridian — end current segment, start new one
        segments.push(seg);
        seg = [];
      }
    }
    seg.push(cur);
  }
  if (seg.length > 0) segments.push(seg);
  return segments;
}

// Convert a GeoJSON ring → SVG path string, antimeridian-safe
function ringToPath(ring, scale, tx, ty) {
  const segments = cutRing(ring);
  return segments.map(seg =>
    seg.map((pt, i) => {
      const { x, y } = mercProject(pt[0], pt[1], scale, tx, ty);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ")
  ).join(" ");
}

function geomToPath(geom, scale = BASE_SCALE, tx = BASE_TX, ty = BASE_TY) {
  if (!geom) return "";
  if (geom.type === "Polygon") {
    return geom.coordinates.map(r => ringToPath(r, scale, tx, ty)).join(" ");
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.flatMap(poly => poly.map(r => ringToPath(r, scale, tx, ty))).join(" ");
  }
  return "";
}

// Compute a zoom+translate that fits two lat/lng points with padding
function fitView(lngA, latA, lngB, latB, padding = 80) {
  // target scale: make the route span ~60% of canvas width
  const pA0 = mercProject(lngA, latA);
  const pB0 = mercProject(lngB, latB);
  const dx = Math.abs(pB0.x - pA0.x) || 1;
  const dy = Math.abs(pB0.y - pA0.y) || 1;
  const targetScale = Math.min(
    (W - padding * 2) / (dx / BASE_SCALE),
    (H - padding * 2) / (dy / BASE_SCALE),
    BASE_SCALE * 6
  );
  const scale = Math.max(targetScale, BASE_SCALE * 1.5);

  // centre of the two points in the new projection
  const midLng = (lngA + lngB) / 2;
  const sinMid = Math.sin((((latA + latB) / 2) * Math.PI) / 180);
  const clamp = Math.max(-0.9999, Math.min(0.9999, sinMid));
  const midY = Math.log((1 + clamp) / (1 - clamp)) / 2;

  const tx = W / 2 - (midLng / 180) * Math.PI * scale;
  const ty = H / 2 + midY * scale;
  return { scale, tx, ty };
}

// ── World Map ────────────────────────────────────────────────────────────────
function WorldMap({ flights, selectedFlight, countryGeoms, mapReady }) {
  const [view, setView] = useState({ scale: BASE_SCALE, tx: BASE_TX, ty: BASE_TY });
  const [animating, setAnimating] = useState(false);
  const animRef = useRef(null);

  // Smooth animate view changes
  function animateTo(target, duration = 600) {
    const start = performance.now();
    const from = { ...view };
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setAnimating(true);
    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out quad
      setView({
        scale: from.scale + (target.scale - from.scale) * ease,
        tx: from.tx + (target.tx - from.tx) * ease,
        ty: from.ty + (target.ty - from.ty) * ease,
      });
      if (t < 1) { animRef.current = requestAnimationFrame(step); }
      else { setAnimating(false); }
    }
    animRef.current = requestAnimationFrame(step);
  }

  // Auto-zoom when selectedFlight changes
  useEffect(() => {
    if (selectedFlight) {
      const fc = AIRPORT_COORDS[selectedFlight.from];
      const tc = AIRPORT_COORDS[selectedFlight.to];
      if (fc && tc) {
        animateTo(fitView(fc.lng, fc.lat, tc.lng, tc.lat));
      }
    } else {
      animateTo({ scale: BASE_SCALE, tx: BASE_TX, ty: BASE_TY });
    }
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [selectedFlight]);

  const { scale, tx, ty } = view;

  // Build country path strings at current view
  const countryPaths = countryGeoms.map(geom => geomToPath(geom, scale, tx, ty));

  const routeMap = {};
  flights.forEach(f => {
    const fc = AIRPORT_COORDS[f.from], tc = AIRPORT_COORDS[f.to];
    if (!fc || !tc) return;
    const key = [f.from, f.to].sort().join("-");
    if (!routeMap[key]) routeMap[key] = { from: f.from, to: f.to, count: 0, color: AIRLINE_COLORS[f.airline] || "#aaa" };
    routeMap[key].count++;
  });

  const airports = {};
  flights.forEach(f => {
    if (AIRPORT_COORDS[f.from]) airports[f.from] = AIRPORT_COORDS[f.from];
    if (AIRPORT_COORDS[f.to]) airports[f.to] = AIRPORT_COORDS[f.to];
  });

  function arcPath(p1, p2) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2 - Math.abs(p2.x - p1.x) * 0.18;
    return `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }

  function zoomBy(factor) {
    const newScale = Math.max(BASE_SCALE * 0.8, Math.min(scale * factor, BASE_SCALE * 8));
    const ratio = newScale / scale;
    animateTo({ scale: newScale, tx: W / 2 - (W / 2 - tx) * ratio, ty: H / 2 - (H / 2 - ty) * ratio }, 300);
  }

  function resetView() {
    animateTo({ scale: BASE_SCALE, tx: BASE_TX, ty: BASE_TY }, 500);
  }

  const dotR = Math.max(2, Math.min(4.5, 3.5 * (scale / BASE_SCALE) ** 0.3));

  return (
    <div style={{ width: "100%", background: "#060d18", borderRadius: 12, overflow: "hidden", border: "1px solid #1e2d45", position: "relative" }}>
      {/* Zoom controls */}
      <div style={{ position: "absolute", top: 12, right: 12, zIndex: 10, display: "flex", flexDirection: "column", gap: 4 }}>
        {[["＋", () => zoomBy(1.5)], ["－", () => zoomBy(1 / 1.5)], ["⊙", resetView]].map(([label, fn]) => (
          <button key={label} className="fl-btn" onClick={fn} style={{
            width: 28, height: 28, background: "rgba(10,20,35,0.9)", border: "1px solid #1e2d45",
            color: "#4a7a9b", borderRadius: 6, cursor: "pointer", fontFamily: FONT, fontSize: 13,
            display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
          }}>{label}</button>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2.5" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <clipPath id="mapClip"><rect width={W} height={H} /></clipPath>
        </defs>

        <rect width={W} height={H} fill="#060d18" />

        <g clipPath="url(#mapClip)">
          {/* Countries */}
          {countryPaths.map((d, i) => (
            <path key={i} d={d} fill="#0c1c2e" stroke="#1e3550" strokeWidth={Math.max(0.3, 0.4 * BASE_SCALE / scale)} />
          ))}

          {/* All routes */}
          {Object.values(routeMap).map(route => {
            const fc = AIRPORT_COORDS[route.from], tc = AIRPORT_COORDS[route.to];
            if (!fc || !tc) return null;
            const p1 = mercProject(fc.lng, fc.lat, scale, tx, ty);
            const p2 = mercProject(tc.lng, tc.lat, scale, tx, ty);
            const isSelRoute = selectedFlight && (
              (selectedFlight.from === route.from && selectedFlight.to === route.to) ||
              (selectedFlight.from === route.to && selectedFlight.to === route.from)
            );
            return (
              <path
                key={`${route.from}-${route.to}`}
                d={arcPath(p1, p2)}
                fill="none"
                stroke={route.color}
                strokeWidth={Math.min(route.count * 0.8 + 0.8, 3)}
                strokeOpacity={selectedFlight && !isSelRoute ? 0.2 : 0.7}
                filter="url(#glow)"
                strokeLinecap="round"
                style={{ transition: "stroke-opacity 0.3s ease" }}
              />
            );
          })}

          {/* Selected arc overlay */}
          {selectedFlight && AIRPORT_COORDS[selectedFlight.from] && AIRPORT_COORDS[selectedFlight.to] && (() => {
            const fc = AIRPORT_COORDS[selectedFlight.from];
            const tc = AIRPORT_COORDS[selectedFlight.to];
            const p1 = mercProject(fc.lng, fc.lat, scale, tx, ty);
            const p2 = mercProject(tc.lng, tc.lat, scale, tx, ty);
            return (
              <path
                className="fl-selected-arc"
                d={arcPath(p1, p2)}
                fill="none" stroke="#FFD700" strokeWidth={2.5}
                strokeOpacity={1} filter="url(#glow)"
                strokeLinecap="round" strokeDasharray="6 3"
              />
            );
          })()}

          {/* Airports */}
          {Object.entries(airports).map(([code, coords]) => {
            const p = mercProject(coords.lng, coords.lat, scale, tx, ty);
            const isSel = selectedFlight && (selectedFlight.from === code || selectedFlight.to === code);
            const r = isSel ? dotR * 1.7 : dotR;
            return (
              <g key={code}>
                <circle cx={p.x} cy={p.y} r={r} fill={isSel ? "#FFD700" : "#29B6F6"} filter="url(#glow)" />
                <circle cx={p.x} cy={p.y} r={r * 2.2} fill="none" stroke={isSel ? "#FFD700" : "#29B6F6"} strokeOpacity={0.2} strokeWidth={1} />
                <text x={p.x + r + 4} y={p.y + 4} fill={isSel ? "#FFD700" : "#8fc8e8"}
                  fontSize={Math.max(7, Math.min(10, 8 * (scale / BASE_SCALE) ** 0.25))}
                  fontFamily={FONT} fontWeight="600" letterSpacing={1}>
                  {code}
                </text>
              </g>
            );
          })}
        </g>

        {!mapReady && (
          <g>
            <rect width={W} height={H} fill="#060d18" opacity={0.9} />
            <circle className="fl-loading-dot" cx={W / 2 - 16} cy={H / 2} r={4} fill="#2a4060" />
            <circle className="fl-loading-dot" cx={W / 2} cy={H / 2} r={4} fill="#2a4060" />
            <circle className="fl-loading-dot" cx={W / 2 + 16} cy={H / 2} r={4} fill="#2a4060" />
          </g>
        )}
      </svg>
    </div>
  );
}

// ── Data helpers ─────────────────────────────────────────────────────────────
function parseFlights(data) {
  return data.filter(r => r.From && r.To && r.Date).map((r, i) => ({
    id: i,
    date: r.Date,
    airline: r.Airline?.trim(),
    flight: r.Flight?.trim(),
    from: r.From?.trim().toUpperCase(),
    to: r.To?.trim().toUpperCase(),
    depSched: r["Gate Departure (Scheduled)"],
    depActual: r["Gate Departure (Actual)"],
    arrSched: r["Gate Arrival (Scheduled)"],
    arrActual: r["Gate Arrival (Actual)"],
    aircraft: r["Aircraft Type Name"]?.trim(),
    seat: r.Seat?.trim(),
    seatType: r["Seat Type"]?.trim(),
    cabin: r["Cabin Class"]?.trim(),
    canceled: r.Canceled === "true",
    pnr: r.PNR?.trim(),
  }));
}

function getDelay(sched, actual) {
  if (!sched || !actual) return null;
  return Math.round((new Date(actual) - new Date(sched)) / 60000);
}

function haversine(a, b) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}



// ── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, accent }) {
  return (
    <div className="fl-stat-card" style={{
      background: "linear-gradient(135deg,#0d1825 0%,#111e2e 100%)",
      border: `1px solid ${accent || "#1e2d45"}`,
      borderRadius: 10, padding: "18px 22px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <span style={{ fontSize: 11, color: "#4a6b8a", fontFamily: FONT, letterSpacing: 2, textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: 28, fontFamily: FONT, color: accent || "#e8f4ff", fontWeight: 700, lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: "#3a5570" }}>{sub}</span>}
    </div>
  );
}

// ── Flight Row ───────────────────────────────────────────────────────────────
function FlightRow({ flight, selected, onClick }) {
  const fc = AIRPORT_COORDS[flight.from], tc = AIRPORT_COORDS[flight.to];
  const dist = fc && tc ? Math.round(haversine(fc, tc)) : null;
  const depDelay = getDelay(flight.depSched, flight.depActual);
  const color = AIRLINE_COLORS[flight.airline] || "#aaa";

  return (
    <div
      onClick={onClick}
      className="fl-flight-row"
      style={{
        display: "grid",
        gridTemplateColumns: "90px 1fr 1fr 80px 90px 80px",
        gap: "0 16px",
        alignItems: "center",
        padding: "12px 16px",
        borderRadius: 8,
        cursor: "pointer",
        background: selected ? "rgba(255,215,0,0.07)" : "transparent",
        border: selected ? "1px solid rgba(255,215,0,0.3)" : "1px solid transparent",
        marginBottom: 2,
      }}
    >
      <span style={{ fontFamily: FONT, fontSize: 11, color: "#3a5570" }}>{flight.date?.slice(0, 10)}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 12, color, fontFamily: FONT, letterSpacing: 1 }}>{flight.airline} {flight.flight}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontFamily: FONT, fontSize: 14, color: "#c8dff0", fontWeight: 700 }}>{flight.from}</span>
        <span style={{ color: "#2a4060", fontSize: 10 }}>→</span>
        <span style={{ fontFamily: FONT, fontSize: 14, color: "#c8dff0", fontWeight: 700 }}>{flight.to}</span>
      </div>
      <span style={{ fontFamily: FONT, fontSize: 11, color: "#3a5570", textAlign: "right" }}>{dist ? `${dist.toLocaleString()} km` : "—"}</span>
      <span style={{
        fontSize: 10, fontFamily: FONT, textAlign: "right",
        color: depDelay === null ? "#3a5570" : depDelay > 15 ? "#EF5350" : depDelay > 0 ? "#FFA726" : "#66BB6A",
      }}>
        {depDelay === null ? "—" : depDelay > 0 ? `+${depDelay}m` : depDelay < 0 ? `${depDelay}m` : "On time"}
      </span>
      <span style={{ fontSize: 10, color: "#2a4060", fontFamily: FONT, textAlign: "right" }}>
        {flight.aircraft?.replace("Airbus ", "A").replace("Boeing ", "B") || "—"}
      </span>
    </div>
  );
}

// ── Detail Panel ─────────────────────────────────────────────────────────────
function DetailPanel({ flight, onClose }) {
  const fc = AIRPORT_COORDS[flight.from], tc = AIRPORT_COORDS[flight.to];
  const dist = fc && tc ? Math.round(haversine(fc, tc)) : null;
  const depDelay = getDelay(flight.depSched, flight.depActual);
  const arrDelay = getDelay(flight.arrSched, flight.arrActual);

  const rows = [
    ["Date", flight.date?.slice(0, 10)],
    ["Flight", `${flight.airline} ${flight.flight}`],
    ["Airline", AIRLINE_NAMES[flight.airline] || flight.airline],
    ["Aircraft", flight.aircraft || "—"],
    ["Seat", flight.seat ? `${flight.seat}${flight.seatType ? ` (${flight.seatType})` : ""}` : "—"],
    ["Cabin", flight.cabin || "—"],
    ["PNR", flight.pnr || "—"],
    ["Distance", dist ? `${dist.toLocaleString()} km` : "—"],
    ["Dep delay", depDelay === null ? "—" : depDelay > 0 ? `+${depDelay} min` : depDelay < 0 ? `${Math.abs(depDelay)} min early` : "On time"],
    ["Arr delay", arrDelay === null ? "—" : arrDelay > 0 ? `+${arrDelay} min` : arrDelay < 0 ? `${Math.abs(arrDelay)} min early` : "On time"],
  ];

  return (
    <div className="fl-detail-panel" style={{
      background: "#0a0f1a", border: "1px solid #1e2d45", borderRadius: 12,
      padding: 20, position: "sticky", top: 20,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={{ fontSize: 10, color: "#2a4060", fontFamily: FONT, letterSpacing: 2 }}>FLIGHT DETAIL</span>
        <button className="fl-btn" onClick={onClose} style={{ background: "none", border: "none", color: "#3a5570", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ textAlign: "center", marginBottom: 20, padding: "16px 0", borderBottom: "1px solid #1a2a3a" }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: "#e8f4ff", fontFamily: FONT, letterSpacing: 4, marginBottom: 4 }}>
          {flight.from} → {flight.to}
        </div>
        <div style={{ fontSize: 11, color: "#3a5570", fontFamily: FONT }}>
          {AIRPORT_COORDS[flight.from]?.city} → {AIRPORT_COORDS[flight.to]?.city}
        </div>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 10, color: "#2a4060", fontFamily: FONT, letterSpacing: 1 }}>{label}</span>
          <span style={{ fontSize: 11, color: "#8fc8e8", fontFamily: FONT, textAlign: "right", maxWidth: 160 }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function FlightLog() {
  const [flights, setFlights] = useState([]);
  const [selectedFlight, setSelectedFlight] = useState(null);
  const [activeTab, setActiveTab] = useState("map");
  const [filterAirline, setFilterAirline] = useState("ALL");
  const [filterYear, setFilterYear] = useState("ALL");
  const [dragOver, setDragOver] = useState(false);
  const [countryGeoms, setCountryGeoms] = useState([]);
  const [mapReady, setMapReady] = useState(false);
  const fileInputRef = useRef(null);

  // Load world map once at startup
  useEffect(() => {
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then(r => r.json())
      .then(world => {
        const countries = topojson.feature(world, world.objects.countries);
        setCountryGeoms(countries.features.map(f => f.geometry).filter(Boolean));
        setMapReady(true);
      })
      .catch(() => setMapReady(true));
  }, []);

  const today = new Date("2026-05-30");
  const past = flights.filter(f => new Date(f.date) <= today);
  const upcoming = flights.filter(f => new Date(f.date) > today);

  const totalKm = past.reduce((acc, f) => {
    const fc = AIRPORT_COORDS[f.from], tc = AIRPORT_COORDS[f.to];
    return acc + (fc && tc ? haversine(fc, tc) : 0);
  }, 0);

  const airlines = [...new Set(flights.map(f => f.airline))].sort();
  const years = [...new Set(flights.map(f => f.date?.slice(0, 4)))].sort();
  const filtered = flights.filter(f =>
    (filterAirline === "ALL" || f.airline === filterAirline) &&
    (filterYear === "ALL" || f.date?.startsWith(filterYear))
  );

  const delays = past.filter(f => { const d = getDelay(f.depSched, f.depActual); return d !== null && d > 0; });
  const avgDelay = delays.length > 0
    ? Math.round(delays.reduce((a, f) => a + getDelay(f.depSched, f.depActual), 0) / delays.length) : 0;

  const airlineCounts = {};
  past.forEach(f => { airlineCounts[f.airline] = (airlineCounts[f.airline] || 0) + 1; });
  const topAirline = Object.entries(airlineCounts).sort((a, b) => b[1] - a[1])[0];

  function processFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      if (file.name.toLowerCase().endsWith(".csv")) {
        const p = parseFlights(parseCSV(text));
        if (p.length) { setFlights(p); setSelectedFlight(null); }
      } else if (file.name.toLowerCase().endsWith(".json")) {
        try {
          const data = JSON.parse(text);
          const arr = Array.isArray(data) ? data : data.flights || [];
          const p = parseFlights(arr);
          if (p.length) { setFlights(p); setSelectedFlight(null); }
        } catch { }
      }
    };
    reader.readAsText(file);
  }

  const tabStyle = tab => ({
    padding: "8px 20px", borderRadius: 6, border: "none", cursor: "pointer",
    fontFamily: FONT, fontSize: 11, letterSpacing: 2, textTransform: "uppercase",
    background: activeTab === tab ? "#FFD700" : "transparent",
    color: activeTab === tab ? "#0a0f1a" : "#3a5570",
    fontWeight: activeTab === tab ? 700 : 400,
  });

  return (
    <div style={{ minHeight: "100vh", background: "#070d18", color: "#c8dff0", fontFamily: FONT, padding: 0 }}>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1a2a3a", padding: "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "linear-gradient(180deg,#0d1825 0%,#070d18 100%)" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 20 }}>✈</span>
            <span style={{ fontSize: 20, fontWeight: 700, color: "#e8f4ff", letterSpacing: 3, fontFamily: FONT }}>FLIGHTING</span>
          </div>
          <div style={{ fontSize: 10, color: "#2a4060", letterSpacing: 2, marginTop: 2, fontFamily: FONT }}>PERSONAL AVIATION RECORD</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="fl-btn"
            onClick={() => fileInputRef.current?.click()}
            onDrop={e => { e.preventDefault(); setDragOver(false); processFile(e.dataTransfer.files[0]); }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            style={{ padding: "8px 16px", background: dragOver ? "rgba(255,215,0,0.15)" : "rgba(255,215,0,0.08)", border: `1px solid ${dragOver ? "#FFD700" : "rgba(255,215,0,0.3)"}`, borderRadius: 6, color: "#FFD700", fontSize: 10, letterSpacing: 2, cursor: "pointer", fontFamily: FONT }}
          >
            ↑ IMPORT CSV / JSON
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,.json" style={{ display: "none" }} onChange={e => { processFile(e.target.files[0]); e.target.value = ""; }} />
          <button
            className="fl-btn"
            onClick={() => { setFlights([]); setSelectedFlight(null); setFilterAirline("ALL"); setFilterYear("ALL"); }}
            style={{ padding: "8px 16px", background: "rgba(239,83,80,0.08)", border: "1px solid rgba(239,83,80,0.25)", borderRadius: 6, color: "#EF5350", fontSize: 10, letterSpacing: 2, cursor: "pointer", fontFamily: FONT }}
          >
            ✕ CLEAR
          </button>
        </div>
      </div>

      {flights.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "70vh", gap: 16 }}>
          <div style={{ fontSize: 48, opacity: 0.15 }}>✈</div>
          <div style={{ color: "#2a4060", letterSpacing: 3, fontFamily: FONT }}>NO FLIGHT DATA</div>
          <div style={{ fontSize: 11, color: "#1a3050", fontFamily: FONT }}>Import a Flighty CSV or JSON export to get started</div>
          <button className="fl-btn" onClick={() => fileInputRef.current?.click()} style={{ marginTop: 8, padding: "10px 24px", background: "rgba(255,215,0,0.08)", border: "1px solid rgba(255,215,0,0.3)", borderRadius: 6, color: "#FFD700", fontSize: 11, letterSpacing: 2, cursor: "pointer", fontFamily: FONT }}>
            ↑ IMPORT FILE
          </button>
        </div>
      ) : (
        <>
          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, padding: "20px 32px 0" }}>
            <StatCard label="Total Flights" value={past.length} sub={`${upcoming.length} upcoming`} accent="#29B6F6" />
            <StatCard label="Km Flown" value={`${Math.round(totalKm / 1000).toLocaleString()}k`} sub="kilometers" accent="#FFD700" />
            <StatCard label="Countries" value={[...new Set(past.flatMap(f => [AIRPORT_COORDS[f.from]?.country, AIRPORT_COORDS[f.to]?.country]).filter(Boolean))].length} sub="visited" accent="#66BB6A" />
            <StatCard label="Top Airline" value={topAirline?.[0] || "—"} sub={`${topAirline?.[1] || 0} flights`} accent="#CE93D8" />
            <StatCard label="Avg Delay" value={`${avgDelay}m`} sub={`${delays.length} delayed`} accent={avgDelay > 20 ? "#EF5350" : "#FFA726"} />
          </div>

          {/* Tabs + Filters */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 32px 12px" }}>
            <div style={{ display: "flex", gap: 4, background: "#0d1825", borderRadius: 8, padding: 4 }}>
              {["map", "flights", "airlines"].map(t => (
                <button key={t} className="fl-tab-btn" style={tabStyle(t)} onClick={() => setActiveTab(t)}>{t}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[["filterYear", filterYear, setFilterYear, "ALL YEARS", years],
              ["filterAirline", filterAirline, setFilterAirline, "ALL AIRLINES", airlines]
              ].map(([key, val, set, placeholder, opts]) => (
                <select key={key} value={val} onChange={e => set(e.target.value)}
                  style={{ background: "#0d1825", border: "1px solid #1e2d45", color: "#8fc8e8", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontFamily: FONT, letterSpacing: 1, cursor: "pointer" }}>
                  <option value="ALL">{placeholder}</option>
                  {opts.map(o => <option key={o} value={o}>{key === "filterAirline" ? `${o} – ${AIRLINE_NAMES[o] || o}` : o}</option>)}
                </select>
              ))}
            </div>
          </div>

          {/* Content */}
          <div style={{ padding: "0 32px 32px", display: "grid", gridTemplateColumns: selectedFlight ? "1fr 300px" : "1fr", gap: 16, alignItems: "start" }}>
            <div className="fl-tab-content" key={activeTab}>
              {activeTab === "map" && (
                <>
                  <WorldMap flights={filtered} selectedFlight={selectedFlight} countryGeoms={countryGeoms} mapReady={mapReady} />
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 10, color: "#2a4060", letterSpacing: 2, marginBottom: 8, fontFamily: FONT }}>RECENT FLIGHTS</div>
                    {filtered.slice(0, 20).map(f => (
                      <FlightRow key={f.id} flight={f} selected={selectedFlight?.id === f.id} onClick={() => setSelectedFlight(selectedFlight?.id === f.id ? null : f)} />
                    ))}
                  </div>
                </>
              )}

              {activeTab === "flights" && (
                <div style={{ background: "#0a0f1a", border: "1px solid #1e2d45", borderRadius: 12, padding: 16 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr 80px 90px 80px", gap: "0 16px", padding: "8px 16px", marginBottom: 8 }}>
                    {["DATE", "FLIGHT", "ROUTE", "DIST", "DEP DELAY", "AIRCRAFT"].map(h => (
                      <span key={h} style={{ fontSize: 9, color: "#2a4060", letterSpacing: 2, fontFamily: FONT }}>{h}</span>
                    ))}
                  </div>
                  <div style={{ maxHeight: 520, overflowY: "auto" }}>
                    {filtered.map(f => (
                      <FlightRow key={f.id} flight={f} selected={selectedFlight?.id === f.id} onClick={() => setSelectedFlight(selectedFlight?.id === f.id ? null : f)} />
                    ))}
                  </div>
                  <div style={{ marginTop: 12, fontSize: 10, color: "#2a4060", textAlign: "right", fontFamily: FONT }}>{filtered.length} flights</div>
                </div>
              )}

              {activeTab === "airlines" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {airlines.map(airline => {
                    const af = filtered.filter(f => f.airline === airline);
                    const pastAf = af.filter(f => new Date(f.date) <= today);
                    const km = pastAf.reduce((acc, f) => {
                      const fc = AIRPORT_COORDS[f.from], tc = AIRPORT_COORDS[f.to];
                      return acc + (fc && tc ? haversine(fc, tc) : 0);
                    }, 0);
                    const color = AIRLINE_COLORS[airline] || "#aaa";
                    return (
                      <div key={airline} className="fl-airline-card" style={{ background: "#0a0f1a", border: "1px solid #1e2d45", borderRadius: 10, padding: 20 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, color, letterSpacing: 2, fontFamily: FONT }}>{airline}</div>
                            <div style={{ fontSize: 10, color: "#3a5570", marginTop: 2, fontFamily: FONT }}>{AIRLINE_NAMES[airline] || airline}</div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 22, fontWeight: 700, color: "#e8f4ff", fontFamily: FONT }}>{af.length}</div>
                            <div style={{ fontSize: 9, color: "#3a5570", letterSpacing: 1, fontFamily: FONT }}>FLIGHTS</div>
                          </div>
                        </div>
                        <div style={{ background: "#0d1825", borderRadius: 4, height: 4, marginBottom: 12, overflow: "hidden" }}>
                          <div style={{ width: `${Math.min((km / 30000) * 100, 100)}%`, background: color, height: "100%", borderRadius: 4, transition: "width 0.6s ease" }} />
                        </div>
                        <div style={{ fontSize: 10, color: "#3a5570", fontFamily: FONT }}>{Math.round(km).toLocaleString()} km flown</div>
                        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {[...new Set(af.flatMap(f => [f.from, f.to]))].map(code => (
                            <span key={code} style={{ fontSize: 9, padding: "2px 6px", background: "rgba(255,255,255,0.04)", border: "1px solid #1e2d45", borderRadius: 3, color: "#4a6b8a", letterSpacing: 1, fontFamily: FONT }}>{code}</span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Detail panel */}
            {selectedFlight && <DetailPanel flight={selectedFlight} onClose={() => setSelectedFlight(null)} />}
          </div>
        </>
      )}
    </div>
  );
}
