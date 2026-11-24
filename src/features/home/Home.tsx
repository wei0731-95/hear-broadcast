import { illust, isMobile } from '../../app/ui.tsx';

const ENTRIES = {
  rx: {
    href: '#/rx',
    title: '我是乘客',
    desc: '打開麥克風接收車站廣播，即時顯示多語字幕。',
    go: '開始收聽',
    art: 'mimi_sumasu_man2',
  },
  station: {
    href: '#/station',
    title: '站務端',
    desc: '選擇模板或輸入文字，透過現有喇叭送出高頻廣播。',
    go: '前往播出',
    art: 'job_ekiin_man',
  },
  admin: {
    href: '#/admin',
    title: '模板管理',
    desc: '編輯廣播模板、6 種語言翻譯與站點設定。',
    go: '前往管理',
    art: 'computer_programming_man',
  },
};

const FEATURES = [
  ['位', '聲音天生帶有位置資訊', '只有聽得到這支喇叭的人才收得到，自動判斷您在哪個月台。'],
  ['離', '完全離線', '模板庫存在手機裡，地下車站斷網時照樣能用。'],
  ['免', '免安裝', '直接用瀏覽器開啟，也可以加入主畫面。'],
  ['走', '邊走邊收', '自動補償走動造成的都卜勒頻率偏移。'],
  ['急', '緊急疏散模式', '緊急廣播會全螢幕紅色閃爍並震動。'],
] as const;

export default function Home() {
  // 手機開啟時把「我是乘客」放在最前面
  const order = isMobile() ? (['rx', 'station', 'admin'] as const) : (['station', 'rx', 'admin'] as const);
  return (
    <>
      <section className="hero">
        <div>
          <span className="kicker">車站廣播字幕系統</span>
          <h1>
            讓每一則廣播，
            <br />
            <em>都被看見</em>
          </h1>
          <p>
            車站喇叭播廣播時，同時送出<strong>人耳聽不到的高頻聲波（19.5 kHz 以上）</strong>
            。乘客用手機網頁接收，即時顯示中文、English、日本語、한국어、台語、客語字幕，不必加裝任何硬體。
          </p>
        </div>
        <div className="art" aria-hidden="true">
          <img src={illust('hochouki_obaasan')} alt="" />
          <img src={illust('kanban_gaikokujin_happy')} alt="" />
        </div>
      </section>

      <div className="entries">
        {order.map((k) => (
          <a key={k} className="entry" href={ENTRIES[k].href}>
            <strong>{ENTRIES[k].title}</strong>
            <span>{ENTRIES[k].desc}</span>
            <div className="go">{ENTRIES[k].go} →</div>
            <img src={illust(ENTRIES[k].art)} alt="" />
          </a>
        ))}
      </div>

      <section className="card" style={{ marginTop: 28 }}>
        <h2>為什麼用聲音傳字幕</h2>
        <ul className="features">
          {FEATURES.map(([ic, title, desc]) => (
            <li key={title}>
              <span className="ic" aria-hidden="true">
                {ic}
              </span>
              <div>
                <b>{title}</b>
                <span>{desc}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p>
        第一次在現場使用？先到 <a href="#/lab">硬體診斷</a> 用掃頻確認喇叭與手機可用的頻段。
      </p>
      <p className="credit">插圖：いらすとや</p>
    </>
  );
}
