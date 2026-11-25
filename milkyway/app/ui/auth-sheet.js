// Sign-in sheet (email + password through supabase-js, loaded only when this opens).
import { t, lang, languages, setLanguage } from '../core/i18n.js';
import { supabase } from '../core/net.js';
import { Sheet } from './sheet.js';
import { h, icon, toast } from './dom.js';
import { registrationIdentity } from '../data/usernames.js';

const PENDING_OAUTH_USERNAME = 'mw_pending_oauth_username';

function passwordControl(input) {
  const toggle = h('button', {
    class: 'auth-password-toggle',
    type: 'button',
    'aria-label': t('showPassword'),
    'aria-pressed': 'false',
    onclick: () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      toggle.setAttribute('aria-label', t(visible ? 'hidePassword' : 'showPassword'));
      toggle.setAttribute('aria-pressed', String(visible));
    },
  }, h('span', { html: icon.eye }));
  return h('div', { class: 'auth-password-field' }, input, toggle);
}

function authError(error) {
  const message = String(error?.message || '');
  if (/username.*reserved|reserved.*username/i.test(message)) return t('usernameReserved');
  if (/username.*(duplicate|already exists)|duplicate key/i.test(message)) return t('usernameTaken');
  if (/username.*3.?20|username.*lowercase/i.test(message)) return t('usernameRule');
  if (/invalid login credentials/i.test(message)) return 'Email or password is incorrect. Check your details and try again.';
  if (/user already registered|already been registered/i.test(message)) return 'An account with this email already exists. Sign in instead.';
  if (/password.*(weak|short|least)/i.test(message)) return t('passwordRule');
  if (/invalid email/i.test(message)) return 'Enter a valid email address.';
  if (/failed to fetch|network/i.test(message)) return 'Connection problem. Check your internet and try again.';
  return message || 'We could not complete that request. Please try again.';
}

function fieldError(input) {
  if (input.validity.valueMissing) return `${input.getAttribute('aria-label') || 'This field'} is required.`;
  if (input.validity.typeMismatch) return 'Enter a valid email address.';
  if (input.validity.tooShort) return t('passwordRule');
  if (input.validity.patternMismatch) return t('usernameRule');
  return '';
}

export class AuthSheet {
  constructor() {
    this.sheet = new Sheet({ title: t('signIn'), className: 'auth-sheet' });
    const username = h('input', {
      id: 'auth-username', class: 'field', type: 'text', autocomplete: 'username', autocapitalize: 'none',
      placeholder: t('usernameOptionalPlaceholder'), 'aria-label': t('username'), maxlength: 20,
    });
    const email = h('input', {
      id: 'auth-email', class: 'field', type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none',
      placeholder: t('emailPlaceholder'),
      'aria-label': t('email'), required: true,
    });
    const password = h('input', {
      id: 'auth-password', class: 'field', type: 'password', autocomplete: 'current-password',
      placeholder: t('passwordPlaceholder'), 'aria-label': t('password'), required: true,
    });
    const confirmation = h('input', {
      id: 'auth-confirmation', class: 'field', type: 'password', autocomplete: 'new-password',
      placeholder: t('confirmPasswordPlaceholder'), 'aria-label': t('confirmPassword'), minlength: 8,
    });
    const usernameWrap = h('div', { class: 'auth-field-wrap', hidden: true },
      h('label', { class: 'auth-label', for: username.id }, t('username')), username);
    const emailWrap = h('div', { class: 'auth-field-wrap' },
      h('label', { class: 'auth-label', for: email.id }, t('email')), email);
    const passwordWrap = h('div', { class: 'auth-field-wrap' },
      h('label', { class: 'auth-label', for: password.id }, t('password')), passwordControl(password));
    const confirmationWrap = h('div', { class: 'auth-field-wrap', hidden: true },
      h('label', { class: 'auth-label', for: confirmation.id }, t('confirmPassword')), passwordControl(confirmation));
    const usernameError = h('span', { class: 'auth-field-error', id: 'auth-username-error', 'aria-live': 'polite' });
    const emailError = h('span', { class: 'auth-field-error', id: 'auth-email-error', 'aria-live': 'polite' });
    const passwordError = h('span', { class: 'auth-field-error', id: 'auth-password-error', 'aria-live': 'polite' });
    const confirmationError = h('span', { class: 'auth-field-error', id: 'auth-confirmation-error', 'aria-live': 'polite' });
    username.setAttribute('aria-describedby', usernameError.id);
    email.setAttribute('aria-describedby', emailError.id);
    password.setAttribute('aria-describedby', passwordError.id);
    confirmation.setAttribute('aria-describedby', confirmationError.id);
    usernameWrap.append(usernameError);
    emailWrap.append(emailError);
    passwordWrap.append(passwordError);
    confirmationWrap.append(confirmationError);
    const subtitle = h('p', { class: 'auth-subtitle' }, t('authSignInSubtitle'));
    const message = h('p', { class: 'auth-message', role: 'status', 'aria-live': 'polite' });
    const submit = h('button', { class: 'pill-btn hot wide auth-submit', type: 'submit' }, t('signIn'));
    const switchMode = h('button', { class: 'link center auth-switch', type: 'button' }, t('createAccount'));
    const policyLink = h('a', { class: 'link center', href: '/privacy.html' }, t('privacyPolicy'));
    const close = h('button', {
      class: 'auth-close', type: 'button', 'aria-label': t('close'), title: t('close'),
      onclick: () => this.sheet.close(),
    }, h('span', { html: icon.close }));
    const forgotPassword = h('button', {
      class: 'link auth-forgot', type: 'button',
      onclick: async () => {
        if (!validate(email)) { email.focus(); return; }
        forgotPassword.disabled = true;
        message.textContent = t('loading');
        try {
          const sb = await supabase();
          const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), {
            redirectTo: `${location.origin}/milkyway/`,
          });
          if (error) throw error;
          message.textContent = `${t('resetSent')} ${email.value.trim()}.`;
        } catch (error) {
          message.textContent = authError(error);
        } finally {
          forgotPassword.disabled = false;
        }
      },
    }, t('forgotPassword'));
    const google = h('button', {
      class: 'auth-google',
      type: 'button',
      onclick: async () => {
        if (mode === 'signup') {
          try {
            localStorage.setItem(PENDING_OAUTH_USERNAME, JSON.stringify({
              username: username.value.trim().toLowerCase(),
              startedAt: Date.now(),
            }));
          } catch {
            message.textContent = 'Could not save your username for Google sign-up. Check your browser storage settings.';
            return;
          }
        }
        google.disabled = true;
        message.textContent = t('loading');
        try {
          const sb = await supabase();
          const { error } = await sb.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: `${location.origin}/milkyway/` },
          });
          if (error) throw error;
        } catch (error) {
          try { localStorage.removeItem(PENDING_OAUTH_USERNAME); } catch {}
          message.textContent = authError(error);
          google.disabled = false;
        }
      },
    }, h('span', { class: 'auth-google-mark', 'aria-hidden': 'true' }, 'G'), t('continueWithGoogle'));
    let mode = 'signin';
    const fieldErrors = new Map([
      [username, usernameError], [email, emailError], [password, passwordError], [confirmation, confirmationError],
    ]);
    const validate = input => {
      const error = fieldErrors.get(input);
      if (!error) return input.checkValidity();
      const text = fieldError(input);
      error.textContent = text;
      input.toggleAttribute('aria-invalid', Boolean(text));
      return !text;
    };
    for (const input of fieldErrors.keys()) {
      input.addEventListener('blur', () => validate(input));
      input.addEventListener('input', () => {
        if (input.getAttribute('aria-invalid') === 'true') validate(input);
      });
    }
    const setMode = next => {
      mode = next;
      const creating = mode === 'signup';
      this.sheet.title = creating ? t('createAccount') : t('signIn');
      subtitle.textContent = t(creating ? 'authSignUpSubtitle' : 'authSignInSubtitle');
      submit.textContent = creating ? t('createAccount') : t('signIn');
      switchMode.textContent = creating ? t('haveAccount') : t('createAccount');
      usernameWrap.hidden = !creating;
      username.required = false;
      confirmationWrap.hidden = !creating;
      confirmation.required = creating;
      forgotPassword.hidden = creating;
      password.autocomplete = creating ? 'new-password' : 'current-password';
      password.minLength = creating ? 8 : 0;
      password.placeholder = t(creating ? 'newPasswordPlaceholder' : 'passwordPlaceholder');
      message.textContent = '';
      confirmation.removeAttribute('aria-invalid');
      for (const input of fieldErrors.keys()) {
        input.removeAttribute('aria-invalid');
        fieldErrors.get(input).textContent = '';
      }
    };
    this.setMode = setMode;
    switchMode.addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
    confirmation.addEventListener('input', () => {
      confirmation.removeAttribute('aria-invalid');
      message.textContent = '';
    });
    const form = h('form', {
      class: 'stack auth-form',
      onsubmit: async event => {
        event.preventDefault();
        const fields = mode === 'signup'
          ? [email, password, confirmation]
          : [email, password];
        const invalid = fields.filter(input => !validate(input));
        if (invalid.length) {
          invalid[0].focus();
          return;
        }
        if (mode === 'signup' && password.value !== confirmation.value) {
          confirmation.setAttribute('aria-invalid', 'true');
          confirmationError.textContent = t('passwordMismatch');
          confirmation.focus();
          return;
        }
        submit.disabled = true;
        switchMode.disabled = true;
        google.disabled = true;
        forgotPassword.disabled = true;
        submit.dataset.loading = 'true';
        message.textContent = t('loading');
        try {
          const sb = await supabase();
          let result;
          if (mode === 'signup') {
            const identity = await registrationIdentity(sb, {
              email: email.value.trim(),
              requestedUsername: username.value,
            });
            result = await sb.auth.signUp({
              email: email.value.trim(),
              password: password.value,
              options: {
                emailRedirectTo: `${location.origin}/milkyway/`,
                data: {
                  username: identity.username,
                  display_name: identity.displayName,
                  username_auto_generated: identity.usernameAutoGenerated,
                },
              },
            });
          } else {
            result = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
          }
          const { data, error } = result;
          if (error) throw error;
          password.value = '';
          confirmation.value = '';
          if (mode === 'signup' && !data.session) {
            message.textContent = t('confirmEmailSent');
            return;
          }
          message.textContent = '';
          this.sheet.close();
          toast(mode === 'signup' ? t('accountCreated') : '✓');
        } catch (error) {
          message.textContent = authError(error);
        } finally {
          submit.disabled = false;
          switchMode.disabled = false;
          google.disabled = false;
          forgotPassword.disabled = mode === 'signup';
          delete submit.dataset.loading;
        }
      },
    },
    subtitle,
    usernameWrap,
    emailWrap,
    passwordWrap,
    forgotPassword,
    confirmationWrap,
    submit,
    message,
    h('div', { class: 'auth-divider', 'aria-hidden': 'true' }, h('span'), h('b', {}, t('or')), h('span')),
    google,
    switchMode,
    policyLink);
    this.sheet.panel.append(close);
    const languageSheet = new Sheet({ title: t('language'), className: 'language-sheet' });
    const languageButton = h('button', {
      class: 'auth-language-button', type: 'button', 'aria-haspopup': 'dialog',
      onclick: () => languageSheet.open(),
    }, h('span', { 'aria-hidden': 'true' }, '🌐'),
    h('span', {}, languages.find(item => item.code === lang)?.name || 'English'),
    h('span', { class: 'auth-language-chevron', 'aria-hidden': 'true' }, '⌄'));
    languageSheet.body.classList.add('language-options');
    for (const item of languages) {
      languageSheet.body.append(h('button', {
        class: 'language-option',
        type: 'button',
        'aria-pressed': String(item.code === lang),
        onclick: () => setLanguage(item.code),
      }, h('span', {}, item.name), h('span', { class: 'language-option-check', 'aria-hidden': 'true' }, item.code === lang ? '✓' : '')));
    }
    this.sheet.body.append(form, languageButton);
  }
  open(mode = 'signin') {
    this.setMode(mode === 'signup' ? 'signup' : 'signin');
    this.sheet.open();
  }
}
