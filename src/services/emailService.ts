import { Resend } from 'resend';
import * as fs from 'fs';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendVerificationEmail(email: string, code: string): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — skipping email send');
    return;
  }

  try {
    await resend.emails.send({
      from: 'SubEnergy <onboarding@resend.dev>',
      to: email,
      subject: 'Verify your SubEnergy email',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #111827;">Verify your email</h2>
          <p>Your verification code is:</p>
          <div style="font-size: 24px; font-weight: bold; color: #2563eb; margin: 16px 0;">${code}</div>
          <p>This code expires in 10 minutes.</p>
          <p style="color: #6b7280; font-size: 14px;">If you didn't create this account, you can ignore this email.</p>
        </div>
      `,
    });
    console.log(`[email] Sent verification code to ${email}`);
  } catch (err) {
    console.error('[email] Failed to send:', err);
    throw err;
  }
}