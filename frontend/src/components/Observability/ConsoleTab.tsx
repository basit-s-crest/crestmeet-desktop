'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { telemetryStore } from './telemetryStore';
import { LogEntry, LogLevel } from './types';
import { Search, Trash2, Copy, Check, ChevronDown, ChevronRight, AlertCircle, AlertTriangle, Info } from 'lucide-react';

export function ConsoleTab() {
  const [logs, setLogs] = useState<LogEntry[]>(() => telemetryStore.getLogs());
  const [filterText, setFilterText] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    return telemetryStore.subscribe(() => {
      setLogs([...telemetryStore.getLogs()]);
    });
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (errorsOnly && log.level !== 'error') {
        return false;
      }
      if (!filterText) return true;
      const query = filterText.toLowerCase();
      return (
        log.message.toLowerCase().includes(query) ||
        log.level.toLowerCase().includes(query) ||
        log.timestamp.includes(query)
      );
    });
  }, [logs, filterText, errorsOnly]);

  const copyLog = (log: LogEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    const content = `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}\n${
      log.stack ? `Stack:\n${log.stack}\n` : ''
    }${log.args?.length ? `Args:\n${JSON.stringify(log.args, null, 2)}` : ''}`;
    navigator.clipboard.writeText(content);
    setCopiedId(log.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const getLevelBadge = (level: LogLevel) => {
    switch (level) {
      case 'error':
        return (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-rose-400 bg-rose-950/60 px-1.5 py-0.5 rounded border border-rose-800/50">
            <AlertCircle className="w-3 h-3 text-rose-400" />
            ERR
          </span>
        );
      case 'warn':
        return (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-400 bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-800/50">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            WARN
          </span>
        );
      case 'info':
        return (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-sky-400 bg-sky-950/60 px-1.5 py-0.5 rounded border border-sky-800/50">
            <Info className="w-3 h-3 text-sky-400" />
            INFO
          </span>
        );
      default:
        return (
          <span className="text-[10px] font-mono text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded border border-neutral-700/50">
            LOG
          </span>
        );
    }
  };

  return (
    <div className="flex flex-col h-full text-xs font-sans">
      {/* Search & Filter Bar */}
      <div className="flex items-center gap-2 p-2.5 border-b border-neutral-800 bg-neutral-900/60 sticky top-0 z-10">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            placeholder="Filter console..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="w-full bg-neutral-950 border border-neutral-800 rounded-md pl-8 pr-2.5 py-1 text-xs text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-sky-500"
          />
        </div>

        <label className="flex items-center gap-1.5 text-neutral-400 hover:text-neutral-200 cursor-pointer text-[11px] whitespace-nowrap select-none">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(e) => setErrorsOnly(e.target.checked)}
            className="rounded border-neutral-700 text-sky-500 focus:ring-0 focus:ring-offset-0 bg-neutral-950"
          />
          Errors only
        </label>

        <button
          onClick={() => telemetryStore.clearLogs()}
          title="Clear console logs"
          className="p-1 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Logs List */}
      <div className="flex-1 overflow-y-auto divide-y divide-neutral-900 font-mono text-[11px]">
        {filteredLogs.length === 0 ? (
          <div className="p-8 text-center text-neutral-500 text-xs font-sans">
            No logs recorded yet.
          </div>
        ) : (
          filteredLogs.map((log) => {
            const isExpanded = expandedId === log.id;
            const hasDetails = log.stack || (log.args && log.args.length > 0);

            return (
              <div
                key={log.id}
                onClick={() => hasDetails && setExpandedId(isExpanded ? null : log.id)}
                className={`p-2 transition-colors flex flex-col gap-1 cursor-pointer ${
                  log.level === 'error'
                    ? 'bg-rose-950/20 hover:bg-rose-950/30 text-rose-200 border-l-2 border-rose-500'
                    : log.level === 'warn'
                    ? 'bg-amber-950/10 hover:bg-amber-950/20 text-amber-200 border-l-2 border-amber-500'
                    : 'hover:bg-neutral-900/60 text-neutral-300'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {hasDetails && (
                      <span className="text-neutral-500 shrink-0">
                        {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </span>
                    )}
                    <div className="shrink-0">{getLevelBadge(log.level)}</div>
                    <span className="text-[10px] text-neutral-400 font-mono shrink-0">{log.timestamp}</span>
                  </div>

                  <button
                    onClick={(e) => copyLog(log, e)}
                    className="p-1 hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300 rounded shrink-0"
                    title="Copy log entry"
                  >
                    {copiedId === log.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>

                <div className="text-[11px] text-neutral-200 break-words whitespace-pre-wrap font-mono leading-relaxed select-text mt-0.5">
                  {log.message}
                </div>

                {isExpanded && (
                  <div className="mt-2 pl-4 space-y-2 text-[10px] text-neutral-400 border-t border-neutral-800/60 pt-2">
                    {log.stack && (
                      <div className="bg-neutral-950 p-2 rounded border border-neutral-800 overflow-x-auto text-rose-300 whitespace-pre">
                        <div className="font-semibold text-neutral-400 mb-1">Stack Trace:</div>
                        {log.stack}
                      </div>
                    )}
                    {log.args && log.args.length > 0 && (
                      <div className="bg-neutral-950 p-2 rounded border border-neutral-800 overflow-x-auto whitespace-pre">
                        <div className="font-semibold text-neutral-400 mb-1">Arguments:</div>
                        {JSON.stringify(log.args, null, 2)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
