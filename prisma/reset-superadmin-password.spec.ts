import { validatePasswordPair } from './reset-superadmin-password.js';

describe('secure superadmin password reset validation', () => {
  it('accepts a matching password that meets the application minimum', () => {
    expect(() =>
      validatePasswordPair('A-new-password-2026', 'A-new-password-2026'),
    ).not.toThrow();
  });

  it('rejects short passwords and mismatched confirmations', () => {
    expect(() => validatePasswordPair('short', 'short')).toThrow(
      '12 caracteres',
    );
    expect(() =>
      validatePasswordPair('A-valid-password-1', 'A-valid-password-2'),
    ).toThrow('no coinciden');
  });

  it('rejects values exceeding bcrypt input size instead of silently truncating them', () => {
    const tooLong = 'a'.repeat(73);
    expect(() => validatePasswordPair(tooLong, tooLong)).toThrow('72 bytes');
  });
});
