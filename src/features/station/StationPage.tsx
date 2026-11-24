/**
 * 站務端（#/station，筆電）：選模板／輸入文字 → 預覽 → 播放（雙聲道對應月台、佇列、TTS、重送）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { WithData, type AppData } from '../../app/data.tsx';
import { ConfirmDialog, PageHead, clock, useConfirm } from '../../app/ui.tsx';
import {
  BroadcastPlayer,
  renderBroadcastWav,
  type BroadcastJob,
  type Phase,
  type PlayerState,
} from '../../audio/player.ts';
import type { Route } from '../../audio/signals.ts';
import { defaultParam, paramChoices, renderTemplate } from '../../data/render.ts';
import { LANG_LABELS, LANGS, type Station, type Template } from '../../data/schema.ts';
import { BANDS, LOW_BAND_F0, SYNTH, makeConfig, type ModeName } from '../../modem/config.ts';
import { packetDuration } from '../../modem/fsk.ts';
import { MAX_TEXT_BYTES, encodeMessage, utf8Length, type Message } from '../../modem/protocol.ts';
import { downloadFile, loadSetting, saveSetting } from '../../platform/index.ts';
import { TemplateSource, TextSource } from '../../services/index.ts';

interface StationSettings {
  stationId: number;
  f0: number;
  mode: ModeName;
  amp: number;
  chime: boolean;
  speech: boolean;
  silent: boolean;
  repeats: 1 | 2;
  /** 月台（'0' = 全站）→ 聲道 */
  routes: Record<string, Route>;
}

const DEFAULTS: StationSettings = {
  stationId: 1,
  f0: 19500,
  mode: 'standard',
  amp: SYNTH.defaultAmp,
  chime: true,
  speech: true,
  silent: false,
  repeats: 2,
  routes: { '0': 'both', '1': 'left', '2': 'right' },
};

const LOW_BAND_WARNING = '部分年輕人與兒童可能聽得到，只在現場設備無法播放更高頻率時使用。';
const PHASE_LABEL: Record<Phase, string> = {
  signal: '叮咚＋第一次高頻訊號',
  speech: '語音廣播',
  gap: '間隔',
  repeat: '第二次高頻訊號（重送）',
};
const ROUTE_LABEL: Record<Route, string> = { left: '左聲道', right: '右聲道', both: '雙聲道' };

interface LogEntry {
  at: number;
  platform: number;
  content: string;
  seq: number;
  error?: string;
}

export default function StationPage() {
  return <WithData>{(d) => <StationConsole data={d} />}</WithData>;
}

let jobCounter = 0;
const newJobId = () => ++jobCounter;
const nowMs = () => Date.now();

function nextSeq(): number {
  const s = (loadSetting('seq', { v: Math.floor(Math.random() * 256) }).v + 1) % 256;
  saveSetting('seq', { v: s });
  return s;
}

function StationConsole({ data }: { data: AppData }) {
  const [s, setS] = useState<StationSettings>(() => loadSetting('station', DEFAULTS));
  const set = (patch: Partial<StationSettings>) =>
    setS((o) => {
      const n = { ...o, ...patch };
      saveSetting('station', n);
      return n;
    });
  const station: Station | undefined =
    data.stations.stations.find((x) => x.stationId === s.stationId) ?? data.stations.stations[0];
  const cfg = makeConfig(s.f0, s.mode);
  const [confirmReq, confirm] = useConfirm();

  const [target, setTarget] = useState(1);
  const [tab, setTab] = useState<'template' | 'text'>('template');
  const general = data.pack.templates;
  const tpl0 = general[0];
  const [tplId, setTplId] = useState(tpl0?.id ?? 0);
  const tpl: Template | undefined = data.pack.templates.find((t) => t.id === tplId);
  const [params, setParams] = useState(() => ({
    p1: tpl0 ? defaultParam(tpl0, 'p1', station) : 0,
    p2: tpl0 ? defaultParam(tpl0, 'p2', station) : 0,
  }));
  const [text, setText] = useState('');
  const [exitId, setExitId] = useState(station?.exits[0]?.id ?? 1);

  const [player, setPlayer] = useState<PlayerState>({
    queue: [],
    current: null,
    leakage: null,
    notice: null,
  });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<BroadcastPlayer | null>(null);
  const jobMeta = useRef(new Map<number, LogEntry>());

  useEffect(() => {
    playerRef.current = new BroadcastPlayer(setPlayer, (job, err) => {
      const meta = jobMeta.current.get(job.id);
      if (meta) setLog((l) => [{ ...meta, at: Date.now(), error: err?.message }, ...l].slice(0, 200));
      if (err) setError(err.message);
    });
    return () => playerRef.current?.stopAll();
  }, []);

  const chooseTemplate = (id: number) => {
    setTplId(id);
    const t = data.pack.templates.find((x) => x.id === id);
    if (t) setParams({ p1: defaultParam(t, 'p1', station), p2: defaultParam(t, 'p2', station) });
  };

  /** 目前編輯中的訊息（不含 seq） */
  const draft = useMemo((): { msg: Message; zh: string } | null => {
    const header = { stationId: station?.stationId ?? 0, platform: target, seq: 0 };
    if (tab === 'template') {
      if (!tpl) return null;
      return {
        msg: new TemplateSource(data.pack.packVersion).build({ template: tpl, ...params }, header),
        zh: renderTemplate(tpl, params, station, 'zh'),
      };
    }
    if (!text.trim() || utf8Length(text) > MAX_TEXT_BYTES) return null;
    return { msg: new TextSource().build({ text: text.trim() }, header), zh: text.trim() };
  }, [tab, tpl, params, text, target, station, data.pack.packVersion]);

  const payloadLen = draft ? encodeMessage(draft.msg).length : 0;

  const makeJob = (msg: Message, zh: string): BroadcastJob => {
    const payload = encodeMessage(msg);
    return {
      id: newJobId(),
      label: zh,
      payload,
      route: s.routes[String(msg.platform)] ?? 'both',
      cfg,
      amp: s.amp,
      chime: s.chime,
      speech: s.speech ? zh : null,
      repeats: s.repeats,
      silent: s.silent,
    };
  };

  const send = async (msg: Message, zh: string, emergency: boolean) => {
    setError(null);
    if (emergency) {
      const ok = await confirm({
        title: '確定送出緊急廣播？',
        body: (
          <p>
            將對<strong>全站</strong>送出：「{zh}」
            <br />
            乘客手機會全螢幕紅色閃爍並震動。
          </p>
        ),
        confirmLabel: '送出緊急廣播',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const full = { ...msg, seq: nextSeq() } as Message;
      const job = makeJob(full, zh);
      jobMeta.current.set(job.id, { at: nowMs(), platform: full.platform, content: zh, seq: full.seq });
      playerRef.current?.enqueue(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sendDraft = () => {
    if (!draft) return;
    void send(draft.msg, draft.zh, tab === 'template' && tpl?.category === 'emergency');
  };

  const sendEmergency = (templateId: number) => {
    const t = data.pack.templates.find((x) => x.id === templateId);
    if (!t) return setError(`模板庫中找不到緊急模板 #${templateId}`);
    const p = { p1: t.params.some((x) => x.type === 'exit') ? exitId : 0, p2: 0 };
    const msg = new TemplateSource(data.pack.packVersion).build(
      { template: t, ...p },
      { stationId: station?.stationId ?? 0, platform: 0, seq: 0 },
    );
    void send(msg, renderTemplate(t, p, station, 'zh'), true);
  };

  const chooseBand = async (f0: number) => {
    if (f0 === LOW_BAND_F0) {
      const ok = await confirm({
        title: '改用 18 kHz 低頻段？',
        body: <p>{LOW_BAND_WARNING}</p>,
        confirmLabel: '我了解，改用 18 kHz',
        danger: true,
      });
      if (!ok) return;
    }
    set({ f0 });
  };

  const downloadWav = () => {
    if (!draft) return;
    try {
      const job = makeJob({ ...draft.msg, seq: 0 } as Message, draft.zh);
      const wav = renderBroadcastWav(job);
      downloadFile(wav as Uint8Array<ArrayBuffer>, `hear-broadcast-${nowMs()}.wav`, 'audio/wav');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const platforms = Array.from({ length: station?.platforms ?? 2 }, (_, i) => i + 1);
  const dur = payloadLen ? packetDuration(payloadLen, cfg) : 0;
  const cur = player.current;

  return (
    <>
      <PageHead
        title="站務端"
        sub="選好月台與模板，按下播出：叮咚聲、高頻訊號和語音廣播會依序送出。"
        art="job_ekiin_man"
      />
      <ConfirmDialog req={confirmReq} />
      {s.f0 === LOW_BAND_F0 && (
        <p className="warn" role="status">
          ⚠ 目前使用 18 kHz 低頻段：{LOW_BAND_WARNING}
        </p>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <div className="grid two">
        <section className="card stack" aria-label="輸出設定">
          <h2>輸出設定</h2>
          <label className="field">
            車站
            <select value={s.stationId} onChange={(e) => set({ stationId: Number(e.target.value) })}>
              {data.stations.stations.map((x) => (
                <option key={x.stationId} value={x.stationId}>
                  {x.name.zh}（#{x.stationId}）
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            頻段
            <select
              value={s.f0}
              onChange={(e) => void chooseBand(Number(e.target.value))}
              data-testid="band-select"
            >
              {BANDS.map((b) => (
                <option key={b.f0} value={b.f0}>
                  {b.f0 / 1000} kHz{b.recommended ? '（建議・人耳聽不到）' : ''}
                  {b.manualOnly ? '（部分人可能聽得到）' : ''}
                </option>
              ))}
            </select>
          </label>
          <div role="radiogroup" aria-label="傳輸模式" className="row">
            <strong>模式：</strong>
            {(['standard', 'stable'] as const).map((m) => (
              <button key={m} aria-pressed={s.mode === m} onClick={() => set({ mode: m })}>
                {m === 'standard' ? '標準（約 2.4 秒）' : '穩定（約 3.1 秒）'}
              </button>
            ))}
          </div>
          <label className="field">
            音量 {s.amp.toFixed(2)}
            <input
              type="range"
              min={0.05}
              max={SYNTH.maxAmp}
              step={0.05}
              value={s.amp}
              onChange={(e) => set({ amp: Number(e.target.value) })}
            />
            <span className="hint">調到「收得到即可」：音量太大時喇叭失真，可能產生聽得到的雜音。</span>
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={s.chime}
              disabled={s.silent}
              onChange={(e) => set({ chime: e.target.checked })}
            />
            叮咚提示音
          </label>
          <label className="chk">
            <input
              type="checkbox"
              checked={s.speech}
              disabled={s.silent}
              onChange={(e) => set({ speech: e.target.checked })}
            />
            語音廣播（瀏覽器 TTS，zh-TW；無法指定聲道）
          </label>
          <label className="chk">
            <input type="checkbox" checked={s.silent} onChange={(e) => set({ silent: e.target.checked })} />
            靜音模式：只送高頻訊號，完全不播可聽見的聲音
          </label>
          <label className="field">
            重送次數
            <select value={s.repeats} onChange={(e) => set({ repeats: Number(e.target.value) as 1 | 2 })}>
              <option value={2}>2 次（預設，提高收訊率）</option>
              <option value={1}>1 次</option>
            </select>
          </label>
          <h3>聲道對應</h3>
          <table>
            <tbody>
              {[0, ...platforms].map((p) => (
                <tr key={p}>
                  <th scope="row">{p === 0 ? '全站' : `第 ${p} 月台`}</th>
                  <td>
                    <select
                      aria-label={`${p === 0 ? '全站' : `第 ${p} 月台`}的聲道`}
                      value={s.routes[String(p)] ?? 'both'}
                      onChange={(e) => set({ routes: { ...s.routes, [String(p)]: e.target.value as Route } })}
                    >
                      {(['left', 'right', 'both'] as Route[]).map((r) => (
                        <option key={r} value={r}>
                          {ROUTE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" data-testid="leakage">
            {player.leakage
              ? `低頻洩漏：16 kHz 以下 ${player.leakage.below16kDb.toFixed(0)} dB、18 kHz 以下 ${player.leakage.below18kDb.toFixed(0)} dB ${player.leakage.pass ? '✓' : '✗'}`
              : '低頻洩漏：每次播放前自動檢查'}
          </p>
        </section>

        <section className="card stack" aria-label="緊急廣播">
          <h2>緊急廣播（全站）</h2>
          <label className="field">
            疏散出口
            <select value={exitId} onChange={(e) => setExitId(Number(e.target.value))}>
              {station?.exits.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name.zh}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button className="danger" onClick={() => sendEmergency(10)}>
              緊急疏散
            </button>
            <button className="danger" onClick={() => sendEmergency(11)}>
              地震警報
            </button>
            <button className="danger" onClick={() => sendEmergency(12)}>
              火災
            </button>
          </div>
          <h2 style={{ marginTop: 16 }}>播放佇列</h2>
          {cur ? (
            <div className="stack" aria-live="polite">
              <div>
                正在播放：<strong>{cur.job.label}</strong>
              </div>
              <div className="small">
                {PHASE_LABEL[cur.phase]}・{ROUTE_LABEL[cur.job.route]}
              </div>
              <div
                className="progress"
                role="progressbar"
                aria-valuenow={Math.round(cur.progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div style={{ width: `${cur.progress * 100}%` }} />
              </div>
            </div>
          ) : (
            <p className="muted">目前沒有播放</p>
          )}
          {player.notice && <p className="warn">{player.notice}</p>}
          {player.queue.length > 0 && (
            <ol className="log">
              {player.queue.map((j) => (
                <li key={j.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{j.label}</span>
                  <button onClick={() => playerRef.current?.remove(j.id)}>移除</button>
                </li>
              ))}
            </ol>
          )}
          <button onClick={() => playerRef.current?.stopAll()} disabled={!cur && !player.queue.length}>
            停止並清空佇列
          </button>
        </section>
      </div>

      <section className="card stack" aria-label="編輯廣播">
        <h2>廣播內容</h2>
        <div role="radiogroup" aria-label="目標" className="row">
          <strong>目標：</strong>
          {platforms.map((p) => (
            <button key={p} aria-pressed={target === p} onClick={() => setTarget(p)}>
              第 {p} 月台（{ROUTE_LABEL[s.routes[String(p)] ?? 'both']}）
            </button>
          ))}
          <button aria-pressed={target === 0} onClick={() => setTarget(0)}>
            全站（{ROUTE_LABEL[s.routes['0'] ?? 'both']}）
          </button>
        </div>
        <div role="tablist" className="row">
          <button
            role="tab"
            aria-selected={tab === 'template'}
            aria-pressed={tab === 'template'}
            onClick={() => setTab('template')}
          >
            模板
          </button>
          <button
            role="tab"
            aria-selected={tab === 'text'}
            aria-pressed={tab === 'text'}
            onClick={() => setTab('text')}
          >
            自由文字
          </button>
        </div>

        {tab === 'template' ? (
          <div className="stack">
            <label className="field">
              模板
              <select
                value={tplId}
                onChange={(e) => chooseTemplate(Number(e.target.value))}
                data-testid="template-select"
              >
                {data.pack.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.id} {t.name}
                    {t.category === 'emergency' ? '（緊急）' : ''}
                  </option>
                ))}
              </select>
            </label>
            {tpl?.params.map((p) => {
              const choices = paramChoices(tpl, p.key, station);
              return (
                <label className="field" key={p.key}>
                  {p.label}（{p.key}）
                  {choices ? (
                    <select
                      value={params[p.key]}
                      onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })}
                    >
                      {choices.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      min={p.type === 'number' ? p.min : 0}
                      max={p.type === 'number' ? p.max : 255}
                      value={params[p.key]}
                      onChange={(e) => {
                        const v = Math.round(Number(e.target.value));
                        const lo = p.type === 'number' ? p.min : 0;
                        const hi = p.type === 'number' ? p.max : 255;
                        setParams({ ...params, [p.key]: Math.max(lo, Math.min(hi, isNaN(v) ? lo : v)) });
                      }}
                    />
                  )}
                </label>
              );
            })}
          </div>
        ) : (
          <label className="field">
            自由文字（剩餘 {MAX_TEXT_BYTES - utf8Length(text)} bytes；中文每字 3 bytes）
            <textarea
              value={text}
              maxLength={MAX_TEXT_BYTES}
              onChange={(e) => {
                if (utf8Length(e.target.value) <= MAX_TEXT_BYTES) setText(e.target.value);
              }}
              aria-describedby="text-hint"
            />
            <span className="hint" id="text-hint">
              自由文字不經模板翻譯，乘客端以原文顯示。
            </span>
          </label>
        )}

        {draft && tab === 'template' && tpl && (
          <table aria-label="6 種語言預覽">
            <tbody>
              {LANGS.map((l) => (
                <tr key={l}>
                  <th scope="row" style={{ width: 90 }}>
                    {LANG_LABELS[l]}
                  </th>
                  <td>
                    {renderTemplate(tpl, params, station, l)}{' '}
                    {tpl.needsReview[l] && <span className="badge review">待校對</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted">
          封包 {payloadLen} bytes・每次約 {dur.toFixed(2)} 秒・{cfg.f0 / 1000} kHz{' '}
          {s.mode === 'standard' ? '標準' : '穩定'}模式
          {s.repeats === 2 ? '・送 2 次' : ''}
        </p>
        <div className="row">
          <button
            className="primary big"
            style={{ width: 'auto' }}
            onClick={sendDraft}
            disabled={!draft}
            data-testid="send"
          >
            播放廣播
          </button>
          <button onClick={downloadWav} disabled={!draft}>
            下載 WAV（雙聲道）
          </button>
        </div>
      </section>

      <section className="card" aria-label="廣播紀錄">
        <h2>廣播紀錄</h2>
        {log.length === 0 ? (
          <p className="muted">尚無紀錄</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>時間</th>
                <th>月台</th>
                <th>內容</th>
                <th>seq</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l, i) => (
                <tr key={i}>
                  <td>{clock(l.at)}</td>
                  <td>{l.platform === 0 ? '全站' : `第 ${l.platform} 月台`}</td>
                  <td>
                    {l.content}
                    {l.error && <div className="error small">{l.error}</div>}
                  </td>
                  <td>{l.seq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
