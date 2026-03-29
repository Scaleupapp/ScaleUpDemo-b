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
    await this._send({
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
}

module.exports = new EmailService();
