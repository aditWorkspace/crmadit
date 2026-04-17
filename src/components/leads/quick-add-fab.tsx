'use client';

import { useState } from 'react';
import { Plus } from '@/lib/icons';
import { LeadFormModal } from './lead-form';

interface QuickAddFabProps {
  onSuccess?: () => void;
}

export function QuickAddFab({ onSuccess }: QuickAddFabProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-30 h-14 w-14 rounded-full bg-gray-900 text-white shadow-lg hover:bg-gray-700 active:scale-95 transition-all flex items-center justify-center"
        aria-label="Add new lead"
        title="New lead (n)"
      >
        <Plus className="h-6 w-6" />
      </button>
      <LeadFormModal
        open={open}
        onClose={() => setOpen(false)}
        onSuccess={() => {
          setOpen(false);
          onSuccess?.();
        }}
      />
    </>
  );
}
