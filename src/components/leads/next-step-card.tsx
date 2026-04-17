'use client';

import { Lead, LeadStage } from '@/types';
import {
  MessageSquareReply,
  Link2,
  BookOpen,
  Upload,
  Send,
  PhoneCall,
  CalendarCheck,
} from '@/lib/icons';
import Link from 'next/link';
import { toast } from 'sonner';

interface NextStepConfig {
  label: string;
  description: string;
  icon: React.ReactNode;
  action: 'link' | 'copy' | 'external';
  href?: string;
  copyText?: string;
  buttonLabel: string;
}

function getNextStep(lead: Lead): NextStepConfig | null {
  const stage = lead.stage;

  const stageMap: Partial<Record<LeadStage, NextStepConfig>> = {
    replied: {
      label: 'Reply within 4 hours',
      description: `${lead.contact_name} is waiting for your response. Speed matters at this stage.`,
      icon: <MessageSquareReply className="h-4 w-4" />,
      action: 'link',
      href: `/leads/${lead.id}?compose=true`,
      buttonLabel: 'Open Compose',
    },
    scheduling: {
      label: 'Send booking link',
      description: `Share your calendar link to get ${lead.contact_name} on a call.`,
      icon: <Link2 className="h-4 w-4" />,
      action: 'copy',
      copyText: process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL}/book`
        : 'https://proxi.ai/book',
      buttonLabel: 'Copy Booking Link',
    },
    scheduled: {
      label: 'Prep for call — review notes',
      description: `Your call with ${lead.contact_name} is coming up. Review their background and prep questions.`,
      icon: <BookOpen className="h-4 w-4" />,
      action: 'link',
      href: `/leads/${lead.id}`,
      buttonLabel: 'Review Notes',
    },
    call_completed: {
      label: 'Upload transcript now',
      description: `Capture insights from your call with ${lead.contact_name} while they are fresh.`,
      icon: <Upload className="h-4 w-4" />,
      action: 'link',
      href: `/leads/${lead.id}?upload=true`,
      buttonLabel: 'Upload Transcript',
    },
    demo_sent: {
      label: 'Follow up in 3 days',
      description: `Check if ${lead.contact_name} has had a chance to try the demo.`,
      icon: <Send className="h-4 w-4" />,
      action: 'link',
      href: `/leads/${lead.id}?compose=true`,
      buttonLabel: 'Compose Follow-up',
    },
    feedback_call: {
      label: 'Schedule feedback call',
      description: `Get ${lead.contact_name} on a call to discuss their experience with the product.`,
      icon: <PhoneCall className="h-4 w-4" />,
      action: 'link',
      href: `/leads/${lead.id}`,
      buttonLabel: 'Book Meeting',
    },
    active_user: {
      label: 'Set up weekly check-in',
      description: `Maintain momentum with ${lead.contact_name} through regular touchpoints.`,
      icon: <CalendarCheck className="h-4 w-4" />,
      action: 'link',
      href: `/leads/${lead.id}?compose=true`,
      buttonLabel: 'Compose Check-in',
    },
  };

  return stageMap[stage] ?? null;
}

interface NextStepCardProps {
  lead: Lead;
}

export function NextStepCard({ lead }: NextStepCardProps) {
  const step = getNextStep(lead);
  if (!step) return null;

  const handleCopy = () => {
    if (step.copyText) {
      navigator.clipboard.writeText(step.copyText);
      toast.success('Copied to clipboard');
    }
  };

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-blue-600">{step.icon}</span>
        <span className="text-xs font-semibold text-blue-800">Next Step</span>
      </div>
      <p className="text-sm font-medium text-blue-900 mb-1">{step.label}</p>
      <p className="text-xs text-blue-600 mb-3">{step.description}</p>

      {step.action === 'link' && step.href ? (
        <Link
          href={step.href}
          className="inline-flex items-center gap-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md px-3 py-1.5 transition-colors font-medium"
        >
          {step.icon}
          {step.buttonLabel}
        </Link>
      ) : step.action === 'copy' ? (
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md px-3 py-1.5 transition-colors font-medium"
        >
          {step.icon}
          {step.buttonLabel}
        </button>
      ) : null}
    </div>
  );
}
