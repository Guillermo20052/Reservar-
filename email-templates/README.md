# Plantillas de correo · Espacios con propósito

Estas plantillas coinciden con el diseño de la página de inicio de sesión (colores, tipografía, tarjeta y botón rojo `#B02934`).

Supabase **no** lee estos archivos del repositorio automáticamente. Hay que copiarlos en el panel de Supabase.

## Cómo aplicarlas

1. Abre [Supabase Dashboard](https://supabase.com/dashboard) → tu proyecto **pfoedrqbqcwhnfyvvgky**.
2. Ve a **Authentication** → **Email Templates**.
3. Para cada plantilla:
   - Abre el archivo `.html` correspondiente en este folder.
   - Copia **todo** el HTML.
   - Pégalo en el campo **Message body** de Supabase.
   - Cambia el **Subject** (asunto) como se indica abajo.
   - Guarda.

## Reset password

| Campo | Valor |
|-------|--------|
| Archivo | `reset-password.html` |
| Subject sugerido | `Restablece tu contraseña · Espacios con propósito` |

Variable requerida en el cuerpo: `{{ .ConfirmationURL }}` (ya incluida).

## Confirm signup (verificación de correo al registrarse)

| Campo | Valor |
|-------|--------|
| Archivo | `confirm-signup.html` |
| Subject sugerido | `Confirma tu correo · Espacios con propósito` |

## Remitente (“Supabase Auth”)

El nombre **Supabase Auth** y el correo `noreply@mail.app.supabase.io` vienen del servicio de correo por defecto de Supabase.

Para mostrar **Espacios con propósito** como remitente:

- **Authentication** → **SMTP Settings** → configura tu propio SMTP (Gmail, SendGrid, Resend, etc.), **o**
- Usa un dominio personalizado en Supabase si lo tienes disponible en tu plan.

## URL de redirección

En **Authentication** → **URL Configuration**, confirma que estén:

- **Site URL:** `https://reservar-five.vercel.app`
- **Redirect URLs:** incluye `https://reservar-five.vercel.app/reset-password.html` y `https://reservar-five.vercel.app/index.html`
