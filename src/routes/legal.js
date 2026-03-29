const router = require('express').Router();
const apiResponse = require('../utils/apiResponse');

const TERMS_VERSION = '1.0';
const PRIVACY_VERSION = '1.0';
const LAST_UPDATED = '2026-03-29';

// --- Privacy Policy ---

router.get('/privacy-policy', (req, res) => {
  res.json(apiResponse.success({
    version: PRIVACY_VERSION,
    lastUpdated: LAST_UPDATED,
    title: 'Privacy Policy',
    sections: [
      {
        heading: 'Introduction',
        body: 'ScaleUp Technologies ("ScaleUp", "we", "us", or "our") operates the ScaleUp mobile application and platform (the "Service"). This Privacy Policy explains how we collect, use, disclose, and protect your personal information when you use our Service.\n\nBy using ScaleUp, you agree to the collection and use of information in accordance with this policy. If you do not agree, please do not use the Service.',
      },
      {
        heading: '1. Information We Collect',
        body: 'We collect the following categories of personal data:\n\n**Account Information:** Email address, phone number, first and last name, username, profile picture, date of birth (optional), and location (optional). If you sign in with Google, we receive your Google account name, email, and profile picture.\n\n**Learning Data:** Your learning objectives, quiz responses and scores, content you consume (watch history, progress), knowledge profile scores, journey plans, milestones, and AI tutor conversation history.\n\n**Social Data:** Follow relationships, comments, likes, saves, ratings, playlists you create, and content you share.\n\n**Competition Data:** Daily challenge attempts, scores, leaderboard rankings, and competition streaks.\n\n**Device Data:** Device type (iOS/Android), push notification token (FCM), and IP address (logged for security).\n\n**Creator Data (if applicable):** Content you upload, creator application details, portfolio links, and creator profile information including education, work experience, and skills.',
      },
      {
        heading: '2. How We Use Your Information',
        body: 'We use your personal data for the following purposes:\n\n**Service Delivery:** To provide and maintain the learning platform, track your progress, generate personalized learning journeys, deliver quizzes, and power the AI tutor.\n\n**Personalization:** To recommend content, generate adaptive learning paths, and tailor quiz difficulty based on your knowledge profile.\n\n**Communication:** To send you transactional emails (OTP codes, password resets, account notifications), push notifications about learning milestones, and security alerts.\n\n**Competition Features:** To rank you on leaderboards, track challenge streaks, and calculate handicapped scores.\n\n**Security:** To detect and prevent fraud, unauthorized access, and abuse. To enforce our Terms of Service and protect our users.\n\n**Analytics:** To understand platform usage patterns and improve the Service. We do not use third-party analytics trackers or advertising pixels.',
      },
      {
        heading: '3. Legal Basis for Processing',
        body: 'Under GDPR, we process your data on the following legal bases:\n\n**Consent:** You provide consent when you create an account and accept this Privacy Policy and our Terms of Service. You may withdraw consent at any time through Settings > Privacy.\n\n**Contract Performance:** Processing necessary to deliver the Service you signed up for (learning journeys, quizzes, progress tracking).\n\n**Legitimate Interest:** Security monitoring, fraud prevention, and platform improvement, where our interests do not override your rights.',
      },
      {
        heading: '4. Data Sharing and Third-Party Processors',
        body: 'We share your data with the following third-party service providers who process data on our behalf:\n\n**Anthropic (Claude AI):** Your quiz responses and AI tutor conversations are sent to Anthropic for processing. Anthropic processes this data per their data processing terms and does not use it to train their models.\n\n**OpenAI:** Content metadata may be sent to OpenAI for analysis and quality scoring.\n\n**Twilio:** Your phone number is shared with Twilio to send SMS verification codes.\n\n**Google Firebase:** Your device push notification token is sent to Firebase Cloud Messaging to deliver push notifications.\n\n**Amazon Web Services (AWS):** Profile pictures and content files are stored on AWS S3. All user data is hosted on infrastructure provided by AWS.\n\n**MongoDB Atlas:** Our database is hosted on MongoDB Atlas cloud infrastructure.\n\nWe do not sell your personal data to any third party. We do not share your data with advertisers.',
      },
      {
        heading: '5. Your Rights Under GDPR',
        body: 'If you are in the European Economic Area (EEA), United Kingdom, or a jurisdiction with similar data protection laws, you have the following rights:\n\n**Right of Access (Article 15):** You can download all your personal data at any time through Settings > Privacy > Download My Data. We provide your data in JSON format.\n\n**Right to Rectification (Article 16):** You can update or correct your personal information through your profile settings at any time.\n\n**Right to Erasure (Article 17):** You can deactivate your account through Settings > Deactivate Account. Your data will be hidden immediately and permanently deleted after 30 days. You can reactivate within those 30 days by logging back in.\n\n**Right to Data Portability (Article 20):** Your data export is provided in a structured, machine-readable JSON format that you can transfer to another service.\n\n**Right to Withdraw Consent:** You can withdraw your consent at any time through Settings > Privacy > Withdraw Consent. Note that withdrawing consent may limit your ability to use certain features.\n\n**Right to Object:** You can object to processing based on legitimate interests by contacting us at privacy@scaleupapp.com.',
      },
      {
        heading: '6. Data Retention',
        body: 'We retain your personal data for as long as your account is active and as needed to provide the Service.\n\n**Active accounts:** Data retained indefinitely while you use the Service.\n\n**Deactivated accounts:** Data hidden immediately. If you do not reactivate within 30 days, all personal data is permanently deleted and your user record is anonymized.\n\n**Security logs and audit records:** Retained for 2 years, then automatically deleted.\n\n**Email communications:** Transactional emails are not stored by us after delivery.\n\n**Deleted content:** Content you delete is removed immediately from the platform and permanently deleted from our storage within 30 days.',
      },
      {
        heading: '7. Data Security',
        body: 'We implement appropriate technical and organizational measures to protect your personal data:\n\n**Encryption in Transit:** All data transmitted between your device and our servers uses HTTPS/TLS encryption.\n\n**Password Security:** Passwords are hashed using bcrypt with a cost factor of 12. We never store plaintext passwords.\n\n**Token Security:** Authentication tokens are stored in your device\'s secure keychain (iOS) or encrypted storage (Android). Refresh tokens are validated against a version counter and can be revoked instantly.\n\n**Access Control:** Role-based access control limits data access to authorized personnel. Admin actions are audit-logged.\n\n**Breach Response:** In the event of a data breach, we will notify affected users and relevant authorities within 72 hours as required by GDPR Article 33.',
      },
      {
        heading: '8. International Data Transfers',
        body: 'Your data may be processed in regions outside your country of residence, including India and the United States, where our servers and third-party processors are located. We ensure appropriate safeguards are in place for any international data transfer in accordance with applicable data protection laws.',
      },
      {
        heading: '9. Children\'s Privacy',
        body: 'ScaleUp is designed for users aged 16 and older. We do not knowingly collect personal data from anyone under the age of 16. If you are a parent or guardian and believe your child has provided us with personal data, please contact us at privacy@scaleupapp.com and we will promptly delete that information.',
      },
      {
        heading: '10. Changes to This Privacy Policy',
        body: 'We may update this Privacy Policy from time to time. When we make material changes, we will notify you through the app and update the "Last Updated" date. Your continued use of the Service after changes constitutes acceptance of the updated policy.',
      },
      {
        heading: '11. Contact Us',
        body: 'For any questions, concerns, or requests related to this Privacy Policy or your personal data, please contact us:\n\n**Email:** privacy@scaleupapp.com\n**Data Controller:** ScaleUp Technologies\n\nYou also have the right to lodge a complaint with your local data protection authority if you believe your rights have been violated.',
      },
    ],
  }));
});

// --- Terms of Service ---

router.get('/terms-of-service', (req, res) => {
  res.json(apiResponse.success({
    version: TERMS_VERSION,
    lastUpdated: LAST_UPDATED,
    title: 'Terms of Service',
    sections: [
      {
        heading: 'Introduction',
        body: 'These Terms of Service ("Terms") govern your use of the ScaleUp mobile application and platform (the "Service") operated by ScaleUp Technologies ("ScaleUp", "we", "us", or "our"). By creating an account or using the Service, you agree to be bound by these Terms.\n\nIf you do not agree to these Terms, you must not use the Service.',
      },
      {
        heading: '1. Eligibility',
        body: 'You must be at least 16 years old to use ScaleUp. By creating an account, you represent that you are at least 16 years of age and have the legal capacity to enter into these Terms.\n\nIf you are using ScaleUp on behalf of an organization, you represent that you have the authority to bind that organization to these Terms.',
      },
      {
        heading: '2. Account Registration and Security',
        body: 'You may register using your email address, phone number, or Google account. You are responsible for:\n\n- Providing accurate and complete registration information.\n- Maintaining the confidentiality of your login credentials.\n- All activity that occurs under your account.\n\nYou must notify us immediately if you suspect unauthorized access to your account. We are not liable for any loss resulting from unauthorized use of your credentials.\n\nYou may not create multiple accounts, impersonate another person, or use someone else\'s account without permission.',
      },
      {
        heading: '3. The Service',
        body: 'ScaleUp is a learning and professional development platform that provides:\n\n- Curated and AI-organized educational content from creators.\n- Personalized learning journeys and adaptive weekly plans.\n- AI-powered quizzes and knowledge assessments.\n- An AI tutor for on-demand learning assistance.\n- Competitive daily challenges and leaderboards.\n- Social features including following creators, commenting, and rating content.\n- Progress tracking, knowledge profiles, and skill readiness scoring.\n\nWe reserve the right to modify, suspend, or discontinue any part of the Service at any time.',
      },
      {
        heading: '4. User Content and Conduct',
        body: 'You retain ownership of content you create or upload to ScaleUp. By posting content, you grant us a non-exclusive, worldwide, royalty-free license to display, distribute, and make available your content through the Service.\n\nYou agree not to:\n\n- Post content that is illegal, harmful, threatening, abusive, defamatory, or violates the rights of others.\n- Use the Service to harass, bully, or intimidate other users.\n- Attempt to gain unauthorized access to other accounts or our systems.\n- Use automated tools (bots, scrapers) to access the Service without our written permission.\n- Manipulate quiz scores, leaderboard rankings, or engagement metrics.\n- Upload malicious code or content designed to disrupt the Service.\n- Resell, redistribute, or commercially exploit content from the platform without the creator\'s permission.\n\nWe may remove content and suspend or ban accounts that violate these Terms.',
      },
      {
        heading: '5. Creator Terms',
        body: 'If you apply to become a creator on ScaleUp:\n\n- You must submit a creator application that is reviewed and approved by our team.\n- You represent that you have the rights to all content you upload.\n- You are responsible for the accuracy of educational content you publish.\n- Content must meet our quality guidelines and community standards.\n- We reserve the right to remove content or revoke creator status for violations.\n- Creator tiers (Rising, Core, Anchor, Pinnacle) are determined by our evaluation criteria including content quality, engagement, and community impact.\n\nCreator content may be organized, summarized, or indexed by our AI systems to improve discoverability and learning outcomes.',
      },
      {
        heading: '6. AI Features',
        body: 'ScaleUp uses artificial intelligence for several features including learning journey generation, quiz creation and evaluation, the AI tutor, content recommendations, and knowledge profiling.\n\n- AI-generated content and assessments are provided for educational purposes and may not always be accurate.\n- Quiz scores and knowledge assessments are algorithmically determined and should be treated as indicative, not definitive.\n- AI tutor responses are generated by language models and should not be considered professional advice.\n- Your interactions with AI features (quiz answers, tutor conversations) are processed by our AI partners (Anthropic, OpenAI) as described in our Privacy Policy.',
      },
      {
        heading: '7. Competition and Leaderboards',
        body: 'ScaleUp offers competitive features including daily challenges, leaderboards, and streaks.\n\n- Scores are calculated using a handicapping system based on your knowledge level.\n- Leaderboard rankings are computed weekly and may be reset.\n- We reserve the right to remove users from leaderboards for suspicious activity or violations.\n- Competition features are for engagement and motivation purposes; no monetary prizes are offered unless explicitly stated.',
      },
      {
        heading: '8. Account Deactivation and Deletion',
        body: 'You may deactivate your account at any time through Settings > Deactivate Account.\n\n- Upon deactivation, your profile, content, and data are immediately hidden from other users.\n- You have a 30-day grace period to reactivate by logging back in.\n- After 30 days, your account and all associated data are permanently and irreversibly deleted.\n- We will send reminder emails at 7 days and 1 day before permanent deletion.\n- Creator content will be removed from the platform upon deactivation.\n\nWe may also suspend or terminate your account if you violate these Terms, with or without notice.',
      },
      {
        heading: '9. Intellectual Property',
        body: 'The ScaleUp platform, including its design, code, AI models, branding, and proprietary features, is owned by ScaleUp Technologies and protected by intellectual property laws.\n\nYou may not copy, modify, reverse-engineer, or create derivative works of the Service or any of its components.\n\nContent created by other users and creators remains the property of those individuals and is licensed to ScaleUp for display on the platform.',
      },
      {
        heading: '10. Limitation of Liability',
        body: 'THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED.\n\nTo the maximum extent permitted by law, ScaleUp shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service, including but not limited to loss of data, loss of revenue, or career decisions made based on content or assessments on the platform.\n\nOur total liability for any claim related to the Service shall not exceed the amount you paid us in the 12 months preceding the claim, or $100, whichever is greater.',
      },
      {
        heading: '11. Indemnification',
        body: 'You agree to indemnify and hold harmless ScaleUp Technologies, its officers, directors, employees, and agents from any claims, damages, losses, or expenses (including legal fees) arising from your use of the Service, your content, or your violation of these Terms.',
      },
      {
        heading: '12. Governing Law',
        body: 'These Terms are governed by and construed in accordance with the laws of India. Any disputes arising from these Terms or the Service shall be subject to the exclusive jurisdiction of the courts in Bangalore, India.\n\nIf you are in the European Economic Area, nothing in these Terms affects your rights under mandatory consumer protection laws in your country of residence.',
      },
      {
        heading: '13. Changes to These Terms',
        body: 'We may update these Terms from time to time. When we make material changes, we will notify you through the app and request your acceptance of the updated Terms. If you do not accept updated Terms, you may deactivate your account.\n\nYour continued use of the Service after changes take effect constitutes acceptance of the new Terms.',
      },
      {
        heading: '14. Contact',
        body: 'For questions about these Terms, please contact us:\n\n**Email:** support@scaleupapp.com\n**Legal inquiries:** legal@scaleupapp.com',
      },
    ],
  }));
});

module.exports = router;
