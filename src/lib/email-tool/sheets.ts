// Ported VERBATIM from emailsendingasa/lib/sheets.ts (PR 3 of the
// email-tool absorption). The OAuth-user-token flow is correct — sheets
// are created in Adit's Drive and shared out per batch via the Drive
// API. The README in the standalone repo says "service account" but the
// code is OAuth user tokens; trust the code.
//
// Env vars required (already added to the CRM's Vercel project per the
// PR 3 sign-off): GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
// GOOGLE_OAUTH_REFRESH_TOKEN.

import { google } from 'googleapis';

const OWNER_EMAIL = 'aditmittal@berkeley.edu';

export interface PickedRow {
  company: string | null;
  full_name: string | null;
  email: string;
  first_name: string | null;
}

export interface CreateBatchSheetInput {
  userName: string;
  userEmail: string;
  rows: PickedRow[];
}

export interface CreateBatchSheetResult {
  url: string;
  spreadsheetId: string;
  title: string;
}

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing OAuth env vars: set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REFRESH_TOKEN (copied from the standalone emailsending Vercel project).',
    );
  }
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export async function createBatchSheet(input: CreateBatchSheetInput): Promise<CreateBatchSheetResult> {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const today = new Date().toISOString().slice(0, 10);
  const title = `${input.userName} - ${today} - Batch`;

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: 'Batch' } }],
    },
  });

  const spreadsheetId = created.data.spreadsheetId;
  const firstSheet = created.data.sheets?.[0]?.properties;
  if (!spreadsheetId) throw new Error('Sheets API did not return a spreadsheetId');
  if (firstSheet?.sheetId == null) throw new Error('Sheets API did not return a sheetId for the first tab');

  const values: (string | null)[][] = [
    ['Company', 'Full Name', 'Email', 'First Name'],
    ...input.rows.map(r => [r.company, r.full_name, r.email, r.first_name]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${firstSheet.title}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { repeatCell: { range: { sheetId: firstSheet.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
        { updateSheetProperties: { properties: { sheetId: firstSheet.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      ],
    },
  });

  // Sheet is owned by the OAuth user (Adit). Skip share-with-self;
  // Google errors on it.
  if (input.userEmail.toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { role: 'writer', type: 'user', emailAddress: input.userEmail },
      sendNotificationEmail: false,
    });
  }

  return {
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    spreadsheetId,
    title,
  };
}

export function describeGoogleError(err: unknown): string {
  const e = err as {
    message?: string;
    code?: number | string;
    status?: string;
    errors?: Array<{ message?: string; reason?: string }>;
    response?: { status?: number; data?: { error?: { message?: string; status?: string } } };
  };
  const googleMsg = e?.response?.data?.error?.message ?? e?.errors?.[0]?.message ?? e?.message ?? 'unknown error';
  const status = e?.response?.status ?? e?.code ?? e?.status ?? '?';
  const reason = e?.errors?.[0]?.reason ?? e?.response?.data?.error?.status ?? '';
  return `[${status}${reason ? ` ${reason}` : ''}] ${googleMsg}`;
}
