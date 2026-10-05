import { defineStore } from 'pinia';
import { ExperimentPlatform, exitReasonText, waitReasonText, type Snapshot, type User } from '../experiment/engine';

const seedSnapshot: Snapshot = {
  version: 1,
  seq: 0,
  config: {
    globalCapacity: 8,
    layers: [
      {
        id: 'pay', name: '支付链路层', capacity: 6, salt: 'pay-layer-v1',
        experiments: [
          { id: 'checkout-v2', flagKey: 'checkout-v2', name: '新版结算页', weight: 5, enabled: false, capacity: 3, targeting: { regions: ['上海', '北京'], minVersion: '8.2', requireAuth: true } },
          { id: 'checkout-slim', flagKey: 'checkout-slim', name: '轻量结算(游客)', weight: 5, enabled: false, capacity: 3, targeting: { regions: ['上海', '北京', '广东'], minVersion: '8.0' } }
        ]
      },
      {
        id: 'rec', name: '推荐算法层', capacity: 7, salt: 'rec-layer-v1',
        experiments: [
          { id: 'model-b', flagKey: 'recommend-model-b', name: '推荐模型B', weight: 7, enabled: true, capacity: 4, targeting: {} },
          { id: 'model-c', flagKey: 'recommend-model-c', name: '推荐模型C', weight: 3, enabled: false, targeting: { minVersion: '8.2', requireAuth: true } }
        ]
      }
    ]
  },
  users: [],
  placements: [],
  audit: []
};

interface State {
  tick: number;
  lastReport: Snapshot | null;
}

let platform: ExperimentPlatform;
function loadPlatform(): ExperimentPlatform {
  const saved = localStorage.getItem('yf58-experiment-state');
  if (saved) {
    try {
      return ExperimentPlatform.restore(JSON.parse(saved) as Snapshot);
    } catch {
      // 快照损坏时回落到种子
    }
  }
  return new ExperimentPlatform(seedSnapshot.config);
}
platform = loadPlatform();

export const useExperimentStore = defineStore('experiments', {
  state: (): State => ({ tick: 0, lastReport: null }),
  getters: {
    // 依赖 tick：引擎内部状态变化（bump）后驱动所有用到 p 的模板重新渲染
    p(): ExperimentPlatform { void this.tick; return platform; },
    globalUsed(): number { void this.tick; return platform.globalOccupied(); }
  },
  actions: {
    bump() { this.tick += 1; this.persist(); },
    persist() { localStorage.setItem('yf58-experiment-state', JSON.stringify(platform.snapshot())); },
    admit(user: User) {
      const results = platform.admit(user);
      this.bump();
      return results;
    },
    /** 规则改动：旧占位作废重算 */
    applyRules(config: Snapshot['config'], note: string, actor = '当前操作人') {
      const report = platform.changeRules(config, note, actor);
      this.bump();
      this.lastReport = platform.snapshot();
      return report;
    },
    toggleExperiment(layerId: string, experimentId: string, enabled: boolean) {
      const next = structuredClone(platform.config);
      const exp = next.layers.find((l) => l.id === layerId)?.experiments.find((e) => e.id === experimentId);
      if (!exp) return;
      exp.enabled = enabled;
      return this.applyRules(next, `${enabled ? '打开' : '关闭'}开关 ${exp.flagKey}（${exp.name}）`);
    },
    setLayerCapacity(layerId: string, capacity: number) {
      const next = structuredClone(platform.config);
      const layer = next.layers.find((l) => l.id === layerId);
      if (!layer) return;
      const from = layer.capacity;
      layer.capacity = capacity;
      return this.applyRules(next, `层「${layer.name}」容量 ${from} → ${capacity}`);
    },
    setGlobalCapacity(capacity: number) {
      const next = structuredClone(platform.config);
      const from = next.globalCapacity;
      next.globalCapacity = capacity;
      return this.applyRules(next, `全局名额 ${from} → ${capacity}`);
    },
    resetDemo() {
      platform = new ExperimentPlatform(structuredClone(seedSnapshot.config));
      this.lastReport = null;
      this.bump();
    },
    reasonText(state: string, wait?: string, exit?: string): string {
      if (state === 'queued' && wait) return waitReasonText(wait as Parameters<typeof waitReasonText>[0]);
      if (state === 'exited' && exit) return exitReasonText(exit as Parameters<typeof exitReasonText>[0]);
      return '';
    }
  }
});
