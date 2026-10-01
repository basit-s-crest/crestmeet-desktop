export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  timestamp: string;
  timeMs: number;
  level: LogLevel;
  message: string;
  args: any[];
  stack?: string;
}

export type NetworkType = 'fetch' | 'xhr' | 'ipc';

export interface NetworkEntry {
  id: string;
  timestamp: string;
  timeMs: number;
  type: NetworkType;
  name: string;
  method: string;
  url: string;
  domain: string;
  status: number | 'pending' | 'failed';
  statusText?: string;
  durationMs?: number;
  requestBody?: any;
  responseBody?: any;
  error?: string;
}

export type ActionType = 'click' | 'navigation' | 'input';

export interface ActionEntry {
  id: string;
  timestamp: string;
  timeMs: number;
  type: ActionType;
  target: string;
  details?: string;
}

export interface SystemInfoData {
  timestamp: string;
  os: string;
  platform: string;
  userAgent: string;
  windowSize: string;
  screenSize: string;
  language: string;
  online: boolean;
  connectionType?: string;
  downlink?: string;
  rtt?: string;
  memoryUsage?: {
    usedJSHeapSize?: string;
    totalJSHeapSize?: string;
  };
  currentUrl: string;
  appVersion: string;
}
