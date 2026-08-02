import nodemailer from "nodemailer";

export interface EmailProvider {
  send(to: string, subject: string, text: string): Promise<{ messageId: string }>;
}

export class MockEmailProvider implements EmailProvider {
  async send(to: string, subject: string, text: string): Promise<{ messageId: string }> {
    return { messageId: `mock-email:${Buffer.from(`${to}:${subject}:${text}`).toString("base64url").slice(0, 24)}` };
  }
}

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === "true",
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }
  async send(to: string, subject: string, text: string): Promise<{ messageId: string }> {
    const result = await this.transport.sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
    return { messageId: result.messageId };
  }
}
