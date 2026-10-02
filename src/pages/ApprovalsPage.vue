<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import { getRuns, mergeRuns } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import type { ScreenshotRun } from '@/types'

const queryClient = useQueryClient()
const selectedKeys = ref<string[]>([])

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', 'review-queue'],
  queryFn: () => getRuns(),
})

const queueRuns = computed(() =>
  (runs.value ?? []).filter((run) => run.status === 'pending' || run.status === 're-review'),
)

const reReviewCount = computed(
  () => queueRuns.value.filter((run) => run.status === 're-review').length,
)

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const unignoredCount = (run: ScreenshotRun) =>
  run.regions.filter((region) => !region.ignored).length
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>审批人不能直接覆盖基线；批准、驳回和忽略都必须留下可审计原因。忽略规则变化引发的复核会优先提示。</p>
    </div>
    <a-space>
      <a-button :disabled="selectedKeys.length < 2" @click="mergeMutation.mutate(selectedKeys)">
        <icon-merge /> 合并重复运行
      </a-button>
      <a-button type="primary" :disabled="selectedKeys.length === 0" @click="selectedKeys = []">
        清除选择
      </a-button>
    </a-space>
  </section>

  <div class="queue-summary">
    <div>
      <span>当前待处理</span>
      <strong>{{ queueRuns.length }}</strong>
    </div>
    <div>
      <span>其中待复核</span>
      <strong :class="{ danger: reReviewCount > 0 }">{{ reReviewCount }}</strong>
    </div>
    <div>
      <span>高风险运行</span>
      <strong class="danger">{{ queueRuns.filter((run) => run.mismatchRate >= 5).length }}</strong>
    </div>
    <div>
      <span>规则依据失效</span>
      <strong>{{ reReviewCount }} 条</strong>
    </div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <a-table
      v-model:selected-keys="selectedKeys"
      :data="queueRuns"
      :loading="isLoading"
      :pagination="false"
      row-key="id"
      :row-selection="{ type: 'checkbox', showCheckedAll: true }"
    >
      <template #columns>
        <a-table-column title="优先队列" :width="300">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
              <span>{{ record.name }} · {{ record.id }}</span>
              <a-tag v-if="record.status === 're-review'" color="gold" size="small" style="margin-top: 4px; width: fit-content">
                规则变化：{{ record.invalidatedBy?.ruleName }}
              </a-tag>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="风险" :width="130">
          <template #cell="{ record }">
            <a-tag :color="record.mismatchRate >= 5 ? 'red' : record.mismatchRate >= 2 ? 'orange' : 'gray'">
              {{ record.mismatchRate.toFixed(2) }}%
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="差异区域" :width="150">
          <template #cell="{ record }">{{ unignoredCount(record) }} 处待判定</template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="提交时间" :width="150">
          <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="100" fixed="right">
          <template #cell="{ record }">
            <router-link :to="`/runs/${record.id}`">{{ record.status === 're-review' ? '开始复核' : '开始评审' }}</router-link>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
