// =============================================================================
// Structured Logger
// =============================================================================

import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';
// Pretty output only for a developer's terminal: the IDE-spawned daemon writes to a pipe, and the
// pino-pretty transport is a worker thread (+15 MB RSS per process) formatting every line for nobody.
const isDev = process.env.NODE_ENV !== 'production' && process.stdout.isTTY === true;

export const logger = pino({
  level,
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Create a child logger with context
 */
export function createContextLogger(context: {
  taskId?: string;
  epicId?: string;
  workerId?: string;
  requestId?: string;
}) {
  return logger.child(context);
}

export default logger;
