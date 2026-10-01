'use client';

import React, { useState, useEffect } from 'react';
import { telemetryStore } from './telemetryStore';
import { ActionEntry } from './types';
import { MousePointer, Compass, Trash2, Clock } from 'lucide-react';

export function ActionsTab() {
  const [actions, setActions] = useState<ActionEntry[]>(() => telemetryStore.getActions());

  useEffect(() => {
    return telemetryStore.subscribe(() => {
      setActions([...telemetryStore.getActions()]);
    });
  }, []);

  return (
    <div className="flex flex-col h-full text-xs font-sans">
      <div className="flex items-center justify-between p-2.5 border-b border-neutral-800 bg-neutral-900/60 sticky top-0 z-10">
        <span className="text-[11px] font-medium text-neutral-400">
          User Interaction Trail ({actions.length})
        </span>
        <button
          onClick={() => telemetryStore.clearActions()}
          title="Clear actions"
          className="p-1 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 rounded transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-neutral-900">
        {actions.length === 0 ? (
          <div className="p-8 text-center text-neutral-500 text-xs">
            No user actions recorded yet. Click anywhere in the app to see actions appear.
          </div>
        ) : (
          actions.map((act) => (
            <div
              key={act.id}
              className="p-2.5 hover:bg-neutral-900/50 transition-colors flex items-start gap-2.5"
            >
              <div className="mt-0.5 p-1 rounded bg-neutral-800/80 text-neutral-400">
                {act.type === 'click' ? (
                  <MousePointer className="w-3.5 h-3.5 text-sky-400" />
                ) : (
                  <Compass className="w-3.5 h-3.5 text-emerald-400" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-neutral-200 capitalize text-[11px]">
                    {act.type}
                  </span>
                  <span className="text-[10px] text-neutral-500 font-mono flex items-center gap-1">
                    <Clock className="w-2.5 h-2.5" />
                    {act.timestamp}
                  </span>
                </div>

                <div className="text-[11px] font-mono text-neutral-300 break-words mt-0.5">
                  {act.target}
                </div>

                {act.details && (
                  <div className="text-[10px] text-neutral-500 truncate mt-0.5">
                    {act.details}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
