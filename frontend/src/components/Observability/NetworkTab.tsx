'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { telemetryStore } from './telemetryStore';
import { NetworkEntry, NetworkType } from './types';
import { Search, Trash2, ArrowUpRight, X, Clock, HardDrive, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';

export function NetworkTab() {
  const [requests, setRequests] = useState<NetworkEntry[]>(() => telemetryStore.getNetwork());
  const [filterText, setFilterText] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'fetch' | 'ipc'>('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selectedReq, setSelectedReq] = useState<NetworkEntry | null>(null);

  useEffect(() => {
    return telemetryStore.subscribe(() => {
      setRequests([...telemetryStore.getNetwork()]);
    });
  }, []);

  const filteredRequests = useMemo(() => {
    return requests.filter((req) => {
      if (errorsOnly) {
        const isErr = req.status === 'failed' || (typeof req.status === 'number' && req.status >= 400);
        if (!isErr) return false;
      }

      if (typeFilter !== 'all') {
        if (typeFilter === 'ipc' && req.type !== 'ipc') return false;
        if (typeFilter === 'fetch' && req.type === 'ipc') return false;
      }

      if (!filterText) return true;
      const query = filterText.toLowerCase();
      return (
        req.name.toLowerCase().includes(query) ||
        req.method.toLowerCase().includes(query) ||
        req.url.toLowerCase().includes(query) ||
        req.domain.toLowerCase().includes(query) ||
        String(req.status).includes(query)
      );
    });
  }, [requests, filterText, typeFilter, errorsOnly]);

  const getStatusBadge = (status: number | 'pending' | 'failed') => {
    if (status === 'pending') {
      return (
        <span className="text-[10px] text-amber-400 bg-amber-950/60 px-1 py-0.5 rounded font-mono border border-amber-800/40 animate-pulse">
          PENDING
        </span>
      );
    }
    if (status === 'failed' || (typeof status === 'number' && status >= 400)) {
      return (
        <span className="text-[10px] font-bold text-rose-300 bg-rose-950 px-1.5 py-0.5 rounded font-mono border border-rose-800">
          {status}
        </span>
      );
    }
    return (
      <span className="text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded font-mono border border-emerald-800/40">
        {status}
      </span>
    );
  };

  const getMethodBadge = (method: string, type: NetworkType) => {
    if (type === 'ipc') {
      return (
        <span className="text-[10px] font-bold text-cyan-400 bg-cyan-950/60 px-1 py-0.5 rounded font-mono border border-cyan-800/40">
          IPC
        </span>
      );
    }
    return (
      <span className="text-[10px] font-mono font-medium text-neutral-300 bg-neutral-800 px-1 py-0.5 rounded">
        {method}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full text-xs font-sans relative">
      {/* Search & Filters */}
      <div className="p-2.5 border-b border-neutral-800 bg-neutral-900/60 space-y-2 sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder="Filter network & IPC calls..."
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
            onClick={() => telemetryStore.clearNetwork()}
            title="Clear network traffic"
            className="p-1 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Type pills */}
        <div className="flex items-center gap-1.5 text-[11px]">
          {(['all', 'fetch', 'ipc'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-2 py-0.5 rounded transition-colors uppercase font-medium text-[10px] ${
                typeFilter === t
                  ? 'bg-neutral-200 text-neutral-900'
                  : 'bg-neutral-800/80 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800'
              }`}
            >
              {t === 'fetch' ? 'HTTP/Fetch' : t}
            </button>
          ))}
        </div>
      </div>

      {/* Network Table */}
      <div className="flex-1 overflow-y-auto">
        {filteredRequests.length === 0 ? (
          <div className="p-8 text-center text-neutral-500 text-xs font-sans">
            No network or IPC requests recorded yet.
          </div>
        ) : (
          <table className="w-full text-left text-[11px] border-collapse">
            <thead className="bg-neutral-950/80 text-neutral-400 sticky top-0 border-b border-neutral-800 select-none text-[10px] uppercase font-semibold">
              <tr>
                <th className="py-1.5 px-2">Name</th>
                <th className="py-1.5 px-2">Method</th>
                <th className="py-1.5 px-2">Status</th>
                <th className="py-1.5 px-2">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900 font-mono">
              {filteredRequests.map((req) => {
                const isError =
                  req.status === 'failed' || (typeof req.status === 'number' && req.status >= 400);

                return (
                  <tr
                    key={req.id}
                    onClick={() => setSelectedReq(req)}
                    className={`cursor-pointer transition-colors ${
                      isError
                        ? 'bg-rose-950/30 hover:bg-rose-950/40 text-rose-200'
                        : selectedReq?.id === req.id
                        ? 'bg-sky-950/40 text-neutral-200'
                        : 'hover:bg-neutral-900/60 text-neutral-300'
                    }`}
                  >
                    <td className="py-2 px-2 max-w-[150px] truncate" title={req.url}>
                      <div className="truncate font-medium text-neutral-200">{req.name}</div>
                      <div className="text-[9px] text-neutral-500 truncate">{req.domain}</div>
                    </td>
                    <td className="py-2 px-2">{getMethodBadge(req.method, req.type)}</td>
                    <td className="py-2 px-2">{getStatusBadge(req.status)}</td>
                    <td className="py-2 px-2 text-neutral-400 text-[10px] whitespace-nowrap">
                      {req.durationMs !== undefined ? `${req.durationMs}ms` : '...'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Request Inspection Modal/Drawer */}
      {selectedReq && (
        <div className="absolute inset-0 bg-neutral-950/95 backdrop-blur-sm z-20 flex flex-col p-3 text-xs overflow-hidden border-t border-neutral-800">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-2 mb-3">
            <div className="flex items-center gap-2">
              {getMethodBadge(selectedReq.method, selectedReq.type)}
              <span className="font-semibold text-neutral-200 max-w-[200px] truncate font-mono text-xs">
                {selectedReq.name}
              </span>
            </div>
            <button
              onClick={() => setSelectedReq(null)}
              className="p-1 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 font-sans">
            <div className="bg-neutral-900/80 p-2.5 rounded-lg border border-neutral-800 text-[11px] space-y-1.5">
              <div className="flex justify-between">
                <span className="text-neutral-400">URL / Target:</span>
                <span className="font-mono text-neutral-200 max-w-[220px] truncate">{selectedReq.url}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Status:</span>
                <span>{getStatusBadge(selectedReq.status)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Duration:</span>
                <span className="font-mono text-neutral-300">
                  {selectedReq.durationMs !== undefined ? `${selectedReq.durationMs} ms` : 'In progress'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Type:</span>
                <span className="uppercase text-neutral-300 font-mono">{selectedReq.type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Timestamp:</span>
                <span className="text-neutral-300 font-mono">{selectedReq.timestamp}</span>
              </div>
            </div>

            {selectedReq.error && (
              <div className="bg-rose-950/40 border border-rose-800/80 rounded-lg p-2.5 text-rose-200 text-[11px]">
                <div className="font-bold text-rose-400 mb-1 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" /> Error Message:
                </div>
                <div className="font-mono whitespace-pre-wrap">{selectedReq.error}</div>
              </div>
            )}

            {selectedReq.requestBody && (
              <div className="space-y-1">
                <div className="font-semibold text-neutral-300 text-[11px]">Request Payload / Arguments</div>
                <pre className="bg-neutral-900 p-2.5 rounded-lg border border-neutral-800 text-[10px] font-mono text-neutral-300 overflow-x-auto max-h-40">
                  {typeof selectedReq.requestBody === 'object'
                    ? JSON.stringify(selectedReq.requestBody, null, 2)
                    : selectedReq.requestBody}
                </pre>
              </div>
            )}

            {selectedReq.responseBody !== undefined && (
              <div className="space-y-1">
                <div className="font-semibold text-neutral-300 text-[11px]">Response Body</div>
                <pre className="bg-neutral-900 p-2.5 rounded-lg border border-neutral-800 text-[10px] font-mono text-neutral-300 overflow-x-auto max-h-56">
                  {typeof selectedReq.responseBody === 'object'
                    ? JSON.stringify(selectedReq.responseBody, null, 2)
                    : String(selectedReq.responseBody)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
