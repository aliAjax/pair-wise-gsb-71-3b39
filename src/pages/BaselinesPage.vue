<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { getBaselines, getProjects } from '@/api/http'
import type { BaselineStatus } from '@/types'

const projectId = ref('')
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: baselines, isLoading } = useQuery({
  queryKey: ['baselines', projectId],
  queryFn: () => getBaselines(projectId.value || undefined),
})

const projectName = (id: string) => projects.value?.find((project) => project.id === id)?.name ?? id

const statusMeta: Record<BaselineStatus, { color: string; label: string }> = {
  active: { color: 'green', label: '生效中' },
  superseded: { color: 'gray', label: '已被取代' },
  invalidated: { color: 'red', label: '已失效待复核' },
}

const statusOf = (status: string) => statusMeta[status as BaselineStatus]

const activeCount = computed(() => baselines.value?.filter((item) => item.status === 'active').length ?? 0)
const invalidatedCount = computed(
  () => baselines.value?.filter((item) => item.status === 'invalidated').length ?? 0,
)
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>历史基线与批准证据</h2>
      <p>每次批准生成不可覆盖的新版本并固化忽略规则快照；规则变化后相关基线立即失效并回到复核，历史依据照旧可查。</p>
    </div>
    <a-select v-model="projectId" allow-clear placeholder="全部项目" style="width: 220px">
      <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
    </a-select>
  </section>

  <div class="queue-summary">
    <div><span>基线总数</span><strong>{{ baselines?.length ?? 0 }}</strong></div>
    <div><span>生效基线</span><strong class="status-ok">{{ activeCount }}</strong></div>
    <div><span>失效待复核</span><strong :class="{ danger: invalidatedCount > 0 }">{{ invalidatedCount }}</strong></div>
    <div><span>同页同设备</span><strong>仅 1 条生效</strong></div>
  </div>

  <div class="baseline-layout">
    <a-card class="table-panel" :bordered="false">
      <a-table
        :data="baselines"
        :loading="isLoading"
        :pagination="false"
        row-key="id"
        :expandable="{ width: 48 }"
      >
        <template #expand-row="{ record }">
          <div class="baseline-detail">
            <div v-if="record.status === 'invalidated'" class="invalid-box">
              <strong>失效原因：</strong>{{ record.invalidatedReason }}
              <span v-if="record.invalidatedAt"> · {{ record.invalidatedAt.slice(0, 16).replace('T', ' ') }}</span>
            </div>
            <h4>批准时的忽略规则快照（{{ record.ignoreRuleSnapshots.length }}）</h4>
            <a-empty v-if="record.ignoreRuleSnapshots.length === 0" description="该基线批准时无生效忽略规则" />
            <ul v-else class="snapshot-list">
              <li v-for="snapshot in record.ignoreRuleSnapshots" :key="snapshot.ruleId">
                <div class="snapshot-head">
                  <strong>{{ snapshot.ruleName }}</strong>
                  <a-space size="small">
                    <a-tag size="small" color="arcoblue">快照版本 v{{ snapshot.ruleVersion }}</a-tag>
                    <a-tag size="small" :color="snapshot.enabled ? 'green' : 'red'">
                      {{ snapshot.enabled ? '快照时启用' : '快照时停用' }}
                    </a-tag>
                  </a-space>
                </div>
                <code>{{ snapshot.selector }}</code>
                <small>
                  页面 {{ snapshot.pagePattern }} · 设备 {{ snapshot.devicePattern }} · 最大色差 Δ{{ snapshot.maxDelta }}
                </small>
              </li>
            </ul>
            <h4 v-if="record.ignoredRegions.length">批准时忽略的差异区域（{{ record.ignoredRegions.length }}）</h4>
            <ul v-if="record.ignoredRegions.length" class="snapshot-list">
              <li v-for="item in record.ignoredRegions" :key="item.regionId">
                {{ item.source === 'rule' ? `规则「${item.ruleName ?? item.ruleId}」忽略` : `手工忽略（${item.operator ?? '—'}）` }}
                · 区域 {{ item.regionId }}
              </li>
            </ul>
          </div>
        </template>
        <template #columns>
          <a-table-column title="项目 / 页面" :width="220">
            <template #cell="{ record }">
              <div class="primary-cell">
                <strong>{{ record.page }}</strong>
                <span>{{ projectName(record.projectId) }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="基线版本" :width="180">
            <template #cell="{ record }"><code>{{ record.version }}</code></template>
          </a-table-column>
          <a-table-column title="设备 / 主题" :width="170">
            <template #cell="{ record }">{{ record.device }} · {{ record.theme === 'light' ? '浅色' : '深色' }}</template>
          </a-table-column>
          <a-table-column title="规则快照" :width="100">
            <template #cell="{ record }">{{ record.ignoreRuleSnapshots.length }} 条</template>
          </a-table-column>
          <a-table-column title="批准人" data-index="approvedBy" :width="100" />
          <a-table-column title="批准时间" :width="150">
            <template #cell="{ record }">{{ record.approvedAt.slice(0, 16).replace('T', ' ') }}</template>
          </a-table-column>
          <a-table-column title="状态" :width="120">
            <template #cell="{ record }">
              <a-tag :color="statusOf(record.status).color" bordered>{{ statusOf(record.status).label }}</a-tag>
            </template>
          </a-table-column>
          <a-table-column title="操作" :width="100">
            <template #cell="{ record }"><router-link :to="`/runs/${record.runId}`">追溯运行</router-link></template>
          </a-table-column>
        </template>
      </a-table>
      <p class="muted" style="margin: 12px 4px 0">
        同一项目、页面、设备和主题下始终只有一条「生效中」基线；新版本批准后旧版本转为「已被取代」。
      </p>
    </a-card>

    <aside class="history-panel">
      <div class="panel-title">
        <div><h3>基线变更时间线</h3><span>含失效与取代记录，均可展开查看依据</span></div>
      </div>
      <a-timeline>
        <a-timeline-item
          v-for="baseline in baselines?.slice(0, 6)"
          :key="baseline.id"
          :dot-color="baseline.status === 'active' ? 'green' : baseline.status === 'invalidated' ? 'red' : 'gray'"
        >
          <strong>{{ baseline.page }} · {{ baseline.version }}</strong>
          <p>{{ baseline.reason }}</p>
          <small v-if="baseline.status === 'invalidated'" class="danger-text">{{ baseline.invalidatedReason }}</small>
          <small>{{ baseline.approvedBy }} · {{ baseline.approvedAt.slice(0, 16).replace('T', ' ') }}</small>
        </a-timeline-item>
      </a-timeline>
    </aside>
  </div>
</template>
