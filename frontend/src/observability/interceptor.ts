import { telemetryStore } from './telemetryStore';
import { LogLevel } from './types';

let initialized = false;

export function initializeInterceptors() {
  if (typeof window === 'undefined' || initialized) {
    return;
  }
  initialized = true;

  // 1. Organic Console Interception
  const originalConsole = {
    log: window.console.log,
    info: window.console.info,
    warn: window.console.warn,
    error: window.console.error,
  };

  const wrapConsole = (level: LogLevel) => {
    return (...args: any[]) => {
      try {
        // Format message
        const message = args
          .map((arg) => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(' ');

        // Extract stack trace if error
        let stack: string | undefined;
        if (level === 'error') {
          const errArg = args.find((a) => a instanceof Error);
          if (errArg) {
            stack = errArg.stack;
          } else {
            stack = new Error().stack;
          }
        }

        telemetryStore.addLog({
          level,
          message,
          args: args.map((a) => {
            try {
              return typeof a === 'object' && a !== null ? JSON.parse(JSON.stringify(a)) : a;
            } catch {
              return String(a);
            }
          }),
          stack,
        });
      } catch (e) {
        // Fail silently so console never breaks
      }

      // Always execute real console method
      originalConsole[level].apply(window.console, args);
    };
  };

  window.console.log = wrapConsole('log');
  window.console.info = wrapConsole('info');
  window.console.warn = wrapConsole('warn');
  window.console.error = wrapConsole('error');

  // 2. Global Uncaught Errors
  window.addEventListener('error', (event) => {
    telemetryStore.addLog({
      level: 'error',
      message: `Uncaught Exception: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
      args: [event.error || event.message],
      stack: event.error?.stack,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    telemetryStore.addLog({
      level: 'error',
      message: `Unhandled Promise Rejection: ${msg}`,
      args: [reason],
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  // 3. Organic Fetch Interception
  const originalFetch = window.fetch;
  window.fetch = async function (...fetchArgs: Parameters<typeof fetch>) {
    const start = performance.now();
    const [resource, config] = fetchArgs;

    let url = typeof resource === 'string' ? resource : resource instanceof Request ? resource.url : String(resource);
    let method = config?.method || (resource instanceof Request ? resource.method : 'GET');
    method = method.toUpperCase();

    let domain = 'localhost';
    let name = url;
    try {
      const parsedUrl = new URL(url, window.location.origin);
      domain = parsedUrl.host;
      name = parsedUrl.pathname + parsedUrl.search;
    } catch {
      // fallback
    }

    let requestBody: any;
    if (config?.body) {
      try {
        if (typeof config.body === 'string') {
          requestBody = JSON.parse(config.body);
        } else {
          requestBody = '[Binary/FormData]';
        }
      } catch {
        requestBody = String(config.body);
      }
    }

    const netId = telemetryStore.addNetwork({
      type: 'fetch',
      name: name || url,
      method,
      url,
      domain,
      status: 'pending',
      requestBody,
    });

    try {
      const response = await originalFetch.apply(this, fetchArgs);
      const durationMs = Math.round(performance.now() - start);

      let responseBody: any;
      try {
        const cloned = response.clone();
        const contentType = cloned.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          responseBody = await cloned.json();
        } else if (contentType.includes('text/')) {
          responseBody = (await cloned.text()).slice(0, 1000);
        }
      } catch {
        // ignore clone error
      }

      telemetryStore.updateNetwork(netId, {
        status: response.status,
        statusText: response.statusText,
        durationMs,
        responseBody,
      });

      return response;
    } catch (err: any) {
      const durationMs = Math.round(performance.now() - start);
      telemetryStore.updateNetwork(netId, {
        status: 'failed',
        statusText: err?.message || 'Network Failed',
        durationMs,
        error: err?.message || String(err),
      });
      throw err;
    }
  };

  // 4. Organic XMLHttpRequest Interception
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: any[]
  ) {
    (this as any)._observability = {
      method: String(method).toUpperCase(),
      url: String(url),
      start: 0,
    };
    return originalXhrOpen.apply(this, [method, url, ...rest] as any);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = (this as any)._observability;
    if (meta) {
      meta.start = performance.now();
      let domain = 'localhost';
      let name = meta.url;
      try {
        const parsed = new URL(meta.url, window.location.origin);
        domain = parsed.host;
        name = parsed.pathname + parsed.search;
      } catch {}

      const netId = telemetryStore.addNetwork({
        type: 'xhr',
        name,
        method: meta.method,
        url: meta.url,
        domain,
        status: 'pending',
        requestBody: body ? String(body).slice(0, 1000) : undefined,
      });

      this.addEventListener('loadend', () => {
        const durationMs = Math.round(performance.now() - meta.start);
        telemetryStore.updateNetwork(netId, {
          status: this.status || (this.statusText ? 'failed' : 200),
          statusText: this.statusText,
          durationMs,
          responseBody: typeof this.response === 'string' ? this.response.slice(0, 1000) : undefined,
        });
      });
    }

    return originalXhrSend.apply(this, arguments as any);
  };

  // 5. Organic Tauri IPC Interception (safely handled for frozen __TAURI_INTERNALS__)
  const attachTauriIpcInterceptor = () => {
    try {
      const tauriGlobal = (window as any).__TAURI_INTERNALS__;
      if (!tauriGlobal || (window as any)._tauriIpcIntercepted) return;

      const originalIpcInvoke = tauriGlobal.invoke;
      if (typeof originalIpcInvoke !== 'function') return;

      const wrappedInvoke = async function (cmd: string, args?: any, options?: any) {
        const start = performance.now();
        const netId = telemetryStore.addNetwork({
          type: 'ipc',
          name: `invoke('${cmd}')`,
          method: 'IPC',
          url: `tauri://${cmd}`,
          domain: 'Rust Core',
          status: 'pending',
          requestBody: args,
        });

        try {
          const result = await originalIpcInvoke.call(tauriGlobal, cmd, args, options);
          const durationMs = Math.round(performance.now() - start);
          telemetryStore.updateNetwork(netId, {
            status: 200,
            statusText: 'OK',
            durationMs,
            responseBody: result,
          });
          return result;
        } catch (err: any) {
          const durationMs = Math.round(performance.now() - start);
          telemetryStore.updateNetwork(netId, {
            status: 500,
            statusText: 'IPC Error',
            durationMs,
            error: typeof err === 'string' ? err : err?.message || JSON.stringify(err),
          });
          throw err;
        }
      };

      // Attempt 1: Try modifying the invoke property if configurable
      try {
        Object.defineProperty(tauriGlobal, 'invoke', {
          value: wrappedInvoke,
          writable: true,
          configurable: true,
        });
        (window as any)._tauriIpcIntercepted = true;
        return;
      } catch {
        // tauriGlobal itself is frozen by Tauri runtime
      }

      // Attempt 2: Try proxying window.__TAURI_INTERNALS__
      try {
        const proxied = new Proxy(tauriGlobal, {
          get(target, prop, receiver) {
            if (prop === 'invoke') {
              return wrappedInvoke;
            }
            return Reflect.get(target, prop, receiver);
          },
        });

        Object.defineProperty(window, '__TAURI_INTERNALS__', {
          value: proxied,
          writable: true,
          configurable: true,
        });
        (window as any)._tauriIpcIntercepted = true;
      } catch {
        // window.__TAURI_INTERNALS__ is strictly non-configurable; fail safely
      }
    } catch {
      // Never crash the application
    }
  };

  attachTauriIpcInterceptor();
  setTimeout(attachTauriIpcInterceptor, 500);

  // 6. Organic User Actions Interception (Breadcrumbs)
  document.addEventListener(
    'click',
    (event) => {
      try {
        const target = event.target as HTMLElement | null;
        if (!target) return;

        // Skip clicks inside the observability drawer itself
        if (target.closest('[data-observability-panel="true"]')) {
          return;
        }

        // Get meaningful description of element
        const tagName = target.tagName.toLowerCase();
        const id = target.id ? `#${target.id}` : '';
        const role = target.getAttribute('role') ? `[role="${target.getAttribute('role')}"]` : '';
        const ariaLabel = target.getAttribute('aria-label') ? ` "${target.getAttribute('aria-label')}"` : '';
        
        let textContent = target.innerText?.trim() || target.textContent?.trim() || '';
        if (textContent.length > 30) {
          textContent = textContent.slice(0, 30) + '...';
        }
        if (textContent) {
          textContent = ` "${textContent}"`;
        }

        const descriptor = `<${tagName}${id}${role}>${ariaLabel || textContent}`;

        telemetryStore.addAction({
          type: 'click',
          target: descriptor,
          details: `Classes: ${target.className?.toString().slice(0, 50) || 'none'}`,
        });
      } catch {
        // ignore
      }
    },
    true
  );

  // Navigation tracking
  const recordNav = () => {
    telemetryStore.addAction({
      type: 'navigation',
      target: window.location.pathname + window.location.search,
      details: document.title ? `Title: ${document.title}` : undefined,
    });
  };

  window.addEventListener('popstate', recordNav);
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const res = originalPushState.apply(this, args);
    recordNav();
    return res;
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const res = originalReplaceState.apply(this, args);
    recordNav();
    return res;
  };

  // Record initial page load
  recordNav();
}
