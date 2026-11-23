import { lazy, Suspense } from 'react';
import { DataProvider } from './app/data.tsx';
import { useRoute } from './app/ui.tsx';

const RxPage = lazy(() => import('./features/rx/RxPage.tsx'));
const StationPage = lazy(() => import('./features/station/StationPage.tsx'));
const AdminPage = lazy(() => import('./features/admin/AdminPage.tsx'));
const LabPage = lazy(() => import('./features/lab/LabPage.tsx'));

const STAFF_NAV = [
  ['/station', '站務發送端'],
  ['/admin', '模板管理'],
  ['/lab', '硬體診斷'],
  ['/rx', '乘客端'],
] as const;

export default function App() {
  const route = useRoute();
  const isRx = route === '/' || route === '/rx';

  const page =
    route === '/station' ? (
      <StationPage />
    ) : route === '/admin' ? (
      <AdminPage />
    ) : route === '/lab' ? (
      <LabPage />
    ) : (
      <RxPage />
    );

  return (
    <DataProvider>
      <a className="skip" href="#content">
        跳到主要內容
      </a>
      {isRx ? (
        <header
          style={{
            background: 'rgba(15, 23, 42, 0.72)',
            borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
            marginBottom: 8,
          }}
        >
          <div
            style={{
              maxWidth: 680,
              margin: '0 auto',
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: 'rgba(59, 130, 246, 0.16)',
                border: '1px solid rgba(59, 130, 246, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#60a5fa',
                flexShrink: 0,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 4v16" />
                <path d="M8 8v8" />
                <path d="M16 8v8" />
                <path d="M4 11v2" />
                <path d="M20 11v2" />
              </svg>
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800, color: '#f8fafc', letterSpacing: '0.03em', lineHeight: 1.25 }}>
                聽見廣播
              </h1>
              <p style={{ margin: 0, fontSize: '0.76rem', color: '#94a3b8', lineHeight: 1.3 }}>
                車站無障礙即時字幕
              </p>
            </div>
          </div>
        </header>
      ) : (
        <header className="top">
          <span className="logo">聽見廣播</span>
          <nav aria-label="主選單">
            {STAFF_NAV.map(([path, label]) => (
              <a key={path} href={`#${path}`} aria-current={route === path ? 'page' : undefined}>
                {label}
              </a>
            ))}
          </nav>
        </header>
      )}
      <main id="content">
        <Suspense fallback={<p role="status">載入中…</p>}>{page}</Suspense>
      </main>
    </DataProvider>
  );
}