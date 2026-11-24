/**
 * 共用元件：確認視窗、Hash 路由。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

/** 目前的 hash 路由（例如 '/rx'） */
export function useRoute(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('hashchange', cb);
      return () => window.removeEventListener('hashchange', cb);
    },
    () => window.location.hash.replace(/^#/, '') || '/',
  );
}

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

/** 確認視窗（使用原生 <dialog>，鍵盤與螢幕閱讀器可操作） */
export function ConfirmDialog({ req }: { req: ConfirmRequest | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (req && !d.open) d.showModal();
    if (!req && d.open) d.close();
  }, [req]);
  return (
    <dialog ref={ref} aria-labelledby="confirm-title" onCancel={() => req?.resolve(false)}>
      {req && (
        <div className="stack">
          <h2 id="confirm-title">{req.title}</h2>
          <div>{req.body}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => req.resolve(false)}>取消</button>
            <button className={req.danger ? 'danger' : 'primary'} onClick={() => req.resolve(true)} autoFocus>
              {req.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

/** 以 Promise 方式使用確認視窗 */
export function useConfirm(): [
  ConfirmRequest | null,
  (r: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>,
] {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const ask = (r: Omit<ConfirmRequest, 'resolve'>) =>
    new Promise<boolean>((resolve) =>
      setReq({
        ...r,
        resolve: (ok) => {
          setReq(null);
          resolve(ok);
        },
      }),
    );
  return [req, ask];
}

/** 偵測是否為手機（觸控、窄螢幕） */
export const isMobile = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700);

/** 格式化時間 hh:mm:ss */
export const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString('zh-TW', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** public/illust 底下的插圖（いらすとや） */
export const illust = (name: string): string => `${import.meta.env.BASE_URL}illust/${name}.png`;

/** 頁首：圓體標題、說明與右側插圖 */
export function PageHead({ title, sub, art }: { title: ReactNode; sub?: ReactNode; art?: string }) {
  return (
    <div className="page-head">
      <div className="words">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {art && <img src={illust(art)} alt="" />}
    </div>
  );
}
