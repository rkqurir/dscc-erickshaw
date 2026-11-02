const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'] as const;

/** Convert Bengali (and Arabic-Indic) digits in a string to ASCII digits. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯٠-٩]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0x09e6 && code <= 0x09ef) return String(code - 0x09e6);
    return String(code - 0x0660);
  });
}

/** Convert ASCII digits in a string (or a number) to Bengali digits. */
export function toBengaliDigits(input: string | number): string {
  return String(input).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
}

/** Remove whitespace, hyphens, dots and other separators commonly typed in IDs and phone numbers. */
export function stripSeparators(input: string): string {
  return input.replace(/[\s\-_.()‌‍]/g, '');
}
