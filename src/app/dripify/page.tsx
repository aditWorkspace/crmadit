import { DripifyClient } from './dripify-client';

export default function DripifyPage() {
  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-gray-100 px-4 md:px-8 py-5">
        <h1 className="text-xl font-semibold text-gray-900">Dripify Integration</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          LinkedIn leads pulled from Dripify (post-like webhook) — email auto-resolved + sent from Adit&apos;s Gmail.
        </p>
      </div>
      <div className="flex-1 overflow-auto px-4 md:px-8 py-6">
        <DripifyClient />
      </div>
    </div>
  );
}
