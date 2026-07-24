import React, { useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';
import { Flame, Play, Pause, Trash2 } from 'lucide-react';

interface Device {
  id: string;
  label: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'banned';
  ownerEmail?: string;
}

interface WarmerSession {
  id: string;
  name: string;
  status: 'active' | 'paused';
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  activeHourStart: number;
  activeHourEnd: number;
  createdAt: string;
  devices: { device: { id: string; label: string; status: string } }[];
  _count: { logs: number };
}

interface WarmerLogEntry {
  id: string;
  warmerSessionId?: string;
  fromDeviceId: string;
  fromDeviceLabel?: string;
  toDeviceId: string;
  toDeviceLabel?: string;
  content: string;
  status: string;
  createdAt: string;
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  devices: Device[];
  socket: Socket | null;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  hasPermission: (key: string) => boolean;
  role: string;
  maxWarmerSessions: number;
}

export default function WarmerPage({ backendUrl, getHeaders, devices, socket, addToast, hasPermission, role, maxWarmerSessions }: Props) {
  const [sessions, setSessions] = useState<WarmerSession[]>([]);
  const [name, setName] = useState('');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(15);
  const [maxIntervalMinutes, setMaxIntervalMinutes] = useState(45);
  const [activeHourStart, setActiveHourStart] = useState(8);
  const [activeHourEnd, setActiveHourEnd] = useState(22);
  const [customPhrases, setCustomPhrases] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [recentLogs, setRecentLogs] = useState<WarmerLogEntry[]>([]);

  const connectedDevices = devices.filter((d) => d.status === 'connected');

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/warmers`, { headers: getHeaders() });
      if (!res.ok) return;
      const data: WarmerSession[] = await res.json();
      setSessions(data);

      const labelByDeviceId = new Map<string, string>();
      data.forEach((s) => s.devices.forEach((d) => labelByDeviceId.set(d.device.id, d.device.label)));

      const logLists = await Promise.all(
        data.map((s) =>
          fetch(`${backendUrl}/api/warmers/${s.id}/logs`, { headers: getHeaders() })
            .then((r) => (r.ok ? r.json() : []))
            .catch(() => [])
        )
      );
      const merged: WarmerLogEntry[] = logLists
        .flat()
        .map((log: WarmerLogEntry) => ({
          ...log,
          fromDeviceLabel: labelByDeviceId.get(log.fromDeviceId),
          toDeviceLabel: labelByDeviceId.get(log.toDeviceId),
        }))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 50);
      setRecentLogs(merged);
    } catch (err) {
      console.error('Failed to load warmer sessions:', err);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onLog = (entry: WarmerLogEntry) => {
      setRecentLogs((prev) => [entry, ...prev.slice(0, 49)]);
    };
    const onStatus = (data: { id: string; status: string }) => {
      setRecentLogs((prev) => prev.map((l) => (l.id === data.id ? { ...l, status: data.status } : l)));
    };
    socket.on('warmer-log', onLog);
    socket.on('warmer-log-status', onStatus);
    return () => {
      socket.off('warmer-log', onLog);
      socket.off('warmer-log-status', onStatus);
    };
  }, [socket]);

  const toggleDevice = (id: string) => {
    setSelectedDeviceIds((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedDeviceIds.length < 2) {
      addToast('Select at least 2 devices to warm up against each other', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const messagePool = customPhrases.split('\n').map((p) => p.trim()).filter(Boolean);
      const res = await fetch(`${backendUrl}/api/warmers`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          name: name || `Warmer ${new Date().toLocaleString()}`,
          deviceIds: selectedDeviceIds,
          minIntervalMinutes,
          maxIntervalMinutes,
          activeHourStart,
          activeHourEnd,
          messagePool: messagePool.length > 0 ? messagePool : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create warmer session');

      addToast('Warmer session created!', 'success');
      setName('');
      setSelectedDeviceIds([]);
      setCustomPhrases('');
      fetchSessions();
    } catch (err: any) {
      addToast(err.message || 'Failed to create warmer session', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const runAction = async (id: string, action: 'start' | 'pause' | 'delete') => {
    try {
      const res = await fetch(`${backendUrl}/api/warmers/${id}${action === 'delete' ? '' : `/${action}`}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: getHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed to ${action} warmer session`);
      }
      fetchSessions();
    } catch (err: any) {
      addToast(err.message || `Failed to ${action} warmer session`, 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">WA Warmer</h2>
        <p className="text-on-surface-variant text-sm mt-1">Let your own devices chat with each other to build number trust before bulk sending</p>
        {role !== 'admin' && (
          <p className="text-xs font-bold text-primary mt-1">
            Slot sesi aktif: {sessions.filter((s) => s.status === 'active').length} / {maxWarmerSessions}
            <span className="font-normal text-on-surface-variant"> (jumlah sesi yang boleh jalan bersamaan - tiap sesi tetap butuh minimal 2 device)</span>
          </p>
        )}
      </div>

      {hasPermission('warmer.manage') && (
      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-base flex items-center gap-2">
          <Flame className="w-5 h-5 text-primary" />
          New Warmer Session
        </h3>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="md:col-span-3 space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Session Name</label>
            <input
              type="text"
              placeholder="e.g. Nomor Baru Batch 1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>

          <div className="md:col-span-3 space-y-2">
            <label className="font-bold text-on-surface-variant px-1">Select at least 2 connected devices</label>
            <div className="flex flex-wrap gap-2">
              {connectedDevices.map((d) => (
                <label
                  key={d.id}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl border cursor-pointer select-none font-bold ${
                    selectedDeviceIds.includes(d.id)
                      ? 'bg-primary-container text-on-primary-container border-primary'
                      : 'bg-surface-container-lowest border-outline-variant text-on-surface-variant'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedDeviceIds.includes(d.id)}
                    onChange={() => toggleDevice(d.id)}
                    className="sr-only"
                  />
                  {d.label}{d.ownerEmail ? ` — ${d.ownerEmail}` : ''}
                </label>
              ))}
              {connectedDevices.length === 0 && (
                <p className="text-on-surface-variant">No connected devices yet - connect at least 2 devices first.</p>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Min Interval (minutes)</label>
            <input
              type="number" min={1}
              value={minIntervalMinutes}
              onChange={(e) => setMinIntervalMinutes(Number(e.target.value))}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Max Interval (minutes)</label>
            <input
              type="number" min={1}
              value={maxIntervalMinutes}
              onChange={(e) => setMaxIntervalMinutes(Number(e.target.value))}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <div className="space-y-1 flex-1">
              <label className="font-bold text-on-surface-variant px-1">Active Hours</label>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={0} max={23}
                  value={activeHourStart}
                  onChange={(e) => setActiveHourStart(Number(e.target.value))}
                  className="w-full px-2 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                />
                <span className="text-on-surface-variant font-bold">to</span>
                <input
                  type="number" min={0} max={23}
                  value={activeHourEnd}
                  onChange={(e) => setActiveHourEnd(Number(e.target.value))}
                  className="w-full px-2 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                />
              </div>
            </div>
          </div>

          <div className="md:col-span-3 space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Custom phrases (optional, one per line - defaults to a built-in casual pool)</label>
            <textarea
              rows={3}
              placeholder={'Halo, apa kabar?\nLagi sibuk apa hari ini?'}
              value={customPhrases}
              onChange={(e) => setCustomPhrases(e.target.value)}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 h-[46px]"
            >
              <Flame className="w-4 h-4" />
              Create Warmer Session
            </button>
          </div>
        </form>
      </div>
      )}

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-base">Warmer Sessions</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Devices</th>
                <th className="py-3 px-4">Interval</th>
                <th className="py-3 px-4">Active Hours</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Exchanges</th>
                <th className="py-3 px-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {sessions.map((s) => (
                <tr key={s.id} className="hover:bg-surface-container-lowest transition-colors">
                  <td className="py-3.5 px-4 font-bold text-on-surface">{s.name}</td>
                  <td className="py-3.5 px-4">{s.devices.map((d) => d.device.label).join(', ')}</td>
                  <td className="py-3.5 px-4 font-mono">{s.minIntervalMinutes}-{s.maxIntervalMinutes}m</td>
                  <td className="py-3.5 px-4 font-mono">{s.activeHourStart}:00-{s.activeHourEnd}:00</td>
                  <td className="py-3.5 px-4">
                    <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${
                      s.status === 'active' ? 'bg-primary-container text-on-primary-container' : 'bg-zinc-100 text-zinc-600'
                    }`}>{s.status}</span>
                  </td>
                  <td className="py-3.5 px-4 font-mono">{s._count.logs}</td>
                  <td className="py-3.5 px-4">
                    {hasPermission('warmer.manage') && (
                      <div className="flex items-center gap-2">
                        {s.status === 'paused' && (
                          <button onClick={() => runAction(s.id, 'start')} className="p-1.5 rounded-lg bg-primary-container text-on-primary-container" title="Start">
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {s.status === 'active' && (
                          <button onClick={() => runAction(s.id, 'pause')} className="p-1.5 rounded-lg bg-amber-100 text-amber-800" title="Pause">
                            <Pause className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => runAction(s.id, 'delete')} className="p-1.5 rounded-lg bg-error-container text-error" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-on-surface-variant">No warmer sessions yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-base">Recent Exchanges</h3>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {recentLogs.map((log) => (
            <div key={log.id} className="flex items-start gap-3 text-xs bg-surface-container-lowest rounded-xl p-3">
              <span className="font-bold text-on-surface whitespace-nowrap">{log.fromDeviceLabel || log.fromDeviceId} → {log.toDeviceLabel || log.toDeviceId}</span>
              <span className="text-on-surface-variant flex-1">{log.content}</span>
              <span className="text-on-surface-variant font-mono whitespace-nowrap">{new Date(log.createdAt).toLocaleTimeString()}</span>
            </div>
          ))}
          {recentLogs.length === 0 && (
            <p className="text-on-surface-variant text-xs text-center py-4">No exchanges yet - live activity will appear here once a session is running.</p>
          )}
        </div>
      </div>
    </div>
  );
}
