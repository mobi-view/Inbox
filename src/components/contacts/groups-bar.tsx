'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Users, Loader2, FolderOpen, Upload } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import type { Tag } from '@/types';

const COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

interface GroupsBarProps {
  groups: Tag[];
  counts: Record<string, number>;
  allCount: number;
  /** The group currently opened, or null for "All contacts". */
  activeGroupId: string | null;
  onSelect: (groupId: string | null) => void;
  onCreated: () => void;
  canCreate: boolean;
  /** Opens the CSV import with this group as the destination. */
  onImport?: (group: Tag) => void;
}

/**
 * Row of group cards shown at the top of the Contacts page. Groups are
 * stored as tags; a contact can belong to several. Clicking a card opens
 * that group (the table below then lists only its numbers).
 */
export function GroupsBar({
  groups,
  counts,
  allCount,
  activeGroupId,
  onSelect,
  onCreated,
  canCreate,
  onImport,
}: GroupsBarProps) {
  const { user, accountId } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[3]);
  const [saving, setSaving] = useState(false);

  async function createGroup() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!user || !accountId) {
      toast.error('You are not signed in.');
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from('tags').insert({
      user_id: user.id,
      account_id: accountId,
      name: trimmed,
      color,
    });
    setSaving(false);
    if (error) {
      toast.error('Could not create the group (the name may already exist).');
      return;
    }
    toast.success(`Group "${trimmed}" created`);
    setName('');
    setColor(COLORS[3]);
    setOpen(false);
    onCreated();
  }

  const cardBase =
    'flex min-w-[140px] flex-col gap-1 rounded-xl border p-3 text-left transition-all';

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">Groups</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`${cardBase} ${
            activeGroupId === null
              ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
              : 'border-border bg-card/50 hover:border-primary/40'
          }`}
        >
          <Users className="size-4 text-primary" />
          <span className="text-sm font-medium text-foreground">All contacts</span>
          <span className="text-xs text-muted-foreground">{allCount}</span>
        </button>

        {groups.map((g) => (
          <div key={g.id} className="relative">
            <button
              type="button"
              onClick={() => onSelect(g.id)}
              className={`${cardBase} w-full ${
                activeGroupId === g.id
                  ? 'ring-1'
                  : 'border-border bg-card/50 hover:border-primary/40'
              }`}
              style={
                activeGroupId === g.id
                  ? {
                      borderColor: g.color,
                      backgroundColor: `${g.color}12`,
                      boxShadow: `0 0 0 1px ${g.color}55`,
                    }
                  : undefined
              }
            >
              <FolderOpen className="size-4" style={{ color: g.color }} />
              <span className="pr-6 text-sm font-medium text-foreground">{g.name}</span>
              <span className="text-xs text-muted-foreground">
                {counts[g.id] ?? 0} {(counts[g.id] ?? 0) === 1 ? 'contact' : 'contacts'}
              </span>
            </button>
            {onImport && canCreate && (
              <button
                type="button"
                onClick={() => onImport(g)}
                title={`Import a file into "${g.name}"`}
                aria-label={`Import a file into ${g.name}`}
                className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Upload className="size-3.5" />
              </button>
            )}
          </div>
        ))}

        {canCreate && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={`${cardBase} items-center justify-center border-dashed border-border text-muted-foreground hover:border-primary/60 hover:text-primary`}
          >
            <Plus className="size-4" />
            <span className="text-sm font-medium">New group</span>
          </button>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createGroup()}
              placeholder="Group name, e.g. VIP customers"
            />
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  className={`size-7 rounded-full ${
                    color === c ? 'ring-2 ring-offset-2 ring-offset-background ring-primary' : ''
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createGroup} disabled={saving || !name.trim()}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Create group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
