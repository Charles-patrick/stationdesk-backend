import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

export async function sendEmail({ to, subject, text, html, attachments }) {
  if (!to) return false;
  if (!transport) {
    console.log(`[email not sent: SMTP not configured] to=${to} subject="${subject}"`);
    return false;
  }
  try {
    await transport.sendMail({ from: config.smtp.from, to, subject, text, html, attachments });
    return true;
  } catch (err) {
    console.error('Email failed:', err.message);
    return false;
  }
}
