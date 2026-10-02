<script setup lang="ts">
import { ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, Modal } from '@arco-design/web-vue'
import { getBaselines, getProjects, recheckBaseline } from '@/api/http'
import type { Baseline, BaselineStatus } from '@/types'

const projectId = ref('')
const queryClient = useQueryClient()
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: baselines, isLoading } = useQuery({
  queryKey: ['baselines', projectId],
  queryFn: () => getBaselines(projectId.value || undefined),
})

const statusMap: Record<BaselineStatus, { color: string; label: string }> = {
  active: { color: 'green', label: '有效' },
  recheck: { color: 'orange', label: '待复核' },
  superseded: { color: 'gray', label: '已停用' },
}

const timelineDot = (status: BaselineStatus) =>
  status === 'active' ? 'green' : status === 'recheck' ? '#ff7d00' : 'gray'

const recheckMutation = useMutation({
  mutationFn: ({ id, reviewer }: { id: string; reviewer: string }) => recheckBaseline(id, reviewer),
  onSuccess: async () => {
    Message.success('基线已复核恢复有效，规则快照已按当前规则重新固化')
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const confirmRecheck = (baseline: Baseline) => {
  Modal.confirm({
    title: '复核并恢复基线',
    content: `将以当前生效的忽略规则重新固化「${baseline.page} · ${baseline.device}」的规则快照，并把 ${baseline.version} 恢复为有效基线。`,
    hideCancel: false,
    onOk: () => recheckMutation.mutate({ id: baseline.id, reviewer: '林默' }),
  })
}

const projectName = (id: string) => projects.value?.find((project) => project.id === id)?.name ?? id
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>历史基线与批准证据</h2>
      <p>每次批准生成不可覆盖的新版本并固化忽略规则快照；规则变化后相关基线立即失效，复核通过方可恢复。</p>
    </div>
    <a-select v-model="projectId" allow-clear placeholder="全部项目" style="width: 220px">
      <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
    </a-select>
  </section>

  <div class="baseline-layout">
    <a-card class="table-panel" :bordered="false">
      <a-table :data="baselines" :loading="isLoading" :pagination="false" row-key="id">
        <template #columns>
          <a-table-column title="项目 / 页面" :width="200">
            <template #cell="{ record }">
              <div class="primary-cell">
                <strong>{{ record.page }}</strong>
                <span>{{ projectName(record.projectId) }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="基线版本" :width="160">
            <template #cell="{ record }"><code>{{ record.version }}</code></template>
          </a-table-column>
          <a-table-column title="设备 / 主题" :width="150">
            <template #cell="{ record }">{{ record.device }} · {{ record.theme === 'light' ? '浅色' : '深色' }}</template>
          </a-table-column>
          <a-table-column title="批准人" data-index="approvedBy" :width="90" />
          <a-table-column title="批准时间" :width="150">
            <template #cell="{ record }">{{ record.approvedAt.slice(0, 16).replace('T', ' ') }}</template>
          </a-table-column>
          <a-table-column title="规则快照" :width="120">
            <template #cell="{ record }">
              <a-popover v-if="record.ruleSnapshot.length" title="批准时生效的忽略规则" position="left">
                <a-link>{{ record.ruleSnapshot.length }} 条规则</a-link>
                <template #content>
                  <div class="snapshot-list">
                    <div v-for="rule in record.ruleSnapshot" :key="rule.id" class="snapshot-item">
                      <strong>{{ rule.name }}</strong>
                      <span><code>{{ rule.selector }}</code> · Δ {{ rule.maxDelta }}</span>
                    </div>
                  </div>
                </template>
              </a-popover>
              <span v-else class="muted">无快照（旧数据）</span>
            </template>
          </a-table-column>
          <a-table-column title="状态" :width="170">
            <template #cell="{ record }">
              <div class="baseline-status">
                <a-tag :color="statusMap[record.status as BaselineStatus].color" bordered>
                  {{ statusMap[record.status as BaselineStatus].label }}
                </a-tag>
                <small v-if="record.status === 'recheck' && record.invalidatedReason">
                  {{ record.invalidatedReason }}
                </small>
                <small v-else-if="record.recheckedBy">
                  已由 {{ record.recheckedBy }} 复核恢复
                </small>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="操作" :width="140" fixed="right">
            <template #cell="{ record }">
              <a-space>
                <router-link :to="`/runs/${record.runId}`">追溯运行</router-link>
                <a-button
                  v-if="record.status === 'recheck'"
                  type="text"
                  size="small"
                  status="warning"
                  :loading="recheckMutation.isPending.value"
                  @click="confirmRecheck(record)"
                >
                  复核
                </a-button>
              </a-space>
            </template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>

    <aside class="history-panel">
      <div class="panel-title">
        <div><h3>基线变更时间线</h3><span>仅展示最近批准记录</span></div>
      </div>
      <a-timeline>
        <a-timeline-item
          v-for="baseline in baselines?.slice(0, 5)"
          :key="baseline.id"
          :dot-color="timelineDot(baseline.status)"
        >
          <strong>{{ baseline.page }} · {{ baseline.version }}</strong>
          <p>{{ baseline.reason }}</p>
          <p v-if="baseline.status === 'recheck' && baseline.invalidatedReason" class="recheck-reason">
            待复核：{{ baseline.invalidatedReason }}
          </p>
          <small>
            {{ baseline.approvedBy }} · {{ baseline.approvedAt.slice(0, 16).replace('T', ' ') }}
            <template v-if="baseline.recheckedBy"> · {{ baseline.recheckedBy }} 复核于 {{ baseline.recheckedAt?.slice(5, 16).replace('T', ' ') }}</template>
          </small>
        </a-timeline-item>
      </a-timeline>
    </aside>
  </div>
</template>
