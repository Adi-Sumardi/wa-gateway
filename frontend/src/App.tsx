import React, { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  LayoutDashboard,
  Smartphone,
  History,
  Settings,
  Plus,
  Search,
  User,
  Lock,
  Eye,
  ArrowRight,
  RefreshCw,
  QrCode,
  Trash2,
  Send,
  Cloud,
  Key,
  AlertCircle,
  Info,
  Check,
  Menu,
  Copy,
  Terminal,
  BookOpen,
  Sparkles,
  Link2,
  Radio,
  Flame,
  Users,
  Contact as ContactIcon,
  ArrowRightLeft,
  Coins
} from 'lucide-react';
import BroadcastPage from './pages/BroadcastPage';
import WarmerPage from './pages/WarmerPage';
import UsersRolesPage from './pages/UsersRolesPage';
import ContactsPage from './pages/ContactsPage';
import TopUpPage from './pages/TopUpPage';

const BACKEND_URL = (import.meta as any).env?.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:5001`;

interface UserData {
  id: string;
  name: string;
  email: string;
  role: string;
  aiCreditBalance?: number;
}

interface Device {
  id: string;
  label: string;
  phoneNumber: string | null;
  status: 'connecting' | 'connected' | 'disconnected' | 'banned';
  lastConnectedAt: string | null;
  aiEnabled?: boolean;
  aiContext?: string | null;
  aiWebsiteUrl?: string | null;
  aiBrochureUrl?: string | null;
  aiPriceList?: string | null;
  ownerName?: string;
  ownerEmail?: string;
}

interface MessageLog {
  id: string;
  deviceId: string;
  deviceLabel: string;
  contactName: string;
  contactPhone: string;
  direction: 'inbound' | 'outbound';
  content: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  failedReason: string | null;
  createdAt: string;
}

interface ApiKey {
  id: string;
  label: string;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  plainKey?: string;
}

interface Webhook {
  id: string;
  url: string;
  eventTypes: string[];
  isActive: boolean;
}

interface WebhookLog {
  id: string;
  webhookId: string;
  webhook: { url: string };
  eventType: string;
  responseCode: number | null;
  payload: string;
  createdAt: string;
}

export default function App() {
  // Auth state
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [user, setUser] = useState<UserData | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Navigation & Data state
  const [activeTab, setActiveTab] = useState<'overview' | 'devices' | 'messages' | 'broadcast' | 'warmer' | 'settings' | 'users' | 'contacts' | 'topup'>('overview');
  const [permissions, setPermissions] = useState<string[]>([]);
  const hasPermission = (key: string) => permissions.includes(key);
  const [activeDocLanguage, setActiveDocLanguage] = useState<'curl' | 'nodejs' | 'python' | 'php'>('curl');
  const [aiContexts, setAiContexts] = useState<Record<string, string>>({});
  const [aiWebsiteUrls, setAiWebsiteUrls] = useState<Record<string, string>>({});
  const [aiBrochureUrls, setAiBrochureUrls] = useState<Record<string, string>>({});
  const [aiPriceLists, setAiPriceLists] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<{ id: string; code: string; originalUrl: string; shortUrl: string; clicks: number; lastClickedAt: string | null; createdAt: string }[]>([]);
  const [newOriginalUrl, setNewOriginalUrl] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [allUsers, setAllUsers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [logs, setLogs] = useState<MessageLog[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [webhookLogs, setWebhookLogs] = useState<WebhookLog[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [selectedViewKey, setSelectedViewKey] = useState<ApiKey | null>(null);

  // Toast notifications state
  const [toasts, setToasts] = useState<{ id: string; type: 'success' | 'error' | 'info' | 'warning'; message: string }[]>([]);

  const addToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  // Socket & QR State
  const [qrs, setQrs] = useState<Record<string, string>>({});
  const socketRef = useRef<Socket | null>(null);

  // Modals & Creation state
  const [showAddDeviceModal, setShowAddDeviceModal] = useState(false);
  const [newDeviceLabel, setNewDeviceLabel] = useState('');
  const [sendTarget, setSendTarget] = useState('');
  const [sendMessageBody, setSendMessageBody] = useState('');
  const [sendSelectedDevice, setSendSelectedDevice] = useState('');
  const [sendMediaUrl, setSendMediaUrl] = useState('');
  const [sendRotateDevices, setSendRotateDevices] = useState(false);
  const [sendSuccessMsg, setSendSuccessMsg] = useState('');
  const [sendErrorMsg, setSendErrorMsg] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [generatedPlainKey, setGeneratedPlainKey] = useState<string | null>(null);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const newWebhookEvents = ['message.in']; // static for MVP

  // Helpers for API calls
  const getHeaders = () => ({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  });

  const loadData = async () => {
    try {
      const headers = getHeaders();
      const [devsRes, msgsRes, keysRes, hooksRes, wLogsRes, linksRes] = await Promise.all([
        fetch(`${BACKEND_URL}/api/devices`, { headers }),
        fetch(`${BACKEND_URL}/api/messages`, { headers }),
        fetch(`${BACKEND_URL}/api/apikeys`, { headers }),
        fetch(`${BACKEND_URL}/api/webhooks`, { headers }),
        fetch(`${BACKEND_URL}/api/webhooks/logs`, { headers }),
        fetch(`${BACKEND_URL}/api/links`, { headers })
      ]);

      if (devsRes.status === 401) return handleLogout();

      setDevices(await devsRes.json());
      setLogs(await msgsRes.json());
      setApiKeys(await keysRes.json());
      setWebhooks(await hooksRes.json());
      setWebhookLogs(await wLogsRes.json());
      setLinks(await linksRes.json());
    } catch (e) {
      console.error('Failed to load dashboard data:', e);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setPermissions([]);
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  };

  const loadPermissions = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/permissions/me`, { headers: getHeaders() });
      if (res.ok) setPermissions((await res.json()).permissions);
    } catch (err) {
      console.error('Failed to load permissions:', err);
    }
  };

  // Auth check & load data
  useEffect(() => {
    if (token) {
      fetch(`${BACKEND_URL}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
        .then(res => {
          if (res.ok) return res.json();
          throw new Error('Verification failed');
        })
        .then(data => {
          setUser(data);
          loadData();
          loadPermissions();
          initSocket();
          if (data.role === 'admin') {
            fetch(`${BACKEND_URL}/api/users`, { headers: { 'Authorization': `Bearer ${token}` } })
              .then(r => r.ok ? r.json() : [])
              .then(setAllUsers)
              .catch(() => {});
          }
        })
        .catch(() => handleLogout());
    }
  }, [token]);

  const initSocket = () => {
    if (socketRef.current) socketRef.current.disconnect();
    const socket = io(BACKEND_URL, { auth: { type: 'dashboard', token } });
    socketRef.current = socket;

    socket.on('device-status', (data: { deviceId: string; status: Device['status']; phoneNumber?: string }) => {
      setDevices(prev => {
        const found = prev.find(d => d.id === data.deviceId);
        if (found && found.status !== 'connected' && data.status === 'connected') {
          addToast(`Device "${found.label}" connected successfully!`, 'success');
        } else if (found && found.status !== 'connecting' && data.status === 'connecting') {
          addToast(`Device "${found.label}" is initializing...`, 'info');
        } else if (found && found.status !== 'disconnected' && data.status === 'disconnected') {
          addToast(`Device "${found.label}" disconnected.`, 'warning');
        } else if (found && found.status !== 'banned' && data.status === 'banned') {
          addToast(`Device "${found.label}" session has expired or been banned!`, 'error');
        }
        return prev.map(d => d.id === data.deviceId ? {
          ...d,
          status: data.status,
          phoneNumber: data.phoneNumber || d.phoneNumber,
          lastConnectedAt: data.status === 'connected' ? new Date().toISOString() : d.lastConnectedAt
        } : d);
      });

      if (data.status === 'connected') {
        setQrs(prev => {
          const updated = { ...prev };
          delete updated[data.deviceId];
          return updated;
        });
      }
    });

    socket.on('device-qr', (data: { deviceId: string; qr: string }) => {
      setQrs(prev => ({ ...prev, [data.deviceId]: data.qr }));
    });

    socket.on('new-message', (msg: MessageLog) => {
      setLogs(prev => [msg, ...prev.slice(0, 99)]);
    });

    socket.on('message-status-update', (data: MessageLog) => {
      setLogs(prev => prev.map(l => l.id === data.id ? { ...l, status: data.status, failedReason: data.failedReason } : l));
    });

    socket.on('ai-credit-depleted', (data: { deviceId: string; deviceLabel: string }) => {
      addToast(`Saldo AI habis untuk device "${data.deviceLabel}". Minta admin untuk top up.`, 'error');
    });

    socket.on('credit-updated', (data: { aiCreditBalance: number }) => {
      setUser(prev => prev ? { ...prev, aiCreditBalance: data.aiCreditBalance } : prev);
      addToast('Pembayaran berhasil! Saldo koin AI Anda sudah diperbarui.', 'success');
    });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      localStorage.setItem('token', data.token);
      setToken(data.token);
    } catch (err: any) {
      setLoginError(err.message);
    }
  };

  // Device Actions
  const createDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeviceLabel) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/devices`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ label: newDeviceLabel })
      });
      const data = await res.json();
      setDevices(prev => [data, ...prev]);
      setNewDeviceLabel('');
      setShowAddDeviceModal(false);
      addToast('Device connection initialized!', 'success');
    } catch (err) {
      addToast('Failed to connect device', 'error');
    }
  };

  const reconnectDevice = async (id: string) => {
    try {
      await fetch(`${BACKEND_URL}/api/devices/${id}/reconnect`, {
        method: 'POST',
        headers: getHeaders()
      });
      setDevices(prev => prev.map(d => d.id === id ? { ...d, status: 'connecting' } : d));
      addToast('Reconnecting device...', 'info');
    } catch (err) {
      addToast('Failed to reconnect device', 'error');
    }
  };

  const deleteDevice = (id: string) => {
    setConfirmDialog({
      title: 'Disconnect Device',
      message: 'Are you sure you want to disconnect and delete this device session? You will need to scan the QR code again to link WhatsApp.',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await fetch(`${BACKEND_URL}/api/devices/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          setDevices(prev => prev.filter(d => d.id !== id));
          setQrs(prev => {
            const u = { ...prev };
            delete u[id];
            return u;
          });
          addToast('Device disconnected and deleted.', 'success');
        } catch (err) {
          addToast('Failed to delete device', 'error');
        }
      }
    });
  };

  const transferDevice = async (id: string, targetUserId: string) => {
    if (!targetUserId) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/devices/${id}/transfer`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ userId: targetUserId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to transfer device');
      addToast('Device transferred successfully', 'success');
      setDevices(prev => prev.filter(d => d.id !== id));
    } catch (err: any) {
      addToast(err.message || 'Failed to transfer device', 'error');
    }
  };

  // Device AI configurations
  const updateDeviceAiConfig = async (id: string, fields: Partial<Pick<Device, 'aiEnabled' | 'aiContext' | 'aiWebsiteUrl' | 'aiBrochureUrl' | 'aiPriceList'>>) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/devices/${id}/ai`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify(fields),
      });

      if (res.ok) {
        const updated = await res.json();
        setDevices(prev => prev.map(d => d.id === id ? {
          ...d,
          aiEnabled: updated.aiEnabled,
          aiContext: updated.aiContext,
          aiWebsiteUrl: updated.aiWebsiteUrl,
          aiBrochureUrl: updated.aiBrochureUrl,
          aiPriceList: updated.aiPriceList,
        } : d));
        addToast('Device AI settings updated successfully!', 'success');
      } else {
        const error = await res.json();
        addToast(error.error || 'Failed to update AI settings', 'error');
      }
    } catch (err) {
      console.error(err);
      addToast('Network error updating AI settings', 'error');
    }
  };

  // Link Tracker Actions
  const createShortLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOriginalUrl) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/links/shorten`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ originalUrl: newOriginalUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        setLinks(prev => [data.data, ...prev]);
        setNewOriginalUrl('');
        addToast('URL shortened and click tracker created!', 'success');
      } else {
        const error = await res.json();
        addToast(error.error || 'Failed to shorten URL', 'error');
      }
    } catch (err) {
      addToast('Network error shortening URL', 'error');
    }
  };

  // Message Sender
  const sendTestMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendSuccessMsg('');
    setSendErrorMsg('');
    try {
      const payload: any = { to: sendTarget, body: sendMessageBody };
      if (sendSelectedDevice && !sendRotateDevices) payload.deviceId = sendSelectedDevice;
      if (sendMediaUrl) payload.mediaUrl = sendMediaUrl;
      if (sendRotateDevices) payload.rotate = true;

      const res = await fetch(`${BACKEND_URL}/api/messages`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send message');
      setSendSuccessMsg('Message queued successfully!');
      addToast('Message queued successfully!', 'success');
      setSendTarget('');
      setSendMessageBody('');
      setSendMediaUrl('');
      const messageLogs = await (await fetch(`${BACKEND_URL}/api/messages`, { headers: getHeaders() })).json();
      setLogs(messageLogs);
    } catch (err: any) {
      setSendErrorMsg(err.message);
      addToast(`Send failed: ${err.message}`, 'error');
    }
  };

  // API Key Actions
  const createApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratedPlainKey(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/apikeys`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ label: newKeyLabel })
      });
      const data = await res.json();
      setGeneratedPlainKey(data.apiKey);
      setNewKeyLabel('');
      setApiKeys(await (await fetch(`${BACKEND_URL}/api/apikeys`, { headers: getHeaders() })).json());
      addToast('API Key generated successfully!', 'success');
    } catch (err) {
      addToast('Failed to generate API Key', 'error');
    }
  };

  const deleteApiKey = (id: string) => {
    setConfirmDialog({
      title: 'Revoke API Token',
      message: 'Are you sure you want to revoke this API Token? Any external system using this key will immediately lose access to the gateway.',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await fetch(`${BACKEND_URL}/api/apikeys/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          setApiKeys(prev => prev.filter(k => k.id !== id));
          addToast('API Key revoked.', 'success');
        } catch (err) {
          addToast('Failed to revoke API key', 'error');
        }
      }
    });
  };

  // Webhook Actions
  const createWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${BACKEND_URL}/api/webhooks`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ url: newWebhookUrl, eventTypes: newWebhookEvents })
      });
      const data = await res.json();
      setWebhooks(prev => [data, ...prev]);
      setNewWebhookUrl('');
      setWebhookLogs(await (await fetch(`${BACKEND_URL}/api/webhooks/logs`, { headers: getHeaders() })).json());
      addToast('Webhook subscription saved!', 'success');
    } catch (err) {
      addToast('Failed to save webhook', 'error');
    }
  };

  const deleteWebhook = (id: string) => {
    setConfirmDialog({
      title: 'Delete Webhook Subscription',
      message: 'Are you sure you want to delete this webhook subscription? CRM callbacks for events will stop immediately.',
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await fetch(`${BACKEND_URL}/api/webhooks/${id}`, {
            method: 'DELETE',
            headers: getHeaders()
          });
          setWebhooks(prev => prev.filter(w => w.id !== id));
          addToast('Webhook subscription deleted.', 'success');
        } catch (err) {
          addToast('Failed to delete webhook', 'error');
        }
      }
    });
  };

  const filteredLogs = logs.filter(l => 
    l.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    l.contactPhone.includes(searchQuery) ||
    l.contactName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    l.deviceLabel.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // LOGIN SCREEN
  if (!token || !user) {
    return (
      <div className="bg-surface-container text-on-surface font-body-md min-h-screen flex items-center justify-center p-6 relative">
        <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-primary-container/20 blur-[120px]"></div>
          <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] rounded-full bg-secondary-container/20 blur-[100px]"></div>
        </div>

        <main className="w-full max-w-[960px] bg-surface-container-lowest rounded-[32px] shadow-2xl overflow-hidden flex flex-col md:flex-row min-h-[600px] border border-outline-variant/30">
          <div className="flex-1 p-8 md:p-12 flex flex-col justify-center">
            <div className="mb-8 flex items-center gap-3">
              <img src="/icon-192.png" alt="SendaGo Logo" className="w-10 h-10 object-contain rounded-xl" />
              <div>
                <h1 className="font-headline-md text-2xl font-bold text-primary leading-none">Gateway Pro</h1>
                <p className="font-label-md text-xs text-on-surface-variant uppercase tracking-widest mt-1">SendaGo Engine</p>
              </div>
            </div>
            
            <div className="mb-8">
              <h2 className="text-3xl font-bold text-on-surface mb-2 font-headline-lg">Welcome back</h2>
              <p className="text-on-surface-variant font-body-md">Log in to manage your high-volume WhatsApp communication.</p>
            </div>

            {loginError && (
              <div className="flex items-start gap-3 bg-error-container text-error px-4 py-3.5 rounded-xl mb-6 border-2 border-error/30 animate-toast-in">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-sm">Login Gagal</p>
                  <p className="text-xs mt-0.5 opacity-90">{loginError}</p>
                </div>
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1">
                <label className="font-label-md text-xs font-semibold text-on-surface-variant px-1" htmlFor="email">Email</label>
                <div className="relative group">
                  <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-outline group-focus-within:text-primary transition-colors" />
                  <input 
                    className="w-full pl-12 pr-4 py-3.5 bg-surface-container-low border border-outline-variant rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" 
                    id="email" 
                    type="email" 
                    placeholder="admin@sendago.com" 
                    required 
                    value={loginEmail} 
                    onChange={e => setLoginEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="font-label-md text-xs font-semibold text-on-surface-variant px-1" htmlFor="password">Password</label>
                <div className="relative group">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-outline group-focus-within:text-primary transition-colors" />
                  <input 
                    className="w-full pl-12 pr-12 py-3.5 bg-surface-container-low border border-outline-variant rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all" 
                    id="password" 
                    type={showPassword ? 'text' : 'password'} 
                    placeholder="••••••••" 
                    required 
                    value={loginPassword} 
                    onChange={e => setLoginPassword(e.target.value)}
                  />
                  <button 
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-outline hover:text-primary transition-colors"
                  >
                    <Eye className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <button 
                className="w-full py-4 bg-primary text-on-primary font-bold rounded-xl hover:bg-primary/90 active:scale-[0.98] transition-all shadow-lg shadow-primary/20 flex items-center justify-center gap-2 mt-6" 
                type="submit"
              >
                <span>Login</span>
                <ArrowRight className="w-5 h-5" />
              </button>
            </form>
          </div>

          <div className="hidden md:flex w-full max-w-[420px] bg-primary/5 p-8 flex-col items-center justify-center text-center relative overflow-hidden">
            <div className="absolute -top-20 -right-20 w-64 h-64 bg-primary-container/20 rounded-full blur-3xl"></div>
            <div className="relative z-10 flex flex-col items-center">
              <div className="w-16 h-16 bg-white rounded-2xl shadow-md flex items-center justify-center p-2 mb-6">
                <img src="/icon-192.png" alt="SendaGo Logo" className="w-full h-full object-contain" />
              </div>
              <h3 className="font-headline-md text-xl font-bold text-on-surface mb-2 font-headline-lg">WhatsApp Gateway</h3>
              <p className="text-on-surface-variant text-sm mb-6 px-8 leading-relaxed">
                Connect your devices via simple QR code scans. Deliver automated notifications and broadcasts instantly.
              </p>
              <div className="bg-white p-6 rounded-[24px] shadow-xl border border-outline-variant/20">
                <div className="w-48 h-48 bg-surface-container-highest rounded-lg flex items-center justify-center border border-outline-variant/20 p-4">
                  <div className="w-full h-full opacity-40 bg-zinc-950 grid grid-cols-4 gap-1 p-2 rounded">
                    <div className="bg-white rounded-sm"></div><div className="bg-white rounded-sm"></div><div></div><div className="bg-white rounded-sm"></div>
                    <div></div><div className="bg-white rounded-sm"></div><div className="bg-white rounded-sm"></div><div></div>
                    <div className="bg-white rounded-sm"></div><div></div><div className="bg-white rounded-sm"></div><div className="bg-white rounded-sm"></div>
                    <div className="bg-white rounded-sm"></div><div className="bg-white rounded-sm"></div><div></div><div className="bg-white rounded-sm"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // APP DASHBOARD SHELL
  return (
    <div className="bg-background text-on-surface min-h-screen flex overflow-x-hidden">
      {/* Sidebar Backdrop on Mobile */}
      {isSidebarOpen && (
        <div 
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 bg-zinc-950/40 backdrop-blur-[1px] z-40 md:hidden animate-fade-in"
        />
      )}

      {/* SideBar */}
      <aside className={`fixed left-0 top-0 h-full w-sidebar-width bg-surface-container-low border-r border-outline-variant flex flex-col py-6 z-50 transition-transform duration-200 ease-in-out md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="px-6 mb-12">
          <div className="flex items-center gap-3">
            <img src="/icon-192.png" alt="SendaGo Logo" className="w-10 h-10 object-contain rounded-xl" />
            <div>
              <h1 className="font-headline-md text-lg font-bold text-primary">Gateway Pro</h1>
              <p className="font-label-md text-xs text-on-surface-variant font-semibold uppercase tracking-wider mt-0.5">SendaGo Hub</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          <button 
            onClick={() => { setActiveTab('overview'); setIsSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'overview' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
          >
            <LayoutDashboard className="w-5 h-5" />
            <span className="text-sm">Overview</span>
          </button>
          <button 
            onClick={() => { setActiveTab('devices'); setIsSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'devices' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
          >
            <Smartphone className="w-5 h-5" />
            <span className="text-sm">Devices</span>
          </button>
          <button 
            onClick={() => { setActiveTab('messages'); setIsSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'messages' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
          >
            <History className="w-5 h-5" />
            <span className="text-sm">Messages</span>
          </button>
          <button
            onClick={() => { setActiveTab('broadcast'); setIsSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'broadcast' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
          >
            <Radio className="w-5 h-5" />
            <span className="text-sm">Broadcast</span>
          </button>
          <button
            onClick={() => { setActiveTab('warmer'); setIsSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'warmer' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
          >
            <Flame className="w-5 h-5" />
            <span className="text-sm">WA Warmer</span>
          </button>
          {hasPermission('contacts.view') && (
            <button
              onClick={() => { setActiveTab('contacts'); setIsSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'contacts' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
            >
              <ContactIcon className="w-5 h-5" />
              <span className="text-sm">Contacts</span>
            </button>
          )}
          <button
            onClick={() => { setActiveTab('topup'); setIsSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'topup' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
          >
            <Coins className="w-5 h-5" />
            <span className="text-sm">Top Up Koin</span>
          </button>
          {hasPermission('settings.view') && (
            <button
              onClick={() => { setActiveTab('settings'); setIsSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'settings' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
            >
              <Settings className="w-5 h-5" />
              <span className="text-sm">API & Settings</span>
            </button>
          )}
          {user.role === 'admin' && (
            <button
              onClick={() => { setActiveTab('users'); setIsSidebarOpen(false); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-semibold ${activeTab === 'users' ? 'bg-primary-container text-on-primary-container sidebar-active-pill' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'}`}
            >
              <Users className="w-5 h-5" />
              <span className="text-sm">Users & Roles</span>
            </button>
          )}
        </nav>

        <div className="px-3 space-y-4">
          {hasPermission('devices.manage') && (
            <button
              onClick={() => setShowAddDeviceModal(true)}
              className="w-full bg-primary text-on-primary font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-2 hover:opacity-90 active:scale-95 transition-all shadow-md"
            >
              <Plus className="w-5 h-5" />
              <span className="text-xs uppercase tracking-wider">Connect Device</span>
            </button>
          )}

          {user.role !== 'admin' && (
            <div className="mx-4 px-3 py-2 rounded-xl bg-primary-container/40 flex items-center justify-between">
              <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">Saldo AI</span>
              <span className="text-xs font-bold text-primary">🪙 {user.aiCreditBalance ?? 0}</span>
            </div>
          )}

          <div className="h-px bg-outline-variant mx-4"></div>

          <div className="flex items-center gap-3 px-4 py-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs">
              {user.name.substring(0, 2).toUpperCase()}
            </div>
            <div className="text-xs truncate">
              <p className="font-bold text-on-surface">{user.name}</p>
              <button onClick={handleLogout} className="text-error hover:underline text-left">Logout</button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Panel */}
      <div className="flex-1 pl-0 md:pl-sidebar-width min-w-0">
        {/* Top bar */}
        <header className="h-16 border-b border-outline-variant flex justify-between items-center px-4 md:px-8 bg-surface-container-lowest sticky top-0 z-40">
          <div className="flex items-center gap-2 md:gap-4">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 -ml-2 rounded-xl text-on-surface-variant hover:bg-surface-container-high md:hidden"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-outline" />
              <input 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 bg-surface-container-low border-none rounded-full text-sm w-36 sm:w-64 focus:ring-2 focus:ring-primary outline-none" 
                placeholder="Search..." 
                type="text"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 md:gap-4 text-[10px] sm:text-xs font-semibold text-on-surface-variant">
            <span className="hidden sm:inline">SendaGo Engine: Online</span>
            <div className="w-2.5 h-2.5 bg-primary rounded-full animate-ping"></div>
          </div>
        </header>

        {/* Dynamic tabs */}
        <main className="p-4 md:p-8 w-full space-y-8">
          
          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Dashboard Overview</h2>
                <p className="text-on-surface-variant text-sm mt-1">Live status and activity feed summary</p>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-5 shadow-sm">
                  <p className="text-xs text-on-surface-variant font-bold uppercase tracking-wider mb-2">Connected Devices</p>
                  <p className="text-3xl font-bold text-primary">{devices.filter(d => d.status === 'connected').length} <span className="text-lg font-normal text-on-surface-variant">/ {devices.length}</span></p>
                </div>
                <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-5 shadow-sm">
                  <p className="text-xs text-on-surface-variant font-bold uppercase tracking-wider mb-2">Sent Messages</p>
                  <p className="text-3xl font-bold text-on-surface">{logs.filter(l => l.direction === 'outbound' && ['sent','delivered','read'].includes(l.status)).length}</p>
                </div>
                <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-5 shadow-sm">
                  <p className="text-xs text-on-surface-variant font-bold uppercase tracking-wider mb-2">Failed Deliveries</p>
                  <p className="text-3xl font-bold text-error">{logs.filter(l => l.status === 'failed').length}</p>
                </div>
                <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-5 shadow-sm">
                  <p className="text-xs text-on-surface-variant font-bold uppercase tracking-wider mb-2">Webhooks Configured</p>
                  <p className="text-3xl font-bold text-secondary">{webhooks.length}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Active devices grid */}
                <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm md:col-span-2 space-y-4">
                  <div className="flex justify-between items-center">
                    <h3 className="text-base font-bold text-on-surface">Signal Board — Active Devices</h3>
                    <button onClick={() => setActiveTab('devices')} className="text-xs font-semibold text-primary hover:underline">Manage</button>
                  </div>
                  
                  {devices.length === 0 ? (
                    <p className="text-sm text-on-surface-variant py-4 text-center">No devices configured yet. Click Connect Device to start.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {devices.map(dev => (
                        <div key={dev.id} className="border border-outline-variant/50 rounded-xl p-4 bg-surface-container-lowest flex items-center justify-between">
                          <div>
                            <p className="font-bold text-sm text-on-surface">{dev.label}</p>
                            <p className="text-xs text-on-surface-variant mt-1 font-mono">{dev.phoneNumber || 'Not connected'}</p>
                            {user.role === 'admin' && dev.ownerEmail && (
                              <p className="text-[10px] text-primary font-bold mt-0.5">Owner: {dev.ownerEmail}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase font-bold text-on-surface-variant tracking-wider">{dev.status}</span>
                            <div className={`w-2.5 h-2.5 rounded-full ${
                              dev.status === 'connected' ? 'bg-primary shadow-[0_0_8px_rgba(0,109,47,0.8)] animate-pulse' :
                              dev.status === 'connecting' ? 'bg-amber-500 shadow-[0_0_8px_rgba(240,167,66,0.8)] animate-pulse' :
                              'bg-zinc-400'
                            }`} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Quick send widget */}
                <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
                  <h3 className="text-base font-bold text-on-surface flex items-center gap-2">
                    <Send className="w-4 h-4 text-primary" />
                    Quick Dispatch
                  </h3>
                  
                  <form onSubmit={sendTestMessage} className="space-y-3 text-xs">
                    <div>
                      <select 
                        value={sendSelectedDevice} 
                        onChange={e => setSendSelectedDevice(e.target.value)}
                        className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                      >
                        <option value="">First Connected Device</option>
                        {devices.filter(d => d.status === 'connected').map(d => (
                          <option key={d.id} value={d.id}>{d.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <input 
                        type="text" 
                        placeholder="Recipient (e.g. 628123456789)" 
                        value={sendTarget}
                        onChange={e => setSendTarget(e.target.value)}
                        className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                      />
                    </div>
                    <div>
                      <textarea 
                        rows={2}
                        placeholder="Message body..." 
                        value={sendMessageBody}
                        onChange={e => setSendMessageBody(e.target.value)}
                        className="w-full px-3 py-2 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                      />
                    </div>

                    {sendSuccessMsg && <p className="text-[10px] text-primary">{sendSuccessMsg}</p>}
                    {sendErrorMsg && <p className="text-[10px] text-error">{sendErrorMsg}</p>}

                    <button className="w-full bg-primary text-on-primary py-2 rounded-xl font-bold transition-opacity hover:opacity-90">
                      Send
                    </button>
                  </form>
                </div>
              </div>

              {/* Logs overview list */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-base font-bold text-on-surface">Recent Activity Log</h3>
                  <button onClick={() => setActiveTab('messages')} className="text-xs font-semibold text-primary hover:underline">View All logs</button>
                </div>

                <div className="divide-y divide-outline-variant/20">
                  {filteredLogs.slice(0, 5).map(log => (
                    <div key={log.id} className="py-3 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-3">
                        <span className="text-on-surface-variant font-mono">{new Date(log.createdAt).toLocaleTimeString()}</span>
                        <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${
                          log.direction === 'inbound' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'
                        }`}>{log.direction}</span>
                        <div>
                          <span className="font-semibold text-on-surface">{log.contactName}</span>
                          <span className="text-on-surface-variant ml-2 font-mono">({log.contactPhone})</span>
                          <p className="text-on-surface-variant mt-1 max-w-[500px] truncate">{log.content}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-on-surface-variant font-semibold text-[10px]">{log.deviceLabel}</span>
                        <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${
                          log.status === 'read' || log.status === 'delivered' ? 'bg-primary-container text-on-primary-container' :
                          log.status === 'sent' ? 'bg-green-50 text-green-700' :
                          log.status === 'failed' ? 'bg-red-100 text-error' :
                          'bg-zinc-105 text-zinc-600'
                        }`}>{log.status}</span>
                      </div>
                    </div>
                  ))}
                  {filteredLogs.length === 0 && (
                    <p className="text-sm text-on-surface-variant py-4 text-center">No message records found.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: DEVICE CONTROLLER */}
          {activeTab === 'devices' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Device Management</h2>
                  <p className="text-on-surface-variant text-sm mt-1">Add and scan sessions to connect WhatsApp numbers</p>
                </div>
                {hasPermission('devices.manage') && (
                  <button
                    onClick={() => setShowAddDeviceModal(true)}
                    className="bg-primary text-on-primary font-bold py-2.5 px-4 rounded-xl flex items-center gap-2 hover:opacity-90"
                  >
                    <Plus className="w-5 h-5" />
                    <span>Connect Device</span>
                  </button>
                )}
              </div>

              {devices.length === 0 ? (
                <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-12 text-center shadow-sm">
                  <QrCode className="w-12 h-12 text-outline-variant mx-auto mb-4" />
                  <h3 className="font-bold text-lg mb-1">No Connected Devices</h3>
                  <p className="text-on-surface-variant text-sm mb-6 max-w-md mx-auto">
                    Initialize a device session, then scan the generated QR code with WhatsApp on your phone to link.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {devices.map(dev => {
                    const qr = qrs[dev.id];
                    return (
                      <div key={dev.id} className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm flex flex-col justify-between space-y-6">
                        <div className="flex justify-between items-start">
                          <div>
                            <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${
                              dev.status === 'connected' ? 'bg-primary-container text-on-primary-container' : 'bg-zinc-150 text-zinc-600'
                            }`}>{dev.status}</span>
                            <h3 className="font-bold text-lg text-on-surface mt-2">{dev.label}</h3>
                            <p className="text-xs text-on-surface-variant font-mono mt-1">{dev.phoneNumber || 'Not connected'}</p>
                            {user.role === 'admin' && dev.ownerEmail && (
                              <p className="text-[10px] text-primary font-bold mt-1">Owner: {dev.ownerEmail}</p>
                            )}
                          </div>
                          
                          <div className={`w-3 h-3 rounded-full ${
                            dev.status === 'connected' ? 'bg-primary shadow-[0_0_8px_rgba(0,109,47,0.8)] animate-pulse' :
                            dev.status === 'connecting' ? 'bg-amber-500 shadow-[0_0_8px_rgba(240,167,66,0.8)] animate-pulse' :
                            'bg-zinc-400'
                          }`} />
                        </div>

                        {dev.status === 'connecting' && (
                          <div className="border border-outline-variant/50 rounded-xl p-4 bg-white flex flex-col items-center justify-center space-y-3">
                            <p className="font-bold text-xs text-on-surface">Scan this QR Code in WhatsApp:</p>
                            <div className="relative border border-outline-variant/20 rounded-xl w-44 h-44 flex items-center justify-center bg-zinc-50 overflow-hidden p-2">
                              {qr ? (
                                <>
                                  <div className="absolute inset-0 qr-overlay pointer-events-none z-10"></div>
                                  <img 
                                    className="w-full h-full object-contain" 
                                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr)}`} 
                                    alt="Scan QR" 
                                  />
                                </>
                              ) : (
                                <div className="text-center text-xs text-on-surface-variant p-4">
                                  <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                                  Generating...
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* AI Chatbot Configuration */}
                        <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-xl p-4 space-y-3 mt-4">
                          <div className="flex justify-between items-center">
                            <h4 className="font-bold text-xs flex items-center gap-1.5 text-on-surface">
                              <Sparkles className="w-4 h-4 text-primary" />
                              AI Auto-Reply Bot
                            </h4>
                            <label className="relative inline-flex items-center cursor-pointer scale-90">
                              <input
                                type="checkbox"
                                checked={dev.aiEnabled || false}
                                onChange={(e) => updateDeviceAiConfig(dev.id, { aiEnabled: e.target.checked })}
                                className="sr-only peer"
                              />
                              <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                            </label>
                          </div>

                          {dev.aiEnabled && (
                            <div className="space-y-2 animate-fade-in text-xs text-left">
                              <label className="text-[10px] font-bold text-on-surface-variant">System Instructions / Context</label>
                              <textarea
                                placeholder="E.g. Anda adalah asisten PMB Universitas. Jawab pertanyaan pendaftaran ujian masuk dengan sopan..."
                                value={aiContexts[dev.id] !== undefined ? aiContexts[dev.id] : (dev.aiContext || '')}
                                onChange={(e) => {
                                  setAiContexts(prev => ({ ...prev, [dev.id]: e.target.value }));
                                }}
                                className="w-full bg-surface-container-low border border-outline-variant rounded-lg p-2 text-xs outline-none focus:border-primary resize-y min-h-[60px]"
                              />

                              <label className="text-[10px] font-bold text-on-surface-variant">Website / Link Pendaftaran (opsional)</label>
                              <input
                                type="url"
                                placeholder="https://pendaftaran.sekolah.sch.id"
                                value={aiWebsiteUrls[dev.id] !== undefined ? aiWebsiteUrls[dev.id] : (dev.aiWebsiteUrl || '')}
                                onChange={(e) => setAiWebsiteUrls(prev => ({ ...prev, [dev.id]: e.target.value }))}
                                className="w-full bg-surface-container-low border border-outline-variant rounded-lg p-2 text-xs outline-none focus:border-primary"
                              />

                              <label className="text-[10px] font-bold text-on-surface-variant">URL Brosur / Gambar (opsional - otomatis dikirim jika ditanya "brosur/katalog")</label>
                              <input
                                type="url"
                                placeholder="https://domain.com/brosur.jpg"
                                value={aiBrochureUrls[dev.id] !== undefined ? aiBrochureUrls[dev.id] : (dev.aiBrochureUrl || '')}
                                onChange={(e) => setAiBrochureUrls(prev => ({ ...prev, [dev.id]: e.target.value }))}
                                className="w-full bg-surface-container-low border border-outline-variant rounded-lg p-2 text-xs outline-none focus:border-primary"
                              />

                              <label className="text-[10px] font-bold text-on-surface-variant">Daftar Harga / Varian (opsional)</label>
                              <textarea
                                placeholder={'TK: Rp 500.000/bulan\nSD: Rp 750.000/bulan'}
                                value={aiPriceLists[dev.id] !== undefined ? aiPriceLists[dev.id] : (dev.aiPriceList || '')}
                                onChange={(e) => setAiPriceLists(prev => ({ ...prev, [dev.id]: e.target.value }))}
                                className="w-full bg-surface-container-low border border-outline-variant rounded-lg p-2 text-xs outline-none focus:border-primary resize-y min-h-[50px]"
                              />

                              <button
                                onClick={() => updateDeviceAiConfig(dev.id, {
                                  aiEnabled: dev.aiEnabled || false,
                                  aiContext: aiContexts[dev.id] !== undefined ? aiContexts[dev.id] : (dev.aiContext || ''),
                                  aiWebsiteUrl: aiWebsiteUrls[dev.id] !== undefined ? aiWebsiteUrls[dev.id] : (dev.aiWebsiteUrl || ''),
                                  aiBrochureUrl: aiBrochureUrls[dev.id] !== undefined ? aiBrochureUrls[dev.id] : (dev.aiBrochureUrl || ''),
                                  aiPriceList: aiPriceLists[dev.id] !== undefined ? aiPriceLists[dev.id] : (dev.aiPriceList || ''),
                                })}
                                className="w-full bg-primary text-on-primary font-bold py-1.5 rounded-lg text-[10px] hover:opacity-90 active:scale-95 transition-all"
                              >
                                Save AI Context
                              </button>
                            </div>
                          )}
                        </div>

                        {hasPermission('devices.manage') && (
                          <div className="flex gap-2 border-t border-outline-variant/30 pt-4 mt-auto">
                            {dev.status !== 'connected' && dev.status !== 'connecting' && (
                              <button
                                onClick={() => reconnectDevice(dev.id)}
                                className="flex-1 bg-primary text-on-primary py-2 rounded-xl text-xs font-bold hover:opacity-90 flex items-center justify-center gap-1.5"
                              >
                                <RefreshCw className="w-4 h-4" />
                                Initialize
                              </button>
                            )}
                            <button
                              onClick={() => deleteDevice(dev.id)}
                              className="px-3 bg-error-container text-error rounded-xl hover:opacity-90 text-xs font-bold flex items-center justify-center gap-1 py-2"
                            >
                              <Trash2 className="w-4 h-4" />
                              <span>Delete</span>
                            </button>
                          </div>
                        )}
                        {user.role === 'admin' && allUsers.length > 0 && (
                          <div className="flex items-center gap-2 border-t border-outline-variant/30 pt-3 mt-3">
                            <ArrowRightLeft className="w-3.5 h-3.5 text-on-surface-variant flex-shrink-0" />
                            <select
                              onChange={(e) => { if (e.target.value) { transferDevice(dev.id, e.target.value); e.target.value = ''; } }}
                              defaultValue=""
                              className="flex-1 px-2 py-1.5 bg-surface-container-lowest border border-outline-variant rounded-lg text-[10px] outline-none"
                            >
                              <option value="" disabled>Transfer to user...</option>
                              {allUsers.map(u => (
                                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: MESSAGE AUDITING */}
          {activeTab === 'messages' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Messages Hub</h2>
                <p className="text-on-surface-variant text-sm mt-1">Audit log of all sent and received gateway messages</p>
              </div>

              {/* Message Sender */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
                <h3 className="font-bold text-base flex items-center gap-2">
                  <Send className="w-5 h-5 text-primary" />
                  Test Message Dispatcher
                </h3>
                <form onSubmit={sendTestMessage} className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs items-end">
                  <div className="space-y-1">
                    <label className="font-bold text-on-surface-variant px-1">Select WhatsApp Device</label>
                    <select 
                      value={sendSelectedDevice} 
                      onChange={e => setSendSelectedDevice(e.target.value)}
                      disabled={sendRotateDevices}
                      className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none disabled:opacity-50"
                    >
                      <option value="">First Connected Device</option>
                      {devices.filter(d => d.status === 'connected').map(d => (
                        <option key={d.id} value={d.id}>{d.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="font-bold text-on-surface-variant px-1">Recipient Number (with country code)</label>
                    <input 
                      type="text" 
                      placeholder="e.g. 628123456789" 
                      value={sendTarget}
                      onChange={e => setSendTarget(e.target.value)}
                      className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                      required
                    />
                  </div>
                  <div className="flex items-center gap-2 h-[46px] px-1 pb-1">
                    <label className="flex items-center gap-2 cursor-pointer font-bold text-on-surface-variant select-none">
                      <input 
                        type="checkbox" 
                        checked={sendRotateDevices}
                        onChange={e => setSendRotateDevices(e.target.checked)}
                        className="w-4.5 h-4.5 rounded border-outline-variant text-primary focus:ring-primary"
                      />
                      <span>Rotate Devices (Round-Robin)</span>
                    </label>
                  </div>

                  <div className="md:col-span-2 space-y-1">
                    <label className="font-bold text-on-surface-variant px-1">Attachment URL (Optional - Image, PDF, Document)</label>
                    <input 
                      type="url" 
                      placeholder="e.g. https://domain.com/file.pdf" 
                      value={sendMediaUrl}
                      onChange={e => setSendMediaUrl(e.target.value)}
                      className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                    />
                  </div>
                  <div>
                    <button className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold transition-opacity hover:opacity-90 flex items-center justify-center gap-1.5 h-[46px]">
                      <Send className="w-4 h-4" />
                      Send Message
                    </button>
                  </div>
                  
                  <div className="md:col-span-3 space-y-1">
                    <label className="font-bold text-on-surface-variant px-1">Message content</label>
                    <textarea 
                      rows={2}
                      placeholder="Type your WhatsApp notification body here..." 
                      value={sendMessageBody}
                      onChange={e => setSendMessageBody(e.target.value)}
                      className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                      required
                    />
                  </div>
                  
                  {sendSuccessMsg && <p className="md:col-span-3 text-xs text-primary font-bold">{sendSuccessMsg}</p>}
                  {sendErrorMsg && <p className="md:col-span-3 text-xs text-error font-bold">{sendErrorMsg}</p>}
                </form>
              </div>

              {/* Logs Table */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
                <h3 className="font-bold text-base">Message History Logs (Latest 100)</h3>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                        <th className="py-3 px-4">Timestamp</th>
                        <th className="py-3 px-4">Device</th>
                        <th className="py-3 px-4">Type</th>
                        <th className="py-3 px-4">Contact</th>
                        <th className="py-3 px-4">Content</th>
                        <th className="py-3 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/20 font-medium">
                      {filteredLogs.map(log => (
                        <tr key={log.id} className="hover:bg-surface-container-lowest transition-colors">
                          <td className="py-3.5 px-4 font-mono text-on-surface-variant">{new Date(log.createdAt).toLocaleString()}</td>
                          <td className="py-3.5 px-4">{log.deviceLabel}</td>
                          <td className="py-3.5 px-4">
                            <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${
                              log.direction === 'inbound' ? 'bg-blue-100 text-blue-800' : 'bg-green-100 text-green-800'
                            }`}>{log.direction}</span>
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="font-bold text-on-surface">{log.contactName}</span>
                            <span className="text-on-surface-variant block font-mono text-[10px]">{log.contactPhone}</span>
                          </td>
                          <td className="py-3.5 px-4 max-w-[300px] truncate" title={log.content}>{log.content}</td>
                          <td className="py-3.5 px-4">
                            <div className="space-y-0.5">
                              <span className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${
                                ['read','delivered'].includes(log.status) ? 'bg-primary-container text-on-primary-container' :
                                log.status === 'sent' ? 'bg-green-50 text-green-700' :
                                log.status === 'failed' ? 'bg-red-100 text-error' :
                                'bg-zinc-100 text-zinc-600'
                              }`}>{log.status}</span>
                              {log.failedReason && <p className="text-[10px] text-error font-normal">{log.failedReason}</p>}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredLogs.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-on-surface-variant">No message logs found.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'broadcast' && (
            <BroadcastPage
              backendUrl={BACKEND_URL}
              getHeaders={getHeaders}
              devices={devices}
              socket={socketRef.current}
              addToast={addToast}
              hasPermission={hasPermission}
            />
          )}

          {activeTab === 'warmer' && (
            <WarmerPage
              backendUrl={BACKEND_URL}
              getHeaders={getHeaders}
              devices={devices}
              socket={socketRef.current}
              addToast={addToast}
              hasPermission={hasPermission}
            />
          )}

          {activeTab === 'contacts' && hasPermission('contacts.view') && (
            <ContactsPage
              backendUrl={BACKEND_URL}
              getHeaders={getHeaders}
              addToast={addToast}
              hasPermission={hasPermission}
              setConfirmDialog={setConfirmDialog}
            />
          )}

          {activeTab === 'topup' && (
            <TopUpPage
              backendUrl={BACKEND_URL}
              getHeaders={getHeaders}
              addToast={addToast}
              role={user.role}
              aiCreditBalance={user.aiCreditBalance ?? 0}
            />
          )}

          {activeTab === 'users' && user.role === 'admin' && (
            <UsersRolesPage
              backendUrl={BACKEND_URL}
              getHeaders={getHeaders}
              addToast={addToast}
              currentUserId={user.id}
              setConfirmDialog={setConfirmDialog}
            />
          )}

          {/* TAB 4: API & WEBHOOK SETTINGS */}
          {activeTab === 'settings' && hasPermission('settings.view') && (
            <div className="space-y-8">
              <div>
                <h2 className="text-3xl font-bold text-on-surface font-headline-lg">API & Webhooks</h2>
                <p className="text-on-surface-variant text-sm mt-1">Integrate SendaGo WA gateway with your external systems</p>
              </div>

              {/* API Keys */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-6">
                <div className="space-y-1">
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <Key className="w-5 h-5 text-primary" />
                    REST API Tokens
                  </h3>
                  <p className="text-xs text-on-surface-variant">Use these tokens in the <code>X-API-KEY</code> header to invoke message sending from your CRM.</p>
                </div>

                {generatedPlainKey && (
                  <div className="bg-primary/10 border-2 border-primary/30 p-5 rounded-2xl space-y-2">
                    <h4 className="font-bold text-xs text-primary uppercase tracking-wider">New API Token Generated:</h4>
                    <p className="text-xs text-on-surface-variant">Copy this token now! It will never be displayed to you again for security reasons.</p>
                    <div className="bg-white border border-outline-variant p-3.5 rounded-xl font-mono text-sm break-all font-bold text-primary flex items-center justify-between select-all">
                      <span>{generatedPlainKey}</span>
                    </div>
                  </div>
                )}

                {hasPermission('apikeys.manage') && (
                  <form onSubmit={createApiKey} className="flex gap-3 text-xs">
                    <input
                      type="text"
                      placeholder="Enter key label e.g. CRM System Key"
                      value={newKeyLabel}
                      onChange={e => setNewKeyLabel(e.target.value)}
                      className="flex-1 px-4 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                      required
                    />
                    <button className="bg-primary text-on-primary font-bold px-4 rounded-xl hover:opacity-90">
                      Generate Token
                    </button>
                  </form>
                )}

                <div className="divide-y divide-outline-variant/20 text-xs">
                  {apiKeys.map(key => (
                    <div key={key.id} className="py-4 flex justify-between items-center">
                      <div>
                        <p className="font-bold text-on-surface">{key.label}</p>
                        <p className="text-on-surface-variant font-mono text-[10px] mt-1">
                          Created: {new Date(key.createdAt).toLocaleDateString()} | 
                          Last Used: {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {key.plainKey && (
                          <button 
                            onClick={() => setSelectedViewKey(key)}
                            className="bg-primary-container text-primary px-3 py-1.5 rounded-xl font-bold hover:opacity-90 flex items-center gap-1"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            View
                          </button>
                        )}
                        {hasPermission('apikeys.manage') && (
                          <button
                            onClick={() => deleteApiKey(key.id)}
                            className="bg-error-container text-error px-3 py-1.5 rounded-xl font-bold hover:opacity-90"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {apiKeys.length === 0 && (
                    <p className="py-4 text-center text-on-surface-variant">No active API keys found.</p>
                  )}
                </div>
              </div>

              {/* API Integration Reference */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-6">
                <div className="space-y-1">
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <BookOpen className="w-5 h-5 text-primary" />
                    API Integration Reference
                  </h3>
                  <p className="text-xs text-on-surface-variant">Complete endpoint details and copyable code snippets to quickly integrate SendaGo with your custom CRM or automation flow.</p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Left Column: Endpoint Details */}
                  <div className="space-y-4 text-xs">
                    <div className="space-y-2">
                      <h4 className="font-bold text-on-surface uppercase tracking-wider text-[10px]">Endpoint</h4>
                      <div className="flex items-center gap-2 bg-surface-container-lowest border border-outline-variant/50 p-2.5 rounded-xl">
                        <span className="bg-primary/20 text-primary font-bold px-2 py-1 rounded text-[10px]">POST</span>
                        <code className="font-mono break-all text-on-surface font-semibold select-all">{BACKEND_URL}/api/messages</code>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h4 className="font-bold text-on-surface uppercase tracking-wider text-[10px]">Authentication Headers</h4>
                      <div className="bg-surface-container-lowest border border-outline-variant/50 p-3 rounded-xl space-y-2 font-mono text-[11px]">
                        <div>
                          <span className="font-bold text-primary">X-API-KEY</span>: <span className="text-on-surface-variant">your_generated_api_token</span>
                        </div>
                        <div className="text-[10px] text-on-surface-variant font-sans border-t border-outline-variant/20 pt-1.5 mt-1.5 leading-relaxed">
                          Alternative: You can also pass the token as a query parameter: <code className="bg-zinc-100 px-1 py-0.5 rounded font-mono">?api_key=your_token</code>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h4 className="font-bold text-on-surface uppercase tracking-wider text-[10px]">Body Parameters (JSON)</h4>
                      <div className="bg-surface-container-lowest border border-outline-variant/50 rounded-xl overflow-hidden">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-zinc-50 border-b border-outline-variant/30 font-bold text-on-surface-variant text-[10px] uppercase">
                              <th className="p-2.5">Field</th>
                              <th className="p-2.5">Type</th>
                              <th className="p-2.5">Description</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-outline-variant/20">
                            <tr>
                              <td className="p-2.5 font-mono font-bold text-primary">to</td>
                              <td className="p-2.5 text-on-surface-variant">string</td>
                              <td className="p-2.5 text-on-surface-variant">Recipient phone number (e.g. <code className="bg-zinc-100 px-1 py-0.5 rounded">0812345678</code> or <code className="bg-zinc-100 px-1 py-0.5 rounded">62812345678</code>). Autoconverted.</td>
                            </tr>
                            <tr>
                              <td className="p-2.5 font-mono font-bold text-primary">body</td>
                              <td className="p-2.5 text-on-surface-variant">string</td>
                              <td className="p-2.5 text-on-surface-variant">The content of the WhatsApp message. Markdown formatting (bold, italic, etc) is supported.</td>
                            </tr>
                            <tr>
                              <td className="p-2.5 font-mono font-bold">deviceId</td>
                              <td className="p-2.5 text-on-surface-variant">string</td>
                              <td className="p-2.5 text-on-surface-variant"><em>Optional.</em> Specific Device UUID. If omitted, sends via the first available connected device.</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Code Snippets */}
                  <div className="space-y-4 flex flex-col font-sans">
                    <div className="flex justify-between items-center">
                      <h4 className="font-bold text-on-surface uppercase tracking-wider text-[10px] flex items-center gap-1">
                        <Terminal className="w-3.5 h-3.5 text-primary" />
                        Quick Start Snippets
                      </h4>
                      <div className="flex bg-surface-container-high rounded-xl p-0.5 border border-outline-variant/30 text-[10px] font-bold">
                        {(['curl', 'nodejs', 'python', 'php'] as const).map(lang => (
                          <button
                            key={lang}
                            type="button"
                            onClick={() => setActiveDocLanguage(lang)}
                            className={`px-3 py-1.5 rounded-lg transition-all capitalize ${
                              activeDocLanguage === lang 
                                ? 'bg-primary text-on-primary shadow-sm' 
                                : 'text-on-surface-variant hover:text-on-surface'
                            }`}
                          >
                            {lang === 'nodejs' ? 'Node.js' : lang}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="bg-zinc-950 text-zinc-100 rounded-xl p-4 font-mono text-[11px] leading-relaxed relative group overflow-x-auto flex-1 flex flex-col min-h-[220px]">
                      <div className="flex-1 whitespace-pre select-all text-left">
                        {activeDocLanguage === 'curl' && `curl -X POST "${BACKEND_URL}/api/messages" \\
  -H "Content-Type: application/json" \\
  -H "X-API-KEY: your_api_key_here" \\
  -d '{
    "to": "081234567890",
    "body": "Hello from SendaGo WA Gateway!",
    "deviceId": "OPTIONAL_DEVICE_UUID"
  }'`}

                        {activeDocLanguage === 'nodejs' && `const axios = require('axios');

axios.post('${BACKEND_URL}/api/messages', {
  to: '081234567890',
  body: 'Hello from SendaGo WA Gateway!',
  deviceId: 'OPTIONAL_DEVICE_UUID'
}, {
  headers: {
    'X-API-KEY': 'your_api_key_here'
  }
})
.then(res => console.log('Success:', res.data))
.catch(err => console.error('Error:', err.response?.data || err.message));`}

                        {activeDocLanguage === 'python' && `import requests

url = "${BACKEND_URL}/api/messages"
headers = {
    "X-API-KEY": "your_api_key_here",
    "Content-Type": "application/json"
}
payload = {
    "to": "081234567890",
    "body": "Hello from SendaGo WA Gateway!",
    "deviceId": "OPTIONAL_DEVICE_UUID"
}

response = requests.post(url, json=payload, headers=headers)
print(response.status_code, response.json())`}

                        {activeDocLanguage === 'php' && `<?php
$ch = curl_init('${BACKEND_URL}/api/messages');
$payload = json_encode([
    "to" => "081234567890",
    "body" => "Hello from SendaGo WA Gateway!",
    "deviceId" => "OPTIONAL_DEVICE_UUID"
]);

curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'X-API-KEY: your_api_key_here'
]);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = curl_exec($ch);
curl_close($ch);

echo $response;`}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          let text = '';
                          if (activeDocLanguage === 'curl') {
                            text = `curl -X POST "${BACKEND_URL}/api/messages" \\\n  -H "Content-Type: application/json" \\\n  -H "X-API-KEY: your_api_key_here" \\\n  -d '{\n    "to": "081234567890",\n    "body": "Hello from SendaGo WA Gateway!",\n    "deviceId": "OPTIONAL_DEVICE_UUID"\n  }'`;
                          } else if (activeDocLanguage === 'nodejs') {
                            text = `const axios = require('axios');\n\naxios.post('${BACKEND_URL}/api/messages', {\n  to: '081234567890',\n  body: 'Hello from SendaGo WA Gateway!',\n  deviceId: 'OPTIONAL_DEVICE_UUID'\n}, {\n  headers: {\n    'X-API-KEY': 'your_api_key_here'\n  }\n})\n.then(res => console.log('Success:', res.data))\n.catch(err => console.error('Error:', err.response?.data || err.message));`;
                          } else if (activeDocLanguage === 'python') {
                            text = `import requests\n\nurl = "${BACKEND_URL}/api/messages"\nheaders = {\n    "X-API-KEY": "your_api_key_here",\n    "Content-Type": "application/json"\n}\npayload = {\n    "to": "081234567890",\n    "body": "Hello from SendaGo WA Gateway!",\n    "deviceId": "OPTIONAL_DEVICE_UUID"\n}\n\nresponse = requests.post(url, json=payload, headers=headers)\nprint(response.status_code, response.json())`;
                          } else if (activeDocLanguage === 'php') {
                            text = `<?php\n$ch = curl_init('${BACKEND_URL}/api/messages');\n$payload = json_encode([\n    "to" => "081234567890",\n    "body" => "Hello from SendaGo WA Gateway!",\n    "deviceId" => "OPTIONAL_DEVICE_UUID"\n]);\n\ncurl_setopt($ch, CURLOPT_POSTFIELDS, $payload);\ncurl_setopt($ch, CURLOPT_HTTPHEADER, [\n    'Content-Type: application/json',\n    'X-API-KEY: your_api_key_here'\n]);\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n$response = curl_exec($ch);\ncurl_close($ch);\n\necho $response;`;
                          }
                          navigator.clipboard.writeText(text);
                          addToast('Snippet copied to clipboard!', 'success');
                        }}
                        className="absolute top-3 right-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white p-2 rounded-lg transition-colors flex items-center gap-1.5"
                        title="Copy Code"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Panduan Integrasi Dinamis (PMB & E-Commerce) */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-6">
                <div className="space-y-1">
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <Smartphone className="w-5 h-5 text-primary" />
                    Panduan Integrasi Dinamis (PMB, E-Commerce, dll.)
                  </h3>
                  <p className="text-xs text-on-surface-variant">Penjelasan cara mengotomatiskan nomor pengiriman secara dinamis agar Anda tidak perlu menginput data manual satu-satu.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
                  {/* Metode 1: Integrasi Database Aplikasi */}
                  <div className="bg-surface-container-lowest border border-outline-variant/50 p-5 rounded-2xl space-y-4">
                    <div>
                      <h4 className="font-bold text-sm text-primary flex items-center gap-1.5 mb-1">
                        <span className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-xs">1</span>
                        Integrasi Otomatis (Coding)
                      </h4>
                      <p className="text-on-surface-variant leading-relaxed">
                        Saat calon pendaftar (PMB) atau pembeli (E-Commerce) melakukan aksi di website Anda, gunakan <strong>variabel</strong> dari database/request untuk mengisi parameter <code>"to"</code>.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <p className="font-bold text-[10px] uppercase text-on-surface tracking-wider">Contoh Controller (Laravel / PHP):</p>
                      <pre className="bg-zinc-950 text-zinc-100 p-3.5 rounded-xl font-mono text-[10px] leading-relaxed overflow-x-auto select-all break-all">
{`use Illuminate\\Support\\Facades\\Http;

// Ambil data pendaftar terbaru dari DB
$pendaftar = Pendaftar::find($id);

// Kirim ke API SendaGo
Http::withHeaders([
    'X-API-KEY' => 'your_api_key_here'
])->post('${BACKEND_URL}/api/messages', [
    'to' => $pendaftar->no_whatsapp, // <-- Nomor HP Pendaftar Dinamis
    'body' => "Halo " . $pendaftar->nama . ", tagihan PMB Anda berhasil terbit."
]);`}
                      </pre>
                    </div>
                  </div>

                  {/* Metode 2: Blast Manual CSV/Excel */}
                  <div className="bg-surface-container-lowest border border-outline-variant/50 p-5 rounded-2xl space-y-4 flex flex-col justify-between">
                    <div className="space-y-3">
                      <h4 className="font-bold text-sm text-primary flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-xs">2</span>
                        Pengiriman Massal Manual (Tanpa Coding)
                      </h4>
                      <p className="text-on-surface-variant leading-relaxed">
                        Jika ingin mengirim pengumuman atau promo massal tanpa menyentuh kode aplikasi:
                      </p>
                      <ul className="list-disc pl-4 space-y-2 text-on-surface-variant leading-relaxed">
                        <li>Ekspor data pendaftar dari sistem PMB / E-Commerce Anda ke format <strong>CSV atau Excel</strong>. Pastikan terdapat kolom nama dan nomor HP.</li>
                        <li>Masuk ke menu <strong className="text-primary">Kontak</strong> di sidebar kiri, buat Grup Baru (contoh: <em>"Pendaftar Jalur Mandiri"</em>), lalu klik <strong>Import</strong> untuk mengunggah file Anda.</li>
                        <li>Masuk ke menu <strong className="text-primary">Broadcast</strong>, buat template pesan dengan variabel seperti <code>{"{{nama}}"}</code> untuk personalisasi otomatis, lalu kirim ke grup kontak tersebut sekaligus.</li>
                      </ul>
                    </div>
                    <div className="pt-2 border-t border-outline-variant/20 flex gap-2">
                      <button 
                        onClick={() => {
                          const messageBtn = document.querySelector('button[title="Messages"], button[onClick*="messages"]');
                          if (messageBtn) (messageBtn as HTMLButtonElement).click();
                        }}
                        className="bg-primary-container text-primary font-bold px-3 py-2 rounded-xl text-[10px] hover:opacity-90 transition-opacity"
                      >
                        Buka Menu Broadcast
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Webhooks Section */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-6">
                <div className="space-y-1">
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <Cloud className="w-5 h-5 text-primary" />
                    Outgoing Webhook Subscriptions
                  </h3>
                  <p className="text-xs text-on-surface-variant">Register a Callback URL. We will perform a POST request to your URL whenever events occur.</p>
                </div>

                {hasPermission('webhooks.manage') && (
                  <form onSubmit={createWebhook} className="space-y-4 text-xs">
                    <div className="flex gap-3">
                      <input
                        type="url"
                        placeholder="https://yourdomain.com/webhooks/whatsapp"
                        value={newWebhookUrl}
                        onChange={e => setNewWebhookUrl(e.target.value)}
                        className="flex-1 px-4 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                        required
                      />
                      <button className="bg-primary text-on-primary font-bold px-4 rounded-xl hover:opacity-90">
                        Add Webhook
                      </button>
                    </div>
                  </form>
                )}

                <div className="divide-y divide-outline-variant/20 text-xs">
                  {webhooks.map(hook => (
                    <div key={hook.id} className="py-4 flex justify-between items-center">
                      <div className="space-y-1 pr-4 truncate">
                        <p className="font-bold text-on-surface truncate">{hook.url}</p>
                        <div className="flex gap-1">
                          {hook.eventTypes.map(t => (
                            <span key={t} className="bg-zinc-100 text-zinc-700 px-2 py-0.5 rounded font-mono text-[9px]">{t}</span>
                          ))}
                        </div>
                      </div>
                      {hasPermission('webhooks.manage') && (
                        <button
                          onClick={() => deleteWebhook(hook.id)}
                          className="bg-error-container text-error px-3 py-1.5 rounded-xl font-bold hover:opacity-90"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  ))}
                  {webhooks.length === 0 && (
                    <p className="py-4 text-center text-on-surface-variant">No webhooks registered.</p>
                  )}
                </div>
              </div>

              {/* Webhook Calls Table */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
                <h3 className="font-bold text-base">Webhook Call Logs</h3>
                <div className="overflow-x-auto text-xs">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                        <th className="py-2.5 px-4">Time</th>
                        <th className="py-2.5 px-4">Event</th>
                        <th className="py-2.5 px-4">Target URL</th>
                        <th className="py-2.5 px-4">Response</th>
                        <th className="py-2.5 px-4">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/20 font-medium">
                      {webhookLogs.map(wLog => (
                        <tr key={wLog.id}>
                          <td className="py-3 px-4 font-mono text-on-surface-variant">{new Date(wLog.createdAt).toLocaleTimeString()}</td>
                          <td className="py-3 px-4 font-mono font-bold">{wLog.eventType}</td>
                          <td className="py-3 px-4 truncate max-w-[200px]" title={wLog.webhook?.url}>{wLog.webhook?.url}</td>
                          <td className="py-3 px-4">
                            <span className={`px-2 py-0.5 rounded font-bold ${
                              wLog.responseCode && wLog.responseCode >= 200 && wLog.responseCode < 300 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-error'
                            }`}>
                              {wLog.responseCode || 'FAIL'}
                            </span>
                          </td>
                          <td className="py-3 px-4 max-w-[250px] truncate text-on-surface-variant" title={wLog.payload}>{wLog.payload}</td>
                        </tr>
                      ))}
                      {webhookLogs.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-on-surface-variant">No webhook delivery logs.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              {/* URL Shortener & Link Tracking Section */}
              <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-6">
                <div className="space-y-1">
                  <h3 className="font-bold text-base flex items-center gap-2 text-on-surface">
                    <Link2 className="w-5 h-5 text-primary" />
                    URL Shortener & Click Tracker
                  </h3>
                  <p className="text-xs text-on-surface-variant">Create click-trackable shortened links. Insert these links into your WhatsApp notifications to get read/click analytics.</p>
                </div>

                <form onSubmit={createShortLink} className="flex gap-3 text-xs">
                  <input 
                    type="url" 
                    placeholder="Enter long destination URL e.g. https://yoursite.com/pmb/invoice/123" 
                    value={newOriginalUrl}
                    onChange={e => setNewOriginalUrl(e.target.value)}
                    className="flex-1 px-4 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none"
                    required
                  />
                  <button className="bg-primary text-on-primary font-bold px-4 rounded-xl hover:opacity-90">
                    Shorten Link
                  </button>
                </form>

                <div className="overflow-x-auto text-xs">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                        <th className="py-2.5 px-4">Original URL</th>
                        <th className="py-2.5 px-4">Shortened URL</th>
                        <th className="py-2.5 px-4 text-center">Clicks</th>
                        <th className="py-2.5 px-4">Last Clicked</th>
                        <th className="py-2.5 px-4">Created At</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/20 font-medium">
                      {links.map(link => (
                        <tr key={link.id}>
                          <td className="py-3 px-4 truncate max-w-[200px]" title={link.originalUrl}>
                            <a href={link.originalUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{link.originalUrl}</a>
                          </td>
                          <td className="py-3 px-4 font-mono font-bold select-all flex items-center gap-1.5">
                            <span>{link.shortUrl}</span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(link.shortUrl);
                                addToast('Short link copied!', 'success');
                              }}
                              className="text-on-surface-variant hover:text-primary transition-colors p-1"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className="bg-primary-container text-on-primary-container px-2 py-0.5 rounded-full font-bold">
                              {link.clicks} clicks
                            </span>
                          </td>
                          <td className="py-3 px-4 text-on-surface-variant font-mono">
                            {link.lastClickedAt ? new Date(link.lastClickedAt).toLocaleString() : 'Never'}
                          </td>
                          <td className="py-3 px-4 text-on-surface-variant font-mono">
                            {new Date(link.createdAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                      {links.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-on-surface-variant">No shortened URLs tracked yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {/* Connect Device Modal */}
      {showAddDeviceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 backdrop-blur-sm p-4">
          <div className="bg-surface-container-lowest border border-outline-variant/30 max-w-sm w-full rounded-2xl shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-lg text-on-surface flex items-center gap-2">
                Add Device Connection
              </h3>
              <button 
                onClick={() => setShowAddDeviceModal(false)}
                className="text-on-surface-variant hover:text-on-surface font-bold text-sm"
              >
                ✕
              </button>
            </div>
            
            <form onSubmit={createDevice} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="font-bold text-on-surface-variant px-1">Device Label</label>
                <input 
                  type="text" 
                  placeholder="e.g. CS Support Line" 
                  value={newDeviceLabel}
                  onChange={e => setNewDeviceLabel(e.target.value)}
                  className="w-full px-3 py-3 border border-outline-variant bg-surface-container-low rounded-xl outline-none text-sm"
                  required
                />
              </div>
              
              <button 
                type="submit" 
                className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold shadow-md hover:opacity-90 transition-opacity"
              >
                Initialize Client Session
              </button>
            </form>
          </div>
        </div>
      )}

      {/* View API Key Modal */}
      {selectedViewKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-surface-container-lowest border border-outline-variant/30 max-w-md w-full rounded-2xl shadow-2xl p-6 space-y-4 animate-toast-in">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-lg text-on-surface flex items-center gap-2 font-headline-md">
                <Key className="w-5 h-5 text-primary" />
                API Token
              </h3>
              <button 
                onClick={() => setSelectedViewKey(null)}
                className="text-on-surface-variant hover:text-on-surface font-bold text-sm"
              >
                ✕
              </button>
            </div>
            
            <div className="space-y-2">
              <p className="font-bold text-xs text-on-surface">Label: {selectedViewKey.label}</p>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Use this token in your integration's headers as <code>X-API-KEY</code>. Keep this token secret.
              </p>
              
              <div className="bg-surface-container-low border border-outline-variant/30 p-4 rounded-xl font-mono text-sm break-all font-bold text-primary flex items-center justify-between gap-4">
                <span>{selectedViewKey.plainKey}</span>
                <button 
                  onClick={() => {
                    if (selectedViewKey.plainKey) {
                      navigator.clipboard.writeText(selectedViewKey.plainKey);
                      addToast('Token copied to clipboard!', 'success');
                    }
                  }}
                  className="bg-primary text-on-primary text-[10px] px-2.5 py-1.5 rounded-lg hover:opacity-95 active:scale-95 transition-all flex-shrink-0 font-sans font-bold"
                >
                  Copy
                </button>
              </div>
            </div>
            
            <div className="flex justify-end pt-2">
              <button 
                onClick={() => setSelectedViewKey(null)}
                className="px-4 py-2.5 bg-surface-container-high hover:bg-surface-container-highest text-on-surface rounded-xl text-xs font-bold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirmation Alert Dialog */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 backdrop-blur-sm p-4 animate-fade-in">
          <div className="bg-surface-container-lowest border border-outline-variant/30 max-w-sm w-full rounded-2xl shadow-2xl p-6 space-y-4 animate-toast-in">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-error-container/30 flex items-center justify-center text-error flex-shrink-0">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="font-bold text-lg text-on-surface font-headline-md leading-tight">
                {confirmDialog.title}
              </h3>
            </div>
            
            <p className="text-xs text-on-surface-variant leading-relaxed">
              {confirmDialog.message}
            </p>
            
            <div className="flex gap-2 pt-2 justify-end">
              <button 
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2.5 border border-outline-variant/50 hover:bg-surface-container-low rounded-xl text-xs font-bold text-on-surface transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={confirmDialog.onConfirm}
                className="px-4 py-2.5 bg-error text-on-error hover:bg-error/90 rounded-xl text-xs font-bold transition-opacity"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notifications Container */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 max-w-sm w-full pointer-events-none animate-toast-container">
        {toasts.map(toast => {
          let icon = <Info className="w-5 h-5 text-blue-500 animate-pulse" />;
          let borderClass = 'border-l-4 border-l-blue-500';
          if (toast.type === 'success') {
            icon = <Check className="w-5 h-5 text-primary" />;
            borderClass = 'border-l-4 border-l-primary';
          } else if (toast.type === 'error') {
            icon = <AlertCircle className="w-5 h-5 text-error" />;
            borderClass = 'border-l-4 border-l-error';
          } else if (toast.type === 'warning') {
            icon = <AlertCircle className="w-5 h-5 text-amber-500" />;
            borderClass = 'border-l-4 border-l-amber-500';
          }

          return (
            <div 
              key={toast.id} 
              className={`pointer-events-auto bg-white/95 backdrop-blur-md shadow-xl border border-outline-variant/30 rounded-xl p-4 flex items-start gap-3 w-full animate-toast-in ${borderClass}`}
            >
              <div className="flex-shrink-0 mt-0.5">{icon}</div>
              <div className="flex-1 text-xs font-semibold text-on-surface leading-tight pr-2">
                {toast.message}
              </div>
              <button 
                onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                className="text-on-surface-variant hover:text-on-surface text-xs font-bold font-mono transition-colors"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
