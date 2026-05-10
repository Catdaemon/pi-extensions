export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export class CodeIntelligenceLogger {
  constructor(
    private readonly prefix = 'pi-code-intelligence',
    private readonly minConsoleLevel: LogLevel = (process.env.PI_CODE_INTELLIGENCE_LOG_LEVEL as LogLevel | undefined) ?? 'silent'
  ) {}

  debug(message: string, meta?: unknown) {
    this.write('debug', message, meta)
  }

  info(message: string, meta?: unknown) {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: unknown) {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: unknown) {
    this.write('error', message, meta)
  }

  private write(level: LogLevel, message: string, meta?: unknown) {
    if (!shouldLog(level, this.minConsoleLevel)) return
    const suffix = meta === undefined ? '' : ` ${safeStringify(meta)}`
    const line = `[${this.prefix}] ${message}${suffix}`

    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
}

function shouldLog(level: LogLevel, minLevel: LogLevel): boolean {
  if (minLevel === 'silent' || level === 'silent') return false
  const order: Record<Exclude<LogLevel, 'silent'>, number> = { debug: 10, info: 20, warn: 30, error: 40 }
  return order[level] >= order[minLevel]
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
