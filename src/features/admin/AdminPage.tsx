/**
 * 模板管理（#/admin）：模板與站點設定的編輯（草稿存在 IndexedDB）、驗證、預覽、匯入／匯出。
 * 正式發布：把匯出的 template-pack.json、stations.json 放進 public/data/ 後重新部署。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog, PageHead, useConfirm } from '../../app/ui.tsx';
import { renderTemplate, validatePack, type TemplateIssue } from '../../data/render.ts';
import { LocalRepository, exportBundle, importBundle } from '../../data/repository.ts';
import {
  DataFormatError,
  LANG_LABELS,
  LANGS,
  parseWith,
  stationsFileSchema,
  templatePackSchema,
  type Lang,
  type Localized,
  type ParamType,
  type Station,
  type StationsFile,
  type Template,
  type TemplatePack,
  type TemplateParam,
} from '../../data/schema.ts';
import { downloadFile } from '../../platform/index.ts';

const repo = new LocalRepository();

const emptyLocalized = (): Localized => ({ zh: '', en: '', ja: '', ko: '', nan: '', hak: '' });
const reviewFlags = () => ({ zh: false, en: true, ja: true, ko: true, nan: true, hak: true });

function newTemplate(pack: TemplatePack): Template {
  const used = new Set(pack.templates.map((t) => t.id));
  let id = 1;
  while (used.has(id) && id < 255) id++;
  return {
    id,
    name: '新模板',
    category: 'general',
    params: [],
    text: emptyLocalized(),
    needsReview: reviewFlags(),
  };
}

const PARAM_LABEL: Record<ParamType, string> = {
  number: '數字',
  station: '目的地站名',
  exit: '出口',
  platform: '月台',
};

function makeParam(key: 'p1' | 'p2', type: ParamType, label: string): TemplateParam {
  return type === 'number' ? { key, type, label, min: 0, max: 255 } : { key, type, label };
}

export default function AdminPage() {
  const [pack, setPack] = useState<TemplatePack | null>(null);
  const [stations, setStations] = useState<StationsFile | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [onlyReview, setOnlyReview] = useState(false);
  const [tab, setTab] = useState<'templates' | 'stations'>('templates');
  const [confirmReq, confirm] = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([repo.loadPack(), repo.loadStations(), repo.hasDraft()])
      .then(([p, s, d]) => {
        setPack(p);
        setStations(s);
        setHasDraft(d);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const savePack = (p: TemplatePack) => {
    setPack(p);
    setHasDraft(true);
    repo.savePack(p).catch((e: unknown) => setError(`草稿儲存失敗：${String(e)}`));
  };
  const saveStations = (s: StationsFile) => {
    setStations(s);
    setHasDraft(true);
    repo.saveStations(s).catch((e: unknown) => setError(`草稿儲存失敗：${String(e)}`));
  };

  const issues = useMemo(() => (pack ? validatePack(pack) : []), [pack]);

  if (error && !pack)
    return (
      <div className="error" role="alert">
        {error}
      </div>
    );
  if (!pack || !stations) return <p role="status">載入中…</p>;

  const station = stations.stations[0];
  const list = pack.templates.filter((t) => !onlyReview || LANGS.some((l) => t.needsReview[l]));
  const editingTpl = editing === null ? null : pack.templates[editing];

  const updateTemplate = (index: number, t: Template) => {
    const templates = pack.templates.slice();
    templates[index] = t;
    savePack({ ...pack, templates });
  };

  const exportFiles = () => {
    setError(null);
    try {
      parseWith(stationsFileSchema, stations, '站點設定');
      parseWith(templatePackSchema, pack, '模板庫');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const bundle = exportBundle(pack, stations);
    downloadFile(JSON.stringify(bundle.pack, null, 2), 'template-pack.json', 'application/json');
    downloadFile(JSON.stringify(bundle.stations, null, 2), 'stations.json', 'application/json');
    savePack(bundle.pack);
    setInfo(`已匯出 packVersion ${bundle.pack.packVersion}。請把兩個檔案放進 public/data/ 後重新部署。`);
  };

  const importFile = async (file: File) => {
    setError(null);
    try {
      const data: unknown = JSON.parse(await file.text());
      const obj = data as Record<string, unknown>;
      if (obj && 'pack' in obj && 'stations' in obj) {
        const b = importBundle(data);
        savePack(b.pack);
        saveStations(b.stations);
      } else if (obj && 'templates' in obj) {
        savePack(parseWith(templatePackSchema, data, file.name));
      } else if (obj && 'stations' in obj) {
        saveStations(parseWith(stationsFileSchema, data, file.name));
      } else {
        throw new DataFormatError(`${file.name} 不是模板庫或站點設定`);
      }
      setInfo(`已匯入 ${file.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const resetDraft = async () => {
    const ok = await confirm({
      title: '捨棄草稿？',
      body: <p>將刪除 IndexedDB 中的所有編輯，回到網站上目前發布的版本。</p>,
      confirmLabel: '捨棄草稿',
      danger: true,
    });
    if (!ok) return;
    await repo.clear();
    const [p, s] = await Promise.all([repo.loadPack(), repo.loadStations()]);
    setPack(p);
    setStations(s);
    setHasDraft(false);
    setEditing(null);
  };

  const removeTemplate = async (index: number) => {
    const t = pack.templates[index];
    const ok = await confirm({
      title: `刪除模板 #${t.id}？`,
      body: <p>「{t.name}」將從草稿中刪除。已部署的版本不受影響，直到重新發布。</p>,
      confirmLabel: '刪除',
      danger: true,
    });
    if (!ok) return;
    savePack({ ...pack, templates: pack.templates.filter((_, i) => i !== index) });
    setEditing(null);
  };

  return (
    <>
      <PageHead
        title="模板管理"
        sub="編輯廣播模板、六種語言的翻譯與車站設定。"
        art="computer_programming_man"
      />
      <ConfirmDialog req={confirmReq} />
      <div className="card stack">
        <p className="small">
          編輯中的內容自動存在本機（IndexedDB）{hasDraft ? '，目前有未發布的草稿' : ''}。
          正式發布：按「匯出」取得 <code>template-pack.json</code> 與 <code>stations.json</code>（packVersion
          自動加 1），放進專案的 <code>public/data/</code> 後重新部署。
        </p>
        <div className="row">
          <button className="primary" onClick={exportFiles} disabled={issues.length > 0}>
            匯出（packVersion {pack.packVersion} → {(pack.packVersion + 1) % 256}）
          </button>
          <button onClick={() => fileInput.current?.click()}>匯入 JSON</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
          <button onClick={() => void resetDraft()} disabled={!hasDraft}>
            捨棄草稿
          </button>
        </div>
        {issues.length > 0 && (
          <div className="warn" role="status">
            有 {issues.length} 個驗證問題，修正後才能匯出：
            <IssueList issues={issues} />
          </div>
        )}
        {info && <p className="ok">{info}</p>}
        {error && (
          <div className="error" role="alert">
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{error}</pre>
          </div>
        )}
      </div>

      <div role="tablist" className="row" style={{ marginBottom: 12 }}>
        <button
          role="tab"
          aria-selected={tab === 'templates'}
          aria-pressed={tab === 'templates'}
          onClick={() => setTab('templates')}
        >
          模板（{pack.templates.length}）
        </button>
        <button
          role="tab"
          aria-selected={tab === 'stations'}
          aria-pressed={tab === 'stations'}
          onClick={() => setTab('stations')}
        >
          站點設定
        </button>
      </div>

      {tab === 'templates' ? (
        <div className="grid two">
          <section className="card stack" aria-label="模板列表">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>模板列表</h2>
              <button
                className="primary"
                onClick={() => {
                  const t = newTemplate(pack);
                  savePack({ ...pack, templates: [...pack.templates, t] });
                  setEditing(pack.templates.length);
                }}
              >
                新增模板
              </button>
            </div>
            <label className="chk">
              <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
              只顯示有待校對翻譯的模板
            </label>
            <ul className="log" style={{ listStyle: 'none', paddingLeft: 0, maxHeight: 'none' }}>
              {list.map((t) => {
                const index = pack.templates.indexOf(t);
                const review = LANGS.filter((l) => t.needsReview[l]);
                return (
                  <li key={index}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        <strong>
                          #{t.id} {t.name}
                        </strong>{' '}
                        {t.category === 'emergency' && <span className="badge emg">緊急</span>}{' '}
                        {review.length > 0 && <span className="badge review">待校對 {review.length}</span>}
                      </span>
                      <span className="row">
                        <button aria-pressed={editing === index} onClick={() => setEditing(index)}>
                          編輯
                        </button>
                        <button
                          onClick={() => {
                            const copy: Template = {
                              ...structuredClone(t),
                              id: newTemplate(pack).id,
                              name: `${t.name}（複製）`,
                            };
                            savePack({ ...pack, templates: [...pack.templates, copy] });
                            setEditing(pack.templates.length);
                          }}
                        >
                          複製
                        </button>
                        <button onClick={() => void removeTemplate(index)}>刪除</button>
                      </span>
                    </div>
                    <div className="small muted">{t.text.zh}</div>
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="card" aria-label="模板編輯">
            {editingTpl && editing !== null ? (
              <TemplateEditor
                key={editing}
                t={editingTpl}
                station={station}
                issues={issues.filter((i) => i.templateId === editingTpl.id)}
                onChange={(t) => updateTemplate(editing, t)}
              />
            ) : (
              <p className="muted">從左側選擇要編輯的模板。</p>
            )}
          </section>
        </div>
      ) : (
        <StationEditor stations={stations} onChange={saveStations} />
      )}
    </>
  );
}

function IssueList({ issues }: { issues: TemplateIssue[] }) {
  return (
    <ul className="small" style={{ margin: '6px 0 0' }}>
      {issues.slice(0, 12).map((i, k) => (
        <li key={k}>
          #{i.templateId}
          {i.lang ? `（${LANG_LABELS[i.lang]}）` : ''}：{i.message}
        </li>
      ))}
      {issues.length > 12 && <li>…另有 {issues.length - 12} 個</li>}
    </ul>
  );
}

function TemplateEditor({
  t,
  station,
  issues,
  onChange,
}: {
  t: Template;
  station: Station | undefined;
  issues: TemplateIssue[];
  onChange: (t: Template) => void;
}) {
  const [sample, setSample] = useState({ p1: 1, p2: 2 });
  const setParam = (key: 'p1' | 'p2', p: TemplateParam | null) => {
    const others = t.params.filter((x) => x.key !== key);
    onChange({ ...t, params: (p ? [...others, p] : others).sort((a, b) => a.key.localeCompare(b.key)) });
  };
  return (
    <div className="stack">
      <h2>編輯模板 #{t.id}</h2>
      <div className="row">
        <label className="field">
          templateId（0～255）
          <input
            type="number"
            min={0}
            max={255}
            value={t.id}
            onChange={(e) =>
              onChange({ ...t, id: Math.max(0, Math.min(255, Math.round(Number(e.target.value)) || 0)) })
            }
          />
        </label>
        <label className="field" style={{ flex: 1 }}>
          名稱
          <input value={t.name} onChange={(e) => onChange({ ...t, name: e.target.value })} />
        </label>
        <label className="field">
          類別
          <select
            value={t.category}
            onChange={(e) => onChange({ ...t, category: e.target.value as Template['category'] })}
          >
            <option value="general">一般</option>
            <option value="emergency">緊急</option>
          </select>
        </label>
      </div>
      <h3>參數</h3>
      {(['p1', 'p2'] as const).map((key) => {
        const p = t.params.find((x) => x.key === key);
        return (
          <div key={key} className="row">
            <strong style={{ width: 28 }}>{key}</strong>
            <select
              aria-label={`${key} 型別`}
              value={p?.type ?? ''}
              onChange={(e) =>
                setParam(
                  key,
                  e.target.value
                    ? makeParam(
                        key,
                        e.target.value as ParamType,
                        p?.label ?? PARAM_LABEL[e.target.value as ParamType],
                      )
                    : null,
                )
              }
            >
              <option value="">（不使用）</option>
              {(Object.keys(PARAM_LABEL) as ParamType[]).map((ty) => (
                <option key={ty} value={ty}>
                  {PARAM_LABEL[ty]}
                </option>
              ))}
            </select>
            {p && (
              <input
                aria-label={`${key} 標籤`}
                value={p.label}
                onChange={(e) => setParam(key, { ...p, label: e.target.value })}
              />
            )}
            {p?.type === 'number' && (
              <>
                <input
                  aria-label={`${key} 最小值`}
                  type="number"
                  min={0}
                  max={255}
                  value={p.min}
                  style={{ width: 90 }}
                  onChange={(e) => setParam(key, { ...p, min: Number(e.target.value) })}
                />
                <input
                  aria-label={`${key} 最大值`}
                  type="number"
                  min={0}
                  max={255}
                  value={p.max}
                  style={{ width: 90 }}
                  onChange={(e) => setParam(key, { ...p, max: Number(e.target.value) })}
                />
              </>
            )}
          </div>
        );
      })}
      <p className="small muted">
        文字中可用佔位符：{'{p1}'}、{'{p2}'}、{'{station}'}（目前車站名稱）。
      </p>
      <h3>文字與預覽</h3>
      <div className="row small">
        預覽參數：p1
        <input
          type="number"
          style={{ width: 80 }}
          value={sample.p1}
          onChange={(e) => setSample({ ...sample, p1: Number(e.target.value) })}
        />
        p2
        <input
          type="number"
          style={{ width: 80 }}
          value={sample.p2}
          onChange={(e) => setSample({ ...sample, p2: Number(e.target.value) })}
        />
      </div>
      {LANGS.map((l: Lang) => (
        <div key={l} className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{LANG_LABELS[l]}</strong>
            <label className="chk small">
              <input
                type="checkbox"
                checked={t.needsReview[l]}
                onChange={(e) => onChange({ ...t, needsReview: { ...t.needsReview, [l]: e.target.checked } })}
              />
              待校對
            </label>
          </div>
          <textarea
            aria-label={`${LANG_LABELS[l]}文字`}
            value={t.text[l]}
            onChange={(e) => onChange({ ...t, text: { ...t.text, [l]: e.target.value } })}
          />
          <div className="small">預覽：{renderTemplate(t, sample, station, l)}</div>
          {issues
            .filter((i) => i.lang === l)
            .map((i, k) => (
              <div key={k} className="error small">
                {i.message}
              </div>
            ))}
        </div>
      ))}
      {issues
        .filter((i) => !i.lang)
        .map((i, k) => (
          <div key={k} className="error small">
            {i.message}
          </div>
        ))}
    </div>
  );
}

function LocalizedInputs({
  value,
  onChange,
  label,
}: {
  value: Localized;
  onChange: (v: Localized) => void;
  label: string;
}) {
  return (
    <div className="row">
      {LANGS.map((l) => (
        <input
          key={l}
          aria-label={`${label}（${LANG_LABELS[l]}）`}
          placeholder={LANG_LABELS[l]}
          value={value[l]}
          style={{ width: 120 }}
          onChange={(e) => onChange({ ...value, [l]: e.target.value })}
        />
      ))}
    </div>
  );
}

function StationEditor({
  stations,
  onChange,
}: {
  stations: StationsFile;
  onChange: (s: StationsFile) => void;
}) {
  const [index, setIndex] = useState(0);
  const st = stations.stations[index];
  const set = (s: Station) => {
    const list = stations.stations.slice();
    list[index] = s;
    onChange({ stations: list });
  };
  const listEditor = (key: 'exits' | 'destinations', title: string) => (
    <>
      <h3>{title}</h3>
      {st[key].map((item, i) => (
        <div key={i} className="row" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
          <input
            aria-label={`${title} id`}
            type="number"
            min={0}
            max={255}
            value={item.id}
            style={{ width: 80 }}
            onChange={(e) => {
              const arr = st[key].slice();
              arr[i] = { ...item, id: Number(e.target.value) };
              set({ ...st, [key]: arr });
            }}
          />
          <LocalizedInputs
            label={title}
            value={item.name}
            onChange={(name) => {
              const arr = st[key].slice();
              arr[i] = { ...item, name };
              set({ ...st, [key]: arr });
            }}
          />
          <button onClick={() => set({ ...st, [key]: st[key].filter((_, k) => k !== i) })}>移除</button>
        </div>
      ))}
      <button
        onClick={() =>
          set({
            ...st,
            [key]: [
              ...st[key],
              { id: Math.max(-1, ...st[key].map((x) => x.id)) + 1, name: emptyLocalized() },
            ],
          })
        }
      >
        新增
      </button>
    </>
  );
  return (
    <section className="card stack" aria-label="站點設定">
      <div className="row">
        <label className="field">
          車站
          <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
            {stations.stations.map((s, i) => (
              <option key={i} value={i}>
                #{s.stationId} {s.name.zh}
              </option>
            ))}
          </select>
        </label>
        <button
          style={{ alignSelf: 'flex-end' }}
          onClick={() => {
            const id = Math.max(...stations.stations.map((s) => s.stationId)) + 1;
            onChange({
              stations: [
                ...stations.stations,
                { stationId: id, name: emptyLocalized(), platforms: 2, exits: [], destinations: [] },
              ],
            });
            setIndex(stations.stations.length);
          }}
        >
          新增車站
        </button>
      </div>
      <div className="row">
        <label className="field">
          stationId（0～255）
          <input
            type="number"
            min={0}
            max={255}
            value={st.stationId}
            onChange={(e) => set({ ...st, stationId: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          月台數（1～15）
          <input
            type="number"
            min={1}
            max={15}
            value={st.platforms}
            onChange={(e) => set({ ...st, platforms: Math.max(1, Math.min(15, Number(e.target.value))) })}
          />
        </label>
      </div>
      <h3>站名</h3>
      <LocalizedInputs label="站名" value={st.name} onChange={(name) => set({ ...st, name })} />
      {listEditor('exits', '出口列表')}
      {listEditor('destinations', '目的地站名')}
    </section>
  );
}
