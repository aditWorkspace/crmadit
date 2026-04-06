import { LeadTable } from '@/components/leads/lead-table';
import { QuickAddFab } from '@/components/leads/quick-add-fab';

export default function LeadsPage() {
  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-gray-100 px-4 md:px-8 py-5 pt-16 md:pt-5">
        <h1 className="text-xl font-semibold text-gray-900">Leads</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          All outreach leads tracked from replied stage.
        </p>
      </div>
      <div className="flex-1 overflow-auto px-4 md:px-8 py-6">
        <LeadTable />
      </div>
      <QuickAddFab />
    </div>
  );
}
