import { supabase } from './supabase.js';

export async function signUp(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
    },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  window.location.href = 'home.html';
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  window.location.href = 'index.html';
}

export async function getSessionUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.user ?? null;
}

export async function getProfile() {
  const user = await getSessionUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, created_at')
    .eq('id', user.id)
    .single();

  if (error) throw error;
  return data;
}

export async function requireAuth(redirectTo = 'index.html') {
  const user = await getSessionUser();
  if (!user) {
    window.location.href = redirectTo;
    return null;
  }
  return user;
}

export async function redirectIfLoggedIn(redirectTo = 'home.html') {
  const user = await getSessionUser();
  if (user) {
    window.location.href = redirectTo;
  }
}

export function getPasswordResetRedirectUrl() {
  return new URL('reset-password.html', window.location.href).href;
}

export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: getPasswordResetRedirectUrl(),
  });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  return data;
}

function parseAuthHash() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  if (!access_token || !refresh_token) return null;
  return {
    access_token,
    refresh_token,
    type: params.get('type'),
  };
}

function clearAuthUrl() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

export async function establishRecoverySession() {
  const query = new URLSearchParams(window.location.search);
  const code = query.get('code');

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    clearAuthUrl();
    return data.session;
  }

  const hash = parseAuthHash();
  if (hash) {
    const { data, error } = await supabase.auth.setSession({
      access_token: hash.access_token,
      refresh_token: hash.refresh_token,
    });
    if (error) throw error;
    clearAuthUrl();
    return data.session;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function completeSessionFromUrl() {
  const session = await establishRecoverySession();
  if (session) return session;

  if (!window.location.hash && !window.location.search.includes('code=')) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        clearTimeout(timeout);
        subscription.unsubscribe();
        clearAuthUrl();
        resolve(session);
      }
    });

    const timeout = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error('El enlace expiró o no es válido.'));
    }, 8000);
  });
}
