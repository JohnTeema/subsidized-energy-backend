import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export async function sendPasswordResetEmail(email: string, code: string): Promise<void> {
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping password reset email');
    console.log(`[email] Password reset code for ${email}: ${code}`);
    return;
  }

  const { data, error } = await resend.emails.send({
    from: 'Subsidized Energy <onboarding@resend.dev>',
    to: email,
    subject: 'Reset your SubEnergy password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #111827;">Reset your password</h2>
        <p>Your password reset code is:</p>
        <div style="font-size: 32px; font-weight: bold; color: #0D9488; letter-spacing: 8px; margin: 20px 0; font-family: monospace;">${code}</div>
        <p>This code expires in <strong>15 minutes</strong>.</p>
        <p style="color: #6b7280; font-size: 14px;">If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  });
  if (error) {
    console.error('[email] Resend error (password reset):', JSON.stringify(error));
    throw new Error(error.message);
  }
  console.log(`[email] Sent password reset code to ${email} — id: ${data?.id}`);
}

export async function sendVerificationEmail(email: string, code: string): Promise<void> {
  if (!resend) {
    console.warn('[email] RESEND_API_KEY not set — skipping email send');
    return;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: 'Subsidized Energy <onboarding@resend.dev>',
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
    if (error) {
      console.error('[email] Resend error (verification):', JSON.stringify(error));
      throw new Error(error.message);
    }
    console.log(`[email] Sent verification code to ${email} — id: ${data?.id}`);
  } catch (err) {
    console.error('[email] Failed to send:', err);
    throw err;
  }
}