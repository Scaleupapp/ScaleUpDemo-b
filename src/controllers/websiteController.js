const emailService = require('../services/emailService');
const apiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const NOTIFY_EMAILS = [
  'nirpeksh@scaleupapp.club',
  'pratiksha@scaleupapp.club',
  'sayyam@scaleupapp.club',
  'gulshan@scaleupapp.club',
];

const submitFeedback = async (req, res, next) => {
  try {
    const { name, email, type, message } = req.body;
    if (!email) throw new ApiError(400, 'Email is required');
    if (!type) throw new ApiError(400, 'Type is required');

    const typeLabels = {
      waitlist: 'Waitlist Signup',
      feedback: 'User Feedback',
      beta: 'Beta Tester Request',
      contact: 'Contact Inquiry',
    };

    const subjectLabel = typeLabels[type] || 'Website Inquiry';
    const subject = `[ScaleUp Website] New ${subjectLabel} from ${name || email}`;

    const html = `
      <h2>${subjectLabel}</h2>
      <table style="border-collapse:collapse;width:100%;max-width:500px;">
        <tr><td style="padding:8px;font-weight:bold;color:#666;">Name</td><td style="padding:8px;">${name || '—'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;color:#666;">Email</td><td style="padding:8px;"><a href="mailto:${email}">${email}</a></td></tr>
        <tr><td style="padding:8px;font-weight:bold;color:#666;">Type</td><td style="padding:8px;">${subjectLabel}</td></tr>
        ${message ? `<tr><td style="padding:8px;font-weight:bold;color:#666;">Message</td><td style="padding:8px;">${message}</td></tr>` : ''}
        <tr><td style="padding:8px;font-weight:bold;color:#666;">Submitted</td><td style="padding:8px;">${new Date().toISOString()}</td></tr>
      </table>
    `;

    // Send notification to all team members
    for (const to of NOTIFY_EMAILS) {
      emailService.transporter.sendMail({
        from: emailService.from,
        to,
        subject,
        html,
        replyTo: email,
      }).catch(err => console.error(`[Website] Failed to notify ${to}:`, err.message));
    }

    // Send confirmation to the user
    if (type === 'waitlist') {
      emailService.transporter.sendMail({
        from: emailService.from,
        to: email,
        subject: 'Welcome to the ScaleUp Waitlist!',
        html: `
          <h2>You're on the list, ${name || 'there'}!</h2>
          <p>Thanks for joining the ScaleUp waitlist. We'll notify you as soon as we're ready for you.</p>
          <p>In the meantime, you can try our beta:</p>
          <ul>
            <li><strong>iOS:</strong> <a href="https://testflight.apple.com/join/akF4bcCG">Join TestFlight</a></li>
          </ul>
          <p>— The ScaleUp Team</p>
        `,
      }).catch(() => {});
    }

    console.log(`[Website] ${subjectLabel}: ${email} (${name || 'no name'})`);
    res.json(apiResponse.success({ received: true }, 'Thank you! We\'ll be in touch.'));
  } catch (err) { next(err); }
};

module.exports = { submitFeedback };
