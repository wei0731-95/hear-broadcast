/**
 * 接收端音訊管線（主執行緒）：
 *   麥克風 → AudioWorklet 擷取（不支援時退回 ScriptProcessor）→ DSP Web Worker 解調 → 回呼。
 * 主執行緒只負責轉送樣本與計算環境音量，不做任何 Goertzel／FFT。
 */
import { openMicrophone } from '../platform/index.ts';
import type { RxOptions } from '../modem/config.ts';
import type {
  FeatureRow,
  FromWorker,
  LevelInfo,
  RxMode,
  ToWorker,
  WorkerFailure,
  WorkerMessage,
} from './protocol.ts';
import workletUrl from './capture.worklet.ts?worker&url';
import DspWorker from './dsp.worker.ts?worker';

export interface PipelineCallbacks {
  onEvent(e: WorkerMessage | WorkerFailure): void;
  onLevel?(l: LevelInfo): void;
  onLock?(cfg: LevelInfo['locked']): void;
  onVolume?(rms: number): void;
  onError?(message: string): void;
}

export class ReceiverPipeline {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private node: AudioNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private featureWaiter:
    ((r: { rows: FeatureRow[]; decoded: (WorkerMessage | WorkerFailure)[] }) => void) | null = null;
  /** 使用的擷取方式 */
  captureKind: 'worklet' | 'script-processor' | null = null;
  sampleRate = 0;

  constructor(private readonly cb: PipelineCallbacks) {}

  get running(): boolean {
    return this.ctx !== null;
  }

  /** 開始接收（必須由使用者手勢觸發） */
  async start(mode: RxMode, opts?: Partial<RxOptions>): Promise<void> {
    if (this.ctx) return;
    this.stream = await openMicrophone();
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    const worker = new DspWorker();
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    worker.onerror = (e) => this.cb.onError?.(`DSP Worker 錯誤：${e.message}`);
    this.send({ type: 'init', fs: ctx.sampleRate, mode, opts });
    this.source = ctx.createMediaStreamSource(this.stream);

    let lastVolAt = 0;
    const forward = (data: Float32Array) => {
      if (this.cb.onVolume && data.length > 0) {
        const now = performance.now();
        if (now - lastVolAt >= 70) {
          lastVolAt = now;
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          this.cb.onVolume(Math.sqrt(sum / data.length));
        }
      }
      this.worker?.postMessage({ type: 'samples', data } satisfies ToWorker, [data.buffer]);
    };

    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'hb-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => forward(e.data);
      this.source.connect(node);
      this.node = node;
      this.captureKind = 'worklet';
    } else {
      // 舊瀏覽器：ScriptProcessor（已被標為過時，但仍可用）
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => forward(Float32Array.from(e.inputBuffer.getChannelData(0)));
      this.source.connect(sp);
      sp.connect(ctx.destination); // 部分瀏覽器要連到輸出才會觸發；輸出為靜音
      this.node = sp;
      this.captureKind = 'script-processor';
    }
    if (ctx.state === 'suspended') await ctx.resume();
  }

  /** 停止接收並釋放麥克風 */
  async stop(): Promise<void> {
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.worker?.terminate();
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.worker = null;
    this.node = null;
    this.source = null;
    this.captureKind = null;
  }

  /**
   * 建立接在麥克風上的 AnalyserNode（診斷頁的即時頻譜顯示用；瀏覽器原生 FFT，不佔用 DSP Worker）。
   */
  createAnalyser(fftSize = 8192): AnalyserNode | null {
    if (!this.ctx || !this.source) return null;
    const a = this.ctx.createAnalyser();
    a.fftSize = fftSize;
    a.smoothingTimeConstant = 0.2;
    a.minDecibels = -140;
    a.maxDecibels = -10;
    this.source.connect(a);
    return a;
  }

  /** 開關「頻道特徵」記錄 */
  setFeatures(on: boolean): void {
    this.send({ type: 'features', on });
  }

  /** 取出記錄的頻道特徵（不含任何原始音訊） */
  dumpFeatures(): Promise<{ rows: FeatureRow[]; decoded: (WorkerMessage | WorkerFailure)[] }> {
    return new Promise((resolve) => {
      if (!this.worker) return resolve({ rows: [], decoded: [] });
      this.featureWaiter = resolve;
      this.send({ type: 'dumpFeatures' });
    });
  }

  private send(m: ToWorker): void {
    this.worker?.postMessage(m);
  }

  private handle(m: FromWorker): void {
    switch (m.type) {
      case 'event':
        this.cb.onEvent(m.event);
        break;
      case 'level':
        this.cb.onLevel?.(m.level);
        break;
      case 'lock':
        this.cb.onLock?.(m.cfg);
        break;
      case 'features':
        this.featureWaiter?.({ rows: m.rows, decoded: m.decoded });
        this.featureWaiter = null;
        break;
      case 'error':
        this.cb.onError?.(m.message);
        break;
    }
  }
}