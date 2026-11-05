import { spawn } from 'node:child_process'

export type ExecutionRequest = {
  jobId: string
  orderId: string
  orderCode: string
  itemId: string
  externalAccountId: string
  credentialRef: string
}

export type ExecutionResult = {
  success: boolean
  result?: Record<string, unknown>
  error?: string
}

export interface JobExecutor {
  execute(request: ExecutionRequest): Promise<ExecutionResult>
}

export class DryRunExecutor implements JobExecutor {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return {
      success: true,
      result: {
        simulated: true,
        externalAccountId: request.externalAccountId,
      },
    }
  }
}

/**
 * Adapter boundary for the existing lower-level processing logic.
 *
 * The command receives one JSON request on stdin and must write one JSON
 * result to stdout. Only credentialRef is passed; raw credentials must be
 * resolved locally by the authorized adapter/vault.
 */
export class CommandExecutor implements JobExecutor {
  constructor(
    private readonly command: string,
    private readonly timeoutMs: number,
  ) {}

  execute(request: ExecutionRequest): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const child = spawn(this.command, [], {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (value: ExecutionResult) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      const timer = setTimeout(() => {
        child.kill()
        finish({ success: false, error: 'Authorized adapter timeout' })
      }, this.timeoutMs)

      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => {
        clearTimeout(timer)
        finish({ success: false, error: error.message })
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) {
          finish({ success: false, error: stderr.trim() || `Adapter exited with code ${code}` })
          return
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
          finish({
            success: parsed.success !== false,
            result: parsed,
            error: typeof parsed.error === 'string' ? parsed.error : undefined,
          })
        } catch {
          finish({ success: false, error: 'Adapter returned invalid JSON' })
        }
      })
      child.stdin.end(JSON.stringify(request))
    })
  }
}

export function createExecutor(): JobExecutor {
  const mode = process.env.AGENT_MODE || 'dry_run'
  if (mode === 'command') {
    const command = process.env.AUTHORIZED_ADAPTER_COMMAND
    if (!command) throw new Error('AUTHORIZED_ADAPTER_COMMAND is required when AGENT_MODE=command')
    return new CommandExecutor(command, Number(process.env.ADAPTER_TIMEOUT_MS || 120_000))
  }
  return new DryRunExecutor()
}
