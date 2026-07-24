import React, { useEffect, useState } from 'react';
import { Contact as ContactIcon, Users2, UserPlus, Trash2, FolderPlus } from 'lucide-react';

interface ContactRow {
  id: string;
  name: string;
  phoneNumber: string;
  tags: string[] | null;
  notes: string | null;
  optedOut: boolean;
  createdAt: string;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  _count: { members: number };
  memberContactIds: string[];
}

interface Props {
  backendUrl: string;
  getHeaders: () => Record<string, string>;
  addToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
  hasPermission: (key: string) => boolean;
  setConfirmDialog: (dialog: { title: string; message: string; onConfirm: () => void } | null) => void;
}

export default function ContactsPage({ backendUrl, getHeaders, addToast, hasPermission, setConfirmDialog }: Props) {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [submittingGroup, setSubmittingGroup] = useState(false);

  const [managingGroupId, setManagingGroupId] = useState<string | null>(null);
  const [managingSelection, setManagingSelection] = useState<string[]>([]);
  const [savingMembers, setSavingMembers] = useState(false);

  const canManage = hasPermission('contacts.manage');

  const fetchContacts = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/contacts`, { headers: getHeaders() });
      if (res.ok) setContacts(await res.json());
    } catch (err) {
      console.error('Failed to load contacts:', err);
    }
  };

  const fetchGroups = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/contact-groups`, { headers: getHeaders() });
      if (res.ok) setGroups(await res.json());
    } catch (err) {
      console.error('Failed to load contact groups:', err);
    }
  };

  useEffect(() => {
    fetchContacts();
    fetchGroups();
  }, []);

  const handleCreateContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !phoneNumber) {
      addToast('Name and phone number are required', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${backendUrl}/api/contacts`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          name,
          phoneNumber,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          notes: notes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create contact');
      addToast(`Contact "${data.name}" created`, 'success');
      setName('');
      setPhoneNumber('');
      setTags('');
      setNotes('');
      fetchContacts();
    } catch (err: any) {
      addToast(err.message || 'Failed to create contact', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleOptedOut = async (contact: ContactRow) => {
    try {
      const res = await fetch(`${backendUrl}/api/contacts/${contact.id}`, {
        method: 'PATCH',
        headers: getHeaders(),
        body: JSON.stringify({ optedOut: !contact.optedOut }),
      });
      if (!res.ok) throw new Error('Failed to update contact');
      setContacts((prev) => prev.map((c) => (c.id === contact.id ? { ...c, optedOut: !c.optedOut } : c)));
    } catch (err) {
      addToast('Failed to update contact', 'error');
    }
  };

  const handleDeleteContact = (contact: ContactRow) => {
    setConfirmDialog({
      title: 'Delete Contact',
      message: `Menghapus "${contact.name}" juga akan menghapus PERMANEN seluruh riwayat chat dengan kontak ini dan datanya di laporan broadcast manapun yang pernah mengirim ke nomor ini. Tindakan ini tidak bisa dibatalkan. Lanjutkan?`,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await fetch(`${backendUrl}/api/contacts/${contact.id}`, { method: 'DELETE', headers: getHeaders() });
          setContacts((prev) => prev.filter((c) => c.id !== contact.id));
          addToast('Contact deleted', 'success');
        } catch (err) {
          addToast('Failed to delete contact', 'error');
        }
      },
    });
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName) {
      addToast('Group name is required', 'error');
      return;
    }
    setSubmittingGroup(true);
    try {
      const res = await fetch(`${backendUrl}/api/contact-groups`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ name: groupName, description: groupDescription || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create group');
      addToast(`Group "${data.name}" created`, 'success');
      setGroupName('');
      setGroupDescription('');
      fetchGroups();
    } catch (err: any) {
      addToast(err.message || 'Failed to create group', 'error');
    } finally {
      setSubmittingGroup(false);
    }
  };

  const handleDeleteGroup = (group: GroupRow) => {
    setConfirmDialog({
      title: 'Delete Group',
      message: `Are you sure you want to delete "${group.name}"?`,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await fetch(`${backendUrl}/api/contact-groups/${group.id}`, { method: 'DELETE', headers: getHeaders() });
          setGroups((prev) => prev.filter((g) => g.id !== group.id));
          addToast('Group deleted', 'success');
        } catch (err) {
          addToast('Failed to delete group', 'error');
        }
      },
    });
  };

  const openManageMembers = (group: GroupRow) => {
    setManagingGroupId(group.id);
    setManagingSelection(group.memberContactIds);
  };

  const toggleMemberSelection = (contactId: string) => {
    setManagingSelection((prev) => (prev.includes(contactId) ? prev.filter((id) => id !== contactId) : [...prev, contactId]));
  };

  const saveMembers = async () => {
    if (!managingGroupId) return;
    setSavingMembers(true);
    try {
      const res = await fetch(`${backendUrl}/api/contact-groups/${managingGroupId}/members`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ contactIds: managingSelection }),
      });
      if (!res.ok) throw new Error('Failed to save members');
      addToast('Group members updated', 'success');
      setManagingGroupId(null);
      fetchGroups();
    } catch (err: any) {
      addToast(err.message || 'Failed to save members', 'error');
    } finally {
      setSavingMembers(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-on-surface font-headline-lg">Contacts</h2>
        <p className="text-on-surface-variant text-sm mt-1">Manage your phonebook and organize contacts into groups</p>
      </div>

      {canManage && (
        <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
          <h3 className="font-bold text-sm flex items-center gap-2">
            <UserPlus className="w-5 h-5" /> Add Contact
          </h3>
          <form onSubmit={handleCreateContact} className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none" />
            <input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="Phone number" className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none" />
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags (comma separated)" className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none" />
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none" />
            <button type="submit" disabled={submitting} className="md:col-span-4 bg-primary text-on-primary py-3 rounded-xl font-bold disabled:opacity-50">
              {submitting ? 'Adding...' : 'Add Contact'}
            </button>
          </form>
        </div>
      )}

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <ContactIcon className="w-5 h-5" /> Contacts
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Phone</th>
                <th className="py-3 px-4">Tags</th>
                <th className="py-3 px-4">Opted Out</th>
                {canManage && <th className="py-3 px-4">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-surface-container-lowest transition-colors">
                  <td className="py-3.5 px-4">{c.name}</td>
                  <td className="py-3.5 px-4 font-mono">{c.phoneNumber}</td>
                  <td className="py-3.5 px-4">{(c.tags || []).join(', ')}</td>
                  <td className="py-3.5 px-4">
                    <button
                      onClick={() => canManage && toggleOptedOut(c)}
                      disabled={!canManage}
                      className={`px-2 py-0.5 rounded-full font-bold text-[9px] uppercase tracking-wider ${c.optedOut ? 'bg-error-container text-error' : 'bg-primary-container text-on-primary-container'} disabled:opacity-60`}
                    >
                      {c.optedOut ? 'Opted Out' : 'Active'}
                    </button>
                  </td>
                  {canManage && (
                    <td className="py-3.5 px-4">
                      <button onClick={() => handleDeleteContact(c)} className="px-3 py-1.5 bg-error-container text-error rounded-xl font-bold text-[10px] uppercase flex items-center gap-1">
                        <Trash2 className="w-3.5 h-3.5" /> Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {contacts.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-on-surface-variant">
                    No contacts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {canManage && (
        <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
          <h3 className="font-bold text-sm flex items-center gap-2">
            <FolderPlus className="w-5 h-5" /> Create Group
          </h3>
          <form onSubmit={handleCreateGroup} className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Group name" className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none" />
            <input value={groupDescription} onChange={(e) => setGroupDescription(e.target.value)} placeholder="Description (optional)" className="w-full px-3 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl outline-none" />
            <button type="submit" disabled={submittingGroup} className="bg-primary text-on-primary py-3 rounded-xl font-bold disabled:opacity-50">
              {submittingGroup ? 'Creating...' : 'Create Group'}
            </button>
          </form>
        </div>
      )}

      <div className="bg-surface-container-low border border-outline-variant/30 rounded-2xl p-6 shadow-sm space-y-4">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <Users2 className="w-5 h-5" /> Groups
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-outline-variant/30 text-on-surface-variant uppercase font-bold tracking-wider">
                <th className="py-3 px-4">Name</th>
                <th className="py-3 px-4">Description</th>
                <th className="py-3 px-4">Members</th>
                {canManage && <th className="py-3 px-4">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/20 font-medium">
              {groups.map((g) => (
                <React.Fragment key={g.id}>
                  <tr className="hover:bg-surface-container-lowest transition-colors">
                    <td className="py-3.5 px-4">{g.name}</td>
                    <td className="py-3.5 px-4">{g.description || '-'}</td>
                    <td className="py-3.5 px-4 font-mono">{g._count.members}</td>
                    {canManage && (
                      <td className="py-3.5 px-4 flex gap-2">
                        <button
                          onClick={() => (managingGroupId === g.id ? setManagingGroupId(null) : openManageMembers(g))}
                          className="px-3 py-1.5 bg-primary-container text-on-primary-container rounded-xl font-bold text-[10px] uppercase"
                        >
                          {managingGroupId === g.id ? 'Close' : 'Manage Members'}
                        </button>
                        <button onClick={() => handleDeleteGroup(g)} className="px-3 py-1.5 bg-error-container text-error rounded-xl font-bold text-[10px] uppercase flex items-center gap-1">
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </td>
                    )}
                  </tr>
                  {managingGroupId === g.id && (
                    <tr>
                      <td colSpan={4} className="p-4 bg-surface-container-lowest">
                        <p className="text-[10px] text-on-surface-variant mb-2 uppercase font-bold tracking-wider">
                          Select contacts for this group
                        </p>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                          {contacts.map((c) => (
                            <label key={c.id} className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={managingSelection.includes(c.id)}
                                onChange={() => toggleMemberSelection(c.id)}
                                className="w-4 h-4 accent-primary"
                              />
                              {c.name}
                            </label>
                          ))}
                        </div>
                        <button
                          onClick={saveMembers}
                          disabled={savingMembers}
                          className="mt-3 bg-primary text-on-primary px-4 py-2 rounded-xl font-bold text-xs disabled:opacity-50"
                        >
                          {savingMembers ? 'Saving...' : 'Save Members'}
                        </button>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-on-surface-variant">
                    No groups yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
