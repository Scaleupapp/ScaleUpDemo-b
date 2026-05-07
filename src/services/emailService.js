const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    this.from = process.env.SMTP_FROM || 'ScaleUp <noreply@scaleup.app>';
  }

  async sendOTP(email, otp) {
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: 'ScaleUp — Password Reset OTP',
      html: `
        <h2>Password Reset</h2>
        <p>Your OTP code is:</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:20px;background:#f4f4f8;text-align:center;border-radius:8px;">${otp}</div>
        <p>This code expires in <strong>10 minutes</strong>.</p>
      `,
    });
  }

  async sendWelcome(email, firstName) {
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: 'Welcome to ScaleUp!',
      html: `
        <h2>Welcome, ${firstName}!</h2>
        <p>We're thrilled to have you. ScaleUp helps you turn content into real outcomes.</p>
        <p>Get started: complete your profile, set learning objectives, and start exploring content.</p>
      `,
    });
  }

  async sendDeletionReminder(email, firstName, daysRemaining) {
    const urgency = daysRemaining <= 1 ? 'FINAL NOTICE' : 'Reminder';
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: `${urgency}: Your ScaleUp account will be permanently deleted in ${daysRemaining} day${daysRemaining > 1 ? 's' : ''}`,
      html: `
        <h2>Hi ${firstName || 'there'},</h2>
        <p>Your ScaleUp account is scheduled for permanent deletion in <strong>${daysRemaining} day${daysRemaining > 1 ? 's' : ''}</strong>.</p>
        <p>Once deleted, all your learning progress, quiz history, and account data will be permanently removed and cannot be recovered.</p>
        <p><strong>To keep your account:</strong> Simply log back into ScaleUp and confirm reactivation.</p>
        <p>If you intended to delete your account, no action is needed.</p>
      `,
    });
  }

  async sendBreachNotification(email, firstName, { title, description, dataAffected, actionRequired }) {
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: `Security Notice: ${title}`,
      html: `
        <h2>Important Security Notice</h2>
        <p>Dear ${firstName || 'User'},</p>
        <p>We are writing to inform you of a security incident that may affect your ScaleUp account.</p>
        <h3>What happened</h3>
        <p>${description}</p>
        <h3>What data was affected</h3>
        <p>${dataAffected}</p>
        <h3>What you should do</h3>
        <p>${actionRequired}</p>
        <h3>What we are doing</h3>
        <p>We have taken immediate steps to secure our systems, investigate the incident, and prevent future occurrences. We have also notified the relevant data protection authorities as required by law.</p>
        <p>If you have any questions or concerns, please contact us at <a href="mailto:privacy@scaleupapp.com">privacy@scaleupapp.com</a>.</p>
        <p>We sincerely apologize for any inconvenience.</p>
        <p>— The ScaleUp Security Team</p>
      `,
    });
  }

  async sendDataExportReady(email, firstName) {
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: 'Your ScaleUp data export is ready',
      html: `
        <h2>Hi ${firstName || 'there'},</h2>
        <p>Your data export is ready. Open the ScaleUp app and go to <strong>Settings > Privacy > Download My Data</strong> to access it.</p>
        <p>The export contains all personal data we hold about you in JSON format, as required by GDPR Articles 15 and 20.</p>
        <p>If you did not request this export, please contact us immediately at <a href="mailto:privacy@scaleupapp.com">privacy@scaleupapp.com</a>.</p>
      `,
    });
  }

  async sendDailyDigest(toEmail, body) {
    await this.transporter.sendMail({
      from: this.from,
      to: toEmail,
      subject: 'ScaleUp daily digest',
      text: body,
    });
  }

  async sendAdminQuestionDigest(email, { queueDepth, estimatedMinutes, dashboardUrl }) {
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: `ScaleUp Admin — ${queueDepth} question${queueDepth !== 1 ? 's' : ''} awaiting review`,
      html: `
        <h2>Weekly Diagnostic Question Review</h2>
        <p>There ${queueDepth === 1 ? 'is' : 'are'} <strong>${queueDepth}</strong> question${queueDepth !== 1 ? 's' : ''} flagged for review in the admin queue.</p>
        <p>Estimated review time: <strong>~${estimatedMinutes} minutes</strong> (at 90 seconds per question).</p>
        <p style="margin-top:24px;">
          <a href="${dashboardUrl}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open dashboard</a>
        </p>
        <p style="margin-top:16px;font-size:0.875rem;color:#888;">Reply to this email if you have any questions.</p>
      `,
    });
  }
}

module.exports = new EmailService();
