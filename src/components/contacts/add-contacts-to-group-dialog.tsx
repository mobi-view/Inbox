'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { addContactTag } from '@/lib/contacts/tag-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { Tag } from '@/types';

interface Row {
  id: string;
  name: string | null;
  phone: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: Tag | null;
  onDone: () => void;
}

/**
 * Pick numbers from your contacts and add them to the opened group.
 * Contacts already in the group are hidden.
 */
export function AddContactsToGroupDialog({ open, onOpenChange, group, onDone }: Props) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !group) return;
    setPicked(new Set());
    setSearch('');
  }, [open, group]);

  useEffect(() => {
    if (!open || !group) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      const supabase = createClient();

      const { data: members } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .eq('tag_id', group.id);
      const inGroup = new Set((members ?? []).map((m) => m.contact_id));

      let q = supabase.from('contacts').select('id, name, phone').order('name').limit(200);
      const term = search.trim().replace(/[%,()]/g, '');
      if (term) q = q.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
      const { data } = await q;

      if (!cancelled) {
        setRows((data ?? []).filter((r) => !inGroup.has(r.id)));
        setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, group, search]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function save() {
    if (!group || picked.size === 0) return;
    setSaving(true);
    const ids = [...picked];
    let failed = 0;
    for (let i = 0; i < ids.length; i += 5) {
      const res = await Promise.allSettled(ids.slice(i, i + 5).map((id) => addContactTag(id, group.id)));
      failed += res.filter((r) => r.status === 'rejected').length;
    }
    setSaving(false);
    if (failed > 0) toast.error(`Failed to add ${failed} contacts`);
    else toast.success(`Added ${ids.length} contacts to "${group.name}"`);
    onOpenChange(false);
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add contacts to “{group?.name}”</DialogTitle>
          <DialogDescription>
            Tick the numbers you want in this group.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            className="pl-8"
          />
        </div>

        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No contacts to add.
            </p>
          ) : (
            rows.map((r) => (
              <label
                key={r.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted"
              >
                <Checkbox checked={picked.has(r.id)} onCheckedChange={() => toggle(r.id)} />
                <span className="text-foreground">{r.name || r.phone}</span>
                {r.name && <span className="text-xs text-muted-foreground">{r.phone}</span>}
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || picked.size === 0}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Add {picked.size > 0 ? picked.size : ''} to group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
