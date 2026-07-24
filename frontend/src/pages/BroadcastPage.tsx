import React, { useEffect, useState } from 'react';
import { Socket } from 'socket.io-client';
import { Radio, Play, Pause, Trash2 } from 'lucide-react';

interface Device {
  id: string;
  label: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'banned';
  ownerEmail?: string;
}

interface Broadcast {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'failed';
  deviceLabel: string;
  content?: string;
  rotateDevices: boolean;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  sleepEnabled: boolean;
  sleepStart: number;
  sleepEnd: number;
  scheduledAt: string | null;
  createdAt: string;
  totalTargets: number;
  sentTargets: number;
  failedTargets: number;
}

interface TemplateOption {
  id: string;
  name: string;
  content: string;
  mediaUrl: string | null;
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  devices: Device[];
  socket: Socket | null;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  hasPermission: (key: string) => boolean;
  role: string;
  broadcastQuotaMonthly: number;
  broadcastSentThisMonth: number;
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-600',
  scheduled: 'bg-blue-100 text-blue-800',
  running: 'bg-primary-container text-on-primary-container',
  paused: 'bg-amber-100 text-amber-800',
  completed: 'bg-green-50 text-green-700',
  failed: 'bg-red-100 text-error',
};

export default function BroadcastPage({ backendUrl, getHeaders, devices, socket, addToast, hasPermission, role, broadcastQuotaMonthly, broadcastSentThisMonth }: Props) {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [recipients, setRecipients] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [rotateDevices, setRotateDevices] = useState(false);
  const [delayMinSeconds, setDelayMinSeconds] = useState(5);
  const [delayMaxSeconds, setDelayMaxSeconds] = useState(15);
  const [sleepEnabled, setSleepEnabled] = useState(false);
  const [sleepStart, setSleepStart] = useState(22);
  const [sleepEnd, setSleepEnd] = useState(7);
  const [scheduledAt, setScheduledAt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const connectedDevices = devices.filter((d) => d.status === 'connected');

  const fetchBroadcasts = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/broadcasts`, { headers: getHeaders() });
      if (res.ok) setBroadcasts(await res.json());
    } catch (err) {
      console.error('Failed to load broadcasts:', err);
    }
  };

  const fetchTemplates = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/templates`, { headers: getHeaders() });
      if (res.ok) setTemplates(await res.json());
    } catch (err) {
      console.error('Failed to load templates:', err);
    }
  };

  useEffect(() => {
    fetchBroadcasts();
    fetchTemplates();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onStatus = () => fetchBroadcasts();
    socket.on('broadcast-status', onStatus);
    return () => {
      socket.off('broadcast-status', onStatus);
    };
  }, [socket]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const phoneNumbers = recipients.split(/[\n,]/).map((n) => n.trim()).filter(Boolean);
    if (!deviceId) {
      addToast('Select a device to send from', 'error');
      return;
    }
    if (phoneNumbers.length === 0) {
      addToast('Add at least one recipient number', 'error');
      return;
    }
    if (!templateId && !content) {
      addToast('Type a message or pick a saved template', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${backendUrl}/api/broadcasts`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          name: name || `Broadcast ${new Date().toLocaleString()}`,
          content: templateId ? undefined : content,
          mediaUrl: templateId ? undefined : (mediaUrl || undefined),
          templateId: templateId || undefined,
          deviceId,
          rotateDevices,
          phoneNumbers,
          delayMinSeconds,
          delayMaxSeconds,
          sleepEnabled,
          sleepStart,
          sleepEnd,
          scheduledAt: scheduledAt || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create broadcast');

      addToast(scheduledAt ? 'Broadcast scheduled!' : 'Broadcast started!', 'success');
      setName('');
      setContent('');
      setMediaUrl('');
      setTemplateId('');
      setRecipients('');
      setScheduledAt('');
      fetchBroadcasts();
    } catch (err: any) {
      addToast(err.message || 'Failed to create broadcast', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const runAction = async (id: string, action: 'start' | 'pause' | 'delete') => {
    try {
      const res = await fetch(`${backendUrl}/api/broadcasts/${id}${action === 'delete' ? '' : `/${action}`}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: getHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `Failed to ${action} broadcast`);
      }
      fetchBroadcasts();
    } catch (err: any) {
      addToast(err.message || `Failed to ${action} broadcast`, 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">WA Broadcast</h2>
        <p className="text-on-surface-variant text-sm mt-1">Send a paced, anti-ban bulk message to many recipients at once</p>
        {role !== 'admin' && (
          <p className="text-xs font-bold text-primary mt-1">
            Sisa kuota bulan ini: {Math.max(broadcastQuotaMonthly - broadcastSentThisMonth, 0)} / {broadcastQuotaMonthly} pesan
          </p>
        )}
      </div>

      {hasPermission('broadcast.manage') && (
      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-base flex items-center gap-2">
          <Radio className="w-5 h-5 text-primary" />
          New Broadcast
        </h3>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Broadcast Name</label>
            <input
              type="text"
              placeholder="e.g. Promo Akhir Tahun"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Send From Device</label>
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
              required
            >
              <option value="">Select a device</option>
              {connectedDevices.map((d) => (
                <option key={d.id} value={d.id}>{d.label}{d.ownerEmail ? ` — ${d.ownerEmail}` : ''}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 h-[46px] px-1 pb-1 mt-auto">
            <label className="flex items-center gap-2 cursor-pointer font-bold text-on-surface-variant select-none">
              <input
                type="checkbox"
                checked={rotateDevices}
                onChange={(e) => setRotateDevices(e.target.checked)}
                className="w-4.5 h-4.5 rounded border-outline-variant text-primary focus:ring-primary"
              />
              <span>Rotate across all connected devices</span>
            </label>
          </div>

          {templates.length > 0 && (
            <div className="md:col-span-3 space-y-1">
              <label className="font-bold text-on-surface-variant px-1">Use saved template (optional)</label>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
              >
                <option value="">Type a new message instead</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {!templateId && (
            <>
              <div className="md:col-span-3 space-y-1">
                <label className="font-bold text-on-surface-variant px-1">Message content</label>
                <textarea
                  rows={2}
                  placeholder="Type the message to broadcast..."
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                  required
                />
              </div>

              <div className="md:col-span-3 space-y-1">
                <label className="font-bold text-on-surface-variant px-1">Attachment URL (optional)</label>
                <input
                  type="url"
                  placeholder="e.g. https://domain.com/file.pdf"
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                />
              </div>
            </>
          )}

          <div className="md:col-span-3 space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Recipients (one number per line)</label>
            <textarea
              rows={4}
              placeholder={'628123456789\n628987654321'}
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none font-mono"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Delay Min (seconds)</label>
            <input
              type="number"
              min={1}
              value={delayMinSeconds}
              onChange={(e) => setDelayMinSeconds(Number(e.target.value))}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Delay Max (seconds)</label>
            <input
              type="number"
              min={1}
              value={delayMaxSeconds}
              onChange={(e) => setDelayMaxSeconds(Number(e.target.value))}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="font-bold text-on-surface-variant px-1">Schedule for later (optional)</label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
            />
          </div>

          <div className="md:col-span-3 flex flex-wrap items-center gap-4 bg-surface-container-lowest border border-outline-variant/30 rounded-xl p-4">
            <label className="flex items-center gap-2 cursor-pointer font-bold text-on-surface-variant select-none">
              <input
                type="checkbox"
                checked={sleepEnabled}
                onChange={(e) => setSleepEnabled(e.target.checked)}
                className="w-4.5 h-4.5 rounded border-outline-variant text-primary focus:ring-primary"
              />
              <span>Sleep window (anti-ban)</span>
            </label>
            {sleepEnabled && (
              <div className="flex items-center gap-2">
                <span className="text-on-surface-variant font-bold">From hour</span>
                <input
                  type="number" min={0} max={23}
                  value={sleepStart}
                  onChange={(e) => setSleepStart(Number(e.target.value))}
                  className="w-16 px-2 py-2 bg-surface-container-low border border-outline-variant rounded-lg outline-none"
                />
                <span className="text-on-surface-variant font-bold">to</span>
                <input
                  type="number" min={0} max={23}
                  value={sleepEnd}
                  onChange={(e) => setSleepEnd(Number(e.target.value))}
                  className="w-16 px-2 py-2 bg-surface-container-low border border-outline-variant rounded-lg outline-none"
                />
              </div>
            )}
          </div>

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 h-[46px]"
            >
              <Radio className="w-4 h-4" />
              {scheduledAt ? 'Schedule Broadcast' : 'Send Now'}
            </button>
          </div>
        </form>
      </div>
      )}

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-base">Broadcasts</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Device</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Progress</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {broadcasts.map((b) => (
                <tr key={b.id} className="hover:bg-surface-container-lowest transition-colors">
                  <td className="py-3.5 px-4 font-bold text-on-surface">{b.name}</td>
                  <td className="py-3.5 px-4">{b.rotateDevices ? 'Rotating' : b.deviceLabel}</td>
                  <td className="py-3.5 px-4">
                    <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${STATUS_STYLES[b.status] || 'bg-zinc-100 text-zinc-600'}`}>{b.status}</span>
                  </td>
                  <td className="py-3.5 px-4 font-mono">
                    {b.sentTargets}/{b.totalTargets}
                    {b.failedTargets > 0 && <span className="text-error ml-1">({b.failedTargets} failed)</span>}
                  </td>
                  <td className="py-3.5 px-4 font-mono text-on-surface-variant">{new Date(b.createdAt).toLocaleString()}</td>
                  <td className="py-3.5 px-4">
                    {hasPermission('broadcast.manage') && (
                      <div className="flex items-center gap-2">
                        {(b.status === 'paused' || b.status === 'draft') && (
                          <button onClick={() => runAction(b.id, 'start')} className="p-1.5 rounded-lg bg-primary-container text-on-primary-container" title="Start">
                            <Play className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {b.status === 'running' && (
                          <button onClick={() => runAction(b.id, 'pause')} className="p-1.5 rounded-lg bg-amber-100 text-amber-800" title="Pause">
                            <Pause className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => runAction(b.id, 'delete')} className="p-1.5 rounded-lg bg-error-container text-error" title="Delete">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {broadcasts.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-on-surface-variant">No broadcasts yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
