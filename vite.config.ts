import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// 部署到 GitHub Pages 時 base 是 /hear-broadcast/；Docker 與本機用 /。以 VITE_BASE 覆寫。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE ?? '/';
  return {
    base,
    plugins: [
      react(),
      // npm run dev:https：自簽憑證，讓同一個區網的手機也能用麥克風（瀏覽器需按「繼續前往」）
      ...(mode === 'https' ? [basicSsl()] : []),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg'],
        manifest: {
          name: '聽見廣播 Hear Broadcast',
          short_name: '聽見廣播',
          description: '用車站喇叭送出人耳聽不到的高頻聲波，手機即時顯示多語字幕',
          lang: 'zh-Hant-TW',
          theme_color: '#fbf6ec',
          background_color: '#fbf6ec',
          display: 'standalone',
          start_url: './#/rx',
          scope: './',
          icons: [
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
        workbox: {
          // 模板資料也要快取，地下車站斷網時照樣能用
          globPatterns: ['**/*.{js,css,html,svg,png,json,webmanifest}'],
          navigateFallback: 'index.html',
          runtimeCaching: [
            {
              urlPattern: ({ url }) =>
                url.pathname.endsWith('/data/template-pack.json') ||
                url.pathname.endsWith('/data/stations.json'),
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'hb-data' },
            },
            {
              // 圓體字型依用到的字分片下載，用過的分片留在快取，離線時其餘字退回系統字型
              urlPattern: ({ url }) => /huninn-.*\.woff2?$/.test(url.pathname),
              handler: 'CacheFirst',
              options: { cacheName: 'hb-fonts', expiration: { maxEntries: 120 } },
            },
          ],
        },
      }),
    ],
    server: { host: mode === 'https' ? true : undefined },
    worker: { format: 'es' },
  };
});
