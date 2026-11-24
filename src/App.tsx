import { lazy, Suspense } from 'react';
import { DataProvider } from './app/data.tsx';
import { useRoute } from './app/ui.tsx';
import Home from './features/home/Home.tsx';

const RxPage = lazy(() => import('./features/rx/RxPage.tsx'));
const StationPage = lazy(() => import('./features/station/StationPage.tsx'));
const AdminPage = lazy(() => import('./features/admin/AdminPage.tsx'));
const LabPage = lazy(() => import('./features/lab/LabPage.tsx'));

const NAV = [
  ['/', '首頁'],
  ['/rx', '乘客'],
  ['/station', '站務端'],
  ['/admin', '模板管理'],
  ['/lab', '硬體診斷'],
] as const;

export default function App() {
  const route = useRoute();
  const page =
    route === '/rx' ? (
      <RxPage />
    ) : route === '/station' ? (
      <StationPage />
    ) : route === '/admin' ? (
      <AdminPage />
    ) : route === '/lab' ? (
      <LabPage />
    ) : (
      <Home />
    );
  return (
    <DataProvider>
      <a className="skip" href="#content">
        跳到主要內容
      </a>
      <header className="top">
        <div className="inner">
          <a className="logo" href="#/">
            <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
            聽見廣播
          </a>
          <nav aria-label="主選單">
            {NAV.map(([path, label]) => (
              <a key={path} href={`#${path}`} aria-current={route === path ? 'page' : undefined}>
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main id="content">
        <Suspense fallback={<p role="status">載入中…</p>}>{page}</Suspense>
      </main>
    </DataProvider>
  );
}
