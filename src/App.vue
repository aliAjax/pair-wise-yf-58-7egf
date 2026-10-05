<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const platform = computed(() => store.platform);
const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string; layerName?: string; experimentName?: string; queued?: boolean; allLayers: { layerId: string; layerName: string; hit: boolean; experimentName?: string; reason: string; queued?: boolean }[] } | null>(null);
const user = reactive({ id: 'u-006', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft' });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [], version: 1 });
  store.select(id); store.audit('创建开关', `${values.key} 草稿版本 1`); createOpen.value = false; resetForm();
});
function simulate() { if (active.value) simulation.value = store.simulateHit({ ...user }); }
function assign() {
  if (!active.value) return;
  const exp = store.experiments.find((e) => e.flagId === active.value!.id);
  if (!exp) return;
  const result = store.assignToExperiment({ ...user }, exp.id);
  simulation.value = store.simulateHit({ ...user });
  if (!result.ok && !result.queued) { /* 已在 simulateHit 中展示 */ }
}
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }
function layerUsage(layerId: string) { return store.assignments.filter((a) => a.layerId === layerId).length; }
function expName(expId: string) { return store.experiments.find((e) => e.id === expId)?.name ?? expId; }
function layerName(layerId: string) { return store.layers.find((l) => l.id === layerId)?.name ?? layerId; }
const globalUsage = computed(() => store.assignments.length);
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small"><a-list :data-source="store.flags" bordered><template #renderItem="{ item }"><a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)"><a-list-item-meta><template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template><template #description><code>{{ item.key }}</code> · {{ item.rollout }}%</template></a-list-item-meta></a-list-item></template></a-list></a-card>
          <a-card title="规则命中模拟" size="small" class="mt"><a-form layout="vertical"><a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item><a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row><a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox><a-space class="mt"><a-button type="primary" @click="simulate">{{ $t('simulate') }}</a-button><a-button @click="assign" :disabled="!active || !active.enabled">分配占位</a-button></a-space></a-form>
            <a-alert v-if="simulation" class="mt" :type="simulation.queued ? 'warning' : simulation.hit ? 'success' : 'info'" show-icon
              :message="simulation.queued ? '排队中' : simulation.hit ? '命中' : '未命中'"
              :description="simulation.hit ? `${simulation.layerName} / ${simulation.experimentName}（${simulation.reason}）` : simulation.reason" />
            <div v-if="simulation" class="mt">
              <div class="sim-sub">各层命中情况：</div>
              <div v-for="r in simulation.allLayers" :key="r.layerId" class="sim-row">
                <a-tag :color="r.queued ? 'orange' : r.hit ? 'green' : 'default'">{{ r.queued ? '排队' : r.hit ? '命中' : '未命中' }}</a-tag>
                <span>{{ r.layerName }}<template v-if="r.experimentName"> / {{ r.experimentName }}</template> · {{ r.reason }}</span>
              </div>
            </div>
          </a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb"><template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button><a-button danger ghost @click="store.rollback">回滚</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }"><a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item><a-descriptions-item label="当前放量">{{ active.rollout }}%</a-descriptions-item><a-descriptions-item label="审批">{{ plan.approvals.join('、') || '待审批' }}</a-descriptions-item></a-descriptions>
              <a-divider>规则组合</a-divider><a-form layout="vertical"><a-row :gutter="16"><a-col :span="8"><a-form-item label="目标地区"><a-select :value="active.rules.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" @change="(value: string) => store.updateRule({ region: value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="客户端版本"><a-input :value="active.rules.appVersion" @change="(event: Event) => store.updateRule({ appVersion: (event.target as HTMLInputElement).value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="active.rules.authenticated" @change="(checked: boolean) => store.updateRule({ authenticated: checked })" /></a-form-item></a-col></a-row></a-form>
              <a-divider>逐步放量</a-divider><a-slider :value="active.rollout" :min="0" :max="100" :step="5" @change="(value: number) => store.setRollout(value)" /><div class="rollout-label">{{ active.rollout }}% 用户可命中</div>
              <a-divider>定时生效</a-divider><a-space><a-input type="datetime-local" :value="plan.scheduledAt" @change="(event: Event) => store.schedule((event.target as HTMLInputElement).value)" /><a-button @click="store.schedule(plan.scheduledAt)">保存定时</a-button></a-space>
              <a-divider>审批与发布</a-divider><a-space><a-button :disabled="plan.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button><a-button :disabled="plan.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button><a-button type="primary" :disabled="active.status !== 'approved'" @click="store.startRollout">开始灰度发布</a-button></a-space>
            </a-card>
            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('退出') ? 'red' : 'blue'"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
          </template>
        </a-col>
      </a-row>

      <a-row :gutter="[18,18]" class="mt">
        <a-col :span="24">
          <a-card title="实验层平台" size="small">
            <a-alert type="info" show-icon class="mb"
              :message="`全局名额 ${globalUsage}/${store.globalCapacity}`"
              description="每层容量独立、层内实验互斥（一人一层只能进一个实验），不同层允许同一人同时命中。规则改动后旧占位作废重算：已占住的先保留，超出的按登记先后退出并写清原因。" />
            <a-row :gutter="[12,12]">
              <a-col v-for="layer in store.layers" :key="layer.id" :xs="24" :md="12">
                <a-card size="small" :title="layer.name">
                  <template #extra>
                    <a-space>
                      <a-tag :color="layerUsage(layer.id) >= layer.capacity ? 'red' : 'blue'">{{ layerUsage(layer.id) }}/{{ layer.capacity }}</a-tag>
                      <a-input-number size="small" :min="1" :value="layer.capacity" style="width:74px" @change="(v: number) => store.updateLayerCapacity(layer.id, v)" />
                    </a-space>
                  </template>
                  <a-progress :percent="Math.round((layerUsage(layer.id) / layer.capacity) * 100)" :status="layerUsage(layer.id) >= layer.capacity ? 'exception' : 'active'" />
                  <div class="plat-section">实验（层内互斥）：
                    <a-tag v-for="e in store.experiments.filter(x => x.layerId === layer.id)" :key="e.id" color="geekblue">{{ e.name }}</a-tag>
                  </div>
                  <div class="plat-section">占位：
                    <span v-if="layerUsage(layer.id) === 0" class="plat-empty">暂无</span>
                    <a-tag v-for="a in store.assignments.filter(x => x.layerId === layer.id)" :key="a.userId" color="green">{{ a.userId }} → {{ expName(a.experimentId) }}</a-tag>
                  </div>
                  <div class="plat-section">队列（FIFO）：
                    <span v-if="layer.queue.length === 0" class="plat-empty">空</span>
                    <a-tag v-for="q in layer.queue" :key="q" color="orange">{{ q }}</a-tag>
                  </div>
                </a-card>
              </a-col>
            </a-row>
            <a-divider>退出记录（规则改动重算后）</a-divider>
            <a-table size="small" :data-source="store.evictions" :pagination="false" row-key="id"
              :columns="[
                { title: '时间', dataIndex: 'at', width: 100 },
                { title: '用户', dataIndex: 'userId', width: 100 },
                { title: '层', dataIndex: 'layerId', width: 120, customRender: ({ layerId }: { layerId: string }) => layerName(layerId) },
                { title: '实验', dataIndex: 'experimentId', width: 140, customRender: ({ experimentId }: { experimentId: string }) => expName(experimentId) },
                { title: '退出原因', dataIndex: 'reason' }
              ]" />
          </a-card>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create"><a-form layout="vertical"><a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item><a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item></a-form></a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.ant-list-item { cursor: pointer; }
.sim-sub { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
.sim-row { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 2px 0; }
.plat-section { margin-top: 8px; font-size: 13px; color: #374151; }
.plat-empty { color: #9ca3af; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
