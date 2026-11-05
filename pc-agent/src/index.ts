import 'dotenv/config'
import { io, type Socket } from 'socket.io-client'
import { createExecutor, type JobExecutor } from './executor.js'

type GroupItem = { id: string; externalAccountId: string; credentialRef: string; username?: string; password?: string }
type Job = {
  jobId: string
  orderId: string
  orderCode: string
  productType?: string
  credentialRefs?: GroupItem[]
  accounts?: Array<{ id: string; username: string; password: string }>
  code?: string
  target: number
  quantity: number
}

const baseUrl = process.env.BACKEND_URL || 'http://127.0.0.1:3000'
const token = process.env.WORKER_SOCKET_TOKEN
if (!token || token.length < 16) throw new Error('WORKER_SOCKET_TOKEN is required')
const executor: JobExecutor = createExecutor()
const maxParallel = Math.max(1, Number(process.env.AGENT_MAX_PARALLEL || 1))

const socket: Socket = io(`${baseUrl}/worker`, {
  auth: { token },
  transports: ['websocket', 'polling'],
  reconnection: true,
})

socket.on('connect', () => {
  console.log(JSON.stringify({ event: 'connected', workerId: socket.id }))
  socket.emit('worker:status', { activeJobs: 0, totalAccounts: 0, availableAccounts: 0 })
})

socket.on('job:dispatch', async (job: Job) => {
  if (job.productType !== 'group_chest_open') return
  const items = job.credentialRefs || []
  let completed = 0
  let finished = 0
  socket.emit('job:progress', {
    orderId: job.orderId, orderCode: job.orderCode, ticketsConfirmed: 0,
    ticketsTarget: items.length, completedRequests: 0, totalRequests: items.length,
    status: 'processing', message: 'PC agent đã nhận job',
  })

  for (let offset = 0; offset < items.length; offset += maxParallel) {
    const batch = items.slice(offset, offset + maxParallel)
    await Promise.all(batch.map(async item => {
      const execution = await executor.execute({
        jobId: job.jobId,
        orderId: job.orderId,
        orderCode: job.orderCode,
        itemId: item.id,
        externalAccountId: item.externalAccountId,
        credentialRef: item.credentialRef,
      })
      const status = execution.success ? 'success' : 'failed'
      if (execution.success) completed++
      finished++
      socket.emit('job:group-result', {
        orderId: job.orderId,
        orderCode: job.orderCode,
        itemId: item.id,
        externalAccountId: item.externalAccountId,
        status,
        result: execution.result,
        error: execution.error,
      })
      socket.emit('job:progress', {
        orderId: job.orderId,
        orderCode: job.orderCode,
        ticketsConfirmed: completed,
        ticketsTarget: items.length,
        completedRequests: finished,
        totalRequests: items.length,
        status: finished === items.length ? (completed === items.length ? 'completed' : 'failed') : 'processing',
      })
      if (finished === items.length) {
        socket.emit('job:completed', {
          orderId: job.orderId,
          orderCode: job.orderCode,
          ticketsConfirmed: completed,
          ticketsTarget: items.length,
          completedRequests: finished,
          totalRequests: items.length,
        })
      }
    }))
  }
})

socket.on('connect_error', (error) => console.error(JSON.stringify({ event: 'connect_error', message: error.message })))
