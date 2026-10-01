'use client';

import React, { useEffect, useState } from 'react';
import { telemetryStore } from './telemetryStore';
import { SystemInfoData } from './types';
import { Laptop, Globe, Cpu, Monitor, Wifi, Clock, Layers } from 'lucide-react';

interface InfoItem {
  label: string;
  value: string;
  truncate?: boolean;
  highlight?: string;
}

interface InfoSection {
  title: string;
  icon: React.ReactNode;
  items: InfoItem[];
}

export function InfoTab() {
  const [info, setInfo] = useState<SystemInfoData>(() => telemetryStore.getSystemInfo());

  useEffect(() => {
    setInfo(telemetryStore.getSystemInfo());
    const interval = setInterval(() => {
      setInfo(telemetryStore.getSystemInfo());
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const infoSections: InfoSection[] = [
    {
      title: 'Operating System & Hardware',
      icon: <Laptop className="w-4 h-4 text-sky-400" />,
      items: [
        { label: 'OS', value: info.os },
        { label: 'Platform', value: info.platform },
        { label: 'User Agent', value: info.userAgent, truncate: true },
      ],
    },
    {
      title: 'Display & Window',
      icon: <Monitor className="w-4 h-4 text-emerald-400" />,
      items: [
        { label: 'Window Size', value: info.windowSize },
        { label: 'Screen Resolution', value: info.screenSize },
        { label: 'Language', value: info.language },
      ],
    },
    {
      title: 'Network & Connectivity',
      icon: <Wifi className="w-4 h-4 text-violet-400" />,
      items: [
        { label: 'Connection Status', value: info.online ? 'Online' : 'Offline', highlight: info.online ? 'text-emerald-400' : 'text-rose-400' },
        { label: 'Network Type', value: info.connectionType || 'Unknown' },
        { label: 'Downlink Speed', value: info.downlink || 'N/A' },
        { label: 'Latency (RTT)', value: info.rtt || 'N/A' },
      ],
    },
    {
      title: 'Application & Runtime',
      icon: <Layers className="w-4 h-4 text-amber-400" />,
      items: [
        { label: 'App Version', value: info.appVersion },
        { label: 'Current Route', value: info.currentUrl, truncate: true },
        { label: 'Timestamp', value: info.timestamp },
        ...(info.memoryUsage
          ? [
              { label: 'JS Heap Used', value: info.memoryUsage.usedJSHeapSize || 'N/A' },
              { label: 'Total JS Heap', value: info.memoryUsage.totalJSHeapSize || 'N/A' },
            ]
          : []),
      ],
    },
  ];

  return (
    <div className="space-y-4 p-4 text-xs font-sans text-neutral-300">
      {infoSections.map((section, idx) => (
        <div key={idx} className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-3 shadow-sm">
          <div className="flex items-center gap-2 mb-2 font-medium text-neutral-200 border-b border-neutral-800/80 pb-1.5">
            {section.icon}
            <span>{section.title}</span>
          </div>
          <div className="grid grid-cols-1 gap-1.5 pt-1">
            {section.items.map((item, itemIdx) => (
              <div key={itemIdx} className="flex justify-between items-start gap-4">
                <span className="text-neutral-400 whitespace-nowrap">{item.label}</span>
                <span
                  className={`font-mono text-right ${item.highlight || 'text-neutral-200'} ${
                    item.truncate ? 'max-w-[200px] truncate' : ''
                  }`}
                  title={item.value}
                >
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
