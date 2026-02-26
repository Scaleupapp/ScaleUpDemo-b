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
}

module.exports = new EmailService();
