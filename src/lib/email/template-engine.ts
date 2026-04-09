/**
 * Simple template engine for email templates.
 * Replaces {{variable_name}} placeholders with values from the context.
 */

export interface TemplateContext {
  contact_name?: string;
  contact_first_name?: string;
  contact_email?: string;
  company_name?: string;
  sender_name?: string;
  sender_first_name?: string;
  sender_email?: string;
  product_url?: string;
  meeting_link?: string;
  original_subject?: string;
}

const PRODUCT_URL = 'https://proxi.ai';

export function buildTemplateContext(opts: {
  contactName?: string;
  contactEmail?: string;
  companyName?: string;
  senderName?: string;
  senderEmail?: string;
  originalSubject?: string;
}): TemplateContext {
  return {
    contact_name: opts.contactName ?? '',
    contact_first_name: opts.contactName?.split(' ')[0] ?? '',
    contact_email: opts.contactEmail ?? '',
    company_name: opts.companyName ?? '',
    sender_name: opts.senderName ?? '',
    sender_first_name: opts.senderName?.split(' ')[0] ?? '',
    sender_email: opts.senderEmail ?? '',
    product_url: PRODUCT_URL,
    meeting_link: `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://proxi.ai'}/book`,
    original_subject: opts.originalSubject ?? '',
  };
}

export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = context[key as keyof TemplateContext];
    return value ?? match; // keep placeholder if no value
  });
}
