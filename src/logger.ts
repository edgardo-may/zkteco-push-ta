export type LogCategory =
  | 'DEVICE CONNECT'
  | 'DEVICE IDENTIFIED'
  | 'DEVICE UNKNOWN'
  | 'DEVICE HEARTBEAT'
  | 'HEARTBEAT'
  | 'ATTENDANCE RECEIVED'
  | 'ATTENDANCE SAVED'
  | 'ATTENDANCE DUPLICATE'
  | 'BIOMETRIC RECEIVED'
  | 'BIOMETRIC SAVED'
  | 'BIOMETRIC PARSE'
  | 'BIOMETRIC CONSISTENCY'
  | 'BIOMETRIC ERROR'
  | 'COMMAND QUEUED'
  | 'COMMAND SENT'
  | 'COMMAND SUCCESS'
  | 'COMMAND ERROR'
  | 'DEVICE ERROR'
  | 'SERVER ERROR'
  | 'SERVER INIT'
  | 'RATE LIMIT'
  | 'DIAGNOSTICS'
  | 'DEVICE WARNING';

class Logger {
  private formatMessage(category: LogCategory, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | Meta: ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${category}] ${message}${metaStr}`;
  }

  public info(category: LogCategory, message: string, meta?: any) {
    console.log(this.formatMessage(category, message, meta));
  }

  public warn(category: LogCategory, message: string, meta?: any) {
    console.warn(this.formatMessage(category, message, meta));
  }

  public error(category: LogCategory, message: string, error?: any, meta?: any) {
    const errObj = error instanceof Error 
      ? { message: error.message, stack: error.stack } 
      : error;
      
    const combinedMeta = { ...(meta || {}), ...(errObj ? { error: errObj } : {}) };
    console.error(this.formatMessage(category, message, combinedMeta));
  }
}

export const logger = new Logger();
