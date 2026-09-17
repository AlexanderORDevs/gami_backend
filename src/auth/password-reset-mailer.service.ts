import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

@Injectable()
export class PasswordResetMailer {
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  async send(email: string, recoveryCode: string): Promise<void> {
    const from = this.config.get<string>('SMTP_FROM');
    if (!from) {
      throw new ServiceUnavailableException(
        'Password reset email delivery is not configured.',
      );
    }

    try {
      await this.getTransporter().sendMail({
        from,
        to: email,
        subject: 'Tu código de recuperación de Gami',
        text: [
          'Usa este código para restablecer tu contraseña de Gami:',
          '',
          recoveryCode,
          '',
          'Este código vence en 15 minutos. Si no lo solicitaste, puedes ignorar este correo.',
        ].join('\n'),
      });
    } catch {
      throw new ServiceUnavailableException(
        'The password reset email could not be sent. Try again later.',
      );
    }
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const password = this.config.get<string>('SMTP_PASSWORD');
    if (!host || !user || !password) {
      throw new ServiceUnavailableException(
        'Password reset email delivery is not configured.',
      );
    }

    const port = Number(this.config.get<string>('SMTP_PORT', '587'));
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: this.config.get<string>('SMTP_SECURE', 'false') === 'true',
      auth: { user, pass: password },
    });
    return this.transporter;
  }
}
