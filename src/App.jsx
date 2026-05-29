import { useState, useRef, useEffect } from "react";

const STORAGE_KEY = "fofabetes_logs";
const SETTINGS_KEY = "fofabetes_settings";
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const defaultSettings = { ic_ratio: 15, target_glucose: 120, correction_factor: 50 };

function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Falha ao ler arquivo"));
    r.readAsDataURL(file);
  });
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function groupByDay(logs) {
  const groups = {};
  logs.forEach(l => {
    const day = new Date(l.ts).toLocaleDateString("pt-BR");
    if (!groups[day]) groups[day] = [];
    groups[day].push(l);
  });
  return groups;
}

function parseGeminiJSON(text) {
  // remove markdown code fences in all variations
  let clean = text.replace(/```[\w]*\n?/g, "").replace(/```/g, "").trim();
  // try direct parse
  try { return JSON.parse(clean); } catch {}
  // try extracting first {...} block
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("JSON não encontrado na resposta");
}

const PROMPT = `Você é um especialista em nutrição e contagem de carboidratos para pacientes com diabetes tipo 1.
Analise os alimentos informados e estime os carboidratos de cada item.
Responda APENAS em JSON puro, sem markdown, sem blocos de código, no seguinte formato:
{"items":[{"name":"Nome do alimento","portion":"porção estimada","cho":número}],"total_cho":número,"notes":"observações sobre incertezas"}
Seja conservador nas estimativas. Se não conseguir identificar algum item, inclua com cho: 0 e anote nas observações.`;

export default function App() {
  const [screen, setScreen] = useState("home");
  const [settings, setSettings] = useState(defaultSettings);
  const [logs, setLogs] = useState([]);
  // analyze state
  const [inputMode, setInputMode] = useState("photo"); // "photo" | "text"
  const [imgFile, setImgFile] = useState(null);
  const [imgPreview, setImgPreview] = useState(null);
  const [textInput, setTextInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [glucose, setGlucose] = useState("");
  const [manualCHO, setManualCHO] = useState("");
  const [saved, setSaved] = useState(false);
  // manual diary entry
  const [manualScreen, setManualScreen] = useState(false);
  const [manualForm, setManualForm] = useState({ desc: "", cho: "", glucose: "", usedRapid: false });
  const fileRef = useRef();

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) setLogs(JSON.parse(s));
      const cfg = localStorage.getItem(SETTINGS_KEY);
      if (cfg) setSettings(JSON.parse(cfg));
    } catch {}
  }, []);

  function saveLogs(next) {
    setLogs(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  }

  function saveSettings(next) {
    setSettings(next);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
  }

  function resetAnalyze() {
    setImgFile(null); setImgPreview(null); setTextInput("");
    setResult(null); setSaved(false); setManualCHO(""); setGlucose("");
  }

  function handleFile(e) {
    const f = e.target.files[0];
    if (!f) return;
    setImgFile(f);
    setImgPreview(URL.createObjectURL(f));
    setResult(null); setSaved(false); setManualCHO(""); setGlucose("");
  }

  async function analyze() {
    setLoading(true); setResult(null);
    try {
      let parts = [];
      if (inputMode === "photo" && imgFile) {
        const b64 = await toBase64(imgFile);
        parts = [
          { inline_data: { mime_type: imgFile.type || "image/jpeg", data: b64 } },
          { text: "Analise esta foto de uma refeição e estime os carboidratos de cada alimento visível.\n" + PROMPT }
        ];
      } else {
        parts = [{ text: `Os alimentos da refeição são: ${textInput}\n${PROMPT}` }];
      }
      const resp = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1 }
        })
      });
      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const parsed = parseGeminiJSON(text);
      setResult(parsed);
      setManualCHO(String(parsed.total_cho));
    } catch (err) {
      setResult({ error: "Não foi possível analisar. Verifique sua conexão ou tente novamente." });
    }
    setLoading(false);
  }

  function calcInsulin(cho, gluc) {
    const choNum = parseFloat(cho) || 0;
    const glucNum = parseFloat(gluc) || 0;
    const mealDose = choNum / settings.ic_ratio;
    const corrDose = glucNum > settings.target_glucose ? (glucNum - settings.target_glucose) / settings.correction_factor : 0;
    return { meal: mealDose.toFixed(1), corr: corrDose.toFixed(1), total: (mealDose + corrDose).toFixed(1) };
  }

  function handleSave() {
    if (!result || result.error) return;
    const cho = parseFloat(manualCHO) || 0;
    const gluc = parseFloat(glucose) || null;
    const insulin = calcInsulin(manualCHO, glucose);
    saveLogs([{ id: Date.now(), ts: Date.now(), imgPreview, items: result.items, cho, glucose: gluc, insulin: parseFloat(insulin.total), usedRapid: parseFloat(glucose) > 200, notes: result.notes }, ...logs]);
    setSaved(true);
  }

  function handleManualSave() {
    const cho = parseFloat(manualForm.cho) || 0;
    const gluc = parseFloat(manualForm.glucose) || null;
    const insulin = calcInsulin(manualForm.cho, manualForm.glucose);
    saveLogs([{ id: Date.now(), ts: Date.now(), imgPreview: null, items: [{ name: manualForm.desc || "Refeição manual", portion: "—", cho }], cho, glucose: gluc, insulin: parseFloat(insulin.total), usedRapid: manualForm.usedRapid, notes: "" }, ...logs]);
    setManualForm({ desc: "", cho: "", glucose: "", usedRapid: false });
    setManualScreen(false);
    setScreen("diary");
  }

  function deleteLog(id) { saveLogs(logs.filter(l => l.id !== id)); }

  const insulin = result && !result.error ? calcInsulin(manualCHO, glucose) : null;
  const canAnalyze = inputMode === "photo" ? !!imgFile : textInput.trim().length > 3;

  // ── SETTINGS ──
  if (screen === "settings") return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => setScreen("home")} style={s.back}>←</button>
        <span style={s.headerTitle}>Configurações</span>
      </div>
      <div style={s.content}>
        <div style={s.card}>
          <p style={s.label}>Razão insulina:carboidrato (I:C)</p>
          <p style={s.hint}>1 unidade para cada X gramas de CHO</p>
          <input style={s.input} type="number" value={settings.ic_ratio} onChange={e => saveSettings({ ...settings, ic_ratio: parseFloat(e.target.value) || 15 })} />
          <p style={{ ...s.label, marginTop: 14 }}>Glicemia-alvo (mg/dL)</p>
          <input style={s.input} type="number" value={settings.target_glucose} onChange={e => saveSettings({ ...settings, target_glucose: parseFloat(e.target.value) || 120 })} />
          <p style={{ ...s.label, marginTop: 14 }}>Fator de sensibilidade (mg/dL por unidade)</p>
          <p style={s.hint}>Quanto 1 unidade de insulina reduz a glicemia</p>
          <input style={s.input} type="number" value={settings.correction_factor} onChange={e => saveSettings({ ...settings, correction_factor: parseFloat(e.target.value) || 50 })} />
        </div>
        <div style={{ ...s.card, background: "#fff8e1", borderColor: "#f59e0b" }}>
          <p style={{ ...s.hint, color: "#92400e" }}>⚕️ Estes valores devem ser definidos com a equipe médica da Aurora. O app oferece estimativas — sempre confirme com o endocrinologista.</p>
        </div>
      </div>
    </div>
  );

  // ── MANUAL ENTRY ──
  if (manualScreen) return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => setManualScreen(false)} style={s.back}>←</button>
        <span style={s.headerTitle}>Registro Manual</span>
      </div>
      <div style={s.content}>
        <div style={s.card}>
          <p style={s.label}>Descrição da refeição</p>
          <input style={s.input} type="text" placeholder="Ex: arroz, feijão, frango grelhado" value={manualForm.desc} onChange={e => setManualForm({ ...manualForm, desc: e.target.value })} />
          <p style={{ ...s.label, marginTop: 14 }}>Total de carboidratos (g)</p>
          <input style={s.input} type="number" placeholder="0" value={manualForm.cho} onChange={e => setManualForm({ ...manualForm, cho: e.target.value })} />
          <p style={{ ...s.label, marginTop: 14 }}>Glicemia pré-prandial (mg/dL)</p>
          <input style={s.input} type="number" placeholder="---" value={manualForm.glucose} onChange={e => setManualForm({ ...manualForm, glucose: e.target.value, usedRapid: parseFloat(e.target.value) > 200 })} />
          {manualForm.glucose && (
            <p style={{ ...s.hint, marginTop: 6, color: parseFloat(manualForm.glucose) > 200 ? "#b91c1c" : "#166534", fontWeight: 600 }}>
              {parseFloat(manualForm.glucose) > 200 ? "⚠️ Acima de 200 — insulina rápida indicada" : "✓ Abaixo de 200 — apenas basal"}
            </p>
          )}
        </div>
        {manualForm.cho && (
          <div style={{ ...s.card, background: "#f0fdf4", borderColor: "#86efac" }}>
            <p style={s.sectionTitle}>💉 Dose estimada</p>
            <p style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#166534" }}>{calcInsulin(manualForm.cho, manualForm.glucose).total}U</p>
          </div>
        )}
        <div style={{ ...s.card, background: "#fff8e1", borderColor: "#f59e0b" }}>
          <p style={{ ...s.hint, color: "#92400e" }}>⚕️ Confirme sempre com a equipe médica antes de aplicar insulina.</p>
        </div>
        <button style={manualForm.cho ? s.btnPrimary : s.btnDisabled} onClick={handleManualSave} disabled={!manualForm.cho}>
          Salvar no diário ✓
        </button>
      </div>
    </div>
  );

  // ── DIARY ──
  if (screen === "diary") {
    const groups = groupByDay(logs);
    const days = Object.keys(groups);
    return (
      <div style={s.page}>
        <div style={s.header}>
          <button onClick={() => setScreen("home")} style={s.back}>←</button>
          <span style={s.headerTitle}>Diário</span>
          <button onClick={() => setManualScreen(true)} style={{ ...s.back, marginLeft: "auto", fontSize: 14, background: "rgba(255,255,255,0.2)", borderRadius: 8, padding: "4px 10px" }}>+ Manual</button>
        </div>
        <div style={s.content}>
          {days.length === 0 && <p style={{ ...s.hint, textAlign: "center", marginTop: 40 }}>Nenhum registro ainda.</p>}
          {days.map(day => {
            const entries = groups[day];
            const totalCHO = entries.reduce((a, e) => a + e.cho, 0);
            return (
              <div key={day}>
                <div style={s.dayHeader}>
                  <span>{day}</span>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>Total: {totalCHO.toFixed(0)}g CHO</span>
                </div>
                {entries.map(e => (
                  <div key={e.id} style={s.logCard}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      {e.imgPreview
                        ? <img src={e.imgPreview} style={s.thumb} alt="prato" />
                        : <div style={{ ...s.thumb, background: "#fce7f3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🍽️</div>
                      }
                      <div style={{ flex: 1 }}>
                        <p style={s.logTime}>{formatDate(e.ts)}</p>
                        <p style={s.logCHO}>{e.cho}g CHO · {e.insulin}U</p>
                        {e.glucose && (
                          <p style={{ margin: 0, fontSize: 12, color: e.usedRapid ? "#b91c1c" : "#166534" }}>
                            {e.usedRapid ? "⚡ insulina rápida aplicada" : "✓ só basal"} · glicemia pré: {e.glucose} mg/dL
                          </p>
                        )}
                        <div style={{ marginTop: 4 }}>
                          {e.items?.map((it, i) => (
                            <span key={i} style={s.tag}>{it.name} {it.cho}g</span>
                          ))}
                        </div>
                      </div>
                      <button onClick={() => deleteLog(e.id)} style={s.del}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── ANALYZE ──
  if (screen === "analyze") return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => { setScreen("home"); resetAnalyze(); }} style={s.back}>←</button>
        <span style={s.headerTitle}>Analisar Refeição</span>
      </div>
      <div style={s.content}>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handleFile} />

        {/* mode toggle */}
        <div style={s.toggle}>
          <button style={inputMode === "photo" ? s.toggleActive : s.toggleInactive} onClick={() => { setInputMode("photo"); setResult(null); }}>📷 Foto</button>
          <button style={inputMode === "text" ? s.toggleActive : s.toggleInactive} onClick={() => { setInputMode("text"); setResult(null); }}>✏️ Texto</button>
        </div>

        {inputMode === "photo" && (
          !imgPreview ? (
            <div style={s.uploadArea} onClick={() => fileRef.current.click()}>
              <div style={{ fontSize: 48 }}>📷</div>
              <p style={s.uploadText}>Toque para fotografar ou escolher da galeria</p>
            </div>
          ) : (
            <div style={{ textAlign: "center" }}>
              <img src={imgPreview} style={s.preview} alt="prato" />
              <button style={s.btnSecondary} onClick={() => { setImgFile(null); setImgPreview(null); setResult(null); setSaved(false); }}>Trocar foto</button>
            </div>
          )
        )}

        {inputMode === "text" && (
          <div style={s.card}>
            <p style={s.label}>Descreva os alimentos da refeição</p>
            <textarea style={{ ...s.input, minHeight: 100, resize: "vertical" }}
              placeholder="Ex: 1 maçã média, 2 colheres de sopa de arroz, 1 filé de tilápia grelhado..."
              value={textInput} onChange={e => setTextInput(e.target.value)} />
          </div>
        )}

        {canAnalyze && !result && (
          <button style={loading ? s.btnDisabled : s.btnPrimary} onClick={analyze} disabled={loading}>
            {loading ? "Analisando... ⏳" : "Calcular carboidratos 🔍"}
          </button>
        )}

        {result?.error && <div style={s.errorCard}>{result.error}</div>}

        {result && !result.error && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={s.card}>
              <p style={s.sectionTitle}>Alimentos identificados</p>
              {result.items.map((it, i) => (
                <div key={i} style={s.itemRow}>
                  <span style={{ flex: 1 }}>{it.name} <span style={s.portion}>({it.portion})</span></span>
                  <span style={s.choBadge}>{it.cho}g</span>
                </div>
              ))}
              {result.notes && <p style={{ ...s.hint, marginTop: 8 }}>⚠️ {result.notes}</p>}
            </div>

            <div style={s.card}>
              <p style={s.sectionTitle}>Total de carboidratos</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input style={{ ...s.input, width: 80, textAlign: "center", fontSize: 22, fontWeight: 700 }}
                  type="number" value={manualCHO} onChange={e => setManualCHO(e.target.value)} />
                <span style={{ fontSize: 16, color: "#6b7280" }}>gramas de CHO</span>
              </div>
              <p style={s.hint}>Ajuste manualmente se necessário</p>
            </div>

            <div style={s.card}>
              <p style={s.sectionTitle}>Glicemia pré-prandial (opcional)</p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input style={{ ...s.input, width: 80, textAlign: "center" }}
                  type="number" placeholder="---" value={glucose} onChange={e => setGlucose(e.target.value)} />
                <span style={{ fontSize: 14, color: "#6b7280" }}>mg/dL</span>
              </div>
              {glucose && (
                <p style={{ ...s.hint, marginTop: 6, color: parseFloat(glucose) > 200 ? "#b91c1c" : "#166534", fontWeight: 600 }}>
                  {parseFloat(glucose) > 200 ? "⚠️ Acima de 200 — insulina rápida indicada" : "✓ Abaixo de 200 — apenas basal hoje"}
                </p>
              )}
            </div>

            {insulin && (
              <div style={{ ...s.card, background: "#f0fdf4", borderColor: "#86efac" }}>
                <p style={s.sectionTitle}>💉 Dose estimada de insulina</p>
                <div style={s.insulinRow}>
                  <div style={s.insulinItem}><span style={s.insulinVal}>{insulin.meal}U</span><span style={s.insulinLabel}>refeição</span></div>
                  {parseFloat(insulin.corr) > 0 && (
                    <div style={s.insulinItem}><span style={s.insulinVal}>{insulin.corr}U</span><span style={s.insulinLabel}>correção</span></div>
                  )}
                  <div style={{ ...s.insulinItem, background: "#dcfce7", borderRadius: 8, padding: "4px 12px" }}>
                    <span style={{ ...s.insulinVal, color: "#166534", fontSize: 26 }}>{insulin.total}U</span>
                    <span style={s.insulinLabel}>total</span>
                  </div>
                </div>
                {glucose && parseFloat(glucose) <= 200 && (
                  <div style={{ marginTop: 10, background: "#f0fdf4", borderRadius: 8, padding: "8px 12px" }}>
                    <p style={{ margin: 0, fontSize: 13, color: "#166534", fontWeight: 600 }}>✓ Glicemia ≤ 200 — insulina rápida não necessária agora</p>
                    <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>Apenas basal conforme rotina</p>
                  </div>
                )}
                {glucose && parseFloat(glucose) > 200 && (
                  <div style={{ marginTop: 10, background: "#fef9c3", borderRadius: 8, padding: "8px 12px" }}>
                    <p style={{ margin: 0, fontSize: 13, color: "#854d0e", fontWeight: 600 }}>⚠️ Glicemia acima de 200 — insulina rápida indicada</p>
                    <p style={{ margin: 0, fontSize: 12, color: "#92400e" }}>Dose estimada: {insulin.total}U</p>
                  </div>
                )}
              </div>
            )}

            <div style={{ ...s.card, background: "#fff8e1", borderColor: "#f59e0b" }}>
              <p style={{ ...s.hint, color: "#92400e" }}>⚕️ Estimativas geradas por IA. Confirme sempre com a equipe médica antes de aplicar insulina.</p>
            </div>

            {!saved ? (
              <button style={s.btnPrimary} onClick={handleSave}>Salvar no diário ✓</button>
            ) : (
              <div style={{ ...s.card, background: "#f0fdf4", textAlign: "center" }}>
                <p style={{ color: "#166534", fontWeight: 600 }}>✓ Registrado no diário!</p>
                <button style={s.btnSecondary} onClick={() => setScreen("diary")}>Ver diário</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // ── HOME ──
  return (
    <div style={s.page}>
      <div style={{ ...s.header, flexDirection: "column", alignItems: "flex-start", padding: "20px 20px 16px" }}>
        <p style={{ margin: 0, fontSize: 12, color: "#f9a8d4" }}>olá, Julia 👋</p>
        <h1 style={{ margin: 0, fontSize: 22, color: "#fff", fontWeight: 700 }}>FofaBetes 🩷</h1>
        <p style={{ margin: 0, fontSize: 13, color: "#fbcfe8" }}>monitor de carboidratos da Aurora</p>
      </div>
      <div style={s.content}>
        <button style={s.mainAction} onClick={() => setScreen("analyze")}>
          <span style={{ fontSize: 36 }}>📷</span>
          <span style={{ fontWeight: 700, fontSize: 17 }}>Analisar refeição</span>
          <span style={{ fontSize: 13, color: "#fbcfe8" }}>foto ou texto — a IA calcula os CHO</span>
        </button>
        <div style={{ display: "flex", gap: 12 }}>
          <button style={s.secondAction} onClick={() => setScreen("diary")}>
            <span style={{ fontSize: 24 }}>📒</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Diário</span>
            <span style={{ fontSize: 11, color: "#6b7280" }}>{logs.length} registros</span>
          </button>
          <button style={s.secondAction} onClick={() => setScreen("settings")}>
            <span style={{ fontSize: 24 }}>⚙️</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Configurações</span>
            <span style={{ fontSize: 11, color: "#6b7280" }}>I:C · alvo · FC</span>
          </button>
        </div>
        {logs.length > 0 && (
          <div style={s.card}>
            <p style={s.sectionTitle}>Última refeição</p>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {logs[0].imgPreview
                ? <img src={logs[0].imgPreview} style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover" }} alt="" />
                : <div style={{ width: 48, height: 48, borderRadius: 8, background: "#fce7f3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>🍽️</div>
              }
              <div style={{ flex: 1 }}>
                <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{formatDate(logs[0].ts)}</p>
                <p style={{ margin: 0, fontWeight: 700, color: "#db2777" }}>{logs[0].cho}g CHO · {logs[0].insulin}U</p>
                {logs[0].glucose && (
                  <p style={{ margin: 0, fontSize: 12, color: logs[0].usedRapid ? "#b91c1c" : "#166534" }}>
                    {logs[0].usedRapid ? "⚡ insulina rápida aplicada" : "✓ só basal"} · glicemia pré: {logs[0].glucose} mg/dL
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  page: { minHeight: "100vh", background: "#fdf2f8", fontFamily: "system-ui, sans-serif", maxWidth: 430, margin: "0 auto", display: "flex", flexDirection: "column" },
  header: { background: "linear-gradient(135deg, #db2777, #be185d)", display: "flex", alignItems: "center", padding: "16px 20px", gap: 12 },
  headerTitle: { color: "#fff", fontWeight: 700, fontSize: 18, flex: 1 },
  back: { background: "none", border: "none", color: "#fff", fontSize: 22, cursor: "pointer", padding: "0 4px" },
  content: { flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 14 },
  card: { background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #fce7f3", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
  mainAction: { background: "linear-gradient(135deg, #db2777, #be185d)", border: "none", borderRadius: 16, padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer", color: "#fff" },
  secondAction: { flex: 1, background: "#fff", border: "1px solid #fce7f3", borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, cursor: "pointer" },
  toggle: { display: "flex", background: "#fce7f3", borderRadius: 10, padding: 4, gap: 4 },
  toggleActive: { flex: 1, background: "#db2777", color: "#fff", border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  toggleInactive: { flex: 1, background: "transparent", color: "#be185d", border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 600, fontSize: 14, cursor: "pointer" },
  uploadArea: { background: "#fff", border: "2px dashed #f9a8d4", borderRadius: 16, padding: 40, textAlign: "center", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 },
  uploadText: { color: "#db2777", fontWeight: 600, margin: 0 },
  preview: { width: "100%", maxHeight: 280, objectFit: "cover", borderRadius: 14, marginBottom: 12 },
  btnPrimary: { background: "#db2777", color: "#fff", border: "none", borderRadius: 12, padding: "14px 20px", fontSize: 16, fontWeight: 700, cursor: "pointer", width: "100%" },
  btnSecondary: { background: "#fce7f3", color: "#be185d", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 14, cursor: "pointer" },
  btnDisabled: { background: "#f9a8d4", color: "#fff", border: "none", borderRadius: 12, padding: "14px 20px", fontSize: 16, fontWeight: 700, width: "100%", cursor: "default" },
  errorCard: { background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 12, padding: 14, color: "#991b1b", fontSize: 14 },
  sectionTitle: { margin: "0 0 10px", fontWeight: 700, color: "#374151", fontSize: 15 },
  itemRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #fce7f3", fontSize: 14, color: "#374151" },
  portion: { fontSize: 12, color: "#9ca3af" },
  choBadge: { background: "#fce7f3", color: "#db2777", fontWeight: 700, padding: "2px 8px", borderRadius: 8, fontSize: 13 },
  tag: { display: "inline-block", background: "#fce7f3", color: "#be185d", fontSize: 11, borderRadius: 6, padding: "2px 6px", margin: "2px 2px 0 0" },
  input: { border: "1.5px solid #f9a8d4", borderRadius: 8, padding: "8px 12px", fontSize: 16, outline: "none", width: "100%", boxSizing: "border-box" },
  label: { fontWeight: 600, color: "#374151", fontSize: 14, margin: "0 0 4px" },
  hint: { fontSize: 12, color: "#6b7280", margin: "2px 0 0" },
  insulinRow: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" },
  insulinItem: { display: "flex", flexDirection: "column", alignItems: "center" },
  insulinVal: { fontSize: 22, fontWeight: 800, color: "#166534" },
  insulinLabel: { fontSize: 11, color: "#6b7280" },
  dayHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 4px 4px", fontWeight: 700, color: "#374151", fontSize: 14 },
  logCard: { background: "#fff", borderRadius: 12, padding: 12, marginBottom: 8, border: "1px solid #fce7f3" },
  logTime: { margin: "0 0 2px", fontSize: 12, color: "#9ca3af" },
  logCHO: { margin: 0, fontWeight: 700, color: "#db2777", fontSize: 15 },
  thumb: { width: 56, height: 56, borderRadius: 8, objectFit: "cover", flexShrink: 0 },
  del: { background: "none", border: "none", color: "#d1d5db", fontSize: 16, cursor: "pointer", padding: 4 }
};
