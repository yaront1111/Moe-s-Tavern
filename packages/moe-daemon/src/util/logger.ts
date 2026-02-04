// =============================================================================
// Structured Logger
// =============================================================================

import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';
const isDev = process.env.NODE_ENV !== 'production';

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
