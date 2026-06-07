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
