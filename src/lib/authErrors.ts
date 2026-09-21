// GoTrue answers with English, developer-facing messages ("Email not confirmed",
// "Invalid login credentials", "For security purposes, you can only request this
// after 47 seconds"). The UI has to explain them in Arabic, and the most common
// one is not a typo the user can fix by retrying: the project requires email
// confirmation (mailer_autoconfirm is off), so a password sign-in is rejected
// until the confirmation link is opened. Recognising the message lets the login
// screen offer "resend the link" / "send a one-time sign-in link" instead of
// leaving the user stuck on a red box.

export type AuthErrorKey =
  | "emailNotConfirmed"
  | "invalidCredentials"
  | "emailAlreadyRegistered"
  | "rateLimited"
  | "weakPassword"
  | "samePassword"
  | "invalidEmail"
  | "offline"
  | "unknown";

/** Map a Supabase auth error message onto a stable, translatable key. */
export function authErrorKey(message: string | null | undefined): AuthErrorKey {
  const text = String(message || "").toLowerCase();
  if (!text) return "unknown";
  if (/email[_ ]not[_ ]confirmed|email not confirmed|not confirmed/.test(text)) return "emailNotConfirmed";
  if (/already registered|already been registered|user already exists|email address is already/.test(text)) return "emailAlreadyRegistered";
  if (/invalid login credentials|invalid credentials|invalid_grant|invalid password/.test(text)) return "invalidCredentials";
  if (/security purposes|rate limit|too many requests|over_email_send_rate_limit|over_request_rate_limit|you can only request/.test(text)) return "rateLimited";
  if (/password should be at least|weak password|password is too short|password should contain/.test(text)) return "weakPassword";
  if (/different from the old password|should be different from the old/.test(text)) return "samePassword";
  if (/unable to validate email|invalid email|email address .* invalid|invalid format/.test(text)) return "invalidEmail";
  if (/network request failed|failed to fetch|network error|timeout|timed out|socket|dns|unreachable/.test(text)) return "offline";
  return "unknown";
}

/** True when the account exists but its email was never confirmed, so the
 * password sign-in can't succeed — the screen then offers the resend/one-time
 * link paths instead of a plain error. */
export function needsConfirmationHelp(key: AuthErrorKey): boolean {
  return key === "emailNotConfirmed";
}
