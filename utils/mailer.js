const https = require('https');
const nodemailer = require('nodemailer');

function sendHttpsPost(urlStr, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const postData = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...headers,
        },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, data: parsed });
            } else {
              reject(new Error(parsed.message || `HTTP ${res.statusCode}: ${data}`));
            }
          } catch {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, raw: data });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTPS request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Creates or retrieves the nodemailer SMTP transporter using current environment variables.
 * Returns null if required SMTP credentials are not configured.
 */
function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS ? process.env.SMTP_PASS.replace(/\s+/g, '') : undefined;

  if (!host || !user) {
    return null;
  }

  const isPort465 = port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure: isPort465,
    auth: {
      user,
      pass,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
    tls: {
      rejectUnauthorized: false,
    },
  });
}

function buildResetEmailHtml(resetUrl) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #334155; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; padding: 36px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 500px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); overflow: hidden;">
          
          <!-- Header Bar -->
          <tr>
            <td style="padding: 32px 32px 24px; text-align: left;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width: 44px; height: 44px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 12px; text-align: center; vertical-align: middle;">
                    <span style="font-size: 20px; line-height: 44px;">🔑</span>
                  </td>
                  <td style="padding-left: 12px;">
                    <span style="font-size: 16px; font-weight: 800; color: #0f172a; letter-spacing: -0.02em;">Attendance System</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: -0.02em;">
                Reset your password
              </h1>
              <p style="margin: 0 0 24px; font-size: 14px; line-height: 1.6; color: #64748b;">
                We received a request to reset the password for your account. You can choose a new password by clicking the button below:
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 0 28px;">
                <tr>
                  <td style="border-radius: 10px; background-color: #0f172a;">
                    <a href="${resetUrl}" target="_blank" style="display: inline-block; padding: 14px 28px; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 10px; background-color: #0f172a; text-align: center;">
                      Reset Password →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Notice Box -->
              <div style="background-color: #f1f5f9; border-left: 4px solid #6366f1; border-radius: 0 8px 8px 0; padding: 14px 16px; margin-bottom: 24px;">
                <p style="margin: 0 0 6px; font-size: 12px; font-weight: 700; color: #1e293b;">
                  ⏱ Security Notice
                </p>
                <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #64748b;">
                  This link is single-use and expires in <strong>15 minutes</strong>. If you did not make this request, you can safely ignore this email — your account remains completely secure.
                </p>
              </div>

              <!-- URL Fallback -->
              <p style="margin: 0; font-size: 12px; line-height: 1.6; color: #94a3b8;">
                If the button above does not work, copy and paste this link into your browser:<br>
                <a href="${resetUrl}" style="color: #4f46e5; word-break: break-all; text-decoration: underline;">${resetUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #f1f5f9; padding: 20px 32px; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #94a3b8; line-height: 1.5;">
                This is an automated message from Attendance System.<br>
                Please do not reply directly to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Sends a password reset email to the given recipient.
 * Supports Resend API (HTTPS port 443), Brevo API (HTTPS port 443), and standard Nodemailer SMTP.
 * If all providers are unconfigured, logs a warning and fallback link to console.
 *
 * @param {string} toEmail - Recipient email address
 * @param {string} resetUrl - Password reset URL containing one-time token
 * @returns {Promise<{success: boolean, fallback?: boolean, messageId?: string, error?: string}>}
 */
async function sendResetEmail(toEmail, resetUrl) {
  const html = buildResetEmailHtml(resetUrl);
  const subject = 'Password Reset - Attendance System';

  // 1. Resend HTTPS API (Port 443 - bypasses cloud SMTP port blocking)
  if (process.env.RESEND_API_KEY) {
    try {
      const from =
        process.env.RESEND_FROM || process.env.SMTP_FROM || 'Attendance System <onboarding@resend.dev>';
      const res = await sendHttpsPost(
        'https://api.resend.com/emails',
        { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        {
          from,
          to: [toEmail],
          subject,
          html,
        }
      );
      return { success: true, messageId: res.data?.id };
    } catch (err) {
      console.error('[mailer:resend] Failed to send via Resend:', err.message);
    }
  }

  // 2. Brevo HTTPS API (Port 443 - bypasses cloud SMTP port blocking)
  if (process.env.BREVO_API_KEY) {
    try {
      const senderEmail = process.env.BREVO_SENDER || 'no-reply@attendance.local';
      const res = await sendHttpsPost(
        'https://api.brevo.com/v3/smtp/email',
        { 'api-key': process.env.BREVO_API_KEY },
        {
          sender: { name: 'Attendance System', email: senderEmail },
          to: [{ email: toEmail }],
          subject,
          htmlContent: html,
        }
      );
      return { success: true, messageId: res.data?.messageId };
    } catch (err) {
      console.error('[mailer:brevo] Failed to send via Brevo:', err.message);
    }
  }

  // 3. Standard SMTP via Nodemailer
  const fromAddress = process.env.SMTP_FROM || '"Attendance System" <no-reply@yourdomain.com>';
  const transporter = getTransporter();

  if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: fromAddress,
        to: toEmail,
        subject,
        html,
      });
      return { success: true, messageId: info?.messageId };
    } catch (err) {
      console.error('[mailer:smtp] Failed to send reset email via SMTP:', err.message);
      console.log(
        `[mailer:fallback] Password reset link for ${toEmail}: ${resetUrl} (expires in 15 minutes, single use)`
      );
      return { success: false, error: err.message };
    }
  } else {
    console.warn(
      '[mailer] SMTP environment variables are missing (SMTP_HOST/SMTP_USER). ' +
        'Password reset email will not be sent; logging to console instead.'
    );
  }

  // Fallback to console
  console.log(
    `[mailer:fallback] Password reset link for ${toEmail}: ${resetUrl} (expires in 15 minutes, single use)`
  );
  return { success: false, fallback: true };
}

module.exports = {
  sendResetEmail,
  getTransporter,
  buildResetEmailHtml,
  get isConfigured() {
    return !!(
      process.env.RESEND_API_KEY ||
      process.env.BREVO_API_KEY ||
      (process.env.SMTP_HOST && process.env.SMTP_USER)
    );
  },
};