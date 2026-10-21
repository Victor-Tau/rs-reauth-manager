<script setup lang="ts">
import { computed } from 'vue'
import type { Job } from '../types'
import { displayTime, progress } from '../format'
const props = defineProps<{ job: Job; expanded?: boolean }>()
const text = computed(() => [
  `任务 ${props.job.requestId}`,
  `类型 ${props.job.kind || 'reauth'} · 状态 ${progress(props.job)}`,
  ...(props.job.logs || []).map(log => `[${displayTime(log.at)}] ${log.message}`),
  ...(!props.job.logs?.length ? ['暂无详细日志，旧版本任务或已清理的记录不会补录'] : []),
  ...(props.job.message ? [`结果 ${props.job.message}`] : []),
].join('\n'))
</script>
<template>
  <details class="job-logs" :open="expanded"><summary>详细日志（{{ job.logs?.length || 0 }}）</summary><p class="muted">仅记录处理阶段及响应特征，不含密码、2FA、令牌、Cookie 或响应正文，每任务最多保留最近 100 条，较早任务日志会随容量清理，可选中文字复制</p><pre tabindex="0" aria-label="任务详细日志">{{ text }}</pre></details>
</template>
