/* app.jsx — GitHub Pages + Babel Standalone compatible (NO imports/exports)
   Requires in index.html:
   - React UMD
   - ReactDOM UMD
   - Babel Standalone
   - JSZip UMD (window.JSZip)
   - FileSaver UMD (window.saveAs)
*/

const { useMemo, useState } = React;

// ============================
// Config / Constants
// ============================
const APP_VERSION = "2026-02-02-CSV";

// Matches the "working TL" format you provided:
const APP_CODE = "TL";
const SENDER_ID = "9979383000006";
const RECIPIENT_ID = "9906629000002";

const SLOT_MS = 15 * 60 * 1000;
const SLOTS_PER_DAY = 96;
const LIMIT_MB = 50;

// ============================
// Helpers
// ============================
function pad(n, size = 2) {
  const s = String(n);
  return s.length >= size ? s : "0".repeat(size - s.length) + s;
}

// UTC EDIFACT date-time with "?+00" + :303 qualifier.
// IMPORTANT: must be UTC to match your working MSCONS examples.
function formatEdifactDateTime(date) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  return `${y}${m}${d}${hh}${mm}?+00`;
}

function seg(tag, ...parts) {
  return `${tag}+${parts.filter((p) => p !== undefined && p !== null).join("+")}'`;
}

// ----------------------------
// CSV helper: parse "DD.MM.YYYY HH:MM;15,024" (kWh per 15 min)
// output: [{dayKey,start,end,values(96)}]
// ----------------------------
function parseQuarterHourCSV(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];
  for (const line of lines) {
    // skip obvious headers
    if (line.toLowerCase().includes("datum") || line.toLowerCase().includes("date")) continue;

    // Expected: "DD.MM.YYYY HH:MM;15,024"
    const parts = line.split(";");
    if (parts.length < 2) continue;

    const left = parts[0].trim();               // "DD.MM.YYYY HH:MM"
    const valStrRaw = parts[1].trim();          // "15,024"
    const valStr = valStrRaw.replace(",", "."); // "15.024"

    const m = left.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!m) continue;

    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yy = Number(m[3]);
    const HH = Number(m[4]);
    const MM = Number(m[5]);

    // local timestamp = interval START
    const ts = new Date(yy, mm - 1, dd, HH, MM);

    const v = Number(valStr);
    rows.push({ ts, v: Number.isFinite(v) ? v : 0 });
  }

  rows.sort((a, b) => a.ts - b.ts);

  // group by local day
  const byDay = new Map(); // key YYYY-MM-DD -> array of {ts,v}
  for (const r of rows) {
    const k = `${r.ts.getFullYear()}-${pad(r.ts.getMonth() + 1)}-${pad(r.ts.getDate())}`;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }

  // build 96-value arrays per day (fill missing with 0)
  const days = Array.from(byDay.keys()).sort();
  const result = [];

  for (const dayKey of days) {
    const [Y, M, D] = dayKey.split("-").map(Number);
    const start = new Date(Y, M - 1, D, 0, 0, 0, 0);

    // expected 96 timestamps (local)
    const expected = new Map();
    for (let i = 0; i < 96; i++) {
      const t = new Date(start.getTime() + i * SLOT_MS);
      expected.set(t.getTime(), 0);
    }

    for (const r of byDay.get(dayKey)) {
      const tms = r.ts.getTime();
      if (expected.has(tms)) expected.set(tms, r.v);
    }

    const values = [];
    for (let i = 0; i < 96; i++) {
      const t = new Date(start.getTime() + i * SLOT_MS);
      values.push(expected.get(t.getTime()) || 0);
    }

    result.push({
      dayKey,
      start,
      end: new Date(start.getTime() + 24 * 3600 * 1000),
      values,
    });
  }

  return result;
}

// ============================
// Core MSCONS builder
// ============================
function buildMSCONS(options) {
  const { malo, obis, start, end, values } = options;
  const ts = new Date();
  const rand = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  const docId = `D${rand}`;
  const msgRef = `MS${rand}${pad(ts.getUTCSeconds(), 2)}`;

  const segments = [];
  segments.push("UNA:+.? '");
  segments.push(
    seg(
      "UNB",
      "UNOC:3",
      `${SENDER_ID}:500`,
      `${RECIPIENT_ID}:500`,
      `${pad(ts.getUTCFullYear() % 100)}${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())}:${pad(ts.getUTCHours())}${pad(ts.getUTCMinutes())}`,
      docId,
      "",
      APP_CODE
    )
  );

  const msg = [];
  msg.push(seg("UNH", msgRef, "MSCONS:D:04B:UN:2.4c"));
  msg.push(seg("BGM", "Z48", msgRef, "9"));
  msg.push(seg("DTM", `137:${formatEdifactDateTime(ts)}:303`));
  msg.push(seg("RFF", "Z13:13025"));
  msg.push(seg("NAD", "MS", `${SENDER_ID}::293`));
  msg.push(seg("NAD", "MR", `${RECIPIENT_ID}::293`));
  msg.push(seg("UNS", "D"));
  msg.push(seg("NAD", "DP"));
  msg.push(seg("LOC", "172", malo));
  msg.push(seg("DTM", `163:${formatEdifactDateTime(start)}:303`));
  msg.push(seg("DTM", `164:${formatEdifactDateTime(end)}:303`));
  msg.push(seg("LIN", "1"));
  msg.push(seg("PIA", "5", `1-0?:${obis}:SRW`));

  let t = new Date(start.getTime());
  for (const v of values) {
    const tNext = new Date(t.getTime() + SLOT_MS);
    msg.push(seg("QTY", `220:${Number(v.toFixed(3))}`));
    msg.push(seg("DTM", `163:${formatEdifactDateTime(t)}:303`));
    msg.push(seg("DTM", `164:${formatEdifactDateTime(tNext)}:303`));
    t = tNext;
  }
  msg.push(seg("UNT", String(msg.length + 1), msgRef));

  segments.push.apply(segments, msg);
  segments.push(seg("UNZ", "1", docId));
  return segments.join("");
}


// ============================
// (SLP / PV placeholders - kept minimal)
// ============================
function makeSLPValues(slots, dailyKWh) {
  return new Array(slots).fill(dailyKWh / slots);
}
function makePVProfile(slots) {
  return new Array(slots).fill(0);
}

// ============================
// UI Component
// ============================
function MSCONSGenerator() {
  const JSZip = window.JSZip;
  const saveAs = window.saveAs;

  const [date, setDate] = useState("2025-08-01");
  const [mode, setMode] = useState("slp"); // "slp" | "csv"

  const [csvName, setCsvName] = useState("");
  const [csvDays, setCsvDays] = useState([]);
  const [csvError, setCsvError] = useState("");
  const [csvLocId, setCsvLocId] = useState("DE913000000000000000000000000000X");
  const [csvDirection, setCsvDirection] = useState("consumption"); // consumption|generation

  const [days, setDays] = useState(31);
  const [rawMalos, setRawMalos] = useState("50226092026\n51620926184\n50234152284");

  const defaults = useMemo(
    () => ({
      slp: "H0",
      expectedAnnualKWh: 7300,
      noisePct: 6,
      direction: "consumption",
      pvPeakKW: 4,
    }),
    []
  );

  const [configs, setConfigs] = useState([]);
  const [fallbackLinks, setFallbackLinks] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const maloList = useMemo(() => {
    return Array.from(
      new Set(
        rawMalos
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
  }, [rawMalos]);

  async function handleCsvFile(file) {
    setCsvError("");
    setCsvName(file ? file.name : "");
    setCsvDays([]);
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = parseQuarterHourCSV(text);

      if (!parsed.length) {
        throw new Error("CSV enthält keine lesbaren Zeilen. Erwartet: DD.MM.YYYY HH:MM;15,024");
      }

      // Hard validation: every day must have 96 values and no NaNs
      for (const d of parsed) {
        if (!d.values || d.values.length !== 96) {
          throw new Error(`Tag ${d.dayKey} hat nicht exakt 96 Werte (hat ${d.values ? d.values.length : 0}).`);
        }
        if (d.values.some((v) => !Number.isFinite(v))) {
          throw new Error(`Tag ${d.dayKey} enthält ungültige Werte (NaN).`);
        }
      }

      setCsvDays(parsed);
    } catch (e) {
      setCsvError(String(e && e.message ? e.message : e));
    }
  }

  function addDefaultConfigs() {
    const next = maloList.map((m) => ({
      malo: m,
      direction: defaults.direction,
      expectedAnnualKWh: defaults.expectedAnnualKWh,
    }));
    setConfigs(next);
  }

  async function handleGenerateZip() {
    if (!JSZip) {
      alert("JSZip fehlt. Prüfe, ob jszip.min.js in index.html geladen wird.");
      return;
    }
    if (!saveAs) {
      alert("FileSaver (saveAs) fehlt. Prüfe, ob FileSaver.min.js in index.html geladen wird.");
      return;
    }

    setIsGenerating(true);
    try {
      const masterZip = new JSZip();

      // =========================
      // CSV → MSCONS (1:1 mode)
      // =========================
      if (mode === "csv") {
        if (!csvDays.length) {
          alert("Bitte zuerst eine CSV hochladen (kWh pro 15 min).");
          return;
        }

        const locId = (csvLocId || "").trim();
        if (!locId) {
          alert("Bitte eine Location-ID (MeLo) für LOC+172 angeben.");
          return;
        }

        const direction = csvDirection;
        const obis = direction === "generation" ? "2.8.0" : "1.8.0";
        const kind = direction === "generation" ? "ERZEUGUNG" : "VERBRAUCH";

        const allFiles = [];

        for (const d of csvDays) {
          const ymd = d.dayKey.replace(/-/g, "");
          const name =
            "MSCONS_" +
            APP_CODE +
            "_" +
            SENDER_ID +
            "_" +
            RECIPIENT_ID +
            "_" +
            ymd +
            "_" +
            locId +
            "_" +
            kind +
            ".txt";

          // Market-compatible settlement day (DE): 22:00 UTC to 22:00 UTC
          const startBase = new Date(`${d.dayKey}T22:00:00Z`);
          const endBase = new Date(startBase.getTime() + 24 * 3600 * 1000);

          const content = buildMSCONS({
            locId,
            obis,
            start: startBase,
            end: endBase,
            values: d.values,
          });

          allFiles.push({ name, content, month: ymd.slice(0, 6) });
        }

        // size check (rough)
        const approxBytes = allFiles.reduce((sum, f) => sum + f.content.length, 0);
        const limitBytes = LIMIT_MB * 1024 * 1024;
        if (approxBytes > limitBytes) {
          const proceed = window.confirm(
            `Du erzeugst ca. ${(approxBytes / (1024 * 1024)).toFixed(1)} MB (> ${LIMIT_MB} MB). Fortfahren?`
          );
          if (!proceed) return;
        }

        // Monthly ZIPs
        const months = Array.from(new Set(allFiles.map((f) => f.month))).sort();
        const monthZips = [];

        for (const m of months) {
          const z = new JSZip();
          allFiles
            .filter((f) => f.month === m)
            .forEach((f) => z.file(f.name, f.content));

          const blob = await z.generateAsync({ type: "blob" });
          const zipName =
            "MSCONS_" +
            APP_CODE +
            "_" +
            SENDER_ID +
            "_" +
            RECIPIENT_ID +
            "_" +
            m +
            "_" +
            locId +
            "_" +
            kind +
            "_CSV.zip";

          monthZips.push({ name: zipName, blob });
        }

        // Master ZIP
        allFiles.forEach((f) => masterZip.file(f.name, f.content));
        const masterBlob = await masterZip.generateAsync({ type: "blob" });
        const masterName =
          "MSCONS_" +
          APP_CODE +
          "_" +
          SENDER_ID +
          "_" +
          RECIPIENT_ID +
          "_" +
          months[0] +
          "-" +
          months[months.length - 1] +
          "_" +
          locId +
          "_" +
          kind +
          "_CSV_master.zip";

        saveAs(masterBlob, masterName);

        // Also show direct month download links
        const links = [
          { name: masterName, href: URL.createObjectURL(masterBlob) },
          ...monthZips.map((z) => ({ name: z.name, href: URL.createObjectURL(z.blob) })),
        ];
        setFallbackLinks(links);
        return;
      }

      // =========================
      // SLP mode (minimal placeholder)
      // =========================
      const startBase = new Date(date + "T00:00:00"); // local day start
      const allFiles = [];

      configs.forEach((cfg) => {
        for (let d = 0; d < days; d++) {
          const start = new Date(startBase.getTime() + d * 24 * 3600 * 1000);
          const end = new Date(start.getTime() + 24 * 3600 * 1000);
          const ymd =
            start.getFullYear().toString() +
            pad(start.getMonth() + 1) +
            pad(start.getDate());

          const vals = makeSLPValues(96, (cfg.expectedAnnualKWh || defaults.expectedAnnualKWh) / 365);

          const content = buildMSCONS({
            locId: cfg.malo,
            obis: "1.8.0",
            start,
            end,
            values: vals,
          });

          const name =
            "MSCONS_" +
            APP_CODE +
            "_" +
            SENDER_ID +
            "_" +
            RECIPIENT_ID +
            "_" +
            ymd +
            "_" +
            cfg.malo +
            "_VERBRAUCH.txt";

          allFiles.push({ malo: cfg.malo, name, content });
        }
      });

      allFiles.forEach((f) => masterZip.file(f.name, f.content));
      const masterBlob = await masterZip.generateAsync({ type: "blob" });
      const masterName = "MSCONS_" + date.replace(/-/g, "") + "_" + configs.length + "MaLo_master.zip";
      saveAs(masterBlob, masterName);

      setFallbackLinks([{ name: masterName, href: URL.createObjectURL(masterBlob) }]);
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>MSCONS Generator</div>
            <div style={{ opacity: 0.8, fontSize: 13 }}>Version: {APP_VERSION}</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button onClick={addDefaultConfigs} disabled={mode === "csv"}>
              Load MaLo list
            </button>
            <button className="primary" onClick={handleGenerateZip} disabled={isGenerating}>
              {isGenerating ? "Generating..." : "Generate ZIP"}
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong>Mode</strong>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="radio" name="mode" checked={mode === "slp"} onChange={() => setMode("slp")} />
            SLP Generator
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="radio" name="mode" checked={mode === "csv"} onChange={() => setMode("csv")} />
            CSV → MSCONS (1:1 kWh/15min)
          </label>
        </div>

        {mode === "csv" && (
          <div style={{ marginTop: 10 }}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>CSV file (kWh per 15 min)</span>
                <input type="file" accept=".csv,text/csv" onChange={(e) => handleCsvFile(e.target.files && e.target.files[0])} />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 420 }}>
                <span>Location ID for LOC+172 (MeLo)</span>
                <input value={csvLocId} onChange={(e) => setCsvLocId(e.target.value)} placeholder="DE913000000000000000000000000000X" />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Direction</span>
                <select value={csvDirection} onChange={(e) => setCsvDirection(e.target.value)}>
                  <option value="consumption">Verbrauch (1.8.0)</option>
                  <option value="generation">Erzeugung (2.8.0)</option>
                </select>
              </label>
            </div>

            <div className="help">
              {csvName ? (
                <span>
                  Loaded: <strong>{csvName}</strong> — Days: <strong>{csvDays.length}</strong>
                </span>
              ) : (
                <span>Upload one CSV. The generator will create one TXT per day, then ZIPs per month.</span>
              )}
            </div>

            {csvError && (
              <div className="error" style={{ marginTop: 8 }}>
                {csvError}
              </div>
            )}
          </div>
        )}
      </div>

      {mode === "slp" && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Start date</span>
              <input value={date} onChange={(e) => setDate(e.target.value)} />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>Days</span>
              <input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} />
            </label>
          </div>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>MaLo list</div>
            <textarea style={{ width: "100%", minHeight: 120 }} value={rawMalos} onChange={(e) => setRawMalos(e.target.value)} />
          </div>
        </div>
      )}

      {fallbackLinks.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Downloads</div>
          <ul>
            {fallbackLinks.map((l) => (
              <li key={l.name}>
                <a href={l.href} download={l.name}>
                  {l.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ============================
// Mount to DOM (NO export)
// ============================
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<MSCONSGenerator />);
