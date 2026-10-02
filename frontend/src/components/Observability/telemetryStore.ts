import { LogEntry, NetworkEntry, ActionEntry, SystemInfoData } from './types';

const MAX_ENTRIES = 500;

class TelemetryStore {
  private logs: LogEntry[] = [];
  private network: NetworkEntry[] = [];
  private actions: ActionEntry[] = [];
  private listeners: Set<() => void> = new Set();
  private errorCount = 0;
  private networkErrorCount = 0;

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyScheduled = false;

  private notify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;

    // Batch updates asynchronously to prevent blocking the main thread or React render cycles
    const schedule = typeof window !== 'undefined' && window.requestAnimationFrame
      ? window.requestAnimationFrame
      : (fn: () => void) => setTimeout(fn, 16);

    schedule(() => {
      this.notifyScheduled = false;
      this.listeners.forEach((listener) => {
        try {
          listener();
        } catch {
          // Do not call console.error here to avoid mutual recursion with console interceptor
        }
      });
    });
  }

  public addLog(entry: Omit<LogEntry, 'id' | 'timestamp' | 'timeMs'>) {
    const now = new Date();
    const item: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: now.toLocaleTimeString(),
      timeMs: now.getTime(),
      ...entry,
    };

    if (item.level === 'error') {
      this.errorCount++;
    }

    this.logs.unshift(item);
    if (this.logs.length > MAX_ENTRIES) {
      this.logs.pop();
    }
    this.notify();
  }

  public addNetwork(entry: Omit<NetworkEntry, 'id' | 'timestamp' | 'timeMs'>): string {
    const now = new Date();
    const id = Math.random().toString(36).substring(2, 9);
    const item: NetworkEntry = {
      id,
      timestamp: now.toLocaleTimeString(),
      timeMs: now.getTime(),
      ...entry,
    };

    if (typeof item.status === 'number' && item.status >= 400) {
      this.networkErrorCount++;
    } else if (item.status === 'failed') {
      this.networkErrorCount++;
    }

    this.network.unshift(item);
    if (this.network.length > MAX_ENTRIES) {
      this.network.pop();
    }
    this.notify();
    return id;
  }

  public updateNetwork(id: string, updates: Partial<NetworkEntry>) {
    const idx = this.network.findIndex((n) => n.id === id);
    if (idx !== -1) {
      const prev = this.network[idx];
      this.network[idx] = { ...prev, ...updates };

      if (
        (typeof updates.status === 'number' && updates.status >= 400 && prev.status !== updates.status) ||
        (updates.status === 'failed' && prev.status !== 'failed')
      ) {
        this.networkErrorCount++;
      }

      this.notify();
    }
  }

  public addAction(entry: Omit<ActionEntry, 'id' | 'timestamp' | 'timeMs'>) {
    const now = new Date();
    const item: ActionEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: now.toLocaleTimeString(),
      timeMs: now.getTime(),
      ...entry,
    };

    this.actions.unshift(item);
    if (this.actions.length > MAX_ENTRIES) {
      this.actions.pop();
    }
    this.notify();
  }

  public getLogs(): LogEntry[] {
    return this.logs;
  }

  public getNetwork(): NetworkEntry[] {
    return this.network;
  }

  public getActions(): ActionEntry[] {
    return this.actions;
  }

  public getErrorCount(): number {
    return this.errorCount;
  }

  public getNetworkErrorCount(): number {
    return this.networkErrorCount;
  }

  public clearLogs() {
    this.logs = [];
    this.errorCount = 0;
    this.notify();
  }

  public clearNetwork() {
    this.network = [];
    this.networkErrorCount = 0;
    this.notify();
  }

  public clearActions() {
    this.actions = [];
    this.notify();
  }

  public clearAll() {
    this.logs = [];
    this.network = [];
    this.actions = [];
    this.errorCount = 0;
    this.networkErrorCount = 0;
    this.notify();
  }

  public getSystemInfo(): SystemInfoData {
    if (typeof window === 'undefined') {
      return {
        timestamp: new Date().toISOString(),
        os: 'Unknown',
        platform: 'Server',
        userAgent: '',
        windowSize: '0x0',
        screenSize: '0x0',
        language: 'en',
        online: false,
        currentUrl: '',
        appVersion: '0.4.0',
      };
    }

    const nav = window.navigator as any;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    const perf = (window.performance as any)?.memory;

    let osName = 'Unknown OS';
    const ua = nav.userAgent || '';
    if (ua.indexOf('Win') !== -1) osName = 'Windows';
    else if (ua.indexOf('Mac') !== -1) osName = 'macOS';
    else if (ua.indexOf('Linux') !== -1) osName = 'Linux';
    else if (ua.indexOf('Android') !== -1) osName = 'Android';
    else if (ua.indexOf('like Mac') !== -1) osName = 'iOS';

    return {
      timestamp: new Date().toLocaleString(),
      os: osName,
      platform: nav.platform || 'Unknown',
      userAgent: ua,
      windowSize: `${window.innerWidth} x ${window.innerHeight}`,
      screenSize: `${window.screen?.width || 0} x ${window.screen?.height || 0}`,
      language: nav.language || 'en-US',
      online: nav.onLine ?? true,
      connectionType: conn?.effectiveType || conn?.type,
      downlink: conn?.downlink ? `${conn.downlink} Mbps` : undefined,
      rtt: conn?.rtt ? `${conn.rtt} ms` : undefined,
      memoryUsage: perf
        ? {
            usedJSHeapSize: `${Math.round(perf.usedJSHeapSize / (1024 * 1024))} MB`,
            totalJSHeapSize: `${Math.round(perf.totalJSHeapSize / (1024 * 1024))} MB`,
          }
        : undefined,
      currentUrl: window.location.href,
      appVersion: '0.4.0',
    };
  }

  public exportReport(): string {
    const report = {
      generatedAt: new Date().toISOString(),
      systemInfo: this.getSystemInfo(),
      errorSummary: {
        consoleErrors: this.errorCount,
        networkErrors: this.networkErrorCount,
      },
      actions: this.actions.slice(0, 100),
      network: this.network.slice(0, 100),
      consoleLogs: this.logs.slice(0, 100),
    };

    return JSON.stringify(report, null, 2);
  }
}

export const telemetryStore = new TelemetryStore();
