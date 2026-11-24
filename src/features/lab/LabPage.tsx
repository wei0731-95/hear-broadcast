/**
 * 硬體診斷（#/lab）：掃頻與單音發送、即時頻譜、18 頻道能量柱、頻段建議、洩漏數值、匯出頻道特徵。
 */
import { useEffect, useRef, useState } from 'react';
import { WithData, type AppData } from '../../app/data.tsx';
import { PageHead } from '../../app/ui.tsx';
import { ReceiverPipeline } from '../../audio/receiverPipeline.ts';
import type { LevelInfo } from '../../audio/protocol.ts';
import { mixInto, sweep, tone, type Route } from '../../audio/signals.ts';
import { CANDIDATES, DEFAULTS, NT, SYNTH, makeConfig, type ModeName } from '../../modem/config.ts';
import { channelFreqs, synthesize } from '../../modem/fsk.ts';
import { checkLeakage, type LeakageReport } from '../../modem/leakage.ts';
import { encodeMessage } from '../../modem/protocol.ts';
import { downloadFile, loadSetting } from '../../platform/index.ts';
import { SweepRuleAdvisor, type BandMeasurement, type ChannelAdvice } from '../../services/index.ts';

const SWEEP = { f1: 17000, f2: 21000, sec: 6 };
const MEASURE_FREQS = Array.from({ length: 13 }, (_, i) => 18000 + i * 250);

export default function LabPage() {
  return <WithData>{(d) => <Lab data={d} />}</WithData>;
}

let sharedCtx: AudioContext | null = null;
const audio = () => {
  sharedCtx ??= new AudioContext();
  if (sharedCtx.state === 'suspended') void sharedCtx.resume();
  return sharedCtx;
};

/** 播放單聲道訊號到指定聲道 */
function playMono(x: Float32Array, route: Route): void {
  const ctx = audio();
  const st = mixInto(null, x, route);
  const buf = ctx.createBuffer(2, st.left.length, ctx.sampleRate);
  buf.copyToChannel(st.left as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(st.right as Float32Array<ArrayBuffer>, 1);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

function Lab({ data }: { data: AppData }) {
  // ---- 發送端 ----
  const [amp, setAmp] = useState(0.3);
  const [route, setRoute] = useState<Route>('both');
  const [toneHz, setToneHz] = useState(19500);

  // ---- 接收端 ----
  const [band, setBand] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<LevelInfo | null>(null);
  const [recording, setRecording] = useState(false);
  const pipe = useRef<ReceiverPipeline | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const raf = useRef(0);

  // ---- 量測 ----
  const [phase, setPhase] = useState<'idle' | 'noise' | 'listen' | 'done'>('idle');
  const [result, setResult] = useState<{ m: BandMeasurement[]; advice: ChannelAdvice } | null>(null);
  const noiseAcc = useRef<number[]>([]);
  const peak = useRef<number[]>([]);
  const noiseFrames = useRef(0);

  // ---- 洩漏 ----
  const [leak, setLeak] = useState<{ cfg: string; r: LeakageReport } | null>(null);

  const cfg = CANDIDATES[band];

  const readLevels = (): number[] | null => {
    const a = analyser.current;
    if (!a) return null;
    const db = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(db);
    const hz = a.context.sampleRate / a.fftSize;
    return MEASURE_FREQS.map((f) => {
      const k = Math.round(f / hz);
      let m = -Infinity;
      for (let i = k - 2; i <= k + 2; i++) if (db[i] > m) m = db[i];
      return m;
    });
  };

  useEffect(() => {
    if (!running) return;
    const draw = () => {
      raf.current = requestAnimationFrame(draw);
      const a = analyser.current;
      const c = canvas.current;
      if (!a || !c) return;
      const db = new Float32Array(a.frequencyBinCount);
      a.getFloatFrequencyData(db);
      const hz = a.context.sampleRate / a.fftSize;
      const ctx = c.getContext('2d')!;
      const W = (c.width = c.clientWidth * devicePixelRatio);
      const H = (c.height = 200 * devicePixelRatio);
      ctx.clearRect(0, 0, W, H);
      const f1 = 16000;
      const f2 = Math.min(22000, a.context.sampleRate / 2);
      const x = (f: number) => ((f - f1) / (f2 - f1)) * W;
      const y = (d: number) => H - ((d + 140) / 130) * H;
      // 目前頻段
      ctx.fillStyle = 'rgba(255,212,0,0.18)';
      ctx.fillRect(x(cfg.f0 - cfg.df / 2), 0, x(cfg.f0 + 17.5 * cfg.df) - x(cfg.f0 - cfg.df / 2), H);
      ctx.strokeStyle = '#4bd1ff';
      ctx.lineWidth = devicePixelRatio;
      ctx.beginPath();
      for (let k = Math.floor(f1 / hz); k * hz <= f2; k++) {
        const px = x(k * hz);
        const py = y(db[k]);
        if (k === Math.floor(f1 / hz)) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.fillStyle = '#c9d1de';
      ctx.font = `${12 * devicePixelRatio}px system-ui`;
      for (let f = 16000; f <= f2; f += 1000) ctx.fillText(`${f / 1000}k`, x(f) + 2, H - 4);
      // 量測
      const lv = readLevels();
      if (lv && phase === 'noise') {
        noiseAcc.current = lv.map((v, i) => (noiseAcc.current[i] ?? 0) + v);
        noiseFrames.current++;
      } else if (lv && phase === 'listen') {
        peak.current = lv.map((v, i) => Math.max(peak.current[i] ?? -Infinity, v));
      }
    };
    draw();
    return () => cancelAnimationFrame(raf.current);
  }, [running, phase, cfg]);

  const startRx = async () => {
    setError(null);
    const p = new ReceiverPipeline({ onEvent: () => {}, onLevel: setLevel, onError: setError });
    try {
      await p.start({ kind: 'manual', cfg });
      pipe.current = p;
      analyser.current = p.createAnalyser();
      setRunning(true);
    } catch (e) {
      await p.stop();
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const stopRx = async () => {
    await pipe.current?.stop();
    pipe.current = null;
    analyser.current = null;
    setRunning(false);
    setRecording(false);
  };
  useEffect(() => () => void pipe.current?.stop(), []);

  const measure = async () => {
    noiseAcc.current = [];
    noiseFrames.current = 0;
    peak.current = [];
    setResult(null);
    setPhase('noise');
    await new Promise((r) => setTimeout(r, 1500));
    setPhase('listen');
    await new Promise((r) => setTimeout(r, (SWEEP.sec + 6) * 1000));
    const n = Math.max(1, noiseFrames.current);
    const m: BandMeasurement[] = MEASURE_FREQS.map((freq, i) => ({
      freq,
      levelDb: peak.current[i] ?? -140,
      noiseDb: (noiseAcc.current[i] ?? -140 * n) / n,
    }));
    setResult({ m, advice: new SweepRuleAdvisor().advise(m, DEFAULTS) });
    setPhase('done');
  };

  const checkCurrent = () => {
    const st = loadSetting('station', { f0: 19500, mode: 'standard' as ModeName, amp: SYNTH.defaultAmp });
    const c = makeConfig(st.f0, st.mode);
    const t = data.pack.templates[0];
    const payload = encodeMessage({
      type: 'template',
      stationId: 1,
      platform: 1,
      seq: 0,
      packVersion: data.pack.packVersion,
      templateId: t?.id ?? 1,
      p1: 0,
      p2: 0,
    });
    const r = checkLeakage(synthesize(payload, c, 48000, st.amp), 48000, c.f0);
    setLeak({ cfg: `${c.f0 / 1000} kHz・${st.mode === 'standard' ? '標準' : '穩定'}・音量 ${st.amp}`, r });
  };

  const exportFeatures = async () => {
    const p = pipe.current;
    if (!p) return;
    const { rows, decoded } = await p.dumpFeatures();
    const json = {
      note: '聽見廣播頻道特徵：只含每個 hop 的 18 頻道功率、同步分數與解碼結果，不含任何原始音訊或人聲',
      exportedAt: new Date().toISOString(),
      sampleRate: p.sampleRate,
      config: cfg,
      channelsHz: channelFreqs(cfg),
      rows,
      decoded,
    };
    downloadFile(JSON.stringify(json), `hb-features-${Date.now()}.json`, 'application/json');
  };

  const maxDb = level?.powersDb ? Math.max(...level.powersDb) : 0;

  return (
    <>
      <PageHead title="硬體診斷" sub="用掃頻確認這組喇叭和手機能用哪些高頻頻段。" art="chouonpa_koumori" />
      <div className="grid two">
        <section className="card stack" aria-label="發送端">
          <h2>發送端（筆電）</h2>
          <label className="field">
            音量 {amp.toFixed(2)}
            <input
              type="range"
              min={0.05}
              max={SYNTH.maxAmp}
              step={0.05}
              value={amp}
              onChange={(e) => setAmp(Number(e.target.value))}
            />
          </label>
          <label className="field">
            聲道
            <select value={route} onChange={(e) => setRoute(e.target.value as Route)}>
              <option value="both">雙聲道</option>
              <option value="left">左聲道</option>
              <option value="right">右聲道</option>
            </select>
          </label>
          <button
            className="primary"
            onClick={() => playMono(sweep(audio().sampleRate, SWEEP.f1, SWEEP.f2, SWEEP.sec, amp), route)}
          >
            播放 17 → 21 kHz 掃頻（6 秒）
          </button>
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              單一頻率（Hz）
              <input
                type="number"
                min={100}
                max={23000}
                value={toneHz}
                onChange={(e) => setToneHz(Number(e.target.value))}
              />
            </label>
            <button
              onClick={() => playMono(tone(audio().sampleRate, toneHz, 2, amp), route)}
              style={{ alignSelf: 'flex-end' }}
            >
              播放 2 秒
            </button>
          </div>
          <h3>目前站務端設定的低頻洩漏</h3>
          <button onClick={checkCurrent}>計算洩漏數值</button>
          {leak && (
            <p data-testid="lab-leakage">
              {leak.cfg}：16 kHz 以下 <strong>{leak.r.below16kDb.toFixed(1)} dB</strong>、18 kHz 以下{' '}
              <strong>{leak.r.below18kDb.toFixed(1)} dB</strong>{' '}
              {leak.r.pass ? <span className="ok">✓ 合格</span> : <span className="error">✗ 不合格</span>}
            </p>
          )}
        </section>

        <section className="card stack" aria-label="接收端">
          <h2>接收端（手機）</h2>
          <label className="field">
            顯示的頻段
            <select value={band} disabled={running} onChange={(e) => setBand(Number(e.target.value))}>
              {CANDIDATES.map((c, i) => (
                <option key={i} value={i}>
                  {c.f0 / 1000} kHz・{c.ts === 0.06 ? '標準' : '穩定'}
                </option>
              ))}
            </select>
          </label>
          {!running ? (
            <button className="primary" onClick={startRx}>
              開始接收
            </button>
          ) : (
            <button onClick={stopRx}>停止</button>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {running && (
            <>
              <canvas ref={canvas} height={200} aria-label="16～22 kHz 即時頻譜（黃色為目前頻段）" />
              <div className="bars" aria-label="18 頻道能量">
                {Array.from({ length: NT }, (_, i) => {
                  const v = level?.powersDb?.[i] ?? -120;
                  const h = Math.max(2, 100 + (v - maxDb) * 2);
                  return (
                    <div
                      key={i}
                      className={i < 2 ? 'sync' : ''}
                      style={{ height: `${Math.min(100, h)}%` }}
                      title={`${channelFreqs(cfg)[i]} Hz：${v.toFixed(1)} dB`}
                    />
                  );
                })}
              </div>
              <p className="small muted">
                橘色為同步音 A、B；藍色為 16 個資料頻道。同步分數 {(level?.score ?? 0).toFixed(2)}
              </p>
            </>
          )}
        </section>
      </div>

      <section className="card stack" aria-label="頻段建議">
        <h2>頻段建議</h2>
        <p>
          找出「這組喇叭＋手機」可用的最高頻段。步驟：手機按「開始量測」→ 先量 1.5 秒背景噪音 →
          看到「請播放掃頻」後，在筆電按「播放 17 → 21 kHz 掃頻」。
        </p>
        <button
          className="primary"
          onClick={measure}
          disabled={!running || phase === 'noise' || phase === 'listen'}
        >
          開始量測
        </button>
        {!running && <p className="muted small">請先在上方「接收端」按開始接收。</p>}
        {phase === 'noise' && <p role="status">量測背景噪音中，請保持安靜…</p>}
        {phase === 'listen' && (
          <p role="status" className="warn">
            請現在在筆電播放掃頻（約 12 秒後自動結束）
          </p>
        )}
        {result && <ResponseChart m={result.m} advice={result.advice} />}
      </section>

      <section className="card stack" aria-label="匯出頻道特徵">
        <h2>匯出頻道特徵</h2>
        <p className="small">
          只匯出每個 hop 的 18 頻道功率、同步分數與解碼結果（JSON），<strong>不錄任何原始音訊或人聲</strong>
          。這是未來訓練「神經網路解調器」的資料來源。
        </p>
        <div className="row">
          <button
            disabled={!running}
            aria-pressed={recording}
            onClick={() => {
              pipe.current?.setFeatures(!recording);
              setRecording(!recording);
            }}
          >
            {recording ? '停止記錄' : '開始記錄'}
          </button>
          <button disabled={!running} onClick={exportFeatures}>
            下載 JSON
          </button>
        </div>
      </section>
    </>
  );
}

function ResponseChart({ m, advice }: { m: BandMeasurement[]; advice: ChannelAdvice }) {
  const W = 640;
  const H = 220;
  const x = (f: number) => 40 + ((f - 18000) / 3000) * (W - 60);
  const lo = Math.min(...m.map((p) => p.noiseDb), ...m.map((p) => p.levelDb)) - 5;
  const hi = Math.max(...m.map((p) => p.levelDb)) + 5;
  const y = (d: number) => H - 30 - ((d - lo) / (hi - lo || 1)) * (H - 50);
  const line = (k: 'levelDb' | 'noiseDb') =>
    m.map((p, i) => `${i ? 'L' : 'M'}${x(p.freq)},${y(p[k])}`).join(' ');
  return (
    <div className="stack">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="頻率響應圖"
        style={{ width: '100%', background: 'var(--card)' }}
      >
        {advice.bands.map((b) => (
          <rect
            key={b.f0}
            x={x(b.f0)}
            width={x(b.f0 + 850) - x(b.f0)}
            y={10}
            height={H - 40}
            fill={b.ok ? 'rgba(10,125,50,0.10)' : 'rgba(192,0,24,0.06)'}
          />
        ))}
        <path d={line('noiseDb')} stroke="#888" strokeDasharray="4 4" fill="none" strokeWidth={2} />
        <path d={line('levelDb')} stroke="#1f6feb" fill="none" strokeWidth={3} />
        {m.map((p) => (
          <text key={p.freq} x={x(p.freq)} y={H - 10} fontSize={11} textAnchor="middle" fill="currentColor">
            {(p.freq / 1000).toFixed(p.freq % 1000 ? 2 : 0)}
          </text>
        ))}
      </svg>
      <p className="small muted">藍線：掃頻時的接收強度；虛線：背景噪音（kHz）。</p>
      <p className={advice.f0 ? 'ok' : 'warn'} role="status">
        {advice.f0 ? `建議頻段：${advice.f0 / 1000} kHz。` : '沒有可用頻段。'}
        {advice.reason}
      </p>
      <table>
        <tbody>
          {advice.bands.map((b) => (
            <tr key={b.f0}>
              <td>{b.f0 / 1000} kHz</td>
              <td>{b.ok ? '✓ 可用' : '✗'}</td>
              <td>最低高於噪音 {isFinite(b.worstMarginDb) ? b.worstMarginDb.toFixed(1) : '—'} dB</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
