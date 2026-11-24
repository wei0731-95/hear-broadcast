/**
 * 乘客端（#/rx）：一鍵開始接收 → 字幕看板（依手機語言自動選字幕語言）、月台判斷、緊急畫面、歷史紀錄。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WithData, type AppData } from '../../app/data.tsx';
import { PageHead, clock, illust } from '../../app/ui.tsx';
import { ReceiverPipeline } from '../../audio/receiverPipeline.ts';
import type { LevelInfo, RxMode, WorkerFailure, WorkerMessage } from '../../audio/protocol.ts';
import { LANG_LABELS, LANG_TAGS, LANGS, type Lang } from '../../data/schema.ts';
import { UI } from '../../i18n/index.ts';
import { CANDIDATES, LOW_BAND_F0, MODES, type ModemConfig } from '../../modem/config.ts';
import { ProtocolError, decodeMessage, isNewerPack } from '../../modem/protocol.ts';
import {
  keepScreenOn,
  loadSetting,
  saveSetting,
  vibrate,
  VIBRATE_EMERGENCY,
  VIBRATE_NORMAL,
} from '../../platform/index.ts';
import { PackTranslator } from '../../services/index.ts';
import { Inbox, type Announcement } from './inbox.ts';

interface RxSettings {
  lang: Lang;
  fontSize: 1 | 2 | 3;
  /** -1 = 自動偵測；否則為 CANDIDATES 的 index */
  band: number;
  platformMode: 'auto' | 'manual';
  manualPlatform: number;
}

function detectInitialLang(): Lang {
  if (typeof navigator === 'undefined') return 'zh';
  const code = navigator.language.toLowerCase().split('-')[0] as Lang;
  return (LANGS as readonly string[]).includes(code) ? code : 'zh';
}

const DEFAULT_SETTINGS: RxSettings = {
  lang: detectInitialLang(),
  fontSize: 2,
  band: -1,
  platformMode: 'auto',
  manualPlatform: 1,
};

export default function RxPage() {
  return <WithData>{(d) => <Rx data={d} />}</WithData>;
}

interface InboxView {
  stationId: number | null;
  history: Announcement[];
  platform: number | null;
}

const modeName = (c: ModemConfig, t: (typeof UI)['zh']) => (c.ts === MODES.standard ? t.standard : t.stable);

function Rx({ data }: { data: AppData }) {
  const [settings, setSettings] = useState<RxSettings>(() => loadSetting('rx', DEFAULT_SETTINGS));
  const update = (patch: Partial<RxSettings>) =>
    setSettings((s) => {
      const n = { ...s, ...patch };
      saveSetting('rx', n);
      return n;
    });
  const t = settings.lang === 'en' ? UI.en : UI.zh;

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<LevelInfo | null>(null);
  const [locked, setLocked] = useState<ModemConfig | null>(null);
  const [latest, setLatest] = useState<Announcement | null>(null);
  const [flash, setFlash] = useState(0);
  const [emergency, setEmergency] = useState<Announcement | null>(null);
  const [packOutdated, setPackOutdated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [counts, setCounts] = useState({ ok: 0, fail: 0 });

  const [inbox] = useState(() => {
    const ib = new Inbox();
    ib.setPlatformMode(settings.platformMode, settings.manualPlatform);
    return ib;
  });
  const [view, setView] = useState<InboxView>({ stationId: null, history: [], platform: null });
  const refresh = useCallback(
    () =>
      setView({
        stationId: inbox.stationId,
        history: [...inbox.history],
        platform: inbox.currentPlatform(Date.now()),
      }),
    [inbox],
  );
  const pipeline = useRef<ReceiverPipeline | null>(null);
  const releaseWake = useRef<(() => void) | null>(null);

  const setPlatformMode = (platformMode: 'auto' | 'manual', manualPlatform = settings.manualPlatform) => {
    inbox.setPlatformMode(platformMode, manualPlatform);
    update({ platformMode, manualPlatform });
    refresh();
  };

  useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const station = data.stations.stations.find((s) => s.stationId === view.stationId);
  const translator = useMemo(() => new PackTranslator(data.pack, station), [data.pack, station]);

  const onEvent = useCallback(
    (e: WorkerMessage | WorkerFailure) => {
      if (!e.ok) {
        setCounts((c) => ({ ...c, fail: c.fail + 1 }));
        return;
      }
      let msg;
      try {
        msg = decodeMessage(e.payload);
      } catch (err) {
        if (err instanceof ProtocolError) setCounts((c) => ({ ...c, fail: c.fail + 1 }));
        return;
      }

      const tpl =
        msg.type === 'template' ? data.pack.templates.find((x) => x.id === msg.templateId) : undefined;
      if (msg.type === 'template' && isNewerPack(msg.packVersion, data.pack.packVersion))
        setPackOutdated(true);
      const emergencyMsg = tpl?.category === 'emergency';
      setCounts((c) => ({ ...c, ok: c.ok + 1 }));
      const r = inbox.receive(
        msg,
        { quality: e.quality, fixed: e.fixed, combined: e.combined, emergency: emergencyMsg },
        Date.now(),
      );
      if (r.status === 'other-station') setNotice(t.otherStation(inbox.otherStation ?? 0));
      if (r.status === 'new' && r.announcement?.shown) {
        setLatest(r.announcement);
        setFlash((f) => f + 1);
        if (emergencyMsg) {
          setEmergency(r.announcement);
          vibrate(VIBRATE_EMERGENCY);
        } else {
          vibrate(VIBRATE_NORMAL);
        }
      }
      refresh();
    },
    [data.pack, t, inbox, refresh],
  );

  const start = async () => {
    setError(null);
    setStarting(true);
    const mode: RxMode =
      settings.band < 0 ? { kind: 'auto' } : { kind: 'manual', cfg: CANDIDATES[settings.band] };
    const p = new ReceiverPipeline({
      onEvent: (ev) => onEventRef.current(ev),
      onLevel: setLevel,
      onLock: setLocked,
      onError: (m) => setError(m),
    });
    try {
      await p.start(mode);
      pipeline.current = p;
      setLocked(mode.kind === 'manual' ? mode.cfg : null);
      setRunning(true);
      releaseWake.current = await keepScreenOn();
    } catch (e) {
      await p.stop();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    await pipeline.current?.stop();
    pipeline.current = null;
    releaseWake.current?.();
    releaseWake.current = null;
    setRunning(false);
    setLevel(null);
  };

  useEffect(
    () => () => {
      void pipeline.current?.stop();
      releaseWake.current?.();
    },
    [],
  );

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const curPlatform = view.platform;
  const render = (a: Announcement) => {
    const tr = translator.translate(a.msg, settings.lang);
    if (tr) return tr;
    return {
      text: a.msg.type === 'template' ? t.unknownTemplate(a.msg.templateId) : '',
      needsReview: false,
      original: true,
    };
  };
  const platformLabel = (p: number) => (p === 0 ? t.allStation : t.platformN(p));
  const bandText = locked
    ? `${t.locked} ${locked.f0 / 1000} kHz・${modeName(locked, t)}${locked.f0 === LOW_BAND_F0 ? `（${t.lowBand}）` : ''}`
    : t.scanning;

  return (
    <div className="rx" lang={LANG_TAGS[settings.lang]}>
      <PageHead title={settings.lang === 'en' ? 'Passenger' : '乘客端'} />

      {/* 一鍵啟動卡片：乘客無需任何設定即可直接點擊接收 */}
      {!running ? (
        <div className="card stack">
          <div className="rx-start">
            <p>{t.startHint}</p>
            <img src={illust('mimi_sumasu_man2')} alt="" />
            <button className="big primary" onClick={start} disabled={starting} data-testid="start">
              {starting ? t.starting : t.start}
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="live">{t.listening}</span>
            <button onClick={stop}>{t.stop}</button>
          </div>
          {/* 月台判斷與收訊狀態固定顯示在主畫面（需求第 4 節）；工程數據在「進階」 */}
          <div className="status" aria-label={t.statusLabel} data-testid="status">
            <span data-testid="platform-status">
              <b>
                {settings.platformMode === 'auto'
                  ? t.platformAuto(curPlatform)
                  : t.platformManual(settings.manualPlatform)}
              </b>
            </span>
            <span>
              {t.station}：
              <b>{station ? station.name[settings.lang] : (view.stationId ?? t.unknownStation)}</b>
            </span>
            <span>
              {t.band}：<b data-testid="band">{bandText}</b>
            </span>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {t.keepOpen}
          </p>
        </div>
      )}

      {packOutdated && (
        <p className="warn" role="status">
          {t.packOutdated}
        </p>
      )}
      {notice && (
        <p className="warn" role="status">
          {notice}
        </p>
      )}

      <section
        key={flash}
        className={`board fs-${settings.fontSize} ${flash ? 'flash' : ''}`}
        aria-live="polite"
        aria-atomic="true"
        aria-label="字幕看板"
      >
        {latest ? (
          (() => {
            const tr = render(latest);
            const p = latest.msg.platform;
            return (
              <>
                <div className="bar">
                  <span className="plat">{p === 0 ? t.allStation : <b>{p}</b>}</span>
                  <span className="label">{p === 0 ? t.latest : `${t.platform}・${t.latest}`}</span>
                  <time>{clock(latest.at)}</time>
                </div>
                <div className="body">
                  <div className="text" data-testid="board-text">
                    {tr.text}
                  </div>
                  <div className="meta">
                    {platformLabel(p)}・{t.fixed(latest.meta.fixed)}
                    {latest.meta.combined ? `・${t.combined}` : ''}
                    {tr.needsReview ? `・${t.needsReview}` : ''}
                  </div>
                </div>
              </>
            );
          })()
        ) : (
          <>
            <div className="bar">
              <span className="label">{t.latest}</span>
            </div>
            <div className="body">
              <div className="text idle">{t.waiting.replace(/…$/, '')}</div>
            </div>
          </>
        )}
      </section>

      {/* 常用顯示設定（語言與字級） */}
      <div className="card stack" style={{ marginTop: 14 }}>
        <div role="group" aria-label={t.language} className="row">
          <strong>{t.language}：</strong>
          {LANGS.map((l) => (
            <button
              key={l}
              aria-pressed={settings.lang === l}
              onClick={() => update({ lang: l })}
              lang={LANG_TAGS[l]}
            >
              {LANG_LABELS[l]}
            </button>
          ))}
        </div>
        <div role="group" aria-label={t.fontSize} className="row">
          <strong>{t.fontSize}：</strong>
          {([1, 2, 3] as const).map((s) => (
            <button key={s} aria-pressed={settings.fontSize === s} onClick={() => update({ fontSize: s })}>
              {'A'.repeat(s)}
            </button>
          ))}
        </div>
      </div>

      {/* 折疊式進階設定與工程數據：讓一般乘客的畫面保持簡潔 */}
      <details className="card" style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>{t.advanced}</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          {running && (
            <div className="status">
              <span>
                {t.sync}：<b>{(level?.score ?? 0).toFixed(2)}</b>
              </span>
              <span>
                <b>{t.okFail(counts.ok, counts.fail)}</b>
              </span>
            </div>
          )}

          {!running && (
            <label className="field">
              {t.mode}
              <select value={settings.band} onChange={(e) => update({ band: Number(e.target.value) })}>
                <option value={-1}>{t.auto}</option>
                {CANDIDATES.map((c, i) => (
                  <option key={i} value={i}>
                    {c.f0 / 1000} kHz・{modeName(c, t)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div role="group" aria-label={t.manualPlatformLabel} className="row">
            <strong>{t.manualPlatformLabel}：</strong>
            <button aria-pressed={settings.platformMode === 'auto'} onClick={() => setPlatformMode('auto')}>
              {t.autoPlatform}
            </button>
            {Array.from({ length: station?.platforms ?? 2 }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                aria-pressed={settings.platformMode === 'manual' && settings.manualPlatform === p}
                onClick={() => setPlatformMode('manual', p)}
              >
                {t.platformN(p)}
              </button>
            ))}
          </div>
        </div>
      </details>

      <section className="card" aria-label={t.history}>
        <h2>{t.history}</h2>
        {view.history.length === 0 ? (
          <p className="muted">—</p>
        ) : (
          <ol className="log" reversed>
            {view.history.map((a) => {
              const tr = render(a);
              return (
                <li key={a.id} data-testid="history-item" data-shown={a.shown}>
                  {a.meta.emergency && <span className="badge emg">{t.emergency}</span>} {tr.text}
                  <div className="small muted">
                    {clock(a.at)}・{platformLabel(a.msg.platform)}・seq {a.msg.seq}
                    {!a.shown && `・${t.hidden}`}
                    {tr.needsReview && <span className="badge review">{t.needsReview}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {emergency && (
        <div
          className="emergency"
          role="alertdialog"
          aria-modal="true"
          aria-live="assertive"
          data-testid="emergency"
        >
          <div className="title">⚠ {t.emergency}</div>
          <div className="text">{render(emergency).text}</div>
          <button onClick={() => setEmergency(null)} autoFocus>
            {t.acknowledge}
          </button>
        </div>
      )}
    </div>
  );
}
