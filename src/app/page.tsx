import { Suspense } from 'react';
import { PipelineView } from '@/components/pipeline/pipeline-view';

export default function HomePage() {
  return (
    <Suspense>
      <PipelineView />
    </Suspense>
  );
}
