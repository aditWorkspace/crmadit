'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { CheckCircle, Video, Calendar, RefreshCw } from '@/lib/icons';

function ConfirmationContent() {
  const params = useSearchParams();
  const meetLink = params.get('meetLink');
  const startTime = params.get('startTime');
  const name = params.get('name');
  const email = params.get('email');
  const eventId = params.get('eventId');
  const durationMinutes = params.get('durationMinutes');
  const wasRescheduled = params.get('rescheduled') === '1';

  const [userTz, setUserTz] = useState('America/Los_Angeles');
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) setUserTz(tz);
  }, []);

  const start = startTime ? new Date(startTime) : null;

  function formatInTz(date: Date, tz: string) {
    const datePart = date.toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    const timePart = date.toLocaleString('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const tzAbbr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short',
    }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? '';
    return `${datePart} at ${timePart} ${tzAbbr}`;
  }

  return (
    <div className="min-h-screen bg-[#111] flex items-center justify-center p-6">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-green-500/10 border border-green-500/20 mb-4">
            <CheckCircle className="h-8 w-8 text-green-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">
            {wasRescheduled ? 'Rescheduled!' : 'You\u0027re confirmed!'}
          </h1>
          <p className="text-gray-400 mt-2">
            {wasRescheduled
              ? 'Your meeting has been moved. An updated invite has been sent to your email.'
              : 'A calendar invite and Google Meet link have been sent to your email.'}
          </p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4 mb-6">
          {name && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-500">Name: </span>{name}
            </div>
          )}
          {start && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-500">When: </span>
              {formatInTz(start, userTz)}
            </div>
          )}
          {durationMinutes && (
            <div className="text-sm text-gray-300">
              <span className="text-gray-500">Duration: </span>{durationMinutes} minutes
            </div>
          )}
        </div>

        <div className="space-y-3">
          {meetLink && (
            <a
              href={meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full bg-white text-gray-900 rounded-xl py-3 font-semibold text-sm hover:bg-gray-100 transition-colors"
            >
              <Video className="h-4 w-4" />
              Join Google Meet
            </a>
          )}
          {eventId && email && (
            <a
              href={`/book?rescheduleEventId=${encodeURIComponent(eventId)}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name ?? '')}`}
              className="flex items-center justify-center gap-2 w-full bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-xl py-3 text-sm font-medium hover:bg-amber-500/20 hover:border-amber-500/40 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Reschedule
            </a>
          )}
          <a
            href="/book"
            className="flex items-center justify-center gap-2 w-full border border-gray-700 text-gray-300 rounded-xl py-3 text-sm hover:border-gray-500 transition-colors"
          >
            <Calendar className="h-4 w-4" />
            Book another time
          </a>
        </div>
      </div>
    </div>
  );
}

export default function ConfirmationPage() {
  return (
    <Suspense>
      <ConfirmationContent />
    </Suspense>
  );
}
